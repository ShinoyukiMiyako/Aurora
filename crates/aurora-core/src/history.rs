//! 变更历史与回滚凭据。
//!
//! 每次安装 / 更新 / 移除 / 回滚都往 `versions/<id>/<元数据目录>/history.json` 追加一条事件，既有条目
//! 永不改写——历史一旦可被改写就不再是证据，玩家「昨天还好好的，今天进不去了」时便无从复盘。
//!
//! 更新事件同时是回滚的凭据：旧 jar 被改名为 `<file>.old`（同名备份已经有了时为 `<file>.<序号>.old`）
//! 留在原目录，事件里记下新旧文件名、备份名与新旧版本，回滚就是把这对名字换回去。一个 Mod 连着
//! 更新几次就留下一条链，只能从最近的那次往回滚。因此「这条能不能回滚」不由历史自身决定，而由 `.old` 文件是否
//! 还躺在磁盘上决定（见 [`RollbackCheck`]）——与卷宗同理，磁盘始终是权威。备份要占盘，代价必须
//! 显式告诉玩家而不是偷偷长在他硬盘里（见 [`Aurora::backup_size`]）。
//!
//! 事件 id 形如 `<unix秒>-<三位序号>`：秒级时间戳保证跨事件可排序，序号解决同一秒内多条事件的
//! 撞号问题。不用随机数——随机 id 无法复现、排不了序，出问题时对着日志也拼不回时间线。
//!
//! 历史与卷宗都是「读全量 - 改 - 整体原子写」，所有写入都在该实例 mods 目录的写锁下进行
//! （见 [`crate::modfs::lock_mods_dir`]），并发的两次变更不会互相覆盖对方追加的事件。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use aurora_instance::{AURORA_META_DIR, VERSIONS_DIR};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::facade::Aurora;
use crate::modfs::{
    BACKUP_SUFFIX, backup_name, ensure_not_held, lock_mods_dir, now_unix, refuse, try_exists,
};
use aurora_modplatform::DISABLED_SUFFIX;

/// 历史文件名。
const HISTORY_FILE: &str = "history.json";

/// 一次变更事件。追加式，永不改写既有条目。
///
/// 可选字段都是给人看的补充（工程标题、版本号），早期记录或来路不明的文件可能缺失；回滚只依赖
/// 必填的文件名与版本标识。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HistoryEvent {
    /// 安装：`files` 为本次新落盘的全部文件名（含被一并带入的依赖）。
    Install {
        id: String,
        at: i64,
        files: Vec<String>,
    },
    /// 更新：`old_file` 已改名为备份（见 `backup_file`）保留在原目录。
    Update {
        id: String,
        at: i64,
        file_name: String,
        old_file: String,
        /// 旧文件实际改成的备份名。同一个文件名先后被更新不止一次时（原地更新、名字来回换），后来的
        /// 备份不能盖掉先前那份，名字里会带序号，所以要记下来。早期记录没有这一项，备份名就是
        /// `<old_file>.old`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        backup_file: Option<String>,
        /// 旧文件的平台版本标识；旧文件查无来源时为「未知」。
        from_version: String,
        to_version: String,
        /// 工程标题。
        #[serde(default)]
        title: Option<String>,
        /// 旧版本号（给人看）。
        #[serde(default)]
        from_version_number: Option<String>,
        /// 新版本号（给人看）。
        #[serde(default)]
        to_version_number: Option<String>,
    },
    /// 回滚：`reverted_event` 指向被撤销的那条更新事件的 id。
    Rollback {
        id: String,
        at: i64,
        reverted_event: String,
    },
    /// 移除：`files` 为本次从磁盘删掉的文件名（磁盘上的原名，禁用态带 `.disabled`）。
    Remove {
        id: String,
        at: i64,
        files: Vec<String>,
    },
}

impl HistoryEvent {
    /// 事件 id。
    pub fn id(&self) -> &str {
        match self {
            HistoryEvent::Install { id, .. }
            | HistoryEvent::Update { id, .. }
            | HistoryEvent::Rollback { id, .. }
            | HistoryEvent::Remove { id, .. } => id,
        }
    }

    /// 事件发生时刻（unix 秒）。
    pub fn at(&self) -> i64 {
        match self {
            HistoryEvent::Install { at, .. }
            | HistoryEvent::Update { at, .. }
            | HistoryEvent::Rollback { at, .. }
            | HistoryEvent::Remove { at, .. } => *at,
        }
    }
}

/// 一个实例的全部变更事件，按追加顺序排列（即时间正序）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    /// 变更事件，最早的在前。
    pub events: Vec<HistoryEvent>,
}

impl History {
    /// 为时刻 `at` 生成一个在本历史内唯一且可排序的事件 id：`<unix秒>-<三位序号>`。
    ///
    /// 序号取同秒已有事件的最大序号加一。零填充到三位是为了让字典序与时间序一致——不填充时同一秒
    /// 内的第 10 条会排到第 2 条前面，按 id 排序的历史视图随即错乱。同秒超过 999 条时序号自然溢出到
    /// 四位，此时唯一性仍成立、排序退化，但一秒内产生上千条变更本身已不是正常场景。
    pub fn next_event_id(&self, at: i64) -> String {
        let prefix = format!("{at}-");
        let seq = self
            .events
            .iter()
            .filter_map(|event| event.id().strip_prefix(&prefix))
            // 只有形如 `<秒>-<数字>` 的 id 才携带序号信息；其它形状（外部工具写入、手工编辑）不参与
            // 取最大值，但也不会因此被判成错误——它们只是不占用序号空间。
            .filter_map(|tail| tail.parse::<u32>().ok())
            .max()
            .map_or(1, |max| max + 1);
        format!("{at}-{seq:03}")
    }
}

/// 历史文件的读写句柄。
#[derive(Debug, Clone)]
pub struct HistoryStore {
    path: PathBuf,
}

impl HistoryStore {
    /// 默认路径：`version_dir/<元数据目录>/history.json`（`version_dir` 即 `versions/<id>`）。
    pub fn for_version_dir(version_dir: &Path) -> Self {
        Self {
            path: version_dir.join(AURORA_META_DIR).join(HISTORY_FILE),
        }
    }

    /// 指定历史文件路径（测试注入）。
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 历史文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取历史；文件缺失返回空历史；存在但损坏则冒泡，不静默重置。
    pub async fn load(&self) -> Result<History> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|source| CoreError::ConfigParse {
                path: self.path.clone(),
                source,
            }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(History::default()),
            Err(source) => Err(aurora_base::Error::Io {
                path: self.path.clone(),
                source,
            }
            .into()),
        }
    }

    /// 追加一条事件并原子落盘，事件 id 由 `make` 依据当前历史现取。
    ///
    /// 实现是「读全量 - 追加 - 整体原子写」：历史文件是几十条量级的小文件，用整体重写换取「要么完整
    /// 要么原样」的崩溃安全，比按行追加更划算。id 在同一次读取上生成，同秒的连续追加各自避开前一条。
    /// 调用方必须持有该实例 mods 目录的写锁，否则并发追加会互相覆盖。
    pub async fn append_with(
        &self,
        at: i64,
        make: impl FnOnce(String) -> HistoryEvent,
    ) -> Result<()> {
        let mut history = self.load().await?;
        let id = history.next_event_id(at);
        history.events.push(make(id));
        self.save(&history).await
    }

    /// 追加一条 id 已定的事件（导入、测试构造历史）。调用方同样必须持有写锁。
    pub async fn append(&self, event: HistoryEvent) -> Result<()> {
        let mut history = self.load().await?;
        history.events.push(event);
        self.save(&history).await
    }

    /// 原子写入整份历史。
    async fn save(&self, history: &History) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(history).map_err(CoreError::ConfigSerialize)?;
        aurora_base::fs::atomic_write(&self.path, &bytes).await?;
        Ok(())
    }
}

