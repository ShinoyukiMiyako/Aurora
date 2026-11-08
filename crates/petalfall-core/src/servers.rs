//! 主页「固定的服务器」：固定列表的读写（含「加入」时记住的实例）、游戏多人列表的读取，以及带缓存的状态查询。
//!
//! 状态查询走 Server List Ping（[`slp`]），每台单独限时 [`PING_TIMEOUT`]，全部并发；结果按地址缓存
//! [`STATUS_TTL`]，主页定时刷新不会每次都去敲一遍服务器。最近一次连通的时刻与在线人数另记一份落盘，
//! 服务器连不上时界面能写「上次 2 小时前在线 1.2 万」。

mod nbt;
pub mod slp;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use petalfall_instance::is_safe_instance_id;

use crate::InstanceError;
use crate::config::PinnedServer;
use crate::error::{CoreError, Result};
use crate::facade::Petalfall;

pub use nbt::{ListedServer, NbtError, parse_servers_dat};

/// Java 版服务器的默认端口。
pub const DEFAULT_PORT: u16 = 25565;
/// 单台服务器一次查询（解析、建连、握手、状态、ping）的总时限。
pub const PING_TIMEOUT: Duration = Duration::from_millis(3000);
/// 查询结果的缓存时长。
pub const STATUS_TTL: Duration = Duration::from_secs(60);
/// 最近连通记录的落盘文件，位于 `<数据目录>/cache/`。
const HISTORY_FILE: &str = "server-history.json";
/// 游戏的多人游戏列表文件名。
const SERVERS_DAT: &str = "servers.dat";

/// 解析后的服务器地址。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerAddress {
    pub host: String,
    pub port: u16,
}

impl ServerAddress {
    /// 缓存键：主机名不区分大小写。
    fn key(&self) -> String {
        format!("{}:{}", self.host.to_lowercase(), self.port)
    }
}

/// 解析 `host`、`host:port`、`[IPv6]:port` 或裸 IPv6。没写端口时用 [`DEFAULT_PORT`]。
///
/// 不查 `_minecraft._tcp` SRV 记录：只写域名、端口靠 SRV 指定的服务器会连到 25565。
pub fn parse_server_address(raw: &str) -> Result<ServerAddress> {
    let address = raw.trim();
    let invalid = |reason: &'static str| CoreError::InvalidServerAddress {
        address: raw.to_owned(),
        reason,
    };
    if address.is_empty() {
        return Err(invalid("地址为空"));
    }
    let (host, port) = if let Some(rest) = address.strip_prefix('[') {
        let (host, tail) = rest.split_once(']').ok_or_else(|| invalid("缺少「]」"))?;
        match tail {
            "" => (host, None),
            _ => (
                host,
                Some(
                    tail.strip_prefix(':')
                        .ok_or_else(|| invalid("「]」之后只能跟端口"))?,
                ),
            ),
        }
    } else {
        match address.matches(':').count() {
            0 => (address, None),
            1 => {
                let (host, port) = address.split_once(':').expect("恰有一个冒号");
                (host, Some(port))
            }
            _ => (address, None),
        }
    };
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err(invalid("主机名为空或含空白"));
    }
    let port = match port {
        None => DEFAULT_PORT,
        Some(text) => match text.parse::<u16>() {
            Ok(port) if port > 0 => port,
            _ => return Err(invalid("端口须是 1 到 65535 的整数")),
        },
    };
    Ok(ServerAddress {
        host: host.to_owned(),
        port,
    })
}

/// 多人游戏列表里的一台服务器，带是否已固定。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KnownServer {
    pub name: String,
    pub address: String,
    pub pinned: bool,
}

