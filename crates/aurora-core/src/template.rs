//! 新实例的默认设置（模板）。
//!
//! 每建一个实例都要重新调一遍键位、视距，再把常去的服务器加一遍。数据目录里存一份
//! `templates/default/`，实例装好之后、第一次启动之前把里面的文件补进实例的工作目录。
//!
//! - 只补缺：实例里已经有的文件（整合包自带的 options.txt）原样不动，键位也不逐行合并——合出来的
//!   一份既不是作者调的也不是玩家调的，出了问题谁都对不上。
//! - 不隔离的实例与别的实例共用游戏目录根下的设置，往里补文件等于改了别的实例，所以跳过。
//! - 只认白名单里的文件：模板目录里手放的别的东西不会被带进实例。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::error::{CoreError, Result};
use crate::facade::Aurora;
use crate::instance_install::now_millis;

/// 白名单，按这个顺序列出、复制。前两个是原版写在游戏目录根下的设置与服务器列表，后两个是 OptiFine
/// 写在同一处的画质设置与光影设置。
pub const TEMPLATE_FILES: [&str; 4] = [
    "options.txt",
    "servers.dat",
    "optionsof.txt",
    "optionsshaders.txt",
];

/// 模板目录里的元数据文件；不在白名单里，所以永远不会被拷进实例。
pub(crate) const TEMPLATE_META_FILE: &str = "template.json";

const TEMPLATES_DIR: &str = "templates";
const DEFAULT_TEMPLATE: &str = "default";
/// 保存时的暂存目录与被换下的旧目录的名字前缀，后面跟 Unix 毫秒。点开头且不是 `default`，
/// 不会被当成模板读到。
const STAGING_PREFIX: &str = ".default-staging-";
const OLD_PREFIX: &str = ".default-old-";

/// 模板里的一个文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateFile {
    pub name: &'static str,
    pub size: u64,
}

/// 模板的现状。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateInfo {
    /// 模板目录里存在、而且是普通文件的白名单项，按 [`TEMPLATE_FILES`] 的顺序。
    pub files: Vec<TemplateFile>,
    /// 从哪个实例保存来的；文件是手放的、没有元数据时为 `None`。
    pub source_instance: Option<String>,
    /// 保存的时刻（Unix 毫秒）。
    pub saved_at: Option<u64>,
    /// 配置里是否开着「新建实例时沿用默认设置」。
    pub enabled: bool,
}

impl TemplateInfo {
    pub fn present(&self) -> bool {
        !self.files.is_empty()
    }
}

/// 没有套模板的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateSkip {
    /// 配置里关掉了。
    Disabled,
    /// 模板里一个文件都没有。
    Empty,
    /// 实例不隔离，与别的实例共用游戏目录根下的设置。
    SharedWorkingDir,
}

impl TemplateSkip {
    /// 进度阶段里用的中文原因。
    pub fn describe(self) -> &'static str {
        match self {
            TemplateSkip::Disabled => "新建实例时沿用默认设置已在配置里关闭",
            TemplateSkip::Empty => "还没有默认设置",
            TemplateSkip::SharedWorkingDir => "这个实例与其他未隔离的实例共用 .minecraft 里的设置",
        }
    }
}

/// 一次套模板的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateOutcome {
    /// 套了：`copied` 是补进去的文件，`kept` 是实例里本来就有、原样留着的文件，都按白名单顺序。
    Applied {
        copied: Vec<&'static str>,
        kept: Vec<&'static str>,
    },
    Skipped(TemplateSkip),
}

/// `template.json` 的内容。字段都可缺：手写或旧版本写的元数据缺哪项就当不知道。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct TemplateMeta {
    source_instance: Option<String>,
    saved_at: Option<u64>,
}

