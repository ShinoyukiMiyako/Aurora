//! 游戏目录（`.minecraft`）的发现、并存与切换，以及首次启动的落盘。
//!
//! 一台机器上常常同时存在好几个 `.minecraft`：官方启动器的、PCL2 或 HMCL 的、以及本启动器自己的。
//! 这里把它们一并列出来让玩家在其间切换，而不是逼他把攒了多年的存档搬过来。
//!
//! 「当前目录」只有一个（[`AuroraConfig::game_directory`]，安装与启动真正落盘的地方），其余记在
//! [`AuroraConfig::extra_game_directories`] 里。切换目录就是把候选提为当前、把原来的当前收进候选。
//!
//! 记录过的目录可能此刻访问不到（外置硬盘没插、网络盘断开），对这类路径做 `is_dir` 可能阻塞数秒，
//! 所以一切磁盘探测都放进阻塞线程池并限时：超时按「不可达」处理，记录照样保留、照样列出。
//!
//! [`AuroraConfig::game_directory`]: crate::config::AuroraConfig::game_directory
//! [`AuroraConfig::extra_game_directories`]: crate::config::AuroraConfig::extra_game_directories

use std::path::{Path, PathBuf};
use std::time::Duration;

use aurora_instance::{MINECRAFT_DIR_NAME, official_minecraft_dir};

use crate::config::NamedDirectory;
use crate::error::{CoreError, GameDirProblem, Result};
use crate::facade::Aurora;

/// 单个目录探测的时限。本地盘是微秒级，超过它的基本是挂起的网络盘或拔掉的外置盘。
pub const DIR_PROBE_TIMEOUT: Duration = Duration::from_millis(2000);

/// 新建游戏目录的时限：比探测宽，因为要真的在盘上建一串目录。
const CREATE_DIR_TIMEOUT: Duration = Duration::from_millis(5000);

/// 一条游戏目录记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameDirectoryEntry {
    pub name: String,
    pub path: PathBuf,
    /// 是否为当前正在使用的目录。
    pub is_current: bool,
    /// 此刻能否访问。为假时记录依然保留，插回硬盘就恢复。
    pub available: bool,
}

/// 首次启动向导第一步之前的目录记录，由 [`Aurora::first_run_baseline`] 取得。
///
/// 第一步可以提交不止一次：离开第一步就提交，用户回到第一步改了目录或勾选再离开时重新提交。
/// 每次提交都从这份记录出发套用本次的选择（[`Aurora::complete_first_run`]），前几次提交设下的
/// 当前目录、收下的文件夹不会叠加进来——否则上一次选的目录会被当成「原来的当前目录」收进额外目录，
/// 取消勾选的文件夹也还留着。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirstRunBaseline {
    game_directory: Option<PathBuf>,
    game_dir: PathBuf,
    extra_game_directories: Vec<NamedDirectory>,
    /// 向导之前的当前目录那时在盘上是否存在。第一次提交可能就是在这里建的目录，事后再看盘就分不清了。
    current_exists: bool,
}

/// 对一个候选目录的检查结果，供首次启动向导提示「这里已经有游戏文件」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GameDirectoryInspection {
    /// 目录是否已存在。
    pub exists: bool,
    /// 目录里是否已有 `versions` 文件夹（已有游戏文件，会直接接管）。
    pub has_versions: bool,
}

/// 校验并规整一个由界面传来的游戏目录路径：不能为空、必须是绝对路径、不能含 `!`。
pub fn validate_game_dir(raw: &str) -> Result<PathBuf> {
    let trimmed = raw.trim();
    let path = PathBuf::from(trimmed);
    let problem = if trimmed.is_empty() {
        Some(GameDirProblem::Empty)
    } else if trimmed.contains('!') {
        Some(GameDirProblem::ContainsBang)
    } else if !path.is_absolute() {
        Some(GameDirProblem::NotAbsolute)
    } else {
        None
    };
    match problem {
        Some(problem) => Err(CoreError::InvalidGameDirectory { path, problem }),
        None => Ok(path),
    }
}