/// 一条事件能否回滚，以及不能的原因。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RollbackCheck {
    /// 被判定的事件 id。
    pub event_id: String,
    /// 是否可回滚。
    pub can_rollback: bool,
    /// 不可回滚时的中文原因；可回滚为 `None`。
    pub reason: Option<String>,
}

/// 收集已被回滚撤销过的事件 id。
///
/// 回滚过的更新不能再滚一次：备份此时已改回原名，重复回滚等于把「当前正在用的文件」当新文件删掉。
fn reverted_event_ids(history: &History) -> HashSet<&str> {
    history
        .events
        .iter()
        .filter_map(|event| match event {
            HistoryEvent::Rollback { reverted_event, .. } => Some(reverted_event.as_str()),
            _ => None,
        })
        .collect()
}

/// 一条更新事件留下的备份文件名。
fn update_backup(old_file: &str, backup_file: Option<&str>) -> String {
    backup_file.map_or_else(|| backup_name(old_file), str::to_owned)
}

/// 收集被之后的更新盖过的更新事件 id。
///
/// 更新 E 装上的文件之后又被更新 L 换掉（L 的旧文件就是 E 的新文件）、且 L 还没回滚时，E 装上的文件
/// 已经变成了 L 的备份。这时回滚 E 会删一个早已不在的文件、再把 E 的备份复原出来，mods 里就同时有
/// L 装上的新版和 E 之前的旧版，游戏按重复 Mod 报错。只能先回滚 L，E 的状态回到眼前才轮得到它。
fn superseded_update_ids<'a>(history: &'a History, reverted: &HashSet<&str>) -> HashSet<&'a str> {
    let live_updates: Vec<(usize, &str, &str)> = history
        .events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| match event {
            HistoryEvent::Update {
                id,
                file_name,
                old_file,
                ..
            } if !reverted.contains(id.as_str()) => {
                Some((index, file_name.as_str(), old_file.as_str()))
            }
            _ => None,
        })
        .collect();
    live_updates
        .iter()
        .filter(|(index, file_name, _)| {
            live_updates
                .iter()
                .any(|(later, _, old_file)| later > index && old_file == file_name)
        })
        .map(|(index, _, _)| history.events[*index].id())
        .collect()
}

/// 列出 mods 目录这一层全部 `.old` 备份的文件名与字节数。
///
/// 回滚判定与备份占用共用这一次列目录：逐条事件去 stat 就是把一次列目录拆成事件数那么多次系统调用。
/// 目录还没建返回空表（这个实例一个 Mod 都没装过）；其余 IO 故障如实冒泡。不递归：备份只可能由
/// 更新链路写在这一层，递归大实例是拿卡顿换零收益。同后缀的目录不是备份，不计入。
async fn list_backups(mods_dir: &Path) -> Result<Vec<(String, u64)>> {
    let io_err = |source| aurora_base::Error::Io {
        path: mods_dir.to_owned(),
        source,
    };
    let mut reader = match tokio::fs::read_dir(mods_dir).await {
        Ok(reader) => reader,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(io_err(source).into()),
    };

    let mut backups = Vec::new();
    while let Some(entry) = reader.next_entry().await.map_err(io_err)? {
        // 非 UTF-8 文件名不可能是本启动器写出来的备份。
        let raw = entry.file_name();
        let Some(name) = raw.to_str() else { continue };
        if !name.ends_with(BACKUP_SUFFIX) {
            continue;
        }
        let meta = entry
            .metadata()
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: entry.path(),
                source,
            })?;
        if meta.is_file() {
            backups.push((name.to_owned(), meta.len()));
        }
    }
    Ok(backups)
}

/// 删掉更新时装上的那个文件，启用态与禁用态两种名字都试。
///
/// 两种名字都不在时不报错：玩家自己删掉新文件是合法操作，而回滚要的结果本就是「新文件不在、旧文件
/// 回来」，此时前半段已经成立。
async fn remove_updated_file(mods_dir: &Path, file_name: &str) -> Result<()> {
    for candidate in [
        mods_dir.join(file_name),
        mods_dir.join(format!("{file_name}{DISABLED_SUFFIX}")),
    ] {
        match tokio::fs::remove_file(&candidate).await {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(aurora_base::Error::Io {
                    path: candidate,
                    source,
                }
                .into());
            }
        }
    }
    Ok(())
}

impl Aurora {
    /// 该实例的历史句柄：`versions/<id>/<元数据目录>/history.json`。
    ///
    /// 与 [`Aurora::ledger_store`] 同一套路径推导——只认版本 id，不随隔离档位漂移。历史记的是「这个
    /// 版本被改过什么」，若跟着工作目录走，关掉隔离后多个版本会共写一份历史，时间线立刻串味。
    pub fn history_store(&self, version_id: &str) -> HistoryStore {
        HistoryStore::for_version_dir(&self.game_dir().join(VERSIONS_DIR).join(version_id))
    }

    /// 读取该实例的全部变更事件（时间正序）。历史文件缺失即空历史，损坏则冒泡；版本未安装报
    /// [`CoreError::VersionNotInstalled`]。
    pub async fn history(&self, version_id: &str) -> Result<History> {
        self.resolve_instance(version_id).await?;
        self.history_store(version_id).load().await
    }

    /// 逐条判断历史事件能否回滚，顺序与 [`Aurora::history`] 一致（时间正序），便于 UI 按下标对齐。
    ///
    /// 判据落在磁盘而不是历史本身：`.old` 备份还在才谈得上回滚，玩家清理过备份就不能——与卷宗同理，
    /// 磁盘是权威。只有更新事件带备份，其余三类事件一律给出不可回滚的具体原因，而不是含糊地留空。
    pub async fn rollback_checks(&self, version_id: &str) -> Result<Vec<RollbackCheck>> {
        let dirs = self.resolved_dirs(version_id).await?;
        let history = self.history_store(version_id).load().await?;
        let backups: HashSet<String> = list_backups(&dirs.mods_dir)
            .await?
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        let reverted = reverted_event_ids(&history);
        let superseded = superseded_update_ids(&history, &reverted);

        Ok(history
            .events
            .iter()
            .map(|event| {
                let (can_rollback, reason) = match event {
                    HistoryEvent::Update {
                        id,
                        file_name,
                        old_file,
                        backup_file,
                        ..
                    } => {
                        let backup = update_backup(old_file, backup_file.as_deref());
                        if reverted.contains(id.as_str()) {
                            (false, Some("该更新已经回滚过".to_owned()))
                        } else if superseded.contains(id.as_str()) {
                            (
                                false,
                                Some(format!("{file_name} 之后又更新过，先回滚之后的那次更新")),
                            )
                        } else if backups.contains(&backup) {
                            (true, None)
                        } else {
                            (false, Some(format!("备份文件 {backup} 已不在 mods 目录里")))
                        }
                    }
                    HistoryEvent::Install { .. } => (
                        false,
                        Some("安装事件不支持回滚，直接移除对应文件".to_owned()),
                    ),
                    HistoryEvent::Remove { .. } => (
                        false,
                        Some("移除事件不支持回滚，文件已从磁盘删除".to_owned()),
                    ),
                    HistoryEvent::Rollback { .. } => {
                        (false, Some("回滚事件本身不可再回滚".to_owned()))
                    }
                };
                RollbackCheck {
                    event_id: event.id().to_owned(),
                    can_rollback,
                    reason,
                }
            })
            .collect())
    }

