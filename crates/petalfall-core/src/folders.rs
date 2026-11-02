//! 游戏目录（`.minecraft`）的发现、并存与切换，以及首次启动的落盘。
//!
//! 一台机器上常常同时存在好几个 `.minecraft`：官方启动器的、PCL2 或 HMCL 的、以及本启动器自己的。
//! 这里把它们一并列出来让玩家在其间切换，而不是逼他把攒了多年的存档搬过来。
//!
//! 「当前目录」只有一个（[`PetalfallConfig::game_directory`]，安装与启动真正落盘的地方），其余记在
//! [`PetalfallConfig::extra_game_directories`] 里。切换目录就是把候选提为当前、把原来的当前收进候选。
//!
//! 记录过的目录可能此刻访问不到（外置硬盘没插、网络盘断开），对这类路径做 `is_dir` 可能阻塞数秒，
//! 所以一切磁盘探测都放进阻塞线程池并限时：超时按「不可达」处理，记录照样保留、照样列出。
//!
//! [`PetalfallConfig::game_directory`]: crate::config::PetalfallConfig::game_directory
//! [`PetalfallConfig::extra_game_directories`]: crate::config::PetalfallConfig::extra_game_directories

use std::path::{Path, PathBuf};
use std::time::Duration;

use petalfall_instance::{MINECRAFT_DIR_NAME, list_version_dirs, official_minecraft_dir};
use tokio::time::Instant;

use crate::config::{NamedDirectory, ParkedDirectory};
use crate::error::{CoreError, GameDirProblem, Result};
use crate::facade::Petalfall;

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
    /// `versions/` 下的版本目录数，口径同 [`list_version_dirs`]，没有 `versions/` 算 0。
    /// 不可达、探测超时或读取失败时为 `None`：这时并不知道里面有多少，不能说成 0。
    pub version_count: Option<u32>,
}

/// 一轮探测对一个游戏目录的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GameDirProbe {
    available: bool,
    version_count: Option<u32>,
}

impl GameDirProbe {
    const UNREACHABLE: Self = Self {
        available: false,
        version_count: None,
    };
}

/// 首次启动向导第一步之前的目录记录，由 [`Petalfall::first_run_baseline`] 取得。
///
/// 第一步可以提交不止一次：离开第一步就提交，用户回到第一步改了目录或勾选再离开时重新提交。
/// 每次提交都从这份记录出发套用本次的选择（[`Petalfall::complete_first_run`]），前几次提交设下的
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

/// 切换游戏目录之前对当前目录做的一次限时探测，由 [`Petalfall::probe_current_game_dir`] 取得。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentDirProbe {
    path: PathBuf,
    exists: bool,
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