/// 一台服务器的状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServerStatus {
    /// 查询时用的地址，原样回传。
    pub address: String,
    pub reachable: bool,
    pub latency_ms: Option<u32>,
    pub online: Option<u32>,
    pub max: Option<u32>,
    pub version_name: Option<String>,
    /// MOTD 纯文本。
    pub motd: Option<String>,
    /// `data:image/png;base64,...`。
    pub favicon: Option<String>,
    /// 本次查询的时刻（Unix 毫秒）。
    pub checked_at: u64,
    /// 最近一次连通的时刻（Unix 毫秒）；从没连通过为 `None`。
    pub last_seen_at: Option<u64>,
    /// 最近一次连通时的在线人数。
    pub last_online: Option<u32>,
    /// 连不上的原因，供排查。
    pub error: Option<String>,
}

/// 最近一次连通的记录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct SeenRecord {
    at: u64,
    online: Option<u32>,
}

/// 带缓存的状态查询器。放在上层的长驻状态里，跨命令共享缓存。
pub struct ServerMonitor {
    timeout: Duration,
    ttl: Duration,
    history_path: PathBuf,
    state: Mutex<MonitorState>,
}

#[derive(Default)]
struct MonitorState {
    cache: HashMap<String, (Instant, ServerStatus)>,
    history: Option<HashMap<String, SeenRecord>>,
}

impl ServerMonitor {
    /// 以数据目录构造，最近连通记录落在 `<数据目录>/cache/server-history.json`。
    pub fn new(data_dir: &Path) -> Self {
        Self {
            timeout: PING_TIMEOUT,
            ttl: STATUS_TTL,
            history_path: data_dir.join("cache").join(HISTORY_FILE),
            state: Mutex::new(MonitorState::default()),
        }
    }

    /// 覆盖单台时限与缓存时长（测试用）。
    pub fn with_timing(mut self, timeout: Duration, ttl: Duration) -> Self {
        self.timeout = timeout;
        self.ttl = ttl;
        self
    }

    /// 查询一组服务器，结果与输入顺序一致。缓存未过期的直接复用，其余并发查询。
    ///
    /// 有地址写法不合法时整体报错、一台也不查：这些地址来自固定列表，写进配置前就校验过，
    /// 走到这里说明调用方传了没校验过的东西。
    pub async fn ping_all(&self, addresses: &[String]) -> Result<Vec<ServerStatus>> {
        let parsed: Vec<ServerAddress> = addresses
            .iter()
            .map(|raw| parse_server_address(raw))
            .collect::<Result<_>>()?;

        let mut results: Vec<Option<ServerStatus>> = vec![None; addresses.len()];
        let mut misses = Vec::new();
        {
            let mut state = self.state.lock().await;
            let history = state.history(&self.history_path).await.clone();
            for (index, address) in parsed.iter().enumerate() {
                match state.cache.get(&address.key()) {
                    Some((at, status)) if at.elapsed() < self.ttl => {
                        let mut status = status.clone();
                        status.address = addresses[index].clone();
                        results[index] = Some(status);
                    }
                    _ => {
                        misses.push((index, address.clone(), history.get(&address.key()).copied()))
                    }
                }
            }
        }

        let mut set = tokio::task::JoinSet::new();
        for (index, address, seen) in misses {
            let raw = addresses[index].clone();
            let timeout = self.timeout;
            set.spawn(async move {
                let started = Instant::now();
                let outcome = slp::ping(&address, timeout).await;
                (
                    index,
                    address,
                    started,
                    status_from(raw, outcome, seen, now_ms()),
                )
            });
        }
        let mut fresh = Vec::new();
        while let Some(joined) = set.join_next().await {
            fresh.push(joined?);
        }

        let mut state = self.state.lock().await;
        let mut history_changed = false;
        for (index, address, started, status) in fresh {
            if status.reachable {
                let history = state.history(&self.history_path).await;
                history.insert(
                    address.key(),
                    SeenRecord {
                        at: status.checked_at,
                        online: status.online,
                    },
                );
                history_changed = true;
            }
            // 缓存时刻取开始查询的那一刻：主页每 60 秒刷新一次，按完成时刻算会让每隔一轮都命中旧缓存。
            state.cache.insert(address.key(), (started, status.clone()));
            results[index] = Some(status);
        }
        if history_changed {
            let snapshot = state.history(&self.history_path).await.clone();
            save_history(&self.history_path, &snapshot).await;
        }
        Ok(results
            .into_iter()
            .map(|status| status.expect("每个下标要么命中缓存要么已查询"))
            .collect())
    }
}