    /// 回滚一次更新：把 `<old_file>.old` 改回原名、删掉更新装上的新文件，再追加一条回滚事件。启用状态跟着
    /// Mod 走，新文件此刻是停用的，旧文件也恢复成停用的。
    ///
    /// 全部前置检查（事件存在、是更新事件、没回滚过、没被之后的更新盖过、备份还在、目标名没被占、
    /// 文件没被游戏占用）通过后才动第一次盘。半个回滚比不回滚更糟——玩家会拿到一个既不是旧版也不是新版的 mods 目录，
    /// 且没人知道它缺了什么。
    pub async fn rollback(&self, version_id: &str, event_id: &str) -> Result<()> {
        let dirs = self.resolved_dirs(version_id).await?;
        let mods_dir = &dirs.mods_dir;
        let _guard = lock_mods_dir(mods_dir).await;

        let store = self.history_store(version_id);
        let history = store.load().await?;
        let event = history
            .events
            .iter()
            .find(|event| event.id() == event_id)
            .ok_or_else(|| {
                refuse(
                    store.path(),
                    std::io::ErrorKind::NotFound,
                    format!("历史中不存在事件 {event_id}，无法回滚"),
                )
            })?;
        let HistoryEvent::Update {
            file_name,
            old_file,
            backup_file,
            from_version,
            from_version_number,
            ..
        } = event
        else {
            return Err(refuse(
                store.path(),
                std::io::ErrorKind::InvalidInput,
                format!("事件 {event_id} 不是更新事件，只有更新事件留有 .old 备份可回滚"),
            ));
        };
        let reverted = reverted_event_ids(&history);
        if reverted.contains(event_id) {
            return Err(refuse(
                store.path(),
                std::io::ErrorKind::AlreadyExists,
                format!("事件 {event_id} 已经回滚过，不能重复回滚"),
            ));
        }
        if superseded_update_ids(&history, &reverted).contains(event_id) {
            return Err(refuse(
                store.path(),
                std::io::ErrorKind::InvalidInput,
                format!("事件 {event_id} 装上的 {file_name} 之后又更新过，先回滚之后的那次更新"),
            ));
        }

        let backup_file = update_backup(old_file, backup_file.as_deref());
        let backup = mods_dir.join(&backup_file);
        if !try_exists(&backup).await? {
            return Err(refuse(
                &backup,
                std::io::ErrorKind::NotFound,
                format!("回滚事件 {event_id} 需要备份文件 {backup_file}，它已不在 mods 目录里"),
            ));
        }
        let disabled = !try_exists(&mods_dir.join(file_name)).await?
            && try_exists(&mods_dir.join(format!("{file_name}{DISABLED_SUFFIX}"))).await?;
        let restored_name = if disabled {
            format!("{old_file}{DISABLED_SUFFIX}")
        } else {
            old_file.clone()
        };
        let restored = mods_dir.join(&restored_name);
        // 原地更新（新旧同名）时目标就是待删的新文件，删完自然腾空，不算被占用；只有改名更新才需要
        // 提防「目标名上另有其人」——直接 rename 会把它悄无声息地覆盖掉。
        if old_file != file_name && try_exists(&restored).await? {
            return Err(refuse(
                &restored,
                std::io::ErrorKind::AlreadyExists,
                format!("回滚目标 {restored_name} 已存在于 mods 目录，拒绝覆盖它"),
            ));
        }
        ensure_not_held(vec![
            mods_dir.join(file_name),
            mods_dir.join(format!("{file_name}{DISABLED_SUFFIX}")),
            backup.clone(),
        ])
        .await?;

        remove_updated_file(mods_dir, file_name).await?;
        tokio::fs::rename(&backup, &restored)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: restored.clone(),
                source,
            })?;

        self.restore_ledger_identity(
            version_id,
            file_name,
            old_file,
            from_version,
            from_version_number.clone(),
            &restored,
        )
        .await?;

        let at = now_unix();
        store
            .append_with(at, |id| HistoryEvent::Rollback {
                id,
                at,
                reverted_event: event_id.to_owned(),
            })
            .await
    }

    /// 该实例 mods 目录下全部 `.old` 备份占用的字节数。
    pub async fn backup_size(&self, version_id: &str) -> Result<u64> {
        let dirs = self.resolved_dirs(version_id).await?;
        Ok(list_backups(&dirs.mods_dir)
            .await?
            .into_iter()
            .map(|(_, size)| size)
            .sum())
    }

    /// 回滚落盘后，把卷宗里那条记录改回旧版本的身份。
    ///
    /// 不改回去的话，更新检查下一轮拿着新版本号去比对，立刻又报「有更新」——玩家刚回滚完就被推着
    /// 滚回去，形成死循环。
    async fn restore_ledger_identity(
        &self,
        version_id: &str,
        file_name: &str,
        old_file: &str,
        from_version: &str,
        from_version_number: Option<String>,
        restored: &Path,
    ) -> Result<()> {
        let store = self.ledger_store(version_id);
        let mut ledger = store.load().await?;
        // 卷宗里没有这条：该 Mod 是手动丢进来或别的启动器装的，没有工程身份可继承，也就无所谓更新提示
        // 循环。不凭空造一条假身份。
        let Some(mut entry) = ledger.remove(file_name) else {
            return Ok(());
        };
        entry.file_name = old_file.to_owned();
        entry.version_id = from_version.to_owned();
        entry.version_number = from_version_number;
        // 旧版本的 sha1 平台侧已无从取得，但文件本身就躺在磁盘上，算一遍是唯一诚实的取值；留 None
        // 会让后续的哈希反查白跑一趟。
        entry.sha1 = Some(aurora_base::fs::sha1_hex(restored).await?);
        // installed_at 沿用装进实例的时刻：回滚换回的是旧版本，不是新装了一个 Mod。
        // 走 upsert 而不是直接 push：万一卷宗里还留着旧文件名的残条，同名原位覆盖，不留重复键。
        ledger.upsert(entry);
        store.save(&ledger).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use crate::ledger::{Ledger, LedgerEntry};
    use aurora_instance::IsolationPolicy;
    use aurora_modplatform::Platform;
    use sha1::{Digest, Sha1};

    /// 测试实例的版本 id。
    const VERSION_ID: &str = "1.20.1-Fabric";
    /// 旧版 jar 的字节内容（长度与新版不同，便于断言复原的是哪一个）。
    const OLD_BYTES: &[u8] = b"sodium 0.5.3";
    /// 新版 jar 的字节内容。
    const NEW_BYTES: &[u8] = b"sodium 0.6.0 payload";

    fn install(id: &str, at: i64, files: &[&str]) -> HistoryEvent {
        HistoryEvent::Install {
            id: id.to_owned(),
            at,
            files: files.iter().map(|f| (*f).to_owned()).collect(),
        }
    }

    fn update_event(
        id: &str,
        at: i64,
        file_name: &str,
        old_file: &str,
        from_version: &str,
        to_version: &str,
    ) -> HistoryEvent {
        HistoryEvent::Update {
            id: id.to_owned(),
            at,
            file_name: file_name.to_owned(),
            old_file: old_file.to_owned(),
            backup_file: None,
            from_version: from_version.to_owned(),
            to_version: to_version.to_owned(),
            title: Some("Sodium".to_owned()),
            from_version_number: Some("0.5.3".to_owned()),
            to_version_number: Some("0.6.0".to_owned()),
        }
    }

    fn update(id: &str, at: i64) -> HistoryEvent {
        update_event(
            id,
            at,
            "sodium-0.6.0.jar",
            "sodium-0.5.3.jar",
            "IZskiJmZ",
            "QwErTyUi",
        )
    }

    #[test]
    fn event_accessors_read_every_variant() {
        assert_eq!(install("1-001", 1, &["a.jar"]).id(), "1-001");
        assert_eq!(install("1-001", 1, &["a.jar"]).at(), 1);
        assert_eq!(update("2-001", 2).id(), "2-001");
        assert_eq!(update("2-001", 2).at(), 2);

        let rollback = HistoryEvent::Rollback {
            id: "3-001".to_owned(),
            at: 3,
            reverted_event: "2-001".to_owned(),
        };
        assert_eq!(rollback.id(), "3-001");
        assert_eq!(rollback.at(), 3);

        let remove = HistoryEvent::Remove {
            id: "4-002".to_owned(),
            at: -4,
            files: vec!["b.jar".to_owned()],
        };
        assert_eq!(remove.id(), "4-002");
        assert_eq!(remove.at(), -4);
    }

    #[test]
    fn next_event_id_increments_within_same_second() {
        let mut history = History::default();
        let at = 1_754_612_345_i64;

        let first = history.next_event_id(at);
        assert_eq!(first, "1754612345-001");
        history.events.push(install(&first, at, &["a.jar"]));

        let second = history.next_event_id(at);
        assert_eq!(second, "1754612345-002");
        history.events.push(update(&second, at));

        // 换一秒重新从 001 起，不受上一秒的序号影响。
        assert_eq!(history.next_event_id(at + 1), "1754612346-001");
    }

    #[test]
    fn next_event_id_stays_unique_past_nine_and_sorts_lexicographically() {
        let mut history = History::default();
        let at = 1_000_000_000_i64;
        let mut ids = Vec::new();
        for _ in 0..12 {
            let id = history.next_event_id(at);
            history.events.push(install(&id, at, &["x.jar"]));
            ids.push(id);
        }

        assert_eq!(ids[0], "1000000000-001");
        assert_eq!(ids[9], "1000000000-010");
        assert_eq!(ids[11], "1000000000-012");
        let mut unique = ids.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), ids.len());
        // 零填充的意义：字典序必须等于生成顺序，第 10 条不能排到第 2 条前面。
        let mut lexical = ids.clone();
        lexical.sort();
        assert_eq!(lexical, ids);
    }

    #[test]
    fn next_event_id_ignores_foreign_id_shapes() {
        let mut history = History::default();
        let at = 42_i64;
        // 非本格式的 id 不占序号空间，也不该让生成过程报错。
        history.events.push(install("42-abc", at, &["a.jar"]));
        history.events.push(install("legacy", at, &["b.jar"]));
        assert_eq!(history.next_event_id(at), "42-001");

        history.events.push(install("42-007", at, &["c.jar"]));
        assert_eq!(history.next_event_id(at), "42-008");
        // 坏时钟给出的负秒同样能生成唯一 id，且不与正秒的序号空间相混。
        assert_eq!(history.next_event_id(-42), "-42-001");
    }

    #[test]
    fn event_serializes_with_ipc_shape() {
        let json = serde_json::to_value(update("9-001", 9)).unwrap();
        assert_eq!(json["kind"], "update");
        assert_eq!(json["id"], "9-001");
        assert_eq!(json["at"], 9);
        assert_eq!(json["file_name"], "sodium-0.6.0.jar");
        assert_eq!(json["old_file"], "sodium-0.5.3.jar");
        assert_eq!(json["from_version"], "IZskiJmZ");
        assert_eq!(json["to_version"], "QwErTyUi");
        assert_eq!(json["title"], "Sodium");
        assert_eq!(json["from_version_number"], "0.5.3");
        assert_eq!(json["to_version_number"], "0.6.0");
        // 没记备份名的（早期记录）不写这一项，读回来仍是 None。
        assert!(json.get("backup_file").is_none());

        // 回环：历史文件要能原样读回。
        let back: HistoryEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back, update("9-001", 9));

        let mut numbered = update("9-002", 9);
        if let HistoryEvent::Update { backup_file, .. } = &mut numbered {
            *backup_file = Some("sodium-0.5.3.jar.2.old".to_owned());
        }
        let json = serde_json::to_value(&numbered).unwrap();
        assert_eq!(json["backup_file"], "sodium-0.5.3.jar.2.old");
        assert_eq!(
            serde_json::from_value::<HistoryEvent>(json).unwrap(),
            numbered
        );

        let install_json = serde_json::to_value(install("8-001", 8, &["a.jar", "b.jar"])).unwrap();
        assert_eq!(install_json["kind"], "install");
        assert_eq!(install_json["files"][1], "b.jar");
    }

    #[test]
    fn update_event_without_optional_fields_still_parses() {
        // 早期记录没有标题与版本号：缺字段读成 None，而不是让整份历史读不出来。
        let raw = r#"{"kind":"update","id":"1-001","at":1,"file_name":"a-2.jar",
            "old_file":"a-1.jar","from_version":"V1","to_version":"V2"}"#;
        match serde_json::from_str::<HistoryEvent>(raw).unwrap() {
            HistoryEvent::Update {
                title,
                from_version_number,
                to_version_number,
                ..
            } => {
                assert_eq!(title, None);
                assert_eq!(from_version_number, None);
                assert_eq!(to_version_number, None);
            }
            other => panic!("期望更新事件，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn missing_file_loads_empty_history() {
        let tmp = tempfile::tempdir().unwrap();
        let store = HistoryStore::for_version_dir(tmp.path());
        assert_eq!(
            store.path(),
            tmp.path().join(AURORA_META_DIR).join("history.json")
        );
        assert_eq!(store.load().await.unwrap(), History::default());
    }

    #[tokio::test]
    async fn append_with_continues_the_same_second_and_preserves_order() {
        let tmp = tempfile::tempdir().unwrap();
        let store = HistoryStore::for_version_dir(tmp.path());
        let at = 1_700_000_000_i64;

        store
            .append_with(at, |id| install(&id, at, &["a.jar"]))
            .await
            .unwrap();
        store.append_with(at, |id| update(&id, at)).await.unwrap();
        store
            .append_with(at + 1, |id| HistoryEvent::Rollback {
                id,
                at: at + 1,
                reverted_event: "1700000000-002".to_owned(),
            })
            .await
            .unwrap();

        let history = store.load().await.unwrap();
        let ids: Vec<&str> = history.events.iter().map(HistoryEvent::id).collect();
        assert_eq!(
            ids,
            vec!["1700000000-001", "1700000000-002", "1700000001-001"]
        );
        // 既有条目不被改写：第一条仍是原封不动的安装事件。
        assert_eq!(history.events[0], install("1700000000-001", at, &["a.jar"]));
    }

    #[tokio::test]
    async fn corrupt_history_file_bubbles_instead_of_resetting() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("history.json");
        tokio::fs::write(&path, b"{\"events\": [{\"kind\":\"nope\"}]}")
            .await
            .unwrap();
        let store = HistoryStore::at(&path);

        match store.load().await.unwrap_err() {
            CoreError::ConfigParse { path: bad, .. } => assert_eq!(bad, path),
            other => panic!("期望解析错误，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn append_onto_corrupt_history_refuses_to_overwrite_it() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("history.json");
        tokio::fs::write(&path, b"not json at all").await.unwrap();
        let store = HistoryStore::at(&path);

        // 追加先读再写：损坏时必须整体失败，绝不能拿一份新历史覆盖掉原文件。
        assert!(matches!(
            store.append(install("1-001", 1, &["a.jar"])).await,
            Err(CoreError::ConfigParse { .. })
        ));
        assert_eq!(
            tokio::fs::read(&path).await.unwrap(),
            b"not json at all".to_vec()
        );
    }

    #[test]
    fn rollback_check_serializes_reason() {
        let blocked = RollbackCheck {
            event_id: "2-001".to_owned(),
            can_rollback: false,
            reason: Some("备份文件 sodium-0.5.3.jar.old 已不在 mods 目录里".to_owned()),
        };
        let json = serde_json::to_value(&blocked).unwrap();
        assert_eq!(json["event_id"], "2-001");
        assert_eq!(json["can_rollback"], false);
        assert_eq!(
            json["reason"],
            "备份文件 sodium-0.5.3.jar.old 已不在 mods 目录里"
        );

        let ok = RollbackCheck {
            event_id: "2-002".to_owned(),
            can_rollback: true,
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap()["reason"],
            serde_json::Value::Null
        );
    }

    // ---- impl Aurora：历史 / 回滚 / 备份占用 ----

    fn sha1_hex(bytes: &[u8]) -> String {
        Sha1::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// 造一个已安装的实例：落一份最小合法版本 JSON，全量隔离（mods 与元数据同处版本目录），
    /// 并建好 mods 目录。返回门面与 mods 目录路径。
    async fn installed_instance(root: &Path) -> (Aurora, PathBuf) {
        let dir = root.join("versions").join(VERSION_ID);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join(format!("{VERSION_ID}.json")),
            format!(r#"{{"id":"{VERSION_ID}","type":"release","mainClass":"m"}}"#),
        )
        .await
        .unwrap();

        let mut aurora = Aurora::for_test(
            AuroraConfig::default(),
            root.to_path_buf(),
            root.to_path_buf(),
        );
        aurora.set_isolation_policy(IsolationPolicy::All);
        let mods_dir = aurora.resolve_mods_dir(VERSION_ID).await.unwrap();
        assert_eq!(
            mods_dir,
            dir.join("mods"),
            "全量隔离时 mods 应落在版本目录内"
        );
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        (aurora, mods_dir)
    }

    /// 一条指向 Modrinth 工程 AANobbMI、且被标记为某工程依赖的卷宗记录。
    fn ledger_entry(file_name: &str, version_id: &str, sha1: &str) -> LedgerEntry {
        LedgerEntry {
            file_name: file_name.to_owned(),
            platform: Platform::Modrinth,
            project_id: "AANobbMI".to_owned(),
            version_id: version_id.to_owned(),
            version_number: Some("0.6.0".to_owned()),
            title: Some("Sodium".to_owned()),
            icon_url: Some("https://cdn.example.invalid/sodium.png".to_owned()),
            sha1: Some(sha1.to_owned()),
            installed_at: 1_700_000_000,
            installed_as_dependency_of: Some("P-OWNER".to_owned()),
            update_hold: None,
        }
    }

    /// 目录下的文件名快照（已排序），用来断言「磁盘一点没动」。
    async fn dir_names(dir: &Path) -> Vec<String> {
        let mut reader = tokio::fs::read_dir(dir).await.unwrap();
        let mut names = Vec::new();
        while let Some(entry) = reader.next_entry().await.unwrap() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort();
        names
    }

    /// 从「回滚被拒绝」的错误里取出出问题的路径与原因文本。
    fn refusal(err: &CoreError) -> (PathBuf, String) {
        match err {
            CoreError::Base(aurora_base::Error::Io { path, source }) => {
                (path.clone(), source.to_string())
            }
            other => panic!("期望回滚拒绝错误，得到 {other:?}"),
        }
    }

    /// 启用状态跟着 Mod 走：新文件此刻是停用的，回滚照样把它删掉，回来的旧文件也是停用的，sha1 照常按复原的
    /// 文件重算。
    #[tokio::test]
    async fn rollback_of_a_disabled_mod_keeps_it_disabled() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;
        for (event, at, new_file, old_file) in [
            ("200-001", 200, "sodium-0.6.0.jar", "sodium-0.5.3.jar"),
            // 原地更新：回滚目标与待删的新文件同名。
            ("300-001", 300, "sodium.jar", "sodium.jar"),
        ] {
            tokio::fs::write(mods_dir.join(format!("{new_file}.disabled")), NEW_BYTES)
                .await
                .unwrap();
            tokio::fs::write(mods_dir.join(format!("{old_file}.old")), OLD_BYTES)
                .await
                .unwrap();
            let ledger_store = aurora.ledger_store(VERSION_ID);
            let mut ledger = Ledger::default();
            ledger.upsert(ledger_entry(new_file, "NEW-VER", &sha1_hex(NEW_BYTES)));
            ledger_store.save(&ledger).await.unwrap();
            aurora
                .history_store(VERSION_ID)
                .append(update_event(
                    event, at, new_file, old_file, "OLD-VER", "NEW-VER",
                ))
                .await
                .unwrap();

            aurora.rollback(VERSION_ID, event).await.unwrap();

            assert_eq!(
                dir_names(&mods_dir).await,
                vec![format!("{old_file}.disabled")]
            );
            assert_eq!(
                tokio::fs::read(mods_dir.join(format!("{old_file}.disabled")))
                    .await
                    .unwrap(),
                OLD_BYTES
            );
            let ledger = ledger_store.load().await.unwrap();
            let entry = ledger.find(old_file).expect("旧文件应有卷宗条目");
            assert_eq!(entry.sha1.as_deref(), Some(sha1_hex(OLD_BYTES).as_str()));
            tokio::fs::remove_file(mods_dir.join(format!("{old_file}.disabled")))
                .await
                .unwrap();
        }
    }

    /// 改名更新回滚时，停用态的目标名被别的文件占着同样拒绝，不悄悄盖掉。
    #[tokio::test]
    async fn rollback_of_a_disabled_mod_refuses_to_overwrite_the_disabled_target() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;
        tokio::fs::write(mods_dir.join("sodium-0.6.0.jar.disabled"), NEW_BYTES)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("sodium-0.5.3.jar.old"), OLD_BYTES)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("sodium-0.5.3.jar.disabled"), b"someone else")
            .await
            .unwrap();
        aurora
            .history_store(VERSION_ID)
            .append(update_event(
                "200-001",
                200,
                "sodium-0.6.0.jar",
                "sodium-0.5.3.jar",
                "OLD-VER",
                "NEW-VER",
            ))
            .await
            .unwrap();

        let err = aurora.rollback(VERSION_ID, "200-001").await.unwrap_err();

        let (path, reason) = refusal(&err);
        assert_eq!(path, mods_dir.join("sodium-0.5.3.jar.disabled"));
        assert!(reason.contains("已存在"), "{reason}");
        assert_eq!(
            tokio::fs::read(mods_dir.join("sodium-0.5.3.jar.disabled"))
                .await
                .unwrap(),
            b"someone else"
        );
    }

    /// 正常回滚：旧文件按原名复原、新文件与备份消失、卷宗身份改回旧版本、历史多出一条回滚事件。
    #[tokio::test]
    async fn rollback_restores_old_file_and_rewrites_ledger_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;

        tokio::fs::write(mods_dir.join("sodium-0.6.0.jar"), NEW_BYTES)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("sodium-0.5.3.jar.old"), OLD_BYTES)
            .await
            .unwrap();

        let ledger_store = aurora.ledger_store(VERSION_ID);
        let mut ledger = Ledger::default();
        ledger.upsert(ledger_entry(
            "sodium-0.6.0.jar",
            "NEW-VER",
            &sha1_hex(NEW_BYTES),
        ));
        ledger_store.save(&ledger).await.unwrap();

        let store = aurora.history_store(VERSION_ID);
        store
            .append(install("100-001", 100, &["sodium-0.5.3.jar"]))
            .await
            .unwrap();
        store
            .append(update_event(
                "200-001",
                200,
                "sodium-0.6.0.jar",
                "sodium-0.5.3.jar",
                "OLD-VER",
                "NEW-VER",
            ))
            .await
            .unwrap();

        // 回滚前：备份占着旧 jar 那么多字节，且这条更新可回滚。
        assert_eq!(
            aurora.backup_size(VERSION_ID).await.unwrap(),
            OLD_BYTES.len() as u64
        );
        let before = aurora.rollback_checks(VERSION_ID).await.unwrap();
        assert!(before[1].can_rollback);
        assert_eq!(before[1].reason, None);

        aurora.rollback(VERSION_ID, "200-001").await.unwrap();

        // 磁盘：旧文件按原名回来（内容是旧的那份）、备份被消费、新文件删除。
        assert_eq!(
            tokio::fs::read(mods_dir.join("sodium-0.5.3.jar"))
                .await
                .unwrap(),
            OLD_BYTES
        );
        assert_eq!(dir_names(&mods_dir).await, vec!["sodium-0.5.3.jar"]);
        assert_eq!(aurora.backup_size(VERSION_ID).await.unwrap(), 0);

        // 卷宗：键换成旧文件名，版本标识与版本号回到旧版，sha1 按复原后的文件重算，
        // 工程身份、标题图标与「谁的依赖」原样保留。
        let ledger = ledger_store.load().await.unwrap();
        assert_eq!(ledger.entries.len(), 1);
        assert!(ledger.find("sodium-0.6.0.jar").is_none());
        let entry = ledger.find("sodium-0.5.3.jar").expect("旧文件应有卷宗条目");
        assert_eq!(entry.version_id, "OLD-VER");
        assert_eq!(entry.version_number.as_deref(), Some("0.5.3"));
        assert_eq!(entry.project_id, "AANobbMI");
        assert_eq!(entry.title.as_deref(), Some("Sodium"));
        assert_eq!(entry.sha1.as_deref(), Some(sha1_hex(OLD_BYTES).as_str()));
        assert_eq!(entry.installed_as_dependency_of.as_deref(), Some("P-OWNER"));
        // 装进实例的时刻沿用原值，不因回滚变成「现在」。
        assert_eq!(entry.installed_at, 1_700_000_000);

        // 历史：追加一条回滚事件，既有两条原样保留。
        let history = aurora.history(VERSION_ID).await.unwrap();
        assert_eq!(history.events.len(), 3);
        assert_eq!(history.events[0].id(), "100-001");
        assert_eq!(history.events[1].id(), "200-001");
        match &history.events[2] {
            HistoryEvent::Rollback { reverted_event, .. } => {
                assert_eq!(reverted_event, "200-001");
            }
            other => panic!("末条应为回滚事件，得到 {other:?}"),
        }

        // 同一条更新不能再滚一次。
        let after = aurora.rollback_checks(VERSION_ID).await.unwrap();
        assert_eq!(after.len(), 3);
        assert!(!after[1].can_rollback);
        assert_eq!(after[1].reason.as_deref(), Some("该更新已经回滚过"));
        let err = aurora.rollback(VERSION_ID, "200-001").await.unwrap_err();
        let (path, reason) = refusal(&err);
        assert_eq!(path, store.path());
        assert!(reason.contains("已经回滚过"), "原因实得 {reason}");
    }

    /// 缺 `.old` 备份：整体拒绝，且磁盘、卷宗、历史三处一个字节都不许动。
    #[tokio::test]
    async fn rollback_without_backup_refuses_and_leaves_everything_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;

        tokio::fs::write(mods_dir.join("sodium-0.6.0.jar"), NEW_BYTES)
            .await
            .unwrap();

        let ledger_store = aurora.ledger_store(VERSION_ID);
        let mut ledger = Ledger::default();
        ledger.upsert(ledger_entry(
            "sodium-0.6.0.jar",
            "NEW-VER",
            &sha1_hex(NEW_BYTES),
        ));
        ledger_store.save(&ledger).await.unwrap();
        let ledger_before = ledger_store.load().await.unwrap();

        aurora
            .history_store(VERSION_ID)
            .append(update_event(
                "200-001",
                200,
                "sodium-0.6.0.jar",
                "sodium-0.5.3.jar",
                "OLD-VER",
                "NEW-VER",
            ))
            .await
            .unwrap();

        let err = aurora.rollback(VERSION_ID, "200-001").await.unwrap_err();
        let (path, reason) = refusal(&err);
        assert_eq!(path, mods_dir.join("sodium-0.5.3.jar.old"));
        assert!(
            reason.contains("sodium-0.5.3.jar.old"),
            "拒绝原因要点名缺的是哪个备份，实得 {reason}"
        );

        assert_eq!(dir_names(&mods_dir).await, vec!["sodium-0.6.0.jar"]);
        assert_eq!(
            tokio::fs::read(mods_dir.join("sodium-0.6.0.jar"))
                .await
                .unwrap(),
            NEW_BYTES
        );
        assert_eq!(ledger_store.load().await.unwrap(), ledger_before);
        assert_eq!(aurora.history(VERSION_ID).await.unwrap().events.len(), 1);
        let checks = aurora.rollback_checks(VERSION_ID).await.unwrap();
        assert!(!checks[0].can_rollback);
        assert_eq!(
            checks[0].reason.as_deref(),
            Some("备份文件 sodium-0.5.3.jar.old 已不在 mods 目录里")
        );
    }

    /// 回滚不存在的事件 id、以及回滚非更新事件：都报错，且不碰磁盘上还在的备份。
    #[tokio::test]
    async fn rollback_rejects_unknown_and_non_update_events() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;

        tokio::fs::write(mods_dir.join("sodium-0.6.0.jar"), NEW_BYTES)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("sodium-0.5.3.jar.old"), OLD_BYTES)
            .await
            .unwrap();

        let store = aurora.history_store(VERSION_ID);
        store
            .append(install("100-001", 100, &["sodium-0.5.3.jar"]))
            .await
            .unwrap();
        store
            .append(update_event(
                "200-001",
                200,
                "sodium-0.6.0.jar",
                "sodium-0.5.3.jar",
                "OLD-VER",
                "NEW-VER",
            ))
            .await
            .unwrap();
        let disk_before = dir_names(&mods_dir).await;

        let err = aurora.rollback(VERSION_ID, "999-001").await.unwrap_err();
        let (path, reason) = refusal(&err);
        assert_eq!(path, store.path());
        assert!(
            reason.contains("999-001"),
            "原因要点名是哪个事件，实得 {reason}"
        );

        let err = aurora.rollback(VERSION_ID, "100-001").await.unwrap_err();
        let (_, reason) = refusal(&err);
        assert!(reason.contains("不是更新事件"), "原因实得 {reason}");

        assert_eq!(dir_names(&mods_dir).await, disk_before);
        assert_eq!(aurora.history(VERSION_ID).await.unwrap().events.len(), 2);
    }

    /// 连续两次更新后回滚：落到上一版而不是最初版；再滚一次才回到最初版。
    #[tokio::test]
    async fn rollback_walks_back_one_update_at_a_time() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;

        let v10 = b"lib 1.0".as_slice();
        let v11 = b"lib 1.1 body".as_slice();
        let v12 = b"lib 1.2 body longer".as_slice();
        tokio::fs::write(mods_dir.join("lib-1.2.jar"), v12)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("lib-1.1.jar.old"), v11)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("lib-1.0.jar.old"), v10)
            .await
            .unwrap();

        let ledger_store = aurora.ledger_store(VERSION_ID);
        let mut ledger = Ledger::default();
        ledger.upsert(ledger_entry("lib-1.2.jar", "V12", &sha1_hex(v12)));
        ledger_store.save(&ledger).await.unwrap();

        let store = aurora.history_store(VERSION_ID);
        store
            .append(install("100-001", 100, &["lib-1.0.jar"]))
            .await
            .unwrap();
        store
            .append(update_event(
                "200-001",
                200,
                "lib-1.1.jar",
                "lib-1.0.jar",
                "V10",
                "V11",
            ))
            .await
            .unwrap();
        store
            .append(update_event(
                "300-001",
                300,
                "lib-1.2.jar",
                "lib-1.1.jar",
                "V11",
                "V12",
            ))
            .await
            .unwrap();

        aurora.rollback(VERSION_ID, "300-001").await.unwrap();
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["lib-1.0.jar.old", "lib-1.1.jar"]
        );
        assert_eq!(
            tokio::fs::read(mods_dir.join("lib-1.1.jar")).await.unwrap(),
            v11
        );
        assert_eq!(
            ledger_store
                .load()
                .await
                .unwrap()
                .find("lib-1.1.jar")
                .unwrap()
                .version_id,
            "V11"
        );

        aurora.rollback(VERSION_ID, "200-001").await.unwrap();
        assert_eq!(dir_names(&mods_dir).await, vec!["lib-1.0.jar"]);
        let ledger = ledger_store.load().await.unwrap();
        assert_eq!(ledger.entries.len(), 1);
        assert_eq!(ledger.find("lib-1.0.jar").unwrap().version_id, "V10");
        assert_eq!(aurora.backup_size(VERSION_ID).await.unwrap(), 0);
        assert_eq!(aurora.history(VERSION_ID).await.unwrap().events.len(), 5);
    }

    /// 更新链里较早的那条在较晚的那条回滚之前不可回滚：检查给出原因，回滚被拒且一个文件都不动；
    /// 较晚的回滚之后它才放开。
    #[tokio::test]
    async fn earlier_update_in_a_chain_waits_for_the_later_one() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;
        tokio::fs::write(mods_dir.join("lib-1.2.jar"), b"v12")
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("lib-1.1.jar.old"), b"v11")
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("lib-1.0.jar.old"), b"v10")
            .await
            .unwrap();
        let store = aurora.history_store(VERSION_ID);
        for event in [
            install("100-001", 100, &["lib-1.0.jar"]),
            update_event("200-001", 200, "lib-1.1.jar", "lib-1.0.jar", "V10", "V11"),
            update_event("300-001", 300, "lib-1.2.jar", "lib-1.1.jar", "V11", "V12"),
        ] {
            store.append(event).await.unwrap();
        }

        let checks = aurora.rollback_checks(VERSION_ID).await.unwrap();
        assert!(!checks[1].can_rollback);
        assert_eq!(
            checks[1].reason.as_deref(),
            Some("lib-1.1.jar 之后又更新过，先回滚之后的那次更新")
        );
        assert!(checks[2].can_rollback);

        let disk_before = dir_names(&mods_dir).await;
        let err = aurora.rollback(VERSION_ID, "200-001").await.unwrap_err();
        let (path, reason) = refusal(&err);
        assert_eq!(path, store.path());
        assert!(
            reason.contains("先回滚之后的那次更新"),
            "原因实得 {reason}"
        );
        assert_eq!(dir_names(&mods_dir).await, disk_before);
        assert_eq!(aurora.history(VERSION_ID).await.unwrap().events.len(), 3);

        aurora.rollback(VERSION_ID, "300-001").await.unwrap();
        let checks = aurora.rollback_checks(VERSION_ID).await.unwrap();
        assert!(checks[1].can_rollback, "{:?}", checks[1].reason);
        assert!(!checks[2].can_rollback);
    }

    /// 同名原地更新做了两次：第二份备份带序号，回滚各自取自己记下的那份，一步步回到最初的内容。
    #[tokio::test]
    async fn rollback_uses_the_backup_name_recorded_in_the_event() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;
        let (v1, v2, v3) = (
            b"one".as_slice(),
            b"two-two".as_slice(),
            b"three-3-3".as_slice(),
        );
        tokio::fs::write(mods_dir.join("sodium.jar"), v3)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("sodium.jar.old"), v1)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("sodium.jar.2.old"), v2)
            .await
            .unwrap();
        let ledger_store = aurora.ledger_store(VERSION_ID);
        let mut ledger = Ledger::default();
        ledger.upsert(ledger_entry("sodium.jar", "V3", &sha1_hex(v3)));
        ledger_store.save(&ledger).await.unwrap();
        let store = aurora.history_store(VERSION_ID);
        store
            .append(update_event(
                "200-001",
                200,
                "sodium.jar",
                "sodium.jar",
                "V1",
                "V2",
            ))
            .await
            .unwrap();
        let mut second = update_event("300-001", 300, "sodium.jar", "sodium.jar", "V2", "V3");
        if let HistoryEvent::Update { backup_file, .. } = &mut second {
            *backup_file = Some("sodium.jar.2.old".to_owned());
        }
        store.append(second).await.unwrap();

        let checks = aurora.rollback_checks(VERSION_ID).await.unwrap();
        assert_eq!(
            checks.iter().map(|c| c.can_rollback).collect::<Vec<_>>(),
            vec![false, true]
        );

        aurora.rollback(VERSION_ID, "300-001").await.unwrap();
        assert_eq!(
            tokio::fs::read(mods_dir.join("sodium.jar")).await.unwrap(),
            v2
        );
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["sodium.jar", "sodium.jar.old"]
        );
        let entry = ledger_store.load().await.unwrap();
        let entry = entry.find("sodium.jar").unwrap();
        assert_eq!(entry.version_id, "V2");
        assert_eq!(entry.sha1.as_deref(), Some(sha1_hex(v2).as_str()));

        aurora.rollback(VERSION_ID, "200-001").await.unwrap();
        assert_eq!(
            tokio::fs::read(mods_dir.join("sodium.jar")).await.unwrap(),
            v1
        );
        assert_eq!(dir_names(&mods_dir).await, vec!["sodium.jar"]);
        assert_eq!(
            ledger_store
                .load()
                .await
                .unwrap()
                .find("sodium.jar")
                .unwrap()
                .version_id,
            "V1"
        );
    }

    /// 原地更新（新旧同名）：备份改回原名即可，「目标名被占」的护栏不能误伤这条正常路径。
    #[tokio::test]
    async fn in_place_update_with_identical_file_name_rolls_back() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;

        tokio::fs::write(mods_dir.join("sodium.jar"), NEW_BYTES)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("sodium.jar.old"), OLD_BYTES)
            .await
            .unwrap();

        let ledger_store = aurora.ledger_store(VERSION_ID);
        let mut ledger = Ledger::default();
        ledger.upsert(ledger_entry("sodium.jar", "NEW-VER", &sha1_hex(NEW_BYTES)));
        ledger_store.save(&ledger).await.unwrap();

        aurora
            .history_store(VERSION_ID)
            .append(update_event(
                "200-001",
                200,
                "sodium.jar",
                "sodium.jar",
                "OLD-VER",
                "NEW-VER",
            ))
            .await
            .unwrap();

        aurora.rollback(VERSION_ID, "200-001").await.unwrap();

        assert_eq!(dir_names(&mods_dir).await, vec!["sodium.jar"]);
        assert_eq!(
            tokio::fs::read(mods_dir.join("sodium.jar")).await.unwrap(),
            OLD_BYTES
        );
        let ledger = ledger_store.load().await.unwrap();
        assert_eq!(ledger.entries.len(), 1);
        assert_eq!(ledger.find("sodium.jar").unwrap().version_id, "OLD-VER");
    }

    /// 目标名已被别的文件占着：拒绝回滚，绝不静默覆盖玩家自己放进去的文件。
    #[tokio::test]
    async fn rollback_refuses_to_overwrite_a_file_sitting_on_the_old_name() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;

        tokio::fs::write(mods_dir.join("sodium-0.6.0.jar"), NEW_BYTES)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("sodium-0.5.3.jar.old"), OLD_BYTES)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("sodium-0.5.3.jar"), b"player's own copy")
            .await
            .unwrap();

        aurora
            .history_store(VERSION_ID)
            .append(update_event(
                "200-001",
                200,
                "sodium-0.6.0.jar",
                "sodium-0.5.3.jar",
                "OLD-VER",
                "NEW-VER",
            ))
            .await
            .unwrap();

        let err = aurora.rollback(VERSION_ID, "200-001").await.unwrap_err();
        let (path, reason) = refusal(&err);
        assert_eq!(path, mods_dir.join("sodium-0.5.3.jar"));
        assert!(reason.contains("拒绝覆盖"), "原因实得 {reason}");
        assert_eq!(
            tokio::fs::read(mods_dir.join("sodium-0.5.3.jar"))
                .await
                .unwrap(),
            b"player's own copy"
        );
        assert_eq!(
            dir_names(&mods_dir).await,
            vec![
                "sodium-0.5.3.jar",
                "sodium-0.5.3.jar.old",
                "sodium-0.6.0.jar"
            ]
        );
    }

    /// 新文件正被别的进程以「不许删除」的方式打开（游戏在跑）：回滚在动盘之前整体拒绝。
    #[cfg(windows)]
    #[tokio::test]
    async fn rollback_refuses_while_the_updated_file_is_held_open() {
        use std::os::windows::fs::OpenOptionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;
        tokio::fs::write(mods_dir.join("sodium-0.6.0.jar"), NEW_BYTES)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("sodium-0.5.3.jar.old"), OLD_BYTES)
            .await
            .unwrap();
        aurora
            .history_store(VERSION_ID)
            .append(update_event(
                "200-001",
                200,
                "sodium-0.6.0.jar",
                "sodium-0.5.3.jar",
                "OLD-VER",
                "NEW-VER",
            ))
            .await
            .unwrap();

        // 与 JVM 打开 jar 的方式一致：只放行读写共享，不放行删除共享。
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(mods_dir.join("sodium-0.6.0.jar"))
            .unwrap();

        let err = aurora.rollback(VERSION_ID, "200-001").await.unwrap_err();
        assert!(
            crate::modfs::is_mod_file_busy(&err),
            "占用应被识别为忙碌，实得 {err:?}"
        );
        assert_eq!(
            dir_names(&mods_dir).await,
            vec!["sodium-0.5.3.jar.old", "sodium-0.6.0.jar"]
        );
        assert_eq!(aurora.history(VERSION_ID).await.unwrap().events.len(), 1);

        drop(held);
        aurora.rollback(VERSION_ID, "200-001").await.unwrap();
        assert_eq!(dir_names(&mods_dir).await, vec!["sodium-0.5.3.jar"]);
    }

    /// 备份占用只统计 mods 目录本层的 `.old` 文件：非备份文件、同后缀目录、子目录里的备份都不计。
    #[tokio::test]
    async fn backup_size_sums_only_top_level_old_files() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;

        tokio::fs::write(mods_dir.join("a.jar.old"), vec![0u8; 10])
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("b.jar.old"), vec![0u8; 3])
            .await
            .unwrap();
        // 边界：零字节备份计入但不改变总数。
        tokio::fs::write(mods_dir.join("c.jar.old"), Vec::<u8>::new())
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("d.jar"), vec![0u8; 500])
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("e.old.jar"), vec![0u8; 700])
            .await
            .unwrap();
        tokio::fs::create_dir_all(mods_dir.join("nested.old"))
            .await
            .unwrap();
        tokio::fs::write(
            mods_dir.join("nested.old").join("f.jar.old"),
            vec![0u8; 900],
        )
        .await
        .unwrap();

        assert_eq!(aurora.backup_size(VERSION_ID).await.unwrap(), 13);

        // mods 目录还没建出来时是 0 字节，而不是报错。
        tokio::fs::remove_dir_all(&mods_dir).await.unwrap();
        assert_eq!(aurora.backup_size(VERSION_ID).await.unwrap(), 0);
    }

    /// 四类事件各自的可回滚判定，以及顺序与 history 一一对齐。
    #[tokio::test]
    async fn rollback_checks_classify_every_event_kind() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;
        tokio::fs::write(mods_dir.join("kept-1.0.jar.old"), OLD_BYTES)
            .await
            .unwrap();

        let store = aurora.history_store(VERSION_ID);
        for event in [
            install("100-001", 100, &["kept-1.0.jar"]),
            update_event("200-001", 200, "kept-1.1.jar", "kept-1.0.jar", "V10", "V11"),
            update_event("200-002", 200, "gone-2.0.jar", "gone-1.0.jar", "W10", "W20"),
            HistoryEvent::Remove {
                id: "300-001".to_owned(),
                at: 300,
                files: vec!["other.jar".to_owned()],
            },
            HistoryEvent::Rollback {
                id: "400-001".to_owned(),
                at: 400,
                reverted_event: "999-999".to_owned(),
            },
        ] {
            store.append(event).await.unwrap();
        }

        let checks = aurora.rollback_checks(VERSION_ID).await.unwrap();
        let history = aurora.history(VERSION_ID).await.unwrap();
        let check_ids: Vec<&str> = checks.iter().map(|c| c.event_id.as_str()).collect();
        let event_ids: Vec<&str> = history.events.iter().map(HistoryEvent::id).collect();
        assert_eq!(check_ids, event_ids, "检查结果必须与历史逐条对齐");

        assert_eq!(
            checks[0].reason.as_deref(),
            Some("安装事件不支持回滚，直接移除对应文件")
        );
        assert!(checks[1].can_rollback);
        assert_eq!(checks[1].reason, None);
        assert!(!checks[2].can_rollback);
        assert_eq!(
            checks[2].reason.as_deref(),
            Some("备份文件 gone-1.0.jar.old 已不在 mods 目录里")
        );
        assert_eq!(
            checks[3].reason.as_deref(),
            Some("移除事件不支持回滚，文件已从磁盘删除")
        );
        assert_eq!(checks[4].reason.as_deref(), Some("回滚事件本身不可再回滚"));
        assert_eq!(checks.iter().filter(|c| c.can_rollback).count(), 1);
    }

    /// 卷宗里没有这个文件（手动丢进来的 jar）：文件照样复原，但不凭空造一条假身份。
    #[tokio::test]
    async fn rollback_without_ledger_entry_still_restores_files() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, mods_dir) = installed_instance(tmp.path()).await;

        tokio::fs::write(mods_dir.join("manual-2.jar"), NEW_BYTES)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("manual-1.jar.old"), OLD_BYTES)
            .await
            .unwrap();
        aurora
            .history_store(VERSION_ID)
            .append(update_event(
                "200-001",
                200,
                "manual-2.jar",
                "manual-1.jar",
                "V1",
                "V2",
            ))
            .await
            .unwrap();

        aurora.rollback(VERSION_ID, "200-001").await.unwrap();

        assert_eq!(dir_names(&mods_dir).await, vec!["manual-1.jar"]);
        assert_eq!(
            aurora.ledger_store(VERSION_ID).load().await.unwrap(),
            Ledger::default()
        );
    }

    /// 历史文件缺失时 history 返回空，而不是报错——新实例还没被改过是正常态。
    #[tokio::test]
    async fn history_on_fresh_instance_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let (aurora, _) = installed_instance(tmp.path()).await;
        assert_eq!(
            aurora.history(VERSION_ID).await.unwrap(),
            History::default()
        );
        assert!(aurora.rollback_checks(VERSION_ID).await.unwrap().is_empty());
    }

    /// 历史句柄固定挂在版本目录下，与卷宗同处一处，不随隔离档位漂移。
    #[test]
    fn history_store_points_into_version_meta_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().join(".minecraft");
        let aurora = Aurora::for_test(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            mc.clone(),
        );
        assert_eq!(
            aurora.history_store("1.20.1-Forge_47.4.20").path(),
            mc.join("versions")
                .join("1.20.1-Forge_47.4.20")
                .join(AURORA_META_DIR)
                .join("history.json")
        );
    }

    /// 未安装的版本：历史、回滚与备份占用都在碰盘之前冒泡。
    #[tokio::test]
    async fn uninstalled_version_errors_before_touching_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = Aurora::for_test(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().to_path_buf(),
        );
        aurora.set_isolation_policy(IsolationPolicy::All);

        assert!(matches!(
            aurora.rollback("ghost", "1-001").await.unwrap_err(),
            CoreError::VersionNotInstalled { id } if id == "ghost"
        ));
        assert!(matches!(
            aurora.backup_size("ghost").await.unwrap_err(),
            CoreError::VersionNotInstalled { id } if id == "ghost"
        ));
        assert!(matches!(
            aurora.history("ghost").await.unwrap_err(),
            CoreError::VersionNotInstalled { id } if id == "ghost"
        ));
        // 带路径成分的 id 不能借历史读取逃出 versions 目录。
        assert!(matches!(
            aurora.history("../outside").await.unwrap_err(),
            CoreError::VersionNotInstalled { .. }
        ));
    }
}