/// 进程内的模板目录锁表，写法与 mods 目录锁相同。保存要先挪走旧目录再换上新目录，两步之间模板目录
/// 不存在；套模板与读状态若不排队，就会在这个空当里把模板当成空的。键是模板目录路径：同一进程里的
/// 门面快照共用同一个数据目录。
static TEMPLATE_DIR_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn lock_template_dir(dir: &Path) -> OwnedMutexGuard<()> {
    let entry = {
        let mut table = TEMPLATE_DIR_LOCKS
            .lock()
            .expect("锁表只在本函数里短暂持有，不会在持有时 panic");
        table
            .entry(dir.to_owned())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    entry.lock_owned().await
}

impl Aurora {
    /// 模板目录 `<数据目录>/templates/default`（不检查是否存在）。
    pub fn template_dir(&self) -> PathBuf {
        self.data_dir().join(TEMPLATES_DIR).join(DEFAULT_TEMPLATE)
    }

    /// 模板的现状。元数据文件读不懂时报错：悄悄当成「来源不明」会让界面写出一句假话。
    pub async fn template_info(&self) -> Result<TemplateInfo> {
        let dir = self.template_dir();
        let _guard = lock_template_dir(&dir).await;
        recover_interrupted_swap(&self.data_dir().join(TEMPLATES_DIR), &dir).await?;
        self.read_template_info(&dir).await
    }

    /// 把实例工作目录里的白名单文件存成模板，整份替换旧模板：实例里没有的白名单文件，新模板里也没有。
    ///
    /// 隔离与不隔离的实例都能保存，不隔离时读的是游戏目录根下的文件。一个白名单文件都没有（还没进过
    /// 游戏）时报 [`CoreError::TemplateSourceEmpty`]，旧模板不动；中途失败时旧模板同样原样保留。
    pub async fn save_template_from_instance(&self, id: &str) -> Result<TemplateInfo> {
        let source = self.resolve_working_dir(id).await?.working_dir;
        let dir = self.template_dir();
        let _guard = lock_template_dir(&dir).await;
        let root = self.data_dir().join(TEMPLATES_DIR);
        // 先于清残留：中断现场里的旧模板也带着残留的前缀，不挪回来就会被当成残留删掉
        recover_interrupted_swap(&root, &dir).await?;
        clear_leftovers(&root).await?;

        let mut present = Vec::new();
        for name in TEMPLATE_FILES {
            if entry_exists(&source.join(name)).await? {
                present.push(name);
            }
        }
        if present.is_empty() {
            return Err(CoreError::TemplateSourceEmpty { id: id.to_owned() });
        }

        let stamp = now_millis();
        let staging = root.join(format!("{STAGING_PREFIX}{stamp}"));
        let meta = TemplateMeta {
            source_instance: Some(id.to_owned()),
            saved_at: Some(stamp),
        };
        let swapped = match fill_staging(&root, &staging, &source, &present, &meta).await {
            Ok(()) => swap_in(&root, &dir, &staging, stamp).await,
            Err(err) => Err(err),
        };
        if let Err(err) = swapped {
            remove_staging(&staging).await;
            return Err(err);
        }
        tracing::info!(id, files = ?present, "已把实例的设置保存为默认");
        self.read_template_info(&dir).await
    }

    /// 删掉整个模板目录；本来就没有也算成功。返回删完之后的状态。
    pub async fn clear_template(&self) -> Result<TemplateInfo> {
        let dir = self.template_dir();
        let _guard = lock_template_dir(&dir).await;
        // 中断现场里的旧模板先挪回原位再随 default 一起删掉，不然它下次读的时候又会被挪回来
        recover_interrupted_swap(&self.data_dir().join(TEMPLATES_DIR), &dir).await?;
        match tokio::fs::remove_dir_all(&dir).await {
            Ok(()) => tracing::info!(dir = %dir.display(), "已清除默认设置"),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(aurora_base::Error::Io { path: dir, source }.into()),
        }
        self.read_template_info(&dir).await
    }

    /// 把模板补进实例的工作目录。要求版本 JSON 已经写好：判断隔离要读版本类型与加载器。
    pub async fn apply_template(&self, id: &str) -> Result<TemplateOutcome> {
        if !self.config().new_instance_template {
            return Ok(TemplateOutcome::Skipped(TemplateSkip::Disabled));
        }
        let dir = self.template_dir();
        let _guard = lock_template_dir(&dir).await;
        recover_interrupted_swap(&self.data_dir().join(TEMPLATES_DIR), &dir).await?;
        let files = template_files(&dir).await?;
        if files.is_empty() {
            return Ok(TemplateOutcome::Skipped(TemplateSkip::Empty));
        }
        let resolved = self.resolve_working_dir(id).await?;
        if !resolved.isolated {
            return Ok(TemplateOutcome::Skipped(TemplateSkip::SharedWorkingDir));
        }
        let mut copied = Vec::new();
        let mut kept = Vec::new();
        for file in files {
            let target = resolved.working_dir.join(file.name);
            if entry_exists(&target).await? {
                kept.push(file.name);
                continue;
            }
            let bytes = read_file(&dir.join(file.name)).await?;
            aurora_base::fs::atomic_write(&target, &bytes).await?;
            copied.push(file.name);
        }
        tracing::info!(id, ?copied, ?kept, "新实例已沿用默认设置");
        Ok(TemplateOutcome::Applied { copied, kept })
    }

    async fn read_template_info(&self, dir: &Path) -> Result<TemplateInfo> {
        let files = template_files(dir).await?;
        let meta_path = dir.join(TEMPLATE_META_FILE);
        let meta = match tokio::fs::read(&meta_path).await {
            Ok(bytes) => serde_json::from_slice::<TemplateMeta>(&bytes).map_err(|source| {
                CoreError::JsonFileInvalid {
                    path: meta_path,
                    source,
                }
            })?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => TemplateMeta::default(),
            Err(source) => {
                return Err(aurora_base::Error::Io {
                    path: meta_path,
                    source,
                }
                .into());
            }
        };
        Ok(TemplateInfo {
            files,
            source_instance: meta.source_instance,
            saved_at: meta.saved_at,
            enabled: self.config().new_instance_template,
        })
    }
}

/// 模板目录里存在、而且是普通文件的白名单项。目录不在即一项都没有。
async fn template_files(dir: &Path) -> Result<Vec<TemplateFile>> {
    let mut files = Vec::new();
    for name in TEMPLATE_FILES {
        let path = dir.join(name);
        match tokio::fs::metadata(&path).await {
            Ok(meta) if meta.is_file() => files.push(TemplateFile {
                name,
                size: meta.len(),
            }),
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => return Err(aurora_base::Error::Io { path, source }.into()),
        }
    }
    Ok(files)
}

/// 路径上有没有东西（不跟随符号链接）。不是普通文件也算有：套模板时不往它上面写，保存时照常去读，
/// 读不了就报出来，而不是悄悄当它不存在。
async fn entry_exists(path: &Path) -> Result<bool> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(aurora_base::Error::Io {
            path: path.to_owned(),
            source,
        }
        .into()),
    }
}