impl MonitorState {
    async fn history(&mut self, path: &Path) -> &mut HashMap<String, SeenRecord> {
        if self.history.is_none() {
            self.history = Some(load_history(path).await);
        }
        self.history.as_mut().expect("刚刚填上")
    }
}

/// 最近连通记录是派生数据：文件缺失或损坏都从空表开始（损坏记一条告警），丢了只是少一句「上次在线」。
async fn load_history(path: &Path) -> HashMap<String, SeenRecord> {
    match tokio::fs::read(path).await {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(history) => history,
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "服务器连通记录损坏，已重新开始记录");
                HashMap::new()
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "读不了服务器连通记录，本次不显示上次在线");
            HashMap::new()
        }
    }
}

/// 写不进去只记告警：查询结果已经拿到，不该因为一份派生记录落盘失败就让主页报错。
async fn save_history(path: &Path, history: &HashMap<String, SeenRecord>) {
    let bytes = match serde_json::to_vec(history) {
        Ok(bytes) => bytes,
        Err(err) => {
            tracing::warn!(error = %err, "序列化服务器连通记录失败");
            return;
        }
    };
    if let Err(err) = petalfall_base::fs::atomic_write(path, &bytes).await {
        tracing::warn!(path = %path.display(), error = %err, "服务器连通记录写盘失败");
    }
}

fn status_from(
    address: String,
    outcome: std::result::Result<slp::PingResponse, slp::PingError>,
    seen: Option<SeenRecord>,
    now: u64,
) -> ServerStatus {
    match outcome {
        Ok(response) => ServerStatus {
            address,
            reachable: true,
            latency_ms: Some(response.latency_ms),
            online: response.online,
            max: response.max,
            version_name: response.version_name,
            motd: response.motd,
            favicon: response.favicon,
            checked_at: now,
            last_seen_at: Some(now),
            last_online: response.online,
            error: None,
        },
        Err(err) => ServerStatus {
            address,
            reachable: false,
            latency_ms: None,
            online: None,
            max: None,
            version_name: None,
            motd: None,
            favicon: None,
            checked_at: now,
            last_seen_at: seen.map(|s| s.at),
            last_online: seen.and_then(|s| s.online),
            error: Some(err.to_string()),
        },
    }
}

fn now_ms() -> u64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时钟早于 1970 年");
    u64::try_from(elapsed.as_millis()).expect("毫秒时间戳放得进 u64")
}

impl Petalfall {
    /// 固定的服务器，按固定的先后。
    pub fn pinned_servers(&self) -> &[PinnedServer] {
        &self.config().pinned_servers
    }

    /// 整体替换固定列表：逐个校验地址与记住的实例 id，同一地址只留第一次出现的那条（连同它记住的实例）；
    /// 名字为空时用地址当名字。实例是否存在不在这里查：列表随时可能变，界面把找不到的当作没记住。
    /// 落盘仍需调用 [`Petalfall::save_config`]。
    pub fn set_pinned_servers(&mut self, servers: Vec<PinnedServer>) -> Result<()> {
        let mut seen = Vec::new();
        let mut cleaned = Vec::with_capacity(servers.len());
        for server in servers {
            let key = parse_server_address(&server.address)?.key();
            if let Some(id) = &server.instance {
                ensure_safe_instance_id(id)?;
            }
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            let address = server.address.trim().to_owned();
            let name = match server.name.trim() {
                "" => address.clone(),
                name => name.to_owned(),
            };
            cleaned.push(PinnedServer {
                name,
                address,
                instance: server.instance,
            });
        }
        self.config_mut().pinned_servers = cleaned;
        Ok(())
    }