/// 限时判断路径是否是一个可访问的目录；超时或探测线程异常都按不可达处理。
pub async fn probe_dir(path: &Path) -> bool {
    let owned = path.to_path_buf();
    let probe = tokio::task::spawn_blocking(move || owned.is_dir());
    match tokio::time::timeout(DIR_PROBE_TIMEOUT, probe).await {
        Ok(Ok(available)) => available,
        Ok(Err(join)) => {
            tracing::warn!(path = %path.display(), error = %join, "目录探测线程异常结束，按不可达处理");
            false
        }
        Err(_) => {
            tracing::info!(path = %path.display(), "目录探测超时，按不可达处理");
            false
        }
    }
}

/// 检查候选目录：是否存在、是否已有 `versions`。
pub async fn inspect_game_directory(path: &Path) -> GameDirectoryInspection {
    let exists = probe_dir(path).await;
    let has_versions = exists && probe_dir(&path.join("versions")).await;
    GameDirectoryInspection {
        exists,
        has_versions,
    }
}

/// 确保目录存在（不存在就建）。访问不到或建不起来都报错，原因原样带回给界面。
pub async fn ensure_game_dir(path: &Path) -> Result<()> {
    let owned = path.to_path_buf();
    let create = tokio::task::spawn_blocking(move || std::fs::create_dir_all(&owned));
    match tokio::time::timeout(CREATE_DIR_TIMEOUT, create).await {
        Ok(joined) => joined?.map_err(|source| {
            CoreError::Base(aurora_base::Error::Io {
                path: path.to_path_buf(),
                source,
            })
        }),
        Err(_) => Err(CoreError::InvalidGameDirectory {
            path: path.to_path_buf(),
            problem: GameDirProblem::Unavailable,
        }),
    }
}

/// 数据目录下的默认游戏目录。
pub fn default_game_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(MINECRAFT_DIR_NAME)
}

impl Aurora {
    /// 首次启动向导是否还没走过第一步。
    pub fn is_first_run(&self) -> bool {
        !self.config().first_run_completed
    }

    /// 记下此刻的目录记录，作为首次启动向导各次提交的出发点。
    ///
    /// `current_exists` 是此刻的当前目录在盘上是否存在，由调用方在任何一次提交建目录之前限时探测
    /// （[`probe_dir`]）：记录过的目录可能在挂起的盘上，不能在门面锁里同步探测。
    pub fn first_run_baseline(&self, current_exists: bool) -> FirstRunBaseline {
        FirstRunBaseline {
            game_directory: self.config().game_directory.clone(),
            game_dir: self.game_dir().to_path_buf(),
            extra_game_directories: self.config().extra_game_directories.clone(),
            current_exists,
        }
    }

    /// 首次启动第一步提交：回到向导之前的目录记录，再把选定的目录设为当前、收下勾选的其它启动器文件夹、
    /// 标记向导已完成。同一个基线上重复提交，结果与只提交最后一次相同。
    ///
    /// 目录须事先经 [`validate_game_dir`] 校验并经 [`ensure_game_dir`] 建好；落盘仍由调用方
    /// [`Aurora::save_config`] 完成。
    pub fn complete_first_run(
        &mut self,
        baseline: &FirstRunBaseline,
        game_dir: PathBuf,
        extras: Vec<NamedDirectory>,
    ) {
        self.config_mut().game_directory = baseline.game_directory.clone();
        self.config_mut().extra_game_directories = baseline.extra_game_directories.clone();
        self.set_game_dir(baseline.game_dir.clone());
        self.replace_current_directory(game_dir, baseline.current_exists);
        for extra in extras {
            self.add_game_directory(extra.name, extra.path);
        }
        self.config_mut().first_run_completed = true;
    }

