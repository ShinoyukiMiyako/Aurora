//! 实例移动的日志：一次移动从开工到收尾走到了哪一步，落在 `<数据目录>/moves/<token>.json`。
//!
//! 进程在提交前后任何一刻没了，收尾代码都跑不到；下次启动按这份日志与两边的盘面判断该回滚还是补完。
//! 日志在盘上，可能被改坏或改过：读的时候核对 id、token 与两个中间目录是不是按约定推出来的那几个，
//! 对不上一律当读不懂，收尾绝不按日志里的路径去删别处的东西。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use petalfall_instance::{PETALFALL_META_DIR, is_safe_instance_id};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::folders::same_path;

/// 数据目录下放移动日志的目录。
const MOVES_DIR: &str = "moves";
/// 日志文件的扩展名；`atomic_write` 的临时文件以 `.tmp` 结尾，不会被当成日志。
const JOURNAL_EXT: &str = "json";
/// 读不懂的日志改名加上这个后缀留着，不删：里面可能有人工收尾要用的路径。
const BROKEN_SUFFIX: &str = ".broken";
/// 跨卷移动在两边游戏目录里放中间产物的目录 `<游戏目录>/.petalfall/moving`。
const MOVING_DIR: &str = "moving";

/// 同一毫秒内开工的两次移动靠它区分 token。
static TOKEN_SEQ: AtomicU64 = AtomicU64::new(0);

/// 移动走到了哪一步。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MoveStage {
    /// 补依赖、复制、校验中：原件没动过。
    Copying,
    /// 开始提交：实例目录可能已经改名到旧目录或目标，要看盘面才知道。
    Committing,
    /// 实例已经在目标里，游玩记录与备份还没迁完。
    Committed,
    /// 记录都迁完了，只剩删旧目录与暂存。
    Settled,
}

/// 一份移动日志。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct MoveJournal {
    pub token: String,
    pub id: String,
    pub source_game_dir: PathBuf,
    pub target_game_dir: PathBuf,
    pub same_volume: bool,
    pub stage: MoveStage,
    /// 跨卷时目标盘上的暂存 `<目标>/.petalfall/moving/<token>`；同卷不复制，为 `None`。
    pub staging_dir: Option<PathBuf>,
    /// 跨卷时原件提交中改名到的旧目录 `<源>/.petalfall/moving/<token>`；同卷直接改名到目标，为 `None`。
    pub old_dir: Option<PathBuf>,
    /// 跨卷时实例名下的备份复制进了暂存（复制时它有备份）。收尾据此决定并不并备份、删不删原游戏目录里的那份：
    /// 没复制过就一概不碰，原目录里那时没有它的备份，后来有的也不是它的。
    #[serde(default)]
    pub backups_staged: bool,
    /// 补依赖前记进目标依赖版本记录的基底版本。提交前失败或回滚时，收回其中目录没落下的那些。
    #[serde(default)]
    pub bases: Vec<String>,
    /// 开工时刻，Unix 毫秒。
    pub started_at: u64,
}

impl MoveJournal {
    /// 新开一份日志，stage 为 [`MoveStage::Copying`]。
    pub(crate) fn new(
        token: String,
        id: &str,
        source_game_dir: &Path,
        target_game_dir: &Path,
        same_volume: bool,
        started_at: u64,
    ) -> Self {
        let (staging_dir, old_dir) = if same_volume {
            (None, None)
        } else {
            (
                Some(moving_dir(target_game_dir, &token)),
                Some(moving_dir(source_game_dir, &token)),
            )
        };
        Self {
            token,
            id: id.to_owned(),
            source_game_dir: source_game_dir.to_path_buf(),
            target_game_dir: target_game_dir.to_path_buf(),
            same_volume,
            stage: MoveStage::Copying,
            staging_dir,
            old_dir,
            backups_staged: false,
            bases: Vec::new(),
            started_at,
        }
    }

    /// 是不是还会动到 `id` 在 `game_dir` 里的东西：没走到 [`MoveStage::Settled`] 的日志收尾时要回滚原件或迁记录，
    /// 这期间不能再移它。`game_dir` 是源或目标都算：从目标再移走，收尾时记录就迁错了地方。
    pub(crate) fn holds(&self, id: &str, game_dir: &Path) -> bool {
        self.stage != MoveStage::Settled
            && self.id.to_lowercase() == id.to_lowercase()
            && (same_path(&self.source_game_dir, game_dir)
                || same_path(&self.target_game_dir, game_dir))
    }