    /// 记住或清掉一台固定服务器「加入」时用的实例。按地址的身份找（主机不分大小写，没写端口等于
    /// 25565），不在固定列表里报 [`CoreError::ServerNotPinned`]。实例是否存在由调用方检查。
    /// 落盘仍需调用 [`Petalfall::save_config`]。
    pub fn set_pinned_server_instance(
        &mut self,
        address: &str,
        instance: Option<String>,
    ) -> Result<()> {
        let key = parse_server_address(address)?.key();
        if let Some(id) = &instance {
            ensure_safe_instance_id(id)?;
        }
        let pinned = self
            .config_mut()
            .pinned_servers
            .iter_mut()
            .find(|server| parse_server_address(&server.address).is_ok_and(|a| a.key() == key))
            .ok_or_else(|| CoreError::ServerNotPinned {
                address: address.to_owned(),
            })?;
        pinned.instance = instance;
        Ok(())
    }

    /// 实例改名后，把记住 `old` 的固定服务器改成记住 `new`。与侧栏固定同一口径：按 id 精确相等。
    /// 返回配置是否有变化。
    pub(crate) fn rename_pinned_instance(&mut self, old: &str, new: &str) -> bool {
        let mut changed = false;
        for server in &mut self.config_mut().pinned_servers {
            if server.instance.as_deref() == Some(old) {
                server.instance = Some(new.to_owned());
                changed = true;
            }
        }
        changed
    }

    /// 实例删除后，记住它的固定服务器改回没记住。返回配置是否有变化。
    pub(crate) fn forget_pinned_instance(&mut self, id: &str) -> bool {
        let mut changed = false;
        for server in &mut self.config_mut().pinned_servers {
            if server.instance.as_deref() == Some(id) {
                server.instance = None;
                changed = true;
            }
        }
        changed
    }

    /// 游戏多人游戏列表里的服务器：读游戏目录根下与各版本目录（隔离实例）下的 `servers.dat`，
    /// 按地址去重，标出是否已固定。读不了或解析失败的文件跳过并记告警——一个实例的坏文件
    /// 不该让其余实例的列表也看不到。
    pub async fn known_servers(&self) -> Result<Vec<KnownServer>> {
        let game_dir = self.game_dir().to_path_buf();
        let listed = tokio::task::spawn_blocking(move || read_all_server_lists(&game_dir)).await?;
        let pinned: Vec<String> = self
            .pinned_servers()
            .iter()
            .filter_map(|p| parse_server_address(&p.address).ok().map(|a| a.key()))
            .collect();
        let mut seen: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for server in listed {
            let Ok(address) = parse_server_address(&server.address) else {
                tracing::debug!(address = %server.address, "多人游戏列表里有写法不合法的地址，跳过");
                continue;
            };
            let key = address.key();
            if seen.contains(&key) {
                continue;
            }
            out.push(KnownServer {
                name: server.name,
                address: server.address,
                pinned: pinned.contains(&key),
            });
            seen.push(key);
        }
        Ok(out)
    }
}

/// 实例 id 来自前端，写进配置之前与拼路径时同一标准。
fn ensure_safe_instance_id(id: &str) -> Result<()> {
    if is_safe_instance_id(id) {
        Ok(())
    } else {
        Err(InstanceError::InvalidId { id: id.to_owned() }.into())
    }
}