/// 探测一个游戏目录：先确认可达，再数版本，两步共用一个 [`DIR_PROBE_TIMEOUT`]。
///
/// 必须先确认可达：盘拔掉时读 `versions/` 报的同样是 NotFound，直接数会把不可达说成 0 个版本。
/// 两步各给一份时限的话，一个挂起的目录要拖住列表两倍时间。数不出来不影响 `available`：
/// 目录确实能访问，只是不知道版本数。
async fn probe_game_dir(
    path: &Path,
    reachable: impl Future<Output = bool>,
    versions: impl Future<Output = petalfall_instance::Result<Option<Vec<String>>>>,
) -> GameDirProbe {
    let deadline = Instant::now() + DIR_PROBE_TIMEOUT;
    if !reachable.await {
        tracing::info!(path = %path.display(), "目录不可达，版本数按未知处理");
        return GameDirProbe::UNREACHABLE;
    }
    let version_count = match tokio::time::timeout_at(deadline, versions).await {
        Ok(Ok(Some(names))) => Some(names.len() as u32),
        // 还没装过东西的目录没有 versions/，这是确切的 0 个，不是不知道。
        Ok(Ok(None)) => Some(0),
        Ok(Err(error)) => {
            tracing::warn!(path = %path.display(), %error, "读取版本目录失败，版本数按未知处理");
            None
        }
        Err(_) => {
            tracing::info!(path = %path.display(), "读取版本目录超时，版本数按未知处理");
            None
        }
    };
    GameDirProbe {
        available: true,
        version_count,
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
            CoreError::Base(petalfall_base::Error::Io {
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

impl Petalfall {
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
    /// [`Petalfall::save_config`] 完成。
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

    /// 列出全部已知游戏目录：当前目录在前，其余按记录顺序；各目录并发限时探测是否可达与版本数。
    pub async fn game_directories(&self) -> Vec<GameDirectoryEntry> {
        let current = self.game_dir().to_path_buf();
        let mut listed = vec![(self.directory_name(&current), current.clone(), true)];
        for extra in &self.config().extra_game_directories {
            // 当前目录同时被记进额外列表时只留一条：它已经在最前面了。
            if !same_path(&extra.path, &current) {
                listed.push((extra.name.clone(), extra.path.clone(), false));
            }
        }
        let paths = listed.iter().map(|(_, path, _)| path.clone());
        let probes = probe_each(paths, GameDirProbe::UNREACHABLE, |path| async move {
            probe_game_dir(&path, probe_dir(&path), list_version_dirs(&path)).await
        })
        .await;
        listed
            .into_iter()
            .zip(probes)
            .map(|((name, path, is_current), probe)| GameDirectoryEntry {
                name,
                path,
                is_current,
                available: probe.available,
                version_count: probe.version_count,
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

    /// 限时探测此刻的当前目录在不在盘上，交给 [`Petalfall::switch_game_directory`]。
    ///
    /// 要在拿门面写锁之前做：玩家多半正是因为当前目录所在的网络盘断了才要切走，对它同步 `is_dir`
    /// 会卡上几十秒，持着写锁卡住，所有读配置的命令跟着排队，整个界面停住。
    pub async fn probe_current_game_dir(&self) -> CurrentDirProbe {
        let path = self.game_dir().to_path_buf();
        let exists = probe_dir(&path).await;
        CurrentDirProbe { path, exists }
    }

    /// 把某个目录提为当前游戏目录。
    ///
    /// 原来的当前目录若在盘上存在就收进额外目录，否则切过去就再也找不回来了；从没建出来过的
    /// 默认目录不收，免得列表里多一条永远不可达的记录。在不在盘上看 `probe`（见
    /// [`Petalfall::probe_current_game_dir`]），这里不碰磁盘。探测之后当前目录已被换过时，探测结果
    /// 说的不是它，按存在处理：多留一条不可达的记录无害，丢掉一个有存档的目录就找不回来了。
    pub fn switch_game_directory(&mut self, path: impl Into<PathBuf>, probe: &CurrentDirProbe) {
        let previous_exists = probe.exists || !same_path(&probe.path, self.game_dir());
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
                    path: previous.clone(),
                });
            }
        }
        self.swap_directory_refs(previous, &next);
        self.set_game_directory(next);
    }

    /// 收起 `previous` 的固定与当前选中，放回 `next` 上次留下的。留在原位的话，在新目录里固定一个实例
    /// （新建实例也会自动固定）就把原目录的固定整份冲掉了：写固定时只认当前目录里的实例。
    fn swap_directory_refs(&mut self, previous: PathBuf, next: &Path) {
        let config = self.config_mut();
        let sidebar_pins = std::mem::take(&mut config.sidebar_pins);
        let selected_version = config.selected_version.take();
        if !sidebar_pins.is_empty() || selected_version.is_some() {
            config.parked_directories.push(ParkedDirectory {
                path: previous,
                sidebar_pins,
                selected_version,
            });
        }
        if let Some(index) = config
            .parked_directories
            .iter()
            .position(|d| same_path(&d.path, next))
        {
            let parked = config.parked_directories.remove(index);
            config.sidebar_pins = parked.sidebar_pins;
            config.selected_version = parked.selected_version;
        }
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
            return petalfall_base::brand::APP_NAME.to_owned();
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
    probe_each(paths, false, |path| async move { probe_dir(&path).await }).await
}

/// 每条路径一个任务并发探测，结果与输入一一对应；任务异常结束的位置留 `failed`。
///
/// 挂起的路径只耗尽它自己的时限：整轮最多等一个时限，其余路径的结果也不受牵连。
async fn probe_each<T, Fut>(
    paths: impl Iterator<Item = PathBuf>,
    failed: T,
    probe: impl Fn(PathBuf) -> Fut,
) -> Vec<T>
where
    T: Copy + Send + 'static,
    Fut: Future<Output = T> + Send + 'static,
{
    let mut set = tokio::task::JoinSet::new();
    let mut out = Vec::new();
    for (index, path) in paths.enumerate() {
        out.push(failed);
        let probing = probe(path);
        set.spawn(async move { (index, probing.await) });
    }
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((index, result)) => out[index] = result,
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
    use crate::config::PetalfallConfig;

    fn petalfall_at(data_dir: &Path, game_dir: &Path, extras: Vec<NamedDirectory>) -> Petalfall {
        let config = PetalfallConfig {
            extra_game_directories: extras,
            ..PetalfallConfig::default()
        };
        Petalfall::for_test(config, data_dir.to_path_buf(), game_dir.to_path_buf())
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
        let mut petalfall = petalfall_at(tmp.path(), &tmp.path().join(".minecraft"), Vec::new());

        petalfall.add_game_directory("旧名", "E:\\Games\\.minecraft");
        petalfall.add_game_directory("新名", "e:/games/.minecraft/");

        let extras = &petalfall.config().extra_game_directories;
        assert_eq!(extras.len(), 1);
        assert_eq!(extras[0].name, "新名");

        // 与当前目录相同的不会被记成额外目录。
        let current = petalfall.game_dir().to_path_buf();
        petalfall.add_game_directory("自己", current);
        assert_eq!(petalfall.config().extra_game_directories.len(), 1);
    }

    #[test]
    fn remove_game_directory_reports_whether_anything_went() {
        let tmp = tempfile::tempdir().unwrap();
        let mut petalfall = petalfall_at(
            tmp.path(),
            &tmp.path().join(".minecraft"),
            vec![named("PCL2", "E:\\PCL2\\.minecraft")],
        );
        assert!(petalfall.remove_game_directory(Path::new("e:/pcl2/.minecraft")));
        assert!(petalfall.config().extra_game_directories.is_empty());
        assert!(!petalfall.remove_game_directory(Path::new("E:\\PCL2\\.minecraft")));
    }

    /// 切换把原当前目录（在盘上存在时）收进额外目录，目标从额外目录里摘掉。
    #[tokio::test(start_paused = true)]
    async fn switch_keeps_existing_previous_directory_reachable() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join("Games").join(".minecraft");
        std::fs::create_dir_all(&current).unwrap();
        let mut petalfall = petalfall_at(
            tmp.path(),
            &current,
            vec![named("PCL2", "E:\\PCL2\\.minecraft")],
        );

        let probe = petalfall.probe_current_game_dir().await;
        petalfall.switch_game_directory("E:\\PCL2\\.minecraft", &probe);

        assert_eq!(petalfall.game_dir(), Path::new("E:\\PCL2\\.minecraft"));
        assert_eq!(
            petalfall.config().game_directory.as_deref(),
            Some(Path::new("E:\\PCL2\\.minecraft"))
        );
        let extras = &petalfall.config().extra_game_directories;
        assert_eq!(extras, &vec![named("Games", current)]);
    }

    /// 固定与当前选中是实例名，只属于它们所在的目录：切走时收起来，切回来原样放回，在别的目录里改固定、
    /// 选别的实例都不影响这份。
    #[tokio::test(start_paused = true)]
    async fn each_directory_keeps_its_own_pins_and_selection_across_switches() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("first").join(".minecraft");
        let second = tmp.path().join("second").join(".minecraft");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let mut petalfall = petalfall_at(tmp.path(), &first, Vec::new());
        let pins = vec!["生存".to_owned(), "建筑".to_owned()];
        petalfall.set_sidebar_pins(pins.clone());
        petalfall.set_selected_version(Some("建筑".to_owned()));

        let probe = petalfall.probe_current_game_dir().await;
        petalfall.switch_game_directory(&second, &probe);
        assert!(petalfall.config().sidebar_pins.is_empty());
        assert_eq!(petalfall.config().selected_version, None);

        petalfall.set_sidebar_pins(vec!["第二目录".to_owned()]);
        petalfall.set_selected_version(Some("第二目录".to_owned()));
        let probe = petalfall.probe_current_game_dir().await;
        petalfall.switch_game_directory(&first, &probe);
        assert_eq!(petalfall.config().sidebar_pins, pins);
        assert_eq!(petalfall.config().selected_version.as_deref(), Some("建筑"));

        let probe = petalfall.probe_current_game_dir().await;
        petalfall.switch_game_directory(&second, &probe);
        assert_eq!(petalfall.config().sidebar_pins, vec!["第二目录".to_owned()]);
        assert_eq!(
            petalfall.config().selected_version.as_deref(),
            Some("第二目录")
        );
        assert_eq!(
            petalfall.config().parked_directories.len(),
            1,
            "切回来的目录不留第二份记录"
        );
    }

    /// 切到当前目录本身什么都不动，固定与当前选中还在原位。
    #[tokio::test(start_paused = true)]
    async fn switching_to_the_same_directory_keeps_pins_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join(".minecraft");
        std::fs::create_dir_all(&current).unwrap();
        let mut petalfall = petalfall_at(tmp.path(), &current, Vec::new());
        petalfall.set_sidebar_pins(vec!["生存".to_owned()]);
        petalfall.set_selected_version(Some("生存".to_owned()));

        let probe = petalfall.probe_current_game_dir().await;
        petalfall.switch_game_directory(&current, &probe);

        assert_eq!(petalfall.config().sidebar_pins, vec!["生存".to_owned()]);
        assert_eq!(petalfall.config().selected_version.as_deref(), Some("生存"));
        assert!(petalfall.config().parked_directories.is_empty());
    }

    /// 从没建出来过的默认目录不收进额外目录，免得列表里多一条永远不可达的记录。
    #[tokio::test(start_paused = true)]
    async fn switch_drops_never_created_previous_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let default_dir = default_game_dir(tmp.path());
        let mut petalfall = petalfall_at(tmp.path(), &default_dir, Vec::new());
        let target = tmp.path().join("elsewhere");

        let probe = petalfall.probe_current_game_dir().await;
        petalfall.switch_game_directory(&target, &probe);

        assert_eq!(petalfall.game_dir(), target);
        assert!(petalfall.config().extra_game_directories.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn switching_to_the_same_directory_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join(".minecraft");
        std::fs::create_dir_all(&current).unwrap();
        let mut petalfall = petalfall_at(tmp.path(), &current, Vec::new());

        let probe = petalfall.probe_current_game_dir().await;
        petalfall.switch_game_directory(&current, &probe);
        petalfall.switch_game_directory(current.display().to_string().to_uppercase(), &probe);

        assert!(petalfall.config().extra_game_directories.is_empty());
        assert!(
            petalfall.config().game_directory.is_none(),
            "没有真正切换就不写配置"
        );
    }

    /// 切换时不看盘，只认拿锁之前那次探测：探测时还在、切换前一刻断开的网络盘目录照样收下，探测时就不在的
    /// 不收。切换自己去访问磁盘的话，挂起的网络盘会让它持着门面写锁一直卡着。
    #[tokio::test(start_paused = true)]
    async fn switch_decides_from_the_probe_taken_before_the_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join("NAS").join(".minecraft");
        std::fs::create_dir_all(&current).unwrap();
        let mut petalfall = petalfall_at(tmp.path(), &current, Vec::new());
        let probe = petalfall.probe_current_game_dir().await;
        std::fs::remove_dir_all(tmp.path().join("NAS")).unwrap();

        let local = tmp.path().join("Local");
        petalfall.switch_game_directory(&local, &probe);
        assert_eq!(petalfall.game_dir(), local);
        assert_eq!(
            petalfall.config().extra_game_directories,
            vec![named("NAS", current.clone())]
        );

        let missing = petalfall.probe_current_game_dir().await;
        std::fs::create_dir_all(&local).unwrap();
        petalfall.switch_game_directory(&current, &missing);
        assert_eq!(petalfall.game_dir(), current);
        assert!(
            petalfall.config().extra_game_directories.is_empty(),
            "探测时不在的目录不收：{:?}",
            petalfall.config().extra_game_directories
        );
    }

    /// 探测之后当前目录已被别的命令换掉：探测说的不是它，宁可多留一条记录，也不把它当成不存在丢掉。
    #[tokio::test(start_paused = true)]
    async fn stale_probe_keeps_the_directory_it_did_not_look_at() {
        let tmp = tempfile::tempdir().unwrap();
        let never_created = default_game_dir(tmp.path());
        let mut petalfall = petalfall_at(tmp.path(), &never_created, Vec::new());
        let stale = petalfall.probe_current_game_dir().await;

        let games = tmp.path().join("Games").join(".minecraft");
        petalfall.switch_game_directory(&games, &stale);
        assert!(petalfall.config().extra_game_directories.is_empty());

        let target = tmp.path().join("Other");
        petalfall.switch_game_directory(&target, &stale);
        assert_eq!(petalfall.game_dir(), target);
        assert_eq!(
            petalfall.config().extra_game_directories,
            vec![named("Games", games)]
        );
    }

    /// 当前目录在最前；不可达的额外目录照样列出，只是 available 为假。
    #[tokio::test(start_paused = true)]
    async fn game_directories_keeps_unavailable_entries_visible() {
        let tmp = tempfile::tempdir().unwrap();
        let current = default_game_dir(tmp.path());
        std::fs::create_dir_all(&current).unwrap();
        let gone = tmp.path().join("unplugged").join(".minecraft");
        let petalfall = petalfall_at(
            tmp.path(),
            &current,
            vec![
                named("外置盘", gone.clone()),
                named("重复记录", current.clone()),
            ],
        );

        let listed = petalfall.game_directories().await;
        assert_eq!(
            listed,
            vec![
                GameDirectoryEntry {
                    name: "重复记录".to_owned(),
                    path: current,
                    is_current: true,
                    available: true,
                    version_count: Some(0),
                },
                GameDirectoryEntry {
                    name: "外置盘".to_owned(),
                    path: gone,
                    is_current: false,
                    available: false,
                    version_count: None,
                },
            ]
        );
    }

    /// 版本数与 `list_version_dirs` 同口径：文件和点开头的目录不算；没有 `versions/` 与空的 `versions/`
    /// 都是确切的 0。访问不到的目录是未知而不是 0，空着的目录和拔掉的盘在界面上要分得开。
    /// 版本数取到超过异步目录读取的单批条数，确认跨批也数得全。
    #[tokio::test(start_paused = true)]
    async fn game_directories_tell_version_counts_from_unknown() {
        let tmp = tempfile::tempdir().unwrap();
        let current = default_game_dir(tmp.path());
        let versions = current.join("versions");
        let installed = fastrand::usize(33..=64);
        for index in 0..installed {
            std::fs::create_dir_all(versions.join(format!("实例 {index}"))).unwrap();
        }
        std::fs::create_dir_all(versions.join(".petalfall")).unwrap();
        std::fs::write(versions.join("usercache.json"), b"[]").unwrap();
        let no_versions = tmp.path().join("PCL").join(".minecraft");
        std::fs::create_dir_all(&no_versions).unwrap();
        let empty_versions = tmp.path().join("HMCL").join(".minecraft");
        std::fs::create_dir_all(empty_versions.join("versions")).unwrap();
        let one_version = tmp.path().join("Games").join(".minecraft");
        std::fs::create_dir_all(one_version.join("versions").join("1.21.1")).unwrap();
        let unplugged = tmp.path().join("unplugged").join(".minecraft");
        let petalfall = petalfall_at(
            tmp.path(),
            &current,
            vec![
                named("PCL", no_versions),
                named("HMCL", empty_versions),
                named("Games", one_version),
                named("外置盘", unplugged),
            ],
        );

        let counts: Vec<(bool, Option<u32>)> = petalfall
            .game_directories()
            .await
            .into_iter()
            .map(|e| (e.available, e.version_count))
            .collect();
        assert_eq!(
            counts,
            vec![
                (true, Some(installed as u32)),
                (true, Some(0)),
                (true, Some(0)),
                (true, Some(1)),
                (false, None),
            ]
        );
    }

    /// `versions` 被一个同名文件占着：目录能访问，但版本目录读不出来，不能说成 0 个。
    #[tokio::test(start_paused = true)]
    async fn versions_occupied_by_a_file_is_unknown_not_zero() {
        let tmp = tempfile::tempdir().unwrap();
        let current = default_game_dir(tmp.path());
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("versions"), b"x").unwrap();
        let petalfall = petalfall_at(tmp.path(), &current, Vec::new());

        let listed = petalfall.game_directories().await;
        assert_eq!(listed.len(), 1);
        assert!(listed[0].available);
        assert_eq!(listed[0].version_count, None);
    }

    /// 被测逻辑丢了时限时让测试挂掉，而不是永远等下去；同时量出花了多久。
    async fn within_time_limit<F: Future>(probing: F) -> (F::Output, Duration) {
        let started = Instant::now();
        let output = tokio::time::timeout(DIR_PROBE_TIMEOUT * 20, probing)
            .await
            .expect("探测没有在时限内结束");
        (output, started.elapsed())
    }

    const REACHED_BUT_UNCOUNTED: GameDirProbe = GameDirProbe {
        available: true,
        version_count: None,
    };

    #[tokio::test(start_paused = true)]
    async fn unreadable_versions_is_unknown_but_directory_stays_available() {
        let failing = async {
            Err(petalfall_instance::Error::Io {
                path: PathBuf::from("N:/.minecraft/versions"),
                source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            })
        };

        let probe = probe_game_dir(Path::new("N:/.minecraft"), async { true }, failing).await;

        assert_eq!(probe, REACHED_BUT_UNCOUNTED);
    }

    /// 读 `versions/` 挂住时，时限一到就放弃数版本；目录本身已经确认可达，不能因此变成不可达。
    #[tokio::test(start_paused = true)]
    async fn stuck_listing_gives_up_at_the_limit_and_keeps_availability() {
        let (probe, elapsed) = within_time_limit(probe_game_dir(
            Path::new("N:/.minecraft"),
            async { true },
            std::future::pending(),
        ))
        .await;

        assert_eq!(probe, REACHED_BUT_UNCOUNTED);
        assert!(elapsed >= DIR_PROBE_TIMEOUT, "提前放弃了：{elapsed:?}");
        assert!(elapsed < DIR_PROBE_TIMEOUT * 2, "等太久：{elapsed:?}");
    }

    /// 可达判断与数版本共用一个时限：前一步慢了，后一步只有余下的时间，一个目录不会等到两倍。
    #[tokio::test(start_paused = true)]
    async fn reachability_and_counting_share_one_limit() {
        let slow_reachable = async {
            tokio::time::sleep(DIR_PROBE_TIMEOUT * 3 / 4).await;
            true
        };

        let (probe, elapsed) = within_time_limit(probe_game_dir(
            Path::new("N:/.minecraft"),
            slow_reachable,
            std::future::pending(),
        ))
        .await;

        assert_eq!(probe, REACHED_BUT_UNCOUNTED);
        assert!(elapsed >= DIR_PROBE_TIMEOUT, "提前放弃了：{elapsed:?}");
        assert!(
            elapsed < DIR_PROBE_TIMEOUT * 5 / 4,
            "时限被累加了：{elapsed:?}"
        );
    }

    /// 不可达的目录一个字节都不读：盘已经挂住了，再派一个阻塞线程去读 `versions/` 只会多卡死一个。
    #[tokio::test(start_paused = true)]
    async fn unreachable_directory_is_never_listed() {
        let probe = probe_game_dir(Path::new("N:/.minecraft"), async { false }, async {
            panic!("不可达的目录不该去读 versions/")
        })
        .await;

        assert_eq!(probe, GameDirProbe::UNREACHABLE);
    }

    /// 几个挂起的目录并发等，整轮只耗一个时限，不随目录数累加；健康的目录不受牵连，照样拿到版本数。
    #[tokio::test(start_paused = true)]
    async fn stuck_directories_share_one_limit_and_spare_healthy_ones() {
        let healthy = PathBuf::from("D:/Games/.minecraft");
        let paths = vec![
            PathBuf::from("N:/a/.minecraft"),
            healthy.clone(),
            PathBuf::from("N:/b/.minecraft"),
            PathBuf::from("N:/c/.minecraft"),
        ];

        let (probes, elapsed) = within_time_limit(probe_each(
            paths.into_iter(),
            GameDirProbe::UNREACHABLE,
            |path| {
                let is_healthy = path == healthy;
                async move {
                    let listing = async move {
                        if is_healthy {
                            Ok(Some(vec!["1.21.1".to_owned(), "生存".to_owned()]))
                        } else {
                            std::future::pending().await
                        }
                    };
                    probe_game_dir(&path, async { true }, listing).await
                }
            },
        ))
        .await;

        let counted = GameDirProbe {
            available: true,
            version_count: Some(2),
        };
        assert_eq!(
            probes,
            vec![
                REACHED_BUT_UNCOUNTED,
                counted,
                REACHED_BUT_UNCOUNTED,
                REACHED_BUT_UNCOUNTED,
            ]
        );
        assert!(elapsed < DIR_PROBE_TIMEOUT * 2, "时限被累加了：{elapsed:?}");
    }

    #[test]
    fn directory_name_prefers_record_then_brand_then_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(
            tmp.path(),
            &tmp.path().join(".minecraft"),
            vec![named("我的整合", "D:/Packs/.minecraft")],
        );
        assert_eq!(
            petalfall.directory_name(Path::new("d:\\packs\\.minecraft")),
            "我的整合"
        );
        assert_eq!(
            petalfall.directory_name(&default_game_dir(tmp.path())),
            petalfall_base::brand::APP_NAME
        );
        assert_eq!(
            petalfall.directory_name(Path::new("E:/Games/.minecraft")),
            "Games"
        );
        assert_eq!(petalfall.directory_name(Path::new("E:/Games/mc")), "mc");
    }

    #[tokio::test(start_paused = true)]
    async fn discover_skips_known_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let known: Vec<NamedDirectory> = sibling_launcher_dirs();
        let petalfall = petalfall_at(tmp.path(), &tmp.path().join(".minecraft"), known.clone());
        let found = petalfall.discover_game_directories().await;
        assert!(
            !found
                .iter()
                .any(|d| known.iter().any(|k| same_path(&k.path, &d.path))),
            "已记录的目录不应再被当成新发现：{found:?}"
        );
    }

    #[tokio::test(start_paused = true)]
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
    #[tokio::test(start_paused = true)]
    async fn first_run_roundtrip_through_config_store() {
        let tmp = tempfile::tempdir().unwrap();
        let config_path = tmp.path().join("config.json");
        let mut petalfall = Petalfall::open(
            PetalfallConfig::default(),
            tmp.path().to_path_buf(),
            config_path.clone(),
        )
        .unwrap();
        assert!(petalfall.is_first_run());

        let chosen = tmp.path().join("Games").join(".minecraft");
        let chosen = validate_game_dir(&chosen.display().to_string()).unwrap();
        let baseline = petalfall.first_run_baseline(probe_dir(petalfall.game_dir()).await);
        ensure_game_dir(&chosen).await.unwrap();
        assert!(chosen.is_dir(), "目录不存在会自动创建");
        petalfall.complete_first_run(
            &baseline,
            chosen.clone(),
            vec![
                named("HMCL", "D:/HMCL/.minecraft"),
                named("自己", chosen.clone()),
            ],
        );
        petalfall.save_config().await.unwrap();

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
        let reopened = Petalfall::open(reloaded, tmp.path().to_path_buf(), config_path).unwrap();
        assert!(!reopened.is_first_run());
        assert_eq!(reopened.game_dir(), chosen);
    }

    /// 回到第一步改了再提交：从基线出发重新套用，结果与只提交最后一次相同。第一次提交建出来的默认目录
    /// 不被当成「原来的当前目录」收进额外目录，取消勾选的文件夹也不留着。
    #[tokio::test(start_paused = true)]
    async fn recommitting_first_run_replaces_the_previous_choice() {
        let tmp = tempfile::tempdir().unwrap();
        let default_dir = default_game_dir(tmp.path());
        let mut petalfall = petalfall_at(tmp.path(), &default_dir, Vec::new());
        let baseline = petalfall.first_run_baseline(probe_dir(petalfall.game_dir()).await);
        assert!(!default_dir.exists(), "向导之前默认目录还没建出来");

        ensure_game_dir(&default_dir).await.unwrap();
        petalfall.complete_first_run(
            &baseline,
            default_dir.clone(),
            vec![
                named("HMCL", "D:/HMCL/.minecraft"),
                named("官方启动器", "C:/Users/p/AppData/Roaming/.minecraft"),
            ],
        );
        assert_eq!(petalfall.config().extra_game_directories.len(), 2);

        let petal = tmp.path().join("Petal");
        ensure_game_dir(&petal).await.unwrap();
        petalfall.complete_first_run(
            &baseline,
            petal.clone(),
            vec![named("官方启动器", "C:/Users/p/AppData/Roaming/.minecraft")],
        );

        assert_eq!(petalfall.game_dir(), petal);
        assert_eq!(
            petalfall.config().game_directory.as_deref(),
            Some(petal.as_path())
        );
        assert_eq!(
            petalfall.config().extra_game_directories,
            vec![named("官方启动器", "C:/Users/p/AppData/Roaming/.minecraft")]
        );
        assert!(petalfall.config().first_run_completed);
        let listed: Vec<(PathBuf, bool)> = petalfall
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
        petalfall.complete_first_run(&baseline, default_dir.clone(), Vec::new());
        assert_eq!(petalfall.game_dir(), default_dir);
        assert_eq!(
            petalfall.config().game_directory,
            None,
            "改回向导之前的当前目录，配置也回到原样"
        );
        assert!(petalfall.config().extra_game_directories.is_empty());
    }

    /// 向导之前就有的记录与当时就在盘上的当前目录照常保留：配置损坏后按默认配置重进向导时，
    /// 原来的默认目录里可能有实例，换走了也要能切回来。
    #[tokio::test(start_paused = true)]
    async fn recommitting_first_run_keeps_what_existed_before_the_wizard() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join("Games").join(".minecraft");
        std::fs::create_dir_all(current.join("versions")).unwrap();
        let mut petalfall = petalfall_at(
            tmp.path(),
            &current,
            vec![named("PCL2", "E:/PCL2/.minecraft")],
        );
        let baseline = petalfall.first_run_baseline(probe_dir(petalfall.game_dir()).await);

        let first = tmp.path().join("A");
        ensure_game_dir(&first).await.unwrap();
        petalfall.complete_first_run(
            &baseline,
            first.clone(),
            vec![named("HMCL", "D:/HMCL/.minecraft")],
        );
        let second = tmp.path().join("B");
        ensure_game_dir(&second).await.unwrap();
        petalfall.complete_first_run(&baseline, second.clone(), Vec::new());

        assert_eq!(petalfall.game_dir(), second);
        assert_eq!(
            petalfall.config().extra_game_directories,
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
            matches!(&err, CoreError::Base(petalfall_base::Error::Io { path, .. }) if path == &target),
            "实际：{err:?}"
        );
    }
}
