//! 实例移动的日志：一次移动从开工到收尾走到了哪一步，落在 `<数据目录>/moves/<token>.json`。
//!
//! 进程在提交前后任何一刻没了，收尾代码都跑不到；下次启动按这份日志与两边的盘面判断该回滚还是补完。
//! 日志在盘上，可能被改坏或改过：读的时候核对 id、token、要带的基底版本与两个中间目录是不是按约定推出来的那几个，
//! 对不上一律当读不懂，收尾绝不按日志里的路径去删别处的东西。
//!
//! 执行收尾之后日志不删：调用方把配置改好、落了盘再确认（[`MoveJournal::config_done`]），确认了、残留也清完了才删。
//! 进程在这中间退出时，启动收尾凭它再交出一次结果，让调用方把配置补上。

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
/// 移动在两边游戏目录里放中间产物的目录 `<游戏目录>/.petalfall/moving`。
const MOVING_DIR: &str = "moving";
/// 暂存与旧目录里放实例目录与备份目录的位置。
const INSTANCE_PART: &str = "instance";
const BACKUPS_PART: &str = "backups";

/// 同一毫秒内开工的两次移动靠它区分 token。
static TOKEN_SEQ: AtomicU64 = AtomicU64::new(0);

/// 移动走到了哪一步。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MoveStage {
    /// 补依赖、复制、校验中：原件与原备份都没动过。
    Copying,
    /// 开始提交：原件与原备份可能已经改名进旧目录，实例可能已经到了目标，要看盘面才知道。
    Committing,
    /// 实例已经在目标里；备份、游玩记录或目标的依赖版本记录还没收拾完。
    Committed,
    /// 备份与记录都收拾完了（原游戏目录里有了同名的新实例时游玩记录不迁，也算完），只剩删旧目录与暂存。
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
    /// 跨卷时目标盘上的暂存 `<目标>/.petalfall/moving/<token>`：`instance/` 是实例副本，`backups/` 是备份副本。
    /// 同卷不复制，为 `None`。
    pub staging_dir: Option<PathBuf>,
    /// 原游戏目录里按 token 收东西的旧目录 `<源>/.petalfall/moving/<token>`：提交时原备份改名进 `backups/`，跨卷
    /// 时原件改名进 `instance/`。提交之后只按这个路径处理它们，不再按实例 id 去动原游戏目录：那时原目录里可能已经
    /// 有了同名的新实例和它的备份。
    pub old_dir: PathBuf,
    /// 跨卷时实例名下的备份复制进了暂存（复制时它有备份）。提交时原备份在不在必须与它一致。
    #[serde(default)]
    pub backups_staged: bool,
    /// 补依赖前记进目标依赖版本记录的基底版本（移动前目标里没有）。回滚时删掉其中没复制完的目录、收回记录。
    #[serde(default)]
    pub bases: Vec<String>,
    /// 游玩记录已经并进目标那本账。
    #[serde(default)]
    pub records_moved: bool,
    /// 调用方已经把配置改好、落了盘，确认过了。
    #[serde(default)]
    pub config_done: bool,
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
        let staging_dir = (!same_volume).then(|| moving_dir(target_game_dir, &token));
        Self {
            old_dir: moving_dir(source_game_dir, &token),
            token,
            id: id.to_owned(),
            source_game_dir: source_game_dir.to_path_buf(),
            target_game_dir: target_game_dir.to_path_buf(),
            same_volume,
            stage: MoveStage::Copying,
            staging_dir,
            backups_staged: false,
            bases: Vec::new(),
            records_moved: false,
            config_done: false,
            started_at,
        }
    }

    /// 跨卷提交时原件改名到的位置。
    pub(crate) fn old_instance(&self) -> PathBuf {
        self.old_dir.join(INSTANCE_PART)
    }

    /// 提交时原备份改名到的位置。
    pub(crate) fn old_backups(&self) -> PathBuf {
        self.old_dir.join(BACKUPS_PART)
    }

    /// 跨卷时暂存里的实例副本。
    pub(crate) fn staged_instance(&self) -> Option<PathBuf> {
        self.staging_dir.as_ref().map(|dir| dir.join(INSTANCE_PART))
    }

    /// 跨卷时暂存里的备份副本。
    pub(crate) fn staged_backups(&self) -> Option<PathBuf> {
        self.staging_dir.as_ref().map(|dir| dir.join(BACKUPS_PART))
    }

    /// 是不是还没彻底完成、又与这次移动沾边：没收拾完（没到 [`MoveStage::Settled`]）收尾时要回滚原件或迁记录，没
    /// 确认的收尾时要再交给调用方改配置，这期间都不能再移同名（不分大小写）的实例。它的源或目标与这次的源或目标
    /// 是同一目录都算：从目标再移走，收尾时记录就迁错了地方；再移进它的源，收尾时会把新来的当成原目录里的同名新实例。
    pub(crate) fn holds(&self, id: &str, source: &Path, target: &Path) -> bool {
        let unfinished = self.stage != MoveStage::Settled || !self.config_done;
        unfinished
            && self.id.to_lowercase() == id.to_lowercase()
            && [&self.source_game_dir, &self.target_game_dir]
                .into_iter()
                .any(|dir| same_path(dir, source) || same_path(dir, target))
    }

    /// 核对从盘上读来的日志：id 与基底版本能拼进路径，token 是文件名，两个中间目录正是按约定推出来的。
    fn check(&self, file_stem: &str) -> std::result::Result<(), String> {
        if !is_safe_token(&self.token) || self.token != file_stem {
            return Err(format!("token {:?} 与文件名对不上", self.token));
        }
        if !is_safe_instance_id(&self.id) {
            return Err(format!("实例 id {:?} 不合法", self.id));
        }
        if let Some(base) = self.bases.iter().find(|base| !is_safe_instance_id(base)) {
            return Err(format!("基底版本 {base:?} 不合法"));
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

/// 按 token 读一份日志；不在为 `None`。token 来自调用方，不是日志编号的样子（比如带路径分隔符）报错，不拿它拼路径；
/// 读不懂或核对不过照实报错。
pub(crate) async fn read(data_dir: &Path, token: &str) -> Result<Option<MoveJournal>> {
    if !is_safe_token(token) {
        return Err(petalfall_base::Error::Io {
            path: moves_dir(data_dir),
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{token:?} 不是移动日志的编号"),
            ),
        }
        .into());
    }
    let path = journal_path(data_dir, token);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(petalfall_base::Error::Io { path, source }.into()),
    };
    let journal: MoveJournal = match serde_json::from_slice(&bytes) {
        Ok(journal) => journal,
        Err(source) => return Err(CoreError::JsonFileInvalid { path, source }),
    };
    if let Err(reason) = journal.check(token) {
        return Err(petalfall_base::Error::Io {
            path,
            source: std::io::Error::new(std::io::ErrorKind::InvalidData, reason),
        }
        .into());
    }
    Ok(Some(journal))
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

/// 有没有拦着这次移动的日志（见 [`MoveJournal::holds`]）。读不懂的日志不算：它说的是哪个实例无从知道，启动收尾
/// 也只能把它改名留着，算进来就永远移不了任何实例。
pub(crate) async fn is_held(
    data_dir: &Path,
    id: &str,
    source: &Path,
    target: &Path,
) -> Result<bool> {
    Ok(list(data_dir).await?.iter().any(|entry| match entry {
        JournalEntry::Read(journal) => journal.holds(id, source, target),
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

    /// 跨卷两边都有按 token 命名的目录；同卷只有原游戏目录里收原备份的旧目录。
    #[test]
    fn journals_derive_the_token_directories_on_both_sides() {
        let root = Path::new(r"C:\games");
        let cross = journal(root, false);
        let moving = |side: &str, token: &str| {
            root.join(side)
                .join(".petalfall")
                .join("moving")
                .join(token)
        };
        let staging = moving("b", &cross.token);
        let old = moving("a", &cross.token);
        assert_eq!(cross.staging_dir, Some(staging.clone()));
        assert_eq!(cross.old_dir, old);
        assert_eq!(cross.staged_instance(), Some(staging.join("instance")));
        assert_eq!(cross.staged_backups(), Some(staging.join("backups")));
        assert_eq!(cross.old_instance(), old.join("instance"));
        assert_eq!(cross.old_backups(), old.join("backups"));

        let same = journal(root, true);
        assert_eq!(same.staging_dir, None);
        assert_eq!(
            (same.staged_instance(), same.staged_backups()),
            (None, None)
        );
        assert_eq!(same.old_backups(), moving("a", &same.token).join("backups"));
    }

    #[tokio::test]
    async fn written_journals_list_back_in_order_and_remove_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let first = journal(tmp.path(), false);
        let mut second = journal(tmp.path(), true);
        second.stage = MoveStage::Committing;
        second.records_moved = true;
        second.config_done = true;
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
        assert_eq!(
            read(&data, &second.token).await.unwrap(),
            Some(second.clone())
        );

        remove(&data, &first.token).await.unwrap();
        remove(&data, &first.token).await.unwrap();
        assert_eq!(list(&data).await.unwrap().len(), 1);
        assert_eq!(read(&data, &first.token).await.unwrap(), None);
        assert!(list(&tmp.path().join("nowhere")).await.unwrap().is_empty());
    }

    /// 确认时 token 来自调用方：不是编号的样子就不拿它拼路径；改过的日志照实报错，不当成不在。
    #[tokio::test]
    async fn read_refuses_tokens_that_are_not_journal_numbers_and_tampered_journals() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        // 拿 `..\evil` 拼路径的话读到的就是这份。
        std::fs::create_dir_all(&data).unwrap();
        let decoy = journal(tmp.path(), true);
        std::fs::write(data.join("evil.json"), serde_json::to_vec(&decoy).unwrap()).unwrap();
        for token in [r"..\evil", "../evil", "", "1-0.json", "a-1"] {
            let err = read(&data, token).await.unwrap_err();
            assert!(
                matches!(&err, CoreError::Base(petalfall_base::Error::Io { source, .. })
                    if source.kind() == std::io::ErrorKind::InvalidInput),
                "{token:?}: {err:?}"
            );
        }

        let mut redirected = journal(tmp.path(), false);
        redirected.old_dir = tmp.path().join("precious");
        write(&data, &redirected).await.unwrap();
        let err = read(&data, &redirected.token).await.unwrap_err();
        assert!(
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { source, .. })
                if source.kind() == std::io::ErrorKind::InvalidData),
            "{err:?}"
        );
        std::fs::write(journal_path(&data, "5-5"), b"{ not json").unwrap();
        assert!(matches!(
            read(&data, "5-5").await.unwrap_err(),
            CoreError::JsonFileInvalid { .. }
        ));
    }

    /// 上一版写的日志没有游玩记录与确认两个字段：读成「没迁、没确认」，收尾会补做并再交给调用方。
    #[tokio::test]
    async fn journals_without_the_newer_fields_read_as_not_done() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let mut older = journal(tmp.path(), false);
        older.stage = MoveStage::Committed;
        let mut value = serde_json::to_value(&older).unwrap();
        let fields = value.as_object_mut().unwrap();
        fields.remove("records_moved").unwrap();
        fields.remove("config_done").unwrap();
        std::fs::create_dir_all(moves_dir(&data)).unwrap();
        std::fs::write(
            journal_path(&data, &older.token),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();

        let read_back = read(&data, &older.token).await.unwrap().unwrap();
        assert!(!read_back.records_moved && !read_back.config_done);
        assert_eq!(read_back, older);
    }

    /// 改过的日志不能把收尾指到别处：暂存或旧目录不是按约定推出来的、id 或基底版本带路径分隔、token 与文件名不符
    /// 都算读不懂。
    #[tokio::test]
    async fn tampered_journals_are_unreadable_and_quarantine_keeps_them() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let mut redirected = journal(tmp.path(), false);
        redirected.staging_dir = Some(tmp.path().join("precious"));
        write(&data, &redirected).await.unwrap();
        let mut old_elsewhere = journal(tmp.path(), true);
        old_elsewhere.old_dir = tmp.path().join("a");
        write(&data, &old_elsewhere).await.unwrap();
        let mut escaping = journal(tmp.path(), true);
        escaping.id = r"..\..\Windows".to_owned();
        write(&data, &escaping).await.unwrap();
        let mut escaping_base = journal(tmp.path(), true);
        escaping_base.bases = vec!["1.21.1".to_owned(), r"..\..\Windows".to_owned()];
        write(&data, &escaping_base).await.unwrap();
        let renamed = journal(tmp.path(), true);
        let bytes = serde_json::to_vec(&renamed).unwrap();
        std::fs::write(moves_dir(&data).join("1-0.json"), bytes).unwrap();
        std::fs::write(moves_dir(&data).join("2-0.json"), b"{ not json").unwrap();

        let entries = list(&data).await.unwrap();
        assert_eq!(entries.len(), 6);
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
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        assert!(!is_held(&data, "Pack", &a, &b).await.unwrap());
    }

    /// 没彻底完成的日志（没收拾完，或没确认）拦着同名（不分大小写）实例的移动，只要它的源或目标与这次的源或目标
    /// 沾边；收拾完又确认过的不再拦。
    #[tokio::test]
    async fn an_unfinished_journal_holds_moves_touching_either_of_its_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path().join("data");
        let mut pending = journal(tmp.path(), false);
        write(&data, &pending).await.unwrap();
        let dir = |name: &str| tmp.path().join(name);
        let (a, b, c, d) = (dir("a"), dir("b"), dir("c"), dir("d"));
        // 从它的源或目标移出，或者移进它的源或目标。
        assert!(is_held(&data, "pack", &a, &c).await.unwrap());
        assert!(is_held(&data, "PACK", &b, &c).await.unwrap());
        assert!(is_held(&data, "Pack", &c, &a).await.unwrap());
        assert!(is_held(&data, "Pack", &c, &b).await.unwrap());
        let alias = PathBuf::from(format!("{}/", b.display().to_string().to_uppercase()));
        assert!(is_held(&data, "Pack", &c, &alias).await.unwrap());
        assert!(!is_held(&data, "Other", &a, &b).await.unwrap());
        assert!(!is_held(&data, "Pack", &c, &d).await.unwrap());

        // 收拾完了、调用方还没确认：收尾还要再交给调用方改配置。
        pending.stage = MoveStage::Settled;
        write(&data, &pending).await.unwrap();
        assert!(is_held(&data, "Pack", &a, &c).await.unwrap());
        // 确认了、还没收拾完（游玩记录没迁上）。
        pending.stage = MoveStage::Committed;
        pending.config_done = true;
        write(&data, &pending).await.unwrap();
        assert!(is_held(&data, "Pack", &c, &b).await.unwrap());
        // 收拾完又确认过的只剩删残留，不再拦。
        pending.stage = MoveStage::Settled;
        write(&data, &pending).await.unwrap();
        assert!(!is_held(&data, "Pack", &a, &b).await.unwrap());
    }
}