fn read_all_server_lists(game_dir: &Path) -> Vec<ListedServer> {
    let mut files = vec![game_dir.join(SERVERS_DAT)];
    if let Ok(entries) = std::fs::read_dir(game_dir.join("versions")) {
        let mut version_files: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path().join(SERVERS_DAT))
            .collect();
        version_files.sort();
        files.extend(version_files);
    }
    let mut out = Vec::new();
    for file in files {
        let bytes = match std::fs::read(&file) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => {
                tracing::warn!(path = %file.display(), error = %err, "读不了多人游戏列表");
                continue;
            }
        };
        match parse_servers_dat(&bytes) {
            Ok(servers) => out.extend(servers),
            Err(err) => {
                tracing::warn!(path = %file.display(), error = %err, "多人游戏列表解析失败");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PetalfallConfig;
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn addr(host: &str, port: u16) -> ServerAddress {
        ServerAddress {
            host: host.to_owned(),
            port,
        }
    }

    #[test]
    fn parses_address_forms_and_rejects_bad_ports() {
        assert_eq!(
            parse_server_address(" mc.hypixel.net ").unwrap(),
            addr("mc.hypixel.net", 25565)
        );
        assert_eq!(
            parse_server_address("play.example.cn:25566").unwrap(),
            addr("play.example.cn", 25566)
        );
        assert_eq!(parse_server_address("[::1]:1").unwrap(), addr("::1", 1));
        assert_eq!(parse_server_address("[::1]").unwrap(), addr("::1", 25565));
        assert_eq!(
            parse_server_address("2001:db8::1").unwrap(),
            addr("2001:db8::1", 25565)
        );
        assert_eq!(parse_server_address("h:65535").unwrap(), addr("h", 65535));
        for bad in [
            "", "   ", "h:0", "h:65536", "h:abc", ":25565", "[::1]x", "a b:1", "[::1",
        ] {
            assert!(
                matches!(
                    parse_server_address(bad),
                    Err(CoreError::InvalidServerAddress { .. })
                ),
                "{bad:?} 应被拒绝"
            );
        }
    }

    #[test]
    fn set_pinned_servers_validates_dedups_and_names() {
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = Petalfall::for_test(
            PetalfallConfig::default(),
            dir.path().to_path_buf(),
            dir.path().join(".minecraft"),
        );
        let pin = |name: &str, address: &str| PinnedServer {
            name: name.to_owned(),
            address: address.to_owned(),
            instance: None,
        };
        petalfall
            .set_pinned_servers(vec![
                pin("Hypixel", "mc.hypixel.net"),
                pin("重复", "MC.HYPIXEL.NET:25565"),
                pin("  ", " play.example.cn:25566 "),
            ])
            .unwrap();
        assert_eq!(
            petalfall.pinned_servers(),
            &[
                pin("Hypixel", "mc.hypixel.net"),
                pin("play.example.cn:25566", "play.example.cn:25566"),
            ]
        );

        // 有一个不合法就整体拒绝，原列表不动。
        let err = petalfall
            .set_pinned_servers(vec![pin("ok", "a.example"), pin("bad", "a:0")])
            .unwrap_err();
        assert!(matches!(err, CoreError::InvalidServerAddress { .. }));
        assert_eq!(petalfall.pinned_servers().len(), 2);
    }

    fn bound(name: &str, address: &str, instance: Option<&str>) -> PinnedServer {
        PinnedServer {
            name: name.to_owned(),
            address: address.to_owned(),
            instance: instance.map(str::to_owned),
        }
    }

    fn test_petalfall(dir: &Path) -> Petalfall {
        Petalfall::for_test(
            PetalfallConfig::default(),
            dir.to_path_buf(),
            dir.join(".minecraft"),
        )
    }

    #[test]
    fn set_pinned_servers_keeps_instances_and_rejects_unsafe_ids() {
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = test_petalfall(dir.path());
        petalfall
            .set_pinned_servers(vec![
                bound("家", "10.0.0.2", Some("生存 1.21.1")),
                // 同一台服务器的第二条连同它记住的实例一起丢掉，留第一次出现的那条。
                bound("重复", "10.0.0.2:25565", Some("创造")),
                bound("小游戏", "mini.example:25570", None),
                // 实例存不存在不在这里查。
                bound("旧服", "old.example", Some("早就删了")),
            ])
            .unwrap();
        assert_eq!(
            petalfall.pinned_servers(),
            &[
                bound("家", "10.0.0.2", Some("生存 1.21.1")),
                bound("小游戏", "mini.example:25570", None),
                bound("旧服", "old.example", Some("早就删了")),
            ]
        );

        for unsafe_id in ["../outside", r"..\outside", "a/b", ""] {
            let err = petalfall
                .set_pinned_servers(vec![
                    bound("ok", "ok.example", None),
                    bound("坏", "bad.example", Some(unsafe_id)),
                ])
                .unwrap_err();
            assert!(
                matches!(&err, CoreError::Instance(InstanceError::InvalidId { id }) if id == unsafe_id),
                "{unsafe_id:?}: {err:?}"
            );
        }
        // 被拒绝时原列表不动。
        assert_eq!(petalfall.pinned_servers().len(), 3);
    }

    #[test]
    fn set_pinned_server_instance_matches_by_address_identity() {
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = test_petalfall(dir.path());
        petalfall
            .set_pinned_servers(vec![
                bound("示例", "play.example.cn", None),
                bound("另一台", "other.example:25570", Some("小游戏")),
            ])
            .unwrap();

        // 大小写不同、显式写出缺省端口，都是同一台。
        petalfall
            .set_pinned_server_instance(" PLAY.example.cn:25565 ", Some("生存".to_owned()))
            .unwrap();
        assert_eq!(
            petalfall.pinned_servers(),
            &[
                bound("示例", "play.example.cn", Some("生存")),
                bound("另一台", "other.example:25570", Some("小游戏")),
            ]
        );

        // 改记另一个，再清掉；别的固定项不受影响。
        petalfall
            .set_pinned_server_instance("play.example.cn", Some("创造".to_owned()))
            .unwrap();
        assert_eq!(
            petalfall.pinned_servers()[0].instance.as_deref(),
            Some("创造")
        );
        petalfall
            .set_pinned_server_instance("play.example.cn", None)
            .unwrap();
        assert_eq!(petalfall.pinned_servers()[0].instance, None);
        assert_eq!(
            petalfall.pinned_servers()[1].instance.as_deref(),
            Some("小游戏")
        );

        // 端口不同就是另一台服务器：没固定。
        let err = petalfall
            .set_pinned_server_instance("play.example.cn:25566", Some("生存".to_owned()))
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::ServerNotPinned { address } if address == "play.example.cn:25566"),
            "{err:?}"
        );
        assert_eq!(err.to_string(), "服务器「play.example.cn:25566」没有固定");

        let err = petalfall
            .set_pinned_server_instance("play.example.cn", Some("../x".to_owned()))
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::Instance(InstanceError::InvalidId { .. })
        ));
        let err = petalfall
            .set_pinned_server_instance("bad:0", None)
            .unwrap_err();
        assert!(matches!(err, CoreError::InvalidServerAddress { .. }));
        assert_eq!(petalfall.pinned_servers()[0].instance, None);
    }

    #[test]
    fn pinned_instance_follows_rename_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = test_petalfall(dir.path());
        petalfall
            .set_pinned_servers(vec![
                bound("一", "a.example", Some("生存")),
                bound("二", "b.example", Some("生存")),
                bound("三", "c.example", Some("生存服")),
                bound("四", "d.example", None),
            ])
            .unwrap();
        let ids = |petalfall: &Petalfall| -> Vec<Option<String>> {
            petalfall
                .pinned_servers()
                .iter()
                .map(|s| s.instance.clone())
                .collect()
        };

        assert!(petalfall.rename_pinned_instance("生存", "生存 2"));
        // 只认精确相等：「生存服」不因前缀相同被改。
        assert_eq!(
            ids(&petalfall),
            vec![
                Some("生存 2".to_owned()),
                Some("生存 2".to_owned()),
                Some("生存服".to_owned()),
                None
            ]
        );
        assert!(!petalfall.rename_pinned_instance("生存", "别的"));

        assert!(petalfall.forget_pinned_instance("生存 2"));
        assert_eq!(
            ids(&petalfall),
            vec![None, None, Some("生存服".to_owned()), None]
        );
        assert!(!petalfall.forget_pinned_instance("生存 2"));
    }

    #[tokio::test]
    async fn known_servers_merge_lists_and_mark_pinned() {
        let dir = tempfile::tempdir().unwrap();
        let game_dir = dir.path().join(".minecraft");
        std::fs::create_dir_all(game_dir.join("versions").join("modpack")).unwrap();
        std::fs::write(
            game_dir.join(SERVERS_DAT),
            nbt::tests::servers_dat(&[("Hypixel", "mc.hypixel.net"), ("家", "10.0.0.2")]),
        )
        .unwrap();
        std::fs::write(
            game_dir.join("versions").join("modpack").join(SERVERS_DAT),
            nbt::tests::servers_dat(&[
                ("同一台", "MC.HYPIXEL.NET:25565"),
                ("整合包服", "pack.example:25570"),
            ]),
        )
        .unwrap();
        // 坏文件只跳过自己。
        std::fs::create_dir_all(game_dir.join("versions").join("broken")).unwrap();
        std::fs::write(
            game_dir.join("versions").join("broken").join(SERVERS_DAT),
            b"not nbt",
        )
        .unwrap();
        let config = PetalfallConfig {
            pinned_servers: vec![PinnedServer {
                name: "整合包服".to_owned(),
                address: "pack.example:25570".to_owned(),
                instance: None,
            }],
            ..PetalfallConfig::default()
        };
        let petalfall = Petalfall::for_test(config, dir.path().to_path_buf(), game_dir);

        let known = petalfall.known_servers().await.unwrap();
        let summary: Vec<(&str, &str, bool)> = known
            .iter()
            .map(|k| (k.name.as_str(), k.address.as_str(), k.pinned))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("Hypixel", "mc.hypixel.net", false),
                ("家", "10.0.0.2", false),
                ("整合包服", "pack.example:25570", true),
            ]
        );
    }

    async fn local_server(status: serde_json::Value, connections: Arc<AtomicUsize>) -> String {
        let addr = slp::tests::fake_server(status, true, connections).await;
        format!("127.0.0.1:{}", addr.port())
    }

    #[tokio::test]
    async fn ping_all_reports_both_description_forms_in_input_order() {
        let connections = Arc::new(AtomicUsize::new(0));
        let plain = local_server(
            json!({"players": {"online": 1, "max": 10}, "description": "§aPlain MOTD"}),
            connections.clone(),
        )
        .await;
        let component = local_server(
            json!({"version": {"name": "1.21.4"}, "description": {"text": "Comp", "extra": [{"text": "onent"}]}}),
            connections.clone(),
        )
        .await;
        let dir = tempfile::tempdir().unwrap();
        let monitor = ServerMonitor::new(dir.path());

        let statuses = monitor
            .ping_all(&[component.clone(), plain.clone()])
            .await
            .unwrap();
        assert_eq!(statuses[0].address, component);
        assert!(statuses[0].reachable);
        assert_eq!(statuses[0].motd.as_deref(), Some("Component"));
        assert_eq!(statuses[0].version_name.as_deref(), Some("1.21.4"));
        assert_eq!(statuses[1].motd.as_deref(), Some("Plain MOTD"));
        assert_eq!(statuses[1].online, Some(1));
        assert_eq!(statuses[1].max, Some(10));
        assert_eq!(statuses[1].last_seen_at, Some(statuses[1].checked_at));
        assert!(statuses[1].latency_ms.is_some());
    }

    #[tokio::test]
    async fn timeout_is_unreachable_and_keeps_last_seen() {
        let connections = Arc::new(AtomicUsize::new(0));
        let dir = tempfile::tempdir().unwrap();
        let up = local_server(
            json!({"players": {"online": 12000, "max": 20000}, "description": "up"}),
            connections,
        )
        .await;
        let monitor =
            ServerMonitor::new(dir.path()).with_timing(Duration::from_millis(300), Duration::ZERO);
        let first = monitor.ping_all(std::slice::from_ref(&up)).await.unwrap();
        assert!(first[0].reachable);

        // 同一地址换成不应答的监听者：模拟服务器挂起。用一个新的监听端口，再把历史记录挪过去。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let silent = format!("127.0.0.1:{}", listener.local_addr().unwrap().port());
        let silent_for = Duration::from_secs(30);
        tokio::spawn(async move {
            let held = listener.accept().await;
            tokio::time::sleep(silent_for).await;
            drop(held);
        });
        {
            let mut state = monitor.state.lock().await;
            let history = state.history(&monitor.history_path).await;
            let record = history[&parse_server_address(&up).unwrap().key()];
            history.insert(parse_server_address(&silent).unwrap().key(), record);
        }
        let started = Instant::now();
        let second = monitor
            .ping_all(std::slice::from_ref(&silent))
            .await
            .unwrap();
        assert!(started.elapsed() < silent_for, "应按时限放弃，不等对方挂断");
        let status = &second[0];
        assert!(!status.reachable);
        assert_eq!(status.latency_ms, None);
        assert_eq!(status.online, None);
        assert_eq!(status.last_seen_at, first[0].last_seen_at);
        assert_eq!(status.last_online, Some(12000));
        assert!(
            status
                .error
                .as_deref()
                .is_some_and(|e| e.contains("300 ms"))
        );

        // 连通记录落了盘，新的查询器也读得到。
        let reopened = ServerMonitor::new(dir.path());
        let mut state = reopened.state.lock().await;
        let history = state.history(&reopened.history_path).await;
        assert_eq!(
            history[&parse_server_address(&up).unwrap().key()].online,
            Some(12000)
        );
    }

    #[tokio::test]
    async fn refused_connection_is_unreachable_without_history() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let dir = tempfile::tempdir().unwrap();
        let monitor = ServerMonitor::new(dir.path());
        let statuses = monitor
            .ping_all(&[format!("127.0.0.1:{port}")])
            .await
            .unwrap();
        assert!(!statuses[0].reachable);
        assert_eq!(statuses[0].last_seen_at, None);
        assert_eq!(statuses[0].last_online, None);
    }

    #[tokio::test]
    async fn results_are_cached_within_ttl() {
        let connections = Arc::new(AtomicUsize::new(0));
        let server = local_server(json!({"description": "cached"}), connections.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let monitor = ServerMonitor::new(dir.path());

        monitor
            .ping_all(std::slice::from_ref(&server))
            .await
            .unwrap();
        let again = monitor
            .ping_all(std::slice::from_ref(&server))
            .await
            .unwrap();
        assert_eq!(connections.load(Ordering::SeqCst), 1, "60 秒内不应再连一次");
        assert_eq!(again[0].motd.as_deref(), Some("cached"));

        let expired = ServerMonitor::new(dir.path()).with_timing(PING_TIMEOUT, Duration::ZERO);
        expired
            .ping_all(std::slice::from_ref(&server))
            .await
            .unwrap();
        expired
            .ping_all(std::slice::from_ref(&server))
            .await
            .unwrap();
        assert_eq!(
            connections.load(Ordering::SeqCst),
            3,
            "缓存过期后每次都重新查询"
        );
    }

    #[tokio::test]
    async fn invalid_address_rejects_whole_batch() {
        let dir = tempfile::tempdir().unwrap();
        let monitor = ServerMonitor::new(dir.path());
        let err = monitor
            .ping_all(&["ok.example".to_owned(), "bad:0".to_owned()])
            .await
            .unwrap_err();
        assert!(
            matches!(err, CoreError::InvalidServerAddress { ref address, .. } if address == "bad:0")
        );
    }
}
