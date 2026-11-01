//! 内部 HTTP 发送助手：把「构建请求 -> 发送 -> 状态校验 -> 反序列化」封成一处，并叠加退避重试。
//!
//! 两个平台客户端共用它。`build` 是「每次尝试都重新构造一个 [`reqwest::RequestBuilder`]」的闭包——
//! 退避重试要求每次都是全新请求（query/header/body 重新装配），因此接收闭包而非现成 builder。
//! 仅可重试错误（5xx/429/408、超时/连接类）才会按 [`RetryPolicy`] 退避后再试；4xx 等确定性失败立即冒泡。

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use aurora_base::retry::{RetryPolicy, retry_async};
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;
// 桶的时间和 sleep 必须走同一只钟，用例暂停时钟时两边才对得上。
use tokio::time::Instant;

use crate::error::{Error, Result};

/// 每个上游的持续放行速率（次/秒）。Modrinth 公开配额约每分钟 300 次，取 5 次/秒留出余量。
const REFILL_PER_SEC: f64 = 5.0;
/// 桶容量：允许这么多次突发。一次交互常要连打几发（搜索、版本列表、依赖解析），
/// 逐个硬加间隔会让界面平白变慢，故用令牌桶——突发放行，只有持续高频才被压住。
const BUCKET_CAPACITY: f64 = 10.0;
/// 最短等待，取 Tokio 的计时精度。补令牌是浮点累加，差一丝到 1 时算出的等待会舍入成 0，
/// 而 sleep(0) 不推进时钟，调用方就原地空转。
const MIN_WAIT: Duration = Duration::from_millis(1);

type Gates = Mutex<HashMap<String, Arc<Mutex<TokenBucket>>>>;

/// 元数据请求的节流闸，键是上游的 origin（scheme + host + port），每个上游一个桶。
///
/// 两个平台客户端的所有请求都经本模块出去，闸设在这里就能覆盖全部调用方。
/// 起因是真实踩过：版本列表页对每个实例查一次更新、每次更新检查又按已装 Mod 逐个问平台，
/// 请求量瞬间打满配额被 Modrinth 429。批量化解决了主要放大源，这道闸负责兜住其余路径。
///
/// 按上游分桶是因为配额是各上游自己的：共用一个桶只会让打给一个上游的请求排在另一个上游的队后面，
/// 分开后每个上游收到的请求上限不变。表项只增不删：一个进程里出现过的上游屈指可数。
///
/// 只管元数据请求：文件下载走 aurora-download 自己的并发池，不受此限。
static GATES: LazyLock<Gates> = LazyLock::new(Gates::default);

struct TokenBucket {
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    /// 按流逝时间补充令牌，取走一个；不够则返回「还需等多久才有一个」。
    ///
    /// 拆成纯函数是为了能脱离时钟直接测：给定桶状态与流逝时间，结果必须确定。
    fn try_take(&mut self, now: Instant) -> Option<Duration> {
        let elapsed = now
            .saturating_duration_since(self.last_refill)
            .as_secs_f64();
        self.tokens = (self.tokens + elapsed * REFILL_PER_SEC).min(BUCKET_CAPACITY);
        self.last_refill = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            return None;
        }
        Some(Duration::from_secs_f64((1.0 - self.tokens) / REFILL_PER_SEC).max(MIN_WAIT))
    }
}