async fn read_file(path: &Path) -> Result<Vec<u8>> {
    tokio::fs::read(path).await.map_err(|source| {
        aurora_base::Error::Io {
            path: path.to_owned(),
            source,
        }
        .into()
    })
}

/// 清掉上次保存中断留下的暂存目录与没删掉的旧目录。删不掉只记 warn：它们不影响这次保存
/// （名字带毫秒时刻，撞不上），拦下保存反倒让玩家什么也做不了。
async fn clear_leftovers(root: &Path) -> Result<()> {
    let mut entries = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(aurora_base::Error::Io {
                path: root.to_owned(),
                source,
            }
            .into());
        }
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => return Ok(()),
            Err(source) => {
                return Err(aurora_base::Error::Io {
                    path: root.to_owned(),
                    source,
                }
                .into());
            }
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with(STAGING_PREFIX) || name.starts_with(OLD_PREFIX)) {
            continue;
        }
        let path = entry.path();
        if let Err(err) = tokio::fs::remove_dir_all(&path).await {
            tracing::warn!(path = %path.display(), error = %err, "清不掉上次保存默认设置留下的目录");
        }
    }
}

/// 上一次保存在两次改名之间中断（进程被结束、断电）时，`default` 不在，同一时刻的旧目录与暂存目录都还在。
/// 那次保存没有完成，回到保存之前：把旧目录挪回原位。只认同一时刻成对的两个目录——单独一个旧目录是换上
/// 新模板后没删掉的，模板随后可能已被清除，挪回来就是把清掉的默认设置又变出来。
async fn recover_interrupted_swap(root: &Path, dir: &Path) -> Result<()> {
    match tokio::fs::symlink_metadata(dir).await {
        Ok(_) => return Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(aurora_base::Error::Io {
                path: dir.to_owned(),
                source,
            }
            .into());
        }
    }
    let io = |source| aurora_base::Error::Io {
        path: root.to_owned(),
        source,
    };
    let mut entries = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => return Err(io(source).into()),
    };
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(io)? {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    let newest = names
        .iter()
        .filter_map(|name| name.strip_prefix(OLD_PREFIX)?.parse::<u64>().ok())
        .filter(|stamp| names.contains(&format!("{STAGING_PREFIX}{stamp}")))
        .max();
    let Some(stamp) = newest else {
        return Ok(());
    };
    let old = root.join(format!("{OLD_PREFIX}{stamp}"));
    tokio::fs::rename(&old, dir)
        .await
        .map_err(|source| aurora_base::Error::Io {
            path: old.clone(),
            source,
        })?;
    tracing::warn!(old = %old.display(), "上次保存默认设置中途中断，已把保存之前的默认设置挪回原位");
    Ok(())
}