    /// 核对从盘上读来的日志：id 能拼进路径，token 是文件名，两个中间目录正是按约定推出来的。
    fn check(&self, file_stem: &str) -> std::result::Result<(), String> {
        if !is_safe_token(&self.token) || self.token != file_stem {
            return Err(format!("token {:?} 与文件名对不上", self.token));
        }
        if !is_safe_instance_id(&self.id) {
            return Err(format!("实例 id {:?} 不合法", self.id));
        }
        if !self.source_game_dir.is_absolute() || !self.target_game_dir.is_absolute() {
            return Err("游戏目录不是绝对路径".to_owned());
        }
        let expected = Self::new(
            self.token.clone(),
            &self.id,
            &self.source_game_dir,
            &self.target_game_dir,
            self.same_volume,
            self.started_at,
        );
        if self.staging_dir != expected.staging_dir || self.old_dir != expected.old_dir {
            return Err("暂存或旧目录不是按约定推出来的".to_owned());
        }
        Ok(())
    }
}

/// 读日志目录的一项。
#[derive(Debug)]
pub(crate) enum JournalEntry {
    Read(MoveJournal),
    /// 读得到、读不懂（或核对不过）的日志。
    Unreadable {
        path: PathBuf,
        reason: String,
    },
}

/// `<游戏目录>/.petalfall/moving/<token>`。
pub(crate) fn moving_dir(game_dir: &Path, token: &str) -> PathBuf {
    game_dir
        .join(PETALFALL_META_DIR)
        .join(MOVING_DIR)
        .join(token)
}

/// 新的 token：毫秒时间戳加进程内计数。时间戳在前，按文件名排序大致就是开工先后。
pub(crate) fn new_token() -> Result<String> {
    let millis = now_millis()?;
    let seq = TOKEN_SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(format!("{millis}-{seq}"))
}

/// 现在的 Unix 毫秒。
pub(crate) fn now_millis() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(CoreError::SystemClock)?
        .as_millis() as u64)
}

fn moves_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(MOVES_DIR)
}

fn journal_path(data_dir: &Path, token: &str) -> PathBuf {
    moves_dir(data_dir).join(format!("{token}.{JOURNAL_EXT}"))
}

fn is_safe_token(token: &str) -> bool {
    !token.is_empty() && token.chars().all(|c| c.is_ascii_digit() || c == '-')
}

/// 整份原子写一份日志，按需建目录。写进盘才返回：调用方据此决定下一步能不能动原件。
pub(crate) async fn write(data_dir: &Path, journal: &MoveJournal) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(journal).map_err(CoreError::JsonSerialize)?;
    petalfall_base::fs::atomic_write(journal_path(data_dir, &journal.token), &bytes).await?;
    Ok(())
}

/// 删掉一份日志；已经不在算成功。
pub(crate) async fn remove(data_dir: &Path, token: &str) -> Result<()> {
    let path = journal_path(data_dir, token);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(petalfall_base::Error::Io { path, source }.into()),
    }
}

/// 日志目录下全部日志，按文件名（大致是开工先后）排序；目录不在为空。读不懂的单列出来，不报错：一份坏日志
/// 不该挡住别的日志的收尾。读目录与读文件本身出错照实报错。
pub(crate) async fn list(data_dir: &Path) -> Result<Vec<JournalEntry>> {
    let dir = moves_dir(data_dir);
    let io = |path: &Path, source| petalfall_base::Error::Io {
        path: path.to_path_buf(),
        source,
    };
    let mut read = match tokio::fs::read_dir(&dir).await {
        Ok(read) => read,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => return Err(io(&dir, source).into()),
    };
    let mut paths = Vec::new();
    while let Some(entry) = read.next_entry().await.map_err(|source| io(&dir, source))? {
        let path = entry.path();
        let is_journal = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case(JOURNAL_EXT));
        if is_journal
            && entry
                .file_type()
                .await
                .map_err(|source| io(&path, source))?
                .is_file()
        {
            paths.push(path);
        }
    }
    paths.sort();
    let mut entries = Vec::with_capacity(paths.len());
    for path in paths {
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|source| io(&path, source))?;
        let stem = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        let parsed = serde_json::from_slice::<MoveJournal>(&bytes)
            .map_err(|err| err.to_string())
            .and_then(|journal| journal.check(&stem).map(|()| journal));
        entries.push(match parsed {
            Ok(journal) => JournalEntry::Read(journal),
            Err(reason) => JournalEntry::Unreadable { path, reason },
        });
    }
    Ok(entries)
}

/// 有没有还会动到 `id` 在 `game_dir` 里的东西的日志（见 [`MoveJournal::holds`]）。读不懂的日志不算：
/// 它说的是哪个实例无从知道，启动收尾也只能把它改名留着，算进来就永远移不了任何实例。
pub(crate) async fn is_held(data_dir: &Path, id: &str, game_dir: &Path) -> Result<bool> {
    Ok(list(data_dir).await?.iter().any(|entry| match entry {
        JournalEntry::Read(journal) => journal.holds(id, game_dir),
        JournalEntry::Unreadable { path, reason } => {
            tracing::debug!(path = %path.display(), reason, "移动日志读不懂，预检不算它");
            false
        }
    }))
}