/// 取 `origin` 这个上游的一个令牌，必要时等待，同一上游的调用方先到先得。
///
/// 桶锁一直持到拿到令牌：Tokio 的 Mutex 按到达顺序放人，于是等令牌的只有队头，其余人都排在锁上。
/// 不能放了锁睡到点再抢：睡着的调用方要和刚做完请求、立刻回来的调用方重新竞争，持续争抢时会被饿死。
///
/// 也不预订将来的令牌（透支、按序号算时间片）：任务取消时等待中的调用方是被直接丢弃的，预订的时间片
/// 收不回来，后来者得替没发出去的请求空等。排在锁上的话，丢弃就等于让出位置。
///
/// 只有表的锁是所有上游共用的，它不跨越任何等待，一个上游排队不影响别的上游。
///
/// 表作参数是给暂停时钟的用例用私有表：全局表被别的线程占住的一瞬，暂停的时钟会因为无事可做一路快进，
/// 虚拟时间里等待者像是被饿死了。
async fn acquire(gates: &Gates, origin: &str) {
    let gate = {
        let mut table = gates.lock().await;
        let gate = table.entry(origin.to_owned()).or_insert_with(|| {
            Arc::new(Mutex::new(TokenBucket {
                tokens: BUCKET_CAPACITY,
                last_refill: Instant::now(),
            }))
        });
        Arc::clone(gate)
    };
    let mut bucket = gate.lock().await;
    while let Some(wait) = bucket.try_take(Instant::now()) {
        tokio::time::sleep(wait).await;
    }
}