/// 建暂存目录，写进白名单文件与元数据。
async fn fill_staging(
    root: &Path,
    staging: &Path,
    source: &Path,
    present: &[&'static str],
    meta: &TemplateMeta,
) -> Result<()> {
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|source| aurora_base::Error::Io {
            path: root.to_owned(),
            source,
        })?;
    // 不用 create_dir_all：同名目录已经存在说明残留没清掉，往里面混写会把别的文件带进模板。
    tokio::fs::create_dir(staging)
        .await
        .map_err(|source| aurora_base::Error::Io {
            path: staging.to_owned(),
            source,
        })?;
    for name in present {
        let bytes = read_file(&source.join(name)).await?;
        aurora_base::fs::atomic_write(staging.join(name), &bytes).await?;
    }
    let bytes = serde_json::to_vec_pretty(meta).map_err(CoreError::JsonSerialize)?;
    aurora_base::fs::atomic_write(staging.join(TEMPLATE_META_FILE), &bytes).await?;
    Ok(())
}

/// 把暂存目录换成模板目录。Windows 上目录不能改名覆盖已有目录，所以先把旧目录挪开再换上新的；
/// 第二步失败时把旧目录挪回来。
async fn swap_in(root: &Path, dir: &Path, staging: &Path, stamp: u64) -> Result<()> {
    let old = root.join(format!("{OLD_PREFIX}{stamp}"));
    let had_old = match tokio::fs::rename(dir, &old).await {
        Ok(()) => true,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(source) => {
            return Err(aurora_base::Error::Io {
                path: dir.to_owned(),
                source,
            }
            .into());
        }
    };
    if let Err(source) = tokio::fs::rename(staging, dir).await {
        if had_old && let Err(err) = tokio::fs::rename(&old, dir).await {
            tracing::error!(old = %old.display(), error = %err, "换上新模板失败后没能把旧模板挪回来");
        }
        return Err(aurora_base::Error::Io {
            path: dir.to_owned(),
            source,
        }
        .into());
    }
    if had_old && let Err(err) = tokio::fs::remove_dir_all(&old).await {
        tracing::warn!(old = %old.display(), error = %err, "旧模板删不掉，下次保存时再清");
    }
    Ok(())
}

