//! 内部 HTTP 发送助手：把「构建请求 -> 发送 -> 状态校验 -> 反序列化」封成一处，并叠加退避重试。
//!
//! 两个平台客户端共用它。`build` 是「每次尝试都重新构造一个 [`reqwest::RequestBuilder`]」的闭包——
//! 退避重试要求每次都是全新请求（query/header/body 重新装配），因此接收闭包而非现成 builder。
//! 仅可重试错误（5xx/429/408、超时/连接类）才会按 [`RetryPolicy`] 退避后再试；4xx 等确定性失败立即冒泡。

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use aurora_base::retry::{RetryPolicy, retry_async};
use serde::de::DeserializeOwned;
use tokio::sync::Mutex;

use crate::error::{Error, Result};

/// 持续放行速率（次/秒）。Modrinth 公开配额约每分钟 300 次，取 5 次/秒留出余量。
const REFILL_PER_SEC: f64 = 5.0;
/// 桶容量：允许这么多次突发。一次交互常要连打几发（搜索、版本列表、依赖解析），
/// 逐个硬加间隔会让界面平白变慢，故用令牌桶——突发放行，只有持续高频才被压住。
const BUCKET_CAPACITY: f64 = 10.0;

/// 元数据请求的全局节流闸。
///
/// 两个平台客户端的所有请求都经本模块出去，闸设在这里就能覆盖全部调用方。
/// 起因是真实踩过：版本列表页对每个实例查一次更新、每次更新检查又按已装 Mod 逐个问平台，
/// 请求量瞬间打满配额被 Modrinth 429。批量化解决了主要放大源，这道闸负责兜住其余路径。
///
/// 只管元数据请求：文件下载走 aurora-download 自己的并发池，不受此限。
static GATE: LazyLock<Mutex<TokenBucket>> = LazyLock::new(|| {
    Mutex::new(TokenBucket {
        tokens: BUCKET_CAPACITY,
        last_refill: Instant::now(),
    })
});

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
        Some(Duration::from_secs_f64(
            (1.0 - self.tokens) / REFILL_PER_SEC,
        ))
    }
}

/// 取一个令牌，必要时等待。等待期间不持锁，否则所有调用方会排成一列而不是各自等到点。
async fn acquire() {
    loop {
        let wait = {
            let mut bucket = GATE.lock().await;
            match bucket.try_take(Instant::now()) {
                None => return,
                Some(wait) => wait,
            }
        };
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
        // 节流放在重试内层：429 触发的重试同样要排队，否则退避完又是一次立刻打出去的请求。
        acquire().await;
        let response = build().send().await.map_err(|source| Error::Http {
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
    use std::sync::Arc;
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