/// 发送请求并把成功响应体反序列化为 `T`。非 2xx 归一到 [`Error::Status`]。
pub(crate) async fn send_json<T, F>(retry: &RetryPolicy, context: &str, build: F) -> Result<T>
where
    T: DeserializeOwned,
    F: Fn() -> reqwest::RequestBuilder,
{
    retry_async(retry, || async {
        let (client, request) = build().build_split();
        let request = request.map_err(|source| Error::Http {
            context: context.to_string(),
            source,
        })?;
        // 节流放在重试内层：429 触发的重试同样要排队，否则退避完又是一次立刻打出去的请求。
        acquire(&GATES, &request.url().origin().ascii_serialization()).await;
        let response = client
            .execute(request)
            .await
            .map_err(|source| Error::Http {
                context: context.to_string(),
                source,
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::Status {
                url: response.url().to_string(),
                status: status.as_u16(),
            });
        }
        // 先收齐再解析：reqwest 的 json() 把读体中断和解析失败都报成 decode 类，前者值得重试，后者不值得。
        let body = response.bytes().await.map_err(|source| Error::Http {
            context: context.to_string(),
            source,
        })?;
        serde_json::from_slice(&body).map_err(|source| Error::Json {
            context: context.to_string(),
            source,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 按连接顺序写出 `replies` 里的（声明长度，实际正文）后关闭连接，wiremock 造不出响应体只到一半。
    /// 返回地址与已接受的连接数。
    fn raw_server(replies: Vec<(usize, Vec<u8>)>) -> (String, Arc<AtomicUsize>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/search", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        std::thread::spawn(move || {
            for (declared, body) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                counter.fetch_add(1, Ordering::SeqCst);
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    head.push(byte[0]);
                }
                let status = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n"
                );
                stream.write_all(status.as_bytes()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        (url, accepted)
    }

    fn two_attempts() -> RetryPolicy {
        RetryPolicy {
            max_attempts: 2,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(1),
            multiplier: 1.0,
            jitter: false,
        }
    }

    /// 响应体读到一半连接断开：搜索、版本列表不该因一次断开直接报错，再试一次就拿到完整内容。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_body_cut_off_midway_is_retried() {
        let full = br#"{"hits":7}"#.to_vec();
        let (url, accepted) = raw_server(vec![
            (full.len(), full[..4].to_vec()),
            (full.len(), full.clone()),
        ]);
        let client = aurora_base::http::build_client().unwrap();

        let value: serde_json::Value =
            send_json(&two_attempts(), "测试", || client.get(url.as_str()))
                .await
                .unwrap();

        assert_eq!(value["hits"], 7);
        assert_eq!(accepted.load(Ordering::SeqCst), 2);
    }

    /// 完整收到但解析不了是确定性失败：报 Json，不重试。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_complete_but_unparsable_body_is_json_and_not_retried() {
        let garbage = b"<html>oops</html>".to_vec();
        let (url, accepted) = raw_server(vec![
            (garbage.len(), garbage.clone()),
            (garbage.len(), garbage),
        ]);
        let client = aurora_base::http::build_client().unwrap();

        let err = send_json::<serde_json::Value, _>(&two_attempts(), "测试", || {
            client.get(url.as_str())
        })
        .await
        .unwrap_err();

        match err {
            Error::Json { context, .. } => assert_eq!(context, "测试"),
            other => panic!("应为 Json，实际 {other:?}"),
        }
        assert_eq!(accepted.load(Ordering::SeqCst), 1, "不该重试");
    }

    /// 配额是各上游自己的：打给不同上游的请求互不排队，哪怕总数远超单个桶的容量。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn requests_to_different_hosts_do_not_queue_behind_each_other() {
        const HOSTS: usize = 40;
        // 共用一个桶时 t 秒内最多放行「容量 + t × 速率」个，这批请求至少要这么久，不靠调度运气。
        let shared_bucket_floor =
            Duration::from_secs_f64((HOSTS as f64 - BUCKET_CAPACITY) / REFILL_PER_SEC);
        let body = br#"{"hits":7}"#.to_vec();
        let client = aurora_base::http::build_client().unwrap();

        let started = Instant::now();
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..HOSTS {
            let (url, accepted) = raw_server(vec![(body.len(), body.clone())]);
            let client = client.clone();
            requests.spawn(async move {
                let value: serde_json::Value =
                    send_json(&two_attempts(), "测试", || client.get(url.as_str()))
                        .await
                        .unwrap();
                (value, accepted.load(Ordering::SeqCst))
            });
        }
        while let Some(joined) = requests.join_next().await {
            let (value, accepted) = joined.unwrap();
            assert_eq!(value["hits"], 7);
            assert_eq!(accepted, 1);
        }

        let elapsed = started.elapsed();
        assert!(
            elapsed < shared_bucket_floor,
            "{HOSTS} 个上游各一个请求用了 {elapsed:?}，已到共用一个桶的下限 {shared_bucket_floor:?}"
        );
    }

    /// 同一上游超出突发容量后仍按补充速率放行：分桶不能把限速本身分没了。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_host_is_still_held_to_the_refill_rate() {
        const OVER_CAPACITY: usize = 6;
        let total = BUCKET_CAPACITY as usize + OVER_CAPACITY;
        // 少算一个令牌，给浮点补充量的舍入留余地。
        let floor = Duration::from_secs_f64((OVER_CAPACITY - 1) as f64 / REFILL_PER_SEC);
        let body = br#"{"hits":7}"#.to_vec();
        let (url, accepted) = raw_server(vec![(body.len(), body); total]);
        let client = aurora_base::http::build_client().unwrap();

        let started = Instant::now();
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..total {
            let (client, url) = (client.clone(), url.clone());
            requests.spawn(async move {
                send_json::<serde_json::Value, _>(&two_attempts(), "测试", || {
                    client.get(url.as_str())
                })
                .await
                .unwrap()
            });
        }
        while let Some(joined) = requests.join_next().await {
            assert_eq!(joined.unwrap()["hits"], 7);
        }

        assert_eq!(accepted.load(Ordering::SeqCst), total);
        let elapsed = started.elapsed();
        assert!(
            elapsed >= floor,
            "{total} 个请求只用了 {elapsed:?}，超出容量的部分应被压到补充速率（至少 {floor:?}）"
        );
    }

    fn full_bucket(at: Instant) -> TokenBucket {
        TokenBucket {
            tokens: BUCKET_CAPACITY,
            last_refill: at,
        }
    }

    /// 满桶允许连续放行 BUCKET_CAPACITY 次而不等待——一次交互里的几发连打不该被拖慢。
    #[test]
    fn full_bucket_lets_a_burst_through_without_waiting() {
        let t0 = Instant::now();
        let mut bucket = full_bucket(t0);
        for i in 0..BUCKET_CAPACITY as usize {
            assert!(bucket.try_take(t0).is_none(), "第 {i} 次不该等待");
        }
    }

    /// 突发用尽后必须开始等待，且等待时长等于补满一个令牌所需时间。
    #[test]
    fn exhausted_bucket_waits_exactly_one_refill_interval() {
        let t0 = Instant::now();
        let mut bucket = full_bucket(t0);
        for _ in 0..BUCKET_CAPACITY as usize {
            bucket.try_take(t0);
        }
        let wait = bucket.try_take(t0).expect("桶已空，必须等待");
        // 每秒补 REFILL_PER_SEC 个，补一个即 1/REFILL_PER_SEC 秒。
        let expected = Duration::from_secs_f64(1.0 / REFILL_PER_SEC);
        assert!(
            wait.abs_diff(expected) < Duration::from_millis(1),
            "期望约 {expected:?}，实得 {wait:?}"
        );
    }

    /// 浮点残差让令牌差一丝到 1 时，等待不能舍入成 0：sleep(0) 不推进时钟，调用方会原地空转。
    #[test]
    fn a_rounding_residue_still_waits_a_timer_tick() {
        let t0 = Instant::now();
        let mut bucket = TokenBucket {
            tokens: 1.0 - f64::EPSILON,
            last_refill: t0,
        };
        let wait = bucket.try_take(t0).expect("差一丝也是不够");
        assert_eq!(wait, Duration::from_millis(1));
    }

    /// 补一个令牌的时间，也就是排队时一个人占用的时长。
    fn slot() -> Duration {
        Duration::from_secs_f64(1.0 / REFILL_PER_SEC)
    }

    /// 暂停时钟的用例专用的闸表。泄漏一下换 'static，好直接交给 spawn 出去的任务。
    fn private_gates() -> &'static Gates {
        Box::leak(Box::default())
    }

    /// 打光 `origin` 的突发额度，此后每个令牌都要等。
    async fn drain(gates: &Gates, origin: &str) {
        let started = Instant::now();
        for _ in 0..BUCKET_CAPACITY as usize {
            acquire(gates, origin).await;
        }
        assert_eq!(started.elapsed(), Duration::ZERO, "突发额度内不该等待");
    }

    /// 到达间隔：头两个是「同一时刻」与「整整隔一格」两个边界，其余随机。
    /// 自己写 xorshift 是因为这点用量不值得给本 crate 添一个 dev 依赖。
    fn arrival_gaps(seed: u64, count: usize) -> Vec<Duration> {
        let mut state = seed | 1;
        let random = std::iter::repeat_with(move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            Duration::from_millis(state % (slot().as_millis() as u64 + 1))
        });
        [Duration::ZERO, slot()]
            .into_iter()
            .chain(random)
            .take(count)
            .collect()
    }

    /// 持续争抢下先到先得：总有人拿完令牌立刻回来接着要，睡着的等待者照样按到达顺序拿到令牌，
    /// 不会一轮轮输给刚回来的人。排队不能把限速排没了：相邻两次放行仍然隔足一格。
    #[tokio::test(start_paused = true)]
    async fn sleeping_waiters_are_served_in_arrival_order_under_contention() {
        const GREEDY: usize = 3;
        const WAITERS: usize = 8;
        let (gates, origin) = (private_gates(), "http://contended.test");
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64;
        drain(gates, origin).await;

        let grants = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut greedy = tokio::task::JoinSet::new();
        for _ in 0..GREEDY {
            let grants = grants.clone();
            greedy.spawn(async move {
                loop {
                    acquire(gates, origin).await;
                    grants.lock().unwrap().push((None, Instant::now()));
                }
            });
        }
        tokio::task::yield_now().await;

        let mut waiters = tokio::task::JoinSet::new();
        for (id, gap) in arrival_gaps(seed, WAITERS).into_iter().enumerate() {
            tokio::time::sleep(gap).await;
            let grants = grants.clone();
            let arrived = Instant::now();
            waiters.spawn(async move {
                acquire(gates, origin).await;
                grants.lock().unwrap().push((Some(id), Instant::now()));
                (id, arrived.elapsed())
            });
            // 让它先进到闸里再放下一个，到达顺序才是这里写的顺序。
            tokio::task::yield_now().await;
        }

        // 最后一个到达时，前面至多是所有抢占者与所有更早的等待者；多留一格给浮点舍入。
        let horizon = slot() * (GREEDY + WAITERS + 1) as u32;
        let waits = tokio::time::timeout(horizon, waiters.join_all())
            .await
            .unwrap_or_else(|_| {
                let served: Vec<usize> = grants
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|(id, _)| *id)
                    .collect();
                panic!("种子 {seed}：{horizon:?} 内没走完，等待者被饿死，只放行了 {served:?}")
            });
        drop(greedy);

        for (id, wait) in waits {
            let bound = slot() * (GREEDY + id + 2) as u32;
            assert!(
                wait <= bound,
                "种子 {seed}：等待者 {id} 等了 {wait:?}，上限 {bound:?}"
            );
        }
        let grants = grants.lock().unwrap();
        let served: Vec<usize> = grants.iter().filter_map(|(id, _)| *id).collect();
        assert_eq!(
            served,
            (0..WAITERS).collect::<Vec<_>>(),
            "种子 {seed}：不是先到先得"
        );
        for pair in grants.windows(2) {
            let gap = pair[1].1 - pair[0].1;
            assert!(
                gap >= slot() - Duration::from_millis(2),
                "种子 {seed}：相邻放行只隔了 {gap:?}，超过了补充速率"
            );
        }
    }

    /// 任务取消后，宽限期满时主体连同闸上的等待一起被丢弃。排在后面的人不替这些没发出去的请求等。
    #[tokio::test(start_paused = true)]
    async fn cancelled_waiters_leave_no_wait_behind() {
        const CANCELLED: usize = 20;
        let (gates, origin) = (private_gates(), "http://cancelled.test");
        drain(gates, origin).await;

        let mut queued = tokio::task::JoinSet::new();
        for _ in 0..CANCELLED {
            queued.spawn(acquire(gates, origin));
        }
        tokio::task::yield_now().await;
        queued.shutdown().await;

        let asked = Instant::now();
        acquire(gates, origin).await;
        let wait = asked.elapsed();
        assert!(
            wait <= slot(),
            "取消了 {CANCELLED} 个排队者，后来者还等了 {wait:?}"
        );
    }

    /// 排队是每个上游自己的事：一个上游的队头睡着时，另一个上游的请求照常立刻放行。
    #[tokio::test(start_paused = true)]
    async fn a_queue_on_one_host_does_not_hold_up_another() {
        let gates = private_gates();
        let (busy, idle) = ("http://busy.test", "http://idle.test");
        drain(gates, busy).await;
        let queued = tokio::spawn(acquire(gates, busy));
        tokio::task::yield_now().await;

        let asked = Instant::now();
        acquire(gates, idle).await;

        assert_eq!(asked.elapsed(), Duration::ZERO);
        assert!(!queued.is_finished(), "繁忙上游的队头应当还在等令牌");
        queued.await.unwrap();
    }

    /// 时间流逝按速率补令牌：空桶等一秒后应恰好补回 REFILL_PER_SEC 个，即能连放这么多次。
    #[test]
    fn tokens_refill_at_configured_rate() {
        let t0 = Instant::now();
        let mut bucket = full_bucket(t0);
        for _ in 0..BUCKET_CAPACITY as usize {
            bucket.try_take(t0);
        }
        let t1 = t0 + Duration::from_secs(1);
        for i in 0..REFILL_PER_SEC as usize {
            assert!(bucket.try_take(t1).is_none(), "补充后第 {i} 次不该等待");
        }
        assert!(bucket.try_take(t1).is_some(), "补充的令牌用完后应重新等待");
    }

    /// 补充不会超过容量：闲置很久也只攒到满桶，不会攒出一次超大突发把配额一口气打光。
    #[test]
    fn refill_is_capped_at_capacity() {
        let t0 = Instant::now();
        let mut bucket = full_bucket(t0);
        for _ in 0..BUCKET_CAPACITY as usize {
            bucket.try_take(t0);
        }
        let long_idle = t0 + Duration::from_secs(3600);
        for _ in 0..BUCKET_CAPACITY as usize {
            assert!(bucket.try_take(long_idle).is_none());
        }
        assert!(
            bucket.try_take(long_idle).is_some(),
            "闲置一小时也不该攒出超过容量的突发"
        );
    }
}