/// 把读不懂的日志改名成 `<原名>.broken` 留着。
pub(crate) async fn quarantine(path: &Path) -> Result<PathBuf> {
    let mut name = path.as_os_str().to_owned();
    name.push(BROKEN_SUFFIX);
    let broken = PathBuf::from(name);
    tokio::fs::rename(path, &broken)
        .await
        .map_err(|source| petalfall_base::Error::Io {
            path: path.to_path_buf(),
            source,
        })?;
    Ok(broken)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal(root: &Path, same_volume: bool) -> MoveJournal {
        MoveJournal::new(
            new_token().unwrap(),
            "Pack",
            &root.join("a"),
            &root.join("b"),
            same_volume,
            1_700_000_000_000,
        )
    }

    #[test]
    fn tokens_are_unique_within_one_millisecond() {
        let tokens: Vec<String> = (0..200).map(|_| new_token().unwrap()).collect();
        let mut unique = tokens.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), tokens.len());
        assert!(tokens.iter().all(|token| is_safe_token(token)));
    }

    #[test]
    fn cross_volume_journal_derives_both_moving_dirs_and_same_volume_has_none() {
        let root = Path::new(r"C:\games");
        let cross = journal(root, false);
        assert_eq!(
            cross.staging_dir,
            Some(
                root.join("b")
                    .join(".petalfall")
                    .join("moving")
                    .join(&cross.token)
            )
        );
        assert_eq!(
            cross.old_dir,
            Some(
                root.join("a")
                    .join(".petalfall")
                    .join("moving")
                    .join(&cross.token)
            )
        );
        let same = journal(root, true);
        assert_eq!((same.staging_dir, same.old_dir), (None, None));
    }

    #[tokio::test]
    async fn written_journals_list_back_in_order_and_remove_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let first = journal(tmp.path(), false);
        let mut second = journal(tmp.path(), true);
        second.stage = MoveStage::Committing;
        write(&data, &second).await.unwrap();
        write(&data, &first).await.unwrap();

        let listed: Vec<MoveJournal> = list(&data)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| match entry {
                JournalEntry::Read(journal) => journal,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(listed, vec![first.clone(), second.clone()]);

        remove(&data, &first.token).await.unwrap();
        remove(&data, &first.token).await.unwrap();
        assert_eq!(list(&data).await.unwrap().len(), 1);
        assert!(list(&tmp.path().join("nowhere")).await.unwrap().is_empty());
    }

    /// 改过的日志不能把收尾指到别处：暂存不是按约定推出来的、id 带路径分隔、token 与文件名不符都算读不懂。
    #[tokio::test]
    async fn tampered_journals_are_unreadable_and_quarantine_keeps_them() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let mut redirected = journal(tmp.path(), false);
        redirected.staging_dir = Some(tmp.path().join("precious"));
        write(&data, &redirected).await.unwrap();
        let mut escaping = journal(tmp.path(), true);
        escaping.id = r"..\..\Windows".to_owned();
        write(&data, &escaping).await.unwrap();
        let renamed = journal(tmp.path(), true);
        let bytes = serde_json::to_vec(&renamed).unwrap();
        std::fs::write(moves_dir(&data).join("1-0.json"), bytes).unwrap();
        std::fs::write(moves_dir(&data).join("2-0.json"), b"{ not json").unwrap();

        let entries = list(&data).await.unwrap();
        assert_eq!(entries.len(), 4);
        let mut unreadable = Vec::new();
        for entry in entries {
            match entry {
                JournalEntry::Unreadable { path, .. } => unreadable.push(path),
                JournalEntry::Read(journal) => panic!("{journal:?}"),
            }
        }
        for path in &unreadable {
            let broken = quarantine(path).await.unwrap();
            assert!(broken.to_string_lossy().ends_with(".json.broken"));
            assert!(broken.is_file());
        }
        assert!(list(&data).await.unwrap().is_empty());
        assert!(!is_held(&data, "Pack", &tmp.path().join("a")).await.unwrap());
    }

    #[tokio::test]
    async fn unsettled_journal_holds_the_instance_in_both_directories_case_insensitively() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let mut pending = journal(tmp.path(), false);
        write(&data, &pending).await.unwrap();
        let source = tmp.path().join("a");
        let target = tmp.path().join("b");
        assert!(is_held(&data, "pack", &source).await.unwrap());
        assert!(is_held(&data, "PACK", &target).await.unwrap());
        assert!(!is_held(&data, "Other", &source).await.unwrap());
        assert!(!is_held(&data, "Pack", &tmp.path().join("c")).await.unwrap());

        // 只剩清理的日志不再动实例与记录。
        pending.stage = MoveStage::Settled;
        write(&data, &pending).await.unwrap();
        assert!(!is_held(&data, "Pack", &source).await.unwrap());
    }
}