    /// 列出全部已知游戏目录：当前目录在前，其余按记录顺序；各目录并发限时探测是否可达。
    pub async fn game_directories(&self) -> Vec<GameDirectoryEntry> {
        let current = self.game_dir().to_path_buf();
        let mut listed = vec![(self.directory_name(&current), current.clone(), true)];
        for extra in &self.config().extra_game_directories {
            // 当前目录同时被记进额外列表时只留一条：它已经在最前面了。
            if !same_path(&extra.path, &current) {
                listed.push((extra.name.clone(), extra.path.clone(), false));
            }
        }
        let availability = probe_all(listed.iter().map(|(_, path, _)| path.clone())).await;
        listed
            .into_iter()
            .zip(availability)
            .map(|((name, path, is_current), available)| GameDirectoryEntry {
                name,
                path,
                is_current,
                available,
            })
            .collect()
    }

    /// 探测这台机器上尚未记录的其它 `.minecraft`。只报告不写入：收不收由用户决定。
    pub async fn discover_game_directories(&self) -> Vec<NamedDirectory> {
        let known: Vec<PathBuf> = std::iter::once(self.game_dir().to_path_buf())
            .chain(
                self.config()
                    .extra_game_directories
                    .iter()
                    .map(|d| d.path.clone()),
            )
            .collect();
        let mut candidates: Vec<NamedDirectory> = Vec::new();
        if let Some(official) = official_minecraft_dir() {
            candidates.push(NamedDirectory {
                name: "官方启动器".to_owned(),
                path: official,
            });
        }
        candidates.extend(sibling_launcher_dirs());
        candidates.retain(|c| !known.iter().any(|k| same_path(k, &c.path)));

        let availability = probe_all(candidates.iter().map(|c| c.path.clone())).await;
        let mut found: Vec<NamedDirectory> = Vec::new();
        for (candidate, available) in candidates.into_iter().zip(availability) {
            if available && !found.iter().any(|f| same_path(&f.path, &candidate.path)) {
                found.push(candidate);
            }
        }
        found
    }

    /// 记下一个额外目录。同路径已记录时只更新名字；与当前目录相同时什么都不做。
    pub fn add_game_directory(&mut self, name: impl Into<String>, path: impl Into<PathBuf>) {
        let path = path.into();
        if same_path(&path, self.game_dir()) {
            return;
        }
        let name = name.into();
        let extras = &mut self.config_mut().extra_game_directories;
        match extras.iter_mut().find(|d| same_path(&d.path, &path)) {
            Some(existing) => existing.name = name,
            None => extras.push(NamedDirectory { name, path }),
        }
    }

    /// 移除一个额外目录；没有这条记录返回 `false`。只摘记录，绝不动磁盘上的文件。
    pub fn remove_game_directory(&mut self, path: &Path) -> bool {
        let extras = &mut self.config_mut().extra_game_directories;
        let before = extras.len();
        extras.retain(|d| !same_path(&d.path, path));
        extras.len() != before
    }

    /// 把某个目录提为当前游戏目录。
    ///
    /// 原来的当前目录若在盘上存在就收进额外目录，否则切过去就再也找不回来了；从没建出来过的
    /// 默认目录不收，免得列表里多一条永远不可达的记录。
    pub fn switch_game_directory(&mut self, path: impl Into<PathBuf>) {
        let previous_exists = self.game_dir().is_dir();
        self.replace_current_directory(path.into(), previous_exists);
    }

    /// 换当前目录；原来的当前目录在盘上存在（`previous_exists`）就收进额外目录。
    fn replace_current_directory(&mut self, next: PathBuf, previous_exists: bool) {
        let previous = self.game_dir().to_path_buf();
        if same_path(&previous, &next) {
            return;
        }
        self.remove_game_directory(&next);
        if previous_exists {
            let name = self.directory_name(&previous);
            let extras = &mut self.config_mut().extra_game_directories;
            if !extras.iter().any(|d| same_path(&d.path, &previous)) {
                extras.push(NamedDirectory {
                    name,
                    path: previous,
                });
            }
        }
        self.set_game_directory(next);
    }