/// 保存失败后删掉暂存目录。这时要返回的是保存本身的错误，删不掉只能留日志，下次保存开头再清。
async fn remove_staging(staging: &Path) {
    match tokio::fs::remove_dir_all(staging).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            tracing::error!(staging = %staging.display(), error = %err, "保存默认设置失败后删不掉暂存目录");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use crate::instances::tests::{vanilla_json, write_version};
    use aurora_instance::IsolationPolicy;

    /// 数据目录在 `root`，游戏目录在 `root/.minecraft`，全部实例隔离。
    fn isolated(root: &Path) -> Aurora {
        let mut aurora = Aurora::for_test(
            AuroraConfig::default(),
            root.to_path_buf(),
            root.join(".minecraft"),
        );
        aurora.set_isolation_policy(IsolationPolicy::All);
        aurora
    }

    fn random_bytes(len: usize) -> Vec<u8> {
        let mut rng = fastrand::Rng::new();
        (0..len).map(|_| rng.u8(..)).collect()
    }

    fn put_template(aurora: &Aurora, files: &[(&str, &[u8])]) {
        let dir = aurora.template_dir();
        std::fs::create_dir_all(&dir).unwrap();
        for (name, bytes) in files {
            std::fs::write(dir.join(name), bytes).unwrap();
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn applies_missing_files_byte_for_byte() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated(tmp.path());
        let dir = write_version(aurora.game_dir(), "周末生存", &vanilla_json("1.21.1"));
        let options = random_bytes(fastrand::usize(1..4096));
        let servers = random_bytes(fastrand::usize(1..4096));
        put_template(
            &aurora,
            &[
                ("options.txt", &options),
                ("servers.dat", &servers),
                (
                    TEMPLATE_META_FILE,
                    r#"{"source_instance":"樱花生存","saved_at":1}"#.as_bytes(),
                ),
                ("config.json", b"{}"),
            ],
        );

        let outcome = aurora.apply_template("周末生存").await.unwrap();
        assert_eq!(
            outcome,
            TemplateOutcome::Applied {
                copied: vec!["options.txt", "servers.dat"],
                kept: vec![],
            }
        );
        assert_eq!(std::fs::read(dir.join("options.txt")).unwrap(), options);
        assert_eq!(std::fs::read(dir.join("servers.dat")).unwrap(), servers);
        assert!(!dir.join(TEMPLATE_META_FILE).exists(), "元数据不进实例");
        assert!(!dir.join("config.json").exists(), "白名单外的文件不进实例");
        assert!(!dir.join("optionsof.txt").exists());
    }

    #[tokio::test]
    async fn existing_target_file_is_kept_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated(tmp.path());
        let dir = write_version(aurora.game_dir(), "整合包", &vanilla_json("1.21.1"));
        std::fs::write(dir.join("options.txt"), b"lang:en_us").unwrap();
        put_template(
            &aurora,
            &[("options.txt", b"fov:90"), ("servers.dat", b"\x0a\x00\x00")],
        );

        let outcome = aurora.apply_template("整合包").await.unwrap();
        assert_eq!(
            outcome,
            TemplateOutcome::Applied {
                copied: vec!["servers.dat"],
                kept: vec!["options.txt"],
            }
        );
        assert_eq!(
            std::fs::read(dir.join("options.txt")).unwrap(),
            b"lang:en_us"
        );
        assert_eq!(
            std::fs::read(dir.join("servers.dat")).unwrap(),
            b"\x0a\x00\x00"
        );
    }

    /// 不隔离的原版正式版共用游戏目录根：根下原有的设置一个字节都不动，也不多出文件。
    #[tokio::test]
    async fn shared_working_dir_is_skipped_and_root_files_are_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = isolated(tmp.path());
        aurora.set_isolation_policy(IsolationPolicy::Disabled);
        let dir = write_version(aurora.game_dir(), "1.21.1", &vanilla_json("1.21.1"));
        let root_options = aurora.game_dir().join("options.txt");
        std::fs::write(&root_options, b"fov:70").unwrap();
        put_template(
            &aurora,
            &[("options.txt", b"fov:90"), ("servers.dat", b"servers")],
        );

        let outcome = aurora.apply_template("1.21.1").await.unwrap();
        assert_eq!(
            outcome,
            TemplateOutcome::Skipped(TemplateSkip::SharedWorkingDir)
        );
        assert_eq!(std::fs::read(&root_options).unwrap(), b"fov:70");
        assert!(!aurora.game_dir().join("servers.dat").exists());
        assert!(!dir.join("options.txt").exists());
    }

    #[tokio::test]
    async fn disabled_in_config_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = Aurora::for_test(
            AuroraConfig {
                new_instance_template: false,
                ..AuroraConfig::default()
            },
            tmp.path().to_path_buf(),
            tmp.path().join(".minecraft"),
        );
        aurora.set_isolation_policy(IsolationPolicy::All);
        let dir = write_version(aurora.game_dir(), "关掉的", &vanilla_json("1.21.1"));
        put_template(
            &aurora,
            &[("options.txt", b"fov:90"), ("servers.dat", b"servers")],
        );

        let outcome = aurora.apply_template("关掉的").await.unwrap();
        assert_eq!(outcome, TemplateOutcome::Skipped(TemplateSkip::Disabled));
        assert_eq!(names(&dir), vec!["关掉的.json".to_owned()]);
        assert!(!aurora.template_info().await.unwrap().enabled);
    }

    /// 模板目录不在、在而空、只有元数据或只有同名目录，都算没有模板。
    #[tokio::test]
    async fn missing_or_empty_template_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated(tmp.path());
        let dir = write_version(aurora.game_dir(), "新的", &vanilla_json("1.21.1"));
        assert_eq!(
            aurora.apply_template("新的").await.unwrap(),
            TemplateOutcome::Skipped(TemplateSkip::Empty)
        );

        put_template(&aurora, &[]);
        assert_eq!(
            aurora.apply_template("新的").await.unwrap(),
            TemplateOutcome::Skipped(TemplateSkip::Empty)
        );

        put_template(&aurora, &[(TEMPLATE_META_FILE, b"{}")]);
        std::fs::create_dir(aurora.template_dir().join("options.txt")).unwrap();
        assert_eq!(
            aurora.apply_template("新的").await.unwrap(),
            TemplateOutcome::Skipped(TemplateSkip::Empty)
        );
        let info = aurora.template_info().await.unwrap();
        assert!(!info.present());
        assert!(info.files.is_empty());
        assert_eq!(names(&dir), vec!["新的.json".to_owned()]);
    }

    /// 只复制白名单，按白名单顺序列出；旧模板里实例没有的文件不留在新模板里；上次留下的暂存目录清掉。
    #[tokio::test]
    async fn save_copies_only_the_whitelist_and_replaces_the_old_template() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated(tmp.path());
        let dir = write_version(aurora.game_dir(), "樱花生存", &vanilla_json("1.21.1"));
        std::fs::write(dir.join("optionsshaders.txt"), b"abc").unwrap();
        std::fs::write(dir.join("servers.dat"), b"12345").unwrap();
        std::fs::write(dir.join("options.txt"), b"fov:90\nlang").unwrap();
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(dir.join("config").join("x.json"), b"{}").unwrap();
        std::fs::write(dir.join("options.txt.bak"), b"old").unwrap();
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        put_template(&aurora, &[("optionsof.txt", b"ofFastRender:true")]);
        let root = tmp.path().join(TEMPLATES_DIR);
        std::fs::create_dir_all(root.join(".default-staging-1")).unwrap();
        std::fs::create_dir_all(root.join(".default-old-2")).unwrap();
        let before = now_millis();

        let info = aurora
            .save_template_from_instance("樱花生存")
            .await
            .unwrap();
        assert_eq!(
            info.files,
            vec![
                TemplateFile {
                    name: "options.txt",
                    size: 11
                },
                TemplateFile {
                    name: "servers.dat",
                    size: 5
                },
                TemplateFile {
                    name: "optionsshaders.txt",
                    size: 3
                },
            ]
        );
        assert!(info.present());
        assert!(info.enabled);
        assert_eq!(info.source_instance.as_deref(), Some("樱花生存"));
        let saved_at = info.saved_at.unwrap();
        assert!(saved_at >= before && saved_at <= now_millis(), "{saved_at}");
        assert_eq!(
            names(&aurora.template_dir()),
            vec![
                "options.txt",
                "optionsshaders.txt",
                "servers.dat",
                TEMPLATE_META_FILE
            ]
        );
        assert_eq!(
            std::fs::read(aurora.template_dir().join("options.txt")).unwrap(),
            b"fov:90\nlang"
        );
        assert_eq!(names(&root), vec![DEFAULT_TEMPLATE.to_owned()]);
        assert_eq!(aurora.template_info().await.unwrap(), info);
    }

    /// 不隔离的实例读的是游戏目录根下的文件。
    #[tokio::test]
    async fn save_from_a_shared_instance_reads_the_game_dir_root() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = isolated(tmp.path());
        aurora.set_isolation_policy(IsolationPolicy::Disabled);
        write_version(aurora.game_dir(), "1.21.1", &vanilla_json("1.21.1"));
        std::fs::write(aurora.game_dir().join("servers.dat"), b"root-servers").unwrap();

        let info = aurora.save_template_from_instance("1.21.1").await.unwrap();
        assert_eq!(
            info.files,
            vec![TemplateFile {
                name: "servers.dat",
                size: 12
            }]
        );
        assert_eq!(
            std::fs::read(aurora.template_dir().join("servers.dat")).unwrap(),
            b"root-servers"
        );
    }

    /// 读到一半失败：旧模板原样留着，新文件一个都没混进去，暂存目录也删干净了。
    #[tokio::test]
    async fn failed_save_keeps_the_old_template_and_leaves_no_staging() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated(tmp.path());
        let dir = write_version(aurora.game_dir(), "坏的", &vanilla_json("1.21.1"));
        std::fs::write(dir.join("options.txt"), b"new").unwrap();
        std::fs::create_dir_all(dir.join("servers.dat")).unwrap();
        put_template(
            &aurora,
            &[
                ("options.txt", b"old"),
                (
                    TEMPLATE_META_FILE,
                    r#"{"source_instance":"旧的","saved_at":7}"#.as_bytes(),
                ),
            ],
        );

        let err = aurora
            .save_template_from_instance("坏的")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::Base(aurora_base::Error::Io { path, .. }) if path.ends_with("servers.dat")),
            "{err:?}"
        );
        assert_eq!(
            std::fs::read(aurora.template_dir().join("options.txt")).unwrap(),
            b"old"
        );
        assert!(!aurora.template_dir().join("servers.dat").exists());
        assert_eq!(
            names(&tmp.path().join(TEMPLATES_DIR)),
            vec![DEFAULT_TEMPLATE.to_owned()]
        );
        let info = aurora.template_info().await.unwrap();
        assert_eq!(info.source_instance.as_deref(), Some("旧的"));
        assert_eq!(info.saved_at, Some(7));
    }

    #[tokio::test]
    async fn instance_without_settings_files_is_reported_and_the_old_template_stays() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated(tmp.path());
        let dir = write_version(aurora.game_dir(), "没进过游戏", &vanilla_json("1.21.1"));
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::write(dir.join("options.txt.bak"), b"x").unwrap();
        put_template(&aurora, &[("options.txt", b"old")]);

        let err = aurora
            .save_template_from_instance("没进过游戏")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::TemplateSourceEmpty { id } if id == "没进过游戏"),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "实例 没进过游戏 的游戏目录里还没有 options.txt 或服务器列表，进一次游戏后再保存"
        );
        assert_eq!(
            std::fs::read(aurora.template_dir().join("options.txt")).unwrap(),
            b"old"
        );
        assert_eq!(
            names(&aurora.template_dir()),
            vec!["options.txt".to_owned()]
        );
    }

    /// 上一次保存在两次改名之间中断（进程被结束、断电）：旧模板已挪开，新的还没换上。之后读、套、清除都先把
    /// 旧模板挪回原位，不当成没有默认设置，保存开头清残留时也不把它删掉。
    #[tokio::test]
    async fn interrupted_swap_puts_the_old_template_back() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated(tmp.path());
        let root = tmp.path().join(TEMPLATES_DIR);
        let interrupted = |stamp: u64| {
            let old = root.join(format!("{OLD_PREFIX}{stamp}"));
            std::fs::create_dir_all(&old).unwrap();
            std::fs::write(old.join("options.txt"), b"fov:90").unwrap();
            std::fs::write(
                old.join(TEMPLATE_META_FILE),
                r#"{"source_instance":"樱花生存","saved_at":3}"#.as_bytes(),
            )
            .unwrap();
            let staging = root.join(format!("{STAGING_PREFIX}{stamp}"));
            std::fs::create_dir_all(&staging).unwrap();
            std::fs::write(staging.join("options.txt"), b"fov:110").unwrap();
        };

        interrupted(5);
        let info = aurora.template_info().await.unwrap();
        assert_eq!(
            info.files,
            vec![TemplateFile {
                name: "options.txt",
                size: 6
            }]
        );
        assert_eq!(info.source_instance.as_deref(), Some("樱花生存"));
        assert_eq!(info.saved_at, Some(3));
        assert_eq!(
            std::fs::read(aurora.template_dir().join("options.txt")).unwrap(),
            b"fov:90"
        );

        std::fs::remove_dir_all(&root).unwrap();
        interrupted(6);
        let dir = write_version(aurora.game_dir(), "周末生存", &vanilla_json("1.21.1"));
        assert_eq!(
            aurora.apply_template("周末生存").await.unwrap(),
            TemplateOutcome::Applied {
                copied: vec!["options.txt"],
                kept: vec![],
            }
        );
        assert_eq!(std::fs::read(dir.join("options.txt")).unwrap(), b"fov:90");

        // 清除之后旧模板不再冒出来：挪回原位的那份随 default 一起删掉，只剩没配对的暂存目录
        std::fs::remove_dir_all(&root).unwrap();
        interrupted(7);
        assert!(!aurora.clear_template().await.unwrap().present());
        assert!(!aurora.template_info().await.unwrap().present());
    }

    /// 换上新模板后没删掉的旧目录单独留着、没有同一时刻的暂存目录：它不是中断的现场，模板随后可能已被清除，
    /// 不能把它挪回来。
    #[tokio::test]
    async fn lone_old_dir_is_not_brought_back() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated(tmp.path());
        let old = tmp
            .path()
            .join(TEMPLATES_DIR)
            .join(format!("{OLD_PREFIX}5"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("options.txt"), b"fov:90").unwrap();
        std::fs::create_dir_all(
            tmp.path()
                .join(TEMPLATES_DIR)
                .join(format!("{STAGING_PREFIX}4")),
        )
        .unwrap();
        let dir = write_version(aurora.game_dir(), "周末生存", &vanilla_json("1.21.1"));

        assert!(!aurora.template_info().await.unwrap().present());
        assert_eq!(
            aurora.apply_template("周末生存").await.unwrap(),
            TemplateOutcome::Skipped(TemplateSkip::Empty)
        );
        assert!(!aurora.template_dir().exists());
        assert!(!dir.join("options.txt").exists());
    }

    #[tokio::test]
    async fn clear_is_idempotent_and_leaves_no_template() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated(tmp.path());
        put_template(
            &aurora,
            &[
                ("options.txt", b"fov:90"),
                (
                    TEMPLATE_META_FILE,
                    br#"{"source_instance":"x","saved_at":1}"#,
                ),
            ],
        );
        assert!(aurora.template_info().await.unwrap().present());

        for _ in 0..2 {
            let info = aurora.clear_template().await.unwrap();
            assert!(!info.present());
            assert_eq!(info.source_instance, None);
            assert_eq!(info.saved_at, None);
        }
        assert!(!aurora.template_dir().exists());
        assert!(!aurora.template_info().await.unwrap().present());
    }

    #[tokio::test]
    async fn hand_placed_files_have_no_source_and_corrupt_meta_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = isolated(tmp.path());
        put_template(&aurora, &[("optionsof.txt", b"ofFastRender:true")]);
        let info = aurora.template_info().await.unwrap();
        assert_eq!(
            info.files,
            vec![TemplateFile {
                name: "optionsof.txt",
                size: 17
            }]
        );
        assert_eq!((info.source_instance, info.saved_at), (None, None));

        put_template(
            &aurora,
            &[(TEMPLATE_META_FILE, r#"{"saved_at":"昨天"}"#.as_bytes())],
        );
        let err = aurora.template_info().await.unwrap_err();
        assert!(
            matches!(&err, CoreError::JsonFileInvalid { path, .. } if path.ends_with(TEMPLATE_META_FILE)),
            "{err:?}"
        );
    }
}