    /// 目录的显示名：记录里有名字用记录的；数据目录下的默认目录用产品名；
    /// 叶子是 `.minecraft` 时取上一级目录名，否则取叶子名。
    fn directory_name(&self, path: &Path) -> String {
        if let Some(named) = self
            .config()
            .extra_game_directories
            .iter()
            .find(|d| same_path(&d.path, path))
        {
            return named.name.clone();
        }
        if same_path(path, &default_game_dir(self.data_dir())) {
            return aurora_base::brand::APP_NAME.to_owned();
        }
        let leaf = path.file_name().map(|s| s.to_string_lossy().into_owned());
        let label = match leaf.as_deref() {
            Some(MINECRAFT_DIR_NAME) => path
                .parent()
                .and_then(Path::file_name)
                .map(|s| s.to_string_lossy().into_owned()),
            other => other.map(str::to_owned),
        };
        // 盘根这类没有任何一级名字的路径，显示路径本身。
        label.unwrap_or_else(|| path.display().to_string())
    }
}

/// 并发限时探测一组路径，结果与输入一一对应。
async fn probe_all(paths: impl Iterator<Item = PathBuf>) -> Vec<bool> {
    let mut set = tokio::task::JoinSet::new();
    let mut count = 0;
    for (index, path) in paths.enumerate() {
        count += 1;
        set.spawn(async move { (index, probe_dir(&path).await) });
    }
    let mut out = vec![false; count];
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((index, available)) => out[index] = available,
            Err(join) => tracing::warn!(error = %join, "目录探测任务异常结束，按不可达处理"),
        }
    }
    out
}

/// 路径等价判定：Windows 下大小写不敏感，且要抹平 `\` 与 `/` 的混用与末尾分隔符。
///
/// 不走 `canonicalize`：那需要路径真实存在，而这里要比的恰恰包含「记着但盘已经拔了」的条目。
pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    fn norm(p: &Path) -> String {
        p.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    }
    norm(a) == norm(b)
}

/// 常见第三方启动器放在各盘根下的 `.minecraft` 候选。
///
/// 只看固定的几个位置，不做全盘遍历：扫全盘既慢又会把玩家的整个磁盘翻一遍，找不到的让他自己添加。
fn sibling_launcher_dirs() -> Vec<NamedDirectory> {
    const LAUNCHER_DIRS: [(&str, &str); 3] = [
        ("PCL2", "Plain Craft Launcher 2"),
        ("PCL", "Plain Craft Launcher"),
        ("HMCL", "HMCL"),
    ];
    let mut out = Vec::new();
    for drive in ['C', 'D', 'E', 'F'] {
        for (label, dir) in LAUNCHER_DIRS {
            out.push(NamedDirectory {
                name: label.to_owned(),
                path: PathBuf::from(format!("{drive}:\\"))
                    .join(dir)
                    .join(MINECRAFT_DIR_NAME),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;

    fn aurora_at(data_dir: &Path, game_dir: &Path, extras: Vec<NamedDirectory>) -> Aurora {
        let config = AuroraConfig {
            extra_game_directories: extras,
            ..AuroraConfig::default()
        };
        Aurora::for_test(config, data_dir.to_path_buf(), game_dir.to_path_buf())
    }

    fn named(name: &str, path: impl Into<PathBuf>) -> NamedDirectory {
        NamedDirectory {
            name: name.to_owned(),
            path: path.into(),
        }
    }

    #[test]
    fn same_path_ignores_case_separator_and_trailing_slash() {
        assert!(same_path(
            Path::new("E:/Games/.minecraft"),
            Path::new("e:\\games\\.minecraft\\")
        ));
        assert!(!same_path(
            Path::new("E:/Games/.minecraft"),
            Path::new("E:/Games/.minecraft2")
        ));
    }

    #[test]
    fn validate_rejects_empty_relative_and_bang_paths() {
        let problem = |raw: &str| match validate_game_dir(raw) {
            Err(CoreError::InvalidGameDirectory { problem, .. }) => Some(problem),
            Err(other) => panic!("意外的错误 {other:?}"),
            Ok(_) => None,
        };
        assert_eq!(problem("   "), Some(GameDirProblem::Empty));
        assert_eq!(
            problem("games/.minecraft"),
            Some(GameDirProblem::NotAbsolute)
        );
        let bang = std::env::temp_dir().join("a!b").join(".minecraft");
        assert_eq!(
            problem(&bang.display().to_string()),
            Some(GameDirProblem::ContainsBang)
        );
        let ok = std::env::temp_dir().join(".minecraft");
        assert_eq!(
            validate_game_dir(&format!("  {}  ", ok.display())).unwrap(),
            ok,
            "首尾空白被去掉"
        );
    }

    #[test]
    fn add_game_directory_updates_name_instead_of_duplicating() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = aurora_at(tmp.path(), &tmp.path().join(".minecraft"), Vec::new());

        aurora.add_game_directory("旧名", "E:\\Games\\.minecraft");
        aurora.add_game_directory("新名", "e:/games/.minecraft/");

        let extras = &aurora.config().extra_game_directories;
        assert_eq!(extras.len(), 1);
        assert_eq!(extras[0].name, "新名");

        // 与当前目录相同的不会被记成额外目录。
        let current = aurora.game_dir().to_path_buf();
        aurora.add_game_directory("自己", current);
        assert_eq!(aurora.config().extra_game_directories.len(), 1);
    }

    #[test]
    fn remove_game_directory_reports_whether_anything_went() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = aurora_at(
            tmp.path(),
            &tmp.path().join(".minecraft"),
            vec![named("PCL2", "E:\\PCL2\\.minecraft")],
        );
        assert!(aurora.remove_game_directory(Path::new("e:/pcl2/.minecraft")));
        assert!(aurora.config().extra_game_directories.is_empty());
        assert!(!aurora.remove_game_directory(Path::new("E:\\PCL2\\.minecraft")));
    }

    /// 切换把原当前目录（在盘上存在时）收进额外目录，目标从额外目录里摘掉。
    #[test]
    fn switch_keeps_existing_previous_directory_reachable() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join("Games").join(".minecraft");
        std::fs::create_dir_all(&current).unwrap();
        let mut aurora = aurora_at(
            tmp.path(),
            &current,
            vec![named("PCL2", "E:\\PCL2\\.minecraft")],
        );

        aurora.switch_game_directory("E:\\PCL2\\.minecraft");

        assert_eq!(aurora.game_dir(), Path::new("E:\\PCL2\\.minecraft"));
        assert_eq!(
            aurora.config().game_directory.as_deref(),
            Some(Path::new("E:\\PCL2\\.minecraft"))
        );
        let extras = &aurora.config().extra_game_directories;
        assert_eq!(extras, &vec![named("Games", current)]);
    }

    /// 从没建出来过的默认目录不收进额外目录，免得列表里多一条永远不可达的记录。
    #[test]
    fn switch_drops_never_created_previous_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let default_dir = default_game_dir(tmp.path());
        let mut aurora = aurora_at(tmp.path(), &default_dir, Vec::new());
        let target = tmp.path().join("elsewhere");

        aurora.switch_game_directory(&target);

        assert_eq!(aurora.game_dir(), target);
        assert!(aurora.config().extra_game_directories.is_empty());
    }

    #[test]
    fn switching_to_the_same_directory_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join(".minecraft");
        std::fs::create_dir_all(&current).unwrap();
        let mut aurora = aurora_at(tmp.path(), &current, Vec::new());

        aurora.switch_game_directory(&current);
        aurora.switch_game_directory(current.display().to_string().to_uppercase());

        assert!(aurora.config().extra_game_directories.is_empty());
        assert!(
            aurora.config().game_directory.is_none(),
            "没有真正切换就不写配置"
        );
    }

    /// 当前目录在最前；不可达的额外目录照样列出，只是 available 为假。
    #[tokio::test]
    async fn game_directories_keeps_unavailable_entries_visible() {
        let tmp = tempfile::tempdir().unwrap();
        let current = default_game_dir(tmp.path());
        std::fs::create_dir_all(&current).unwrap();
        let gone = tmp.path().join("unplugged").join(".minecraft");
        let aurora = aurora_at(
            tmp.path(),
            &current,
            vec![
                named("外置盘", gone.clone()),
                named("重复记录", current.clone()),
            ],
        );

        let listed = aurora.game_directories().await;
        assert_eq!(
            listed,
            vec![
                GameDirectoryEntry {
                    name: "重复记录".to_owned(),
                    path: current,
                    is_current: true,
                    available: true,
                },
                GameDirectoryEntry {
                    name: "外置盘".to_owned(),
                    path: gone,
                    is_current: false,
                    available: false,
                },
            ]
        );
    }

    #[test]
    fn directory_name_prefers_record_then_brand_then_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(
            tmp.path(),
            &tmp.path().join(".minecraft"),
            vec![named("我的整合", "D:/Packs/.minecraft")],
        );
        assert_eq!(
            aurora.directory_name(Path::new("d:\\packs\\.minecraft")),
            "我的整合"
        );
        assert_eq!(
            aurora.directory_name(&default_game_dir(tmp.path())),
            aurora_base::brand::APP_NAME
        );
        assert_eq!(
            aurora.directory_name(Path::new("E:/Games/.minecraft")),
            "Games"
        );
        assert_eq!(aurora.directory_name(Path::new("E:/Games/mc")), "mc");
    }

    #[tokio::test]
    async fn discover_skips_known_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let known: Vec<NamedDirectory> = sibling_launcher_dirs();
        let aurora = aurora_at(tmp.path(), &tmp.path().join(".minecraft"), known.clone());
        let found = aurora.discover_game_directories().await;
        assert!(
            !found
                .iter()
                .any(|d| known.iter().any(|k| same_path(&k.path, &d.path))),
            "已记录的目录不应再被当成新发现：{found:?}"
        );
    }

    #[tokio::test]
    async fn inspect_reports_existing_game_files() {
        let tmp = tempfile::tempdir().unwrap();
        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let used = tmp.path().join("used");
        std::fs::create_dir_all(used.join("versions")).unwrap();

        assert_eq!(
            inspect_game_directory(&tmp.path().join("missing")).await,
            GameDirectoryInspection {
                exists: false,
                has_versions: false
            }
        );
        assert_eq!(
            inspect_game_directory(&empty).await,
            GameDirectoryInspection {
                exists: true,
                has_versions: false
            }
        );
        assert_eq!(
            inspect_game_directory(&used).await,
            GameDirectoryInspection {
                exists: true,
                has_versions: true
            }
        );
    }

    /// 首次启动：建目录、切过去、收下勾选的文件夹、标记完成；之后不再是首次启动。
    #[tokio::test]
    async fn first_run_roundtrip_through_config_store() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");
        let mut aurora = Aurora::open(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            config_path.clone(),
        )
        .unwrap();
        assert!(aurora.is_first_run());

        let chosen = tmp.path().join("Games").join(".minecraft");
        let chosen = validate_game_dir(&chosen.display().to_string()).unwrap();
        let baseline = aurora.first_run_baseline(probe_dir(aurora.game_dir()).await);
        ensure_game_dir(&chosen).await.unwrap();
        assert!(chosen.is_dir(), "目录不存在会自动创建");
        aurora.complete_first_run(
            &baseline,
            chosen.clone(),
            vec![
                named("HMCL", "D:/HMCL/.minecraft"),
                named("自己", chosen.clone()),
            ],
        );
        aurora.save_config().await.unwrap();

        let reloaded = crate::config::ConfigStore::at(&config_path)
            .load()
            .await
            .unwrap();
        assert!(reloaded.first_run_completed);
        assert_eq!(reloaded.game_directory.as_deref(), Some(chosen.as_path()));
        assert_eq!(
            reloaded.extra_game_directories,
            vec![named("HMCL", "D:/HMCL/.minecraft")],
            "与当前目录相同的勾选项不重复记录"
        );
        let reopened = Aurora::open(reloaded, tmp.path().to_path_buf(), config_path).unwrap();
        assert!(!reopened.is_first_run());
        assert_eq!(reopened.game_dir(), chosen);
    }

    /// 回到第一步改了再提交：从基线出发重新套用，结果与只提交最后一次相同。第一次提交建出来的默认目录
    /// 不被当成「原来的当前目录」收进额外目录，取消勾选的文件夹也不留着。
    #[tokio::test]
    async fn recommitting_first_run_replaces_the_previous_choice() {
        let tmp = tempfile::tempdir().unwrap();
        let default_dir = default_game_dir(tmp.path());
        let mut aurora = aurora_at(tmp.path(), &default_dir, Vec::new());
        let baseline = aurora.first_run_baseline(probe_dir(aurora.game_dir()).await);
        assert!(!default_dir.exists(), "向导之前默认目录还没建出来");

        ensure_game_dir(&default_dir).await.unwrap();
        aurora.complete_first_run(
            &baseline,
            default_dir.clone(),
            vec![
                named("HMCL", "D:/HMCL/.minecraft"),
                named("官方启动器", "C:/Users/p/AppData/Roaming/.minecraft"),
            ],
        );
        assert_eq!(aurora.config().extra_game_directories.len(), 2);

        let petal = tmp.path().join("Petal");
        ensure_game_dir(&petal).await.unwrap();
        aurora.complete_first_run(
            &baseline,
            petal.clone(),
            vec![named("官方启动器", "C:/Users/p/AppData/Roaming/.minecraft")],
        );

        assert_eq!(aurora.game_dir(), petal);
        assert_eq!(
            aurora.config().game_directory.as_deref(),
            Some(petal.as_path())
        );
        assert_eq!(
            aurora.config().extra_game_directories,
            vec![named("官方启动器", "C:/Users/p/AppData/Roaming/.minecraft")]
        );
        assert!(aurora.config().first_run_completed);
        let listed: Vec<(PathBuf, bool)> = aurora
            .game_directories()
            .await
            .into_iter()
            .map(|e| (e.path, e.is_current))
            .collect();
        assert_eq!(
            listed,
            vec![
                (petal.clone(), true),
                (
                    PathBuf::from("C:/Users/p/AppData/Roaming/.minecraft"),
                    false
                )
            ]
        );

        // 再改回默认目录：默认目录又是当前，Petal 不留记录
        aurora.complete_first_run(&baseline, default_dir.clone(), Vec::new());
        assert_eq!(aurora.game_dir(), default_dir);
        assert_eq!(
            aurora.config().game_directory,
            None,
            "改回向导之前的当前目录，配置也回到原样"
        );
        assert!(aurora.config().extra_game_directories.is_empty());
    }

    /// 向导之前就有的记录与当时就在盘上的当前目录照常保留：配置损坏后按默认配置重进向导时，
    /// 原来的默认目录里可能有实例，换走了也要能切回来。
    #[tokio::test]
    async fn recommitting_first_run_keeps_what_existed_before_the_wizard() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join("Games").join(".minecraft");
        std::fs::create_dir_all(current.join("versions")).unwrap();
        let mut aurora = aurora_at(
            tmp.path(),
            &current,
            vec![named("PCL2", "E:/PCL2/.minecraft")],
        );
        let baseline = aurora.first_run_baseline(probe_dir(aurora.game_dir()).await);

        let first = tmp.path().join("A");
        ensure_game_dir(&first).await.unwrap();
        aurora.complete_first_run(
            &baseline,
            first.clone(),
            vec![named("HMCL", "D:/HMCL/.minecraft")],
        );
        let second = tmp.path().join("B");
        ensure_game_dir(&second).await.unwrap();
        aurora.complete_first_run(&baseline, second.clone(), Vec::new());

        assert_eq!(aurora.game_dir(), second);
        assert_eq!(
            aurora.config().extra_game_directories,
            vec![named("PCL2", "E:/PCL2/.minecraft"), named("Games", current)]
        );
    }

    #[tokio::test]
    async fn ensure_game_dir_reports_io_failure_with_path() {
        let tmp = tempfile::tempdir().unwrap();
        // 父路径是个文件：建目录必然失败。
        let file = tmp.path().join("occupied");
        std::fs::write(&file, b"x").unwrap();
        let target = file.join(".minecraft");
        let err = ensure_game_dir(&target).await.unwrap_err();
        assert!(
            matches!(&err, CoreError::Base(aurora_base::Error::Io { path, .. }) if path == &target),
            "实际：{err:?}"
        );
    }
}
