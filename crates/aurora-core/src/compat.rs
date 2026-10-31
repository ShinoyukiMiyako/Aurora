//! 兼容性判定与实例匹配。
//!
//! 下载页的落位层要回答一个问题：「这个 Mod 该装进哪个实例」。答案由两部分组成——纯判定
//! （[`classify`]：某个版本对某组实例事实是否可用）与编排（把判定结果铺成全部已装实例的矩阵）。
//! 判定被刻意做成不带 `self` 的自由函数，边界情形（平台没给加载器、实例是原版、MC 版本对不上）
//! 才有可能被单元测试逐条钉死。
//!
//! 三态而非布尔是关键决策：平台元数据本来就不完整（CurseForge 早期文件常常既没标加载器也没标
//! MC 版本），把「不知道」压成「不兼容」会让一大批本可正常使用的 Mod 在 UI 上凭空消失。
//! 因此 [`Compatibility::Unknown`] 在界面上是软提示、仍然放行，只有确凿对不上才判
//! [`Compatibility::Mismatch`]；两者都附一句给玩家看的中文原因——「装不了」与「拿不准」都必须
//! 同时说明「为什么」。
//!
//! 资源包、光影、数据包也走同一张矩阵，但只判 MC 版本一维（[`classify_game_version`]）：它们由游戏本体
//! （光影由 Iris / OptiFine）读取，与实例装的 Mod 加载器无关。

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use aurora_instance::{DiscoveredVersion, discover_versions};
use aurora_modplatform::{
    ModLoader, ModVersionInfo, Platform, ResourceType, parse_loader_name, scan_mods_dir_cached,
};
use aurora_version::identify_mc_version;
use serde::Serialize;

use crate::error::{CoreError, Result};
use crate::facade::Aurora;
use crate::modfs::{bounded_map, ledger_key, local_concurrency, try_exists};
use crate::modversions::sort_by_published_desc;

/// 某版本对某实例的兼容判定。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Compatibility {
    /// MC 版本与加载器都对上。
    Match,
    /// 平台没给足够元数据或认不出实例版本，无法判断（不等于不兼容，UI 上作软提示放行）。
    Unknown { reason: String },
    /// 明确对不上，`reason` 是给玩家看的一句中文说明。
    Mismatch { reason: String },
}

/// 落位层的四态结论：在兼容判定之上叠加「这个工程是否已经装在该实例里」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchState {
    /// 兼容且未装。
    Compatible,
    /// 可能可行且未装（原因见 [`Compatibility::Unknown`]）。
    Maybe,
    /// 已装（启用或禁用态）。是否有可换的新版由 `best_version` 与已装版本比较得出。
    Installed,
    /// 不兼容且未装（原因见 [`Compatibility::Mismatch`]）。
    Incompatible,
}

/// 该工程已装在实例里的那份文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstalledCopy {
    /// Mod 为启用态文件名（卷宗的 join 键；磁盘上可能多一个 `.disabled` 后缀）；资源包、光影、
    /// 数据包为盘上的文件名。
    pub file_name: String,
    /// 已装的平台版本标识。
    pub version_id: String,
    /// 已装的版本号；卷宗里没记为 `None`。
    pub version_number: Option<String>,
    /// 数据包装在哪个存档（存档目录名）；其余类型为 `None`。
    pub world: Option<String>,
}

impl InstalledCopy {
    fn of_version(version: &ModVersionInfo, world: Option<String>) -> Self {
        Self {
            file_name: version.file_name.clone(),
            version_id: version.version_id.clone(),
            version_number: Some(version.version_number.clone()),
            world,
        }
    }
}

/// 一个已装实例对某工程的匹配结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstanceMatch {
    /// 实例（已安装版本）id。
    pub version_id: String,
    /// 实例的 MC 版本号；版本 JSON 给不出任何线索时为 `None`。
    pub mc_version: Option<String>,
    /// 实例已装的加载器种类（小写名，OptiFine 这类也照实列出）。
    pub loaders: Vec<String>,
    /// 四态结论。
    pub state: MatchState,
    /// 该实例对本工程最佳版本（或调用方指定的版本）的兼容判定。
    pub compatibility: Compatibility,
    /// 该实例下最合适的版本（无可用版本时为 `None`）。
    pub best_version: Option<ModVersionInfo>,
    /// 该工程已装在此实例里时给出已装的那份（据卷宗与磁盘 join）。
    pub installed: Option<InstalledCopy>,
}

/// 加载器的展示名（专有名词，保留原文大小写）。
///
/// 判定结果里的实例加载器是小写技术名，直接塞进中文文案会读成「该实例装的是 neoforge」；
/// 玩家在其它地方看到的一律是 NeoForge，两处不一致会让人怀疑是不是两个东西。
pub(crate) fn loader_display_name(loader: ModLoader) -> &'static str {
    match loader {
        ModLoader::Fabric => "Fabric",
        ModLoader::Quilt => "Quilt",
        ModLoader::Forge => "Forge",
        ModLoader::NeoForge => "NeoForge",
        ModLoader::LiteLoader => "LiteLoader",
    }
}

/// 把一组加载器拼成文案里的一段，如 `Fabric/Quilt`。
fn join_loader_names(loaders: &[ModLoader]) -> String {
    loaders
        .iter()
        .map(|l| loader_display_name(*l))
        .collect::<Vec<_>>()
        .join("/")
}

/// 纯函数：判定某个版本能否用于给定的实例事实。
///
/// `instance_loaders` 取实例已装的加载器名（大小写不敏感，非 Mod 加载器如 OptiFine 会被忽略）。
/// 判定顺序按「越确凿越先判」排：先看加载器（对不上一定装不了），再看 MC 版本，最后才把
/// 元数据缺失归到 [`Compatibility::Unknown`]。
/// `instance_mc_version` 传 `None` 表示「认不出这个实例基于哪个 MC 版本」。此时只判加载器，
/// 版本维度一律归入 [`Compatibility::Unknown`]——拿一个没把握的版本号去比对，得到的
/// 「不支持 MC X」是凭空捏造的结论，比说不知道更糟。
pub fn classify(
    version: &ModVersionInfo,
    instance_mc_version: Option<&str>,
    instance_loaders: &[String],
) -> Compatibility {
    // 实例侧加载器归一后再比对：两个平台与本地探测对同一加载器的写法并不统一。认不出的名字
    // （OptiFine 这类不是 Mod 加载器的东西）不参与交集——把它算作加载器会让原版+OptiFine 的实例
    // 被误判成「装了加载器」，进而给出一条毫无帮助的「需要 Forge，该实例装的是 OptiFine」。
    let instance_kinds: Vec<ModLoader> = instance_loaders
        .iter()
        .filter_map(|name| parse_loader_name(name))
        .collect();

    if !version.loaders.is_empty() {
        if instance_kinds.is_empty() {
            return Compatibility::Mismatch {
                reason: "该实例未安装 Mod 加载器".to_owned(),
            };
        }
        let intersects = version
            .loaders
            .iter()
            .any(|needed| instance_kinds.contains(needed));
        if !intersects {
            return Compatibility::Mismatch {
                reason: format!(
                    "需要 {}，该实例装的是 {}",
                    join_loader_names(&version.loaders),
                    join_loader_names(&instance_kinds)
                ),
            };
        }
    }

    // 加载器这一关已经过了，剩下的 MC 版本一维与资源同一口径。版本维度对得上也不够：加载器一维
    // 平台压根没给时，同样没有资格声称匹配。
    match classify_game_version(version, instance_mc_version) {
        Compatibility::Match if version.loaders.is_empty() => Compatibility::Unknown {
            reason: "平台没有标注这个版本支持的加载器".to_owned(),
        },
        other => other,
    }
}

/// 纯函数：只按 MC 版本判定（资源包、光影、数据包；Mod 判定的版本维度也由它给出）。
///
/// 平台给这几类资源标的「加载器」是 `minecraft`、`iris` 之类的取值，并不是 Mod 加载器；按 Mod 口径判，
/// 认不出的取值成了空列表，每个资源包都会落到「平台没有标注加载器」的可能可行，CurseForge 上偶尔标了
/// Forge 的资源包文件更会在原版实例上被判成不兼容。
pub fn classify_game_version(
    version: &ModVersionInfo,
    instance_mc_version: Option<&str>,
) -> Compatibility {
    // 认不出实例的 MC 版本：版本对不对无从判断，交给用户自行决定。
    let Some(instance_mc_version) = instance_mc_version else {
        return Compatibility::Unknown {
            reason: "认不出该实例基于哪个 MC 版本，无法确认是否适配".to_owned(),
        };
    };
    // 平台没给 MC 版本：不知道就不能声称匹配。
    if version.game_versions.is_empty() {
        return Compatibility::Unknown {
            reason: "平台没有标注这个版本支持的 MC 版本".to_owned(),
        };
    }
    if !version
        .game_versions
        .iter()
        .any(|v| v == instance_mc_version)
    {
        return Compatibility::Mismatch {
            reason: format!("不支持 MC {instance_mc_version}"),
        };
    }
    Compatibility::Match
}

/// 按资源类型选判定口径：只有 Mod 要看加载器。整合包与插件在 [`Aurora::match_instances`] 入口就被拒掉。
fn judge(
    resource_type: ResourceType,
    version: &ModVersionInfo,
    instance_mc_version: Option<&str>,
    instance_loaders: &[String],
) -> Compatibility {
    match resource_type {
        ResourceType::Mod => classify(version, instance_mc_version, instance_loaders),
        _ => classify_game_version(version, instance_mc_version),
    }
}

/// 排序档位：兼容 0 > 可能可行 1 > 已安装 2 > 不兼容 3。
///
/// 落位层默认选中第一项，所以档位序即「替玩家做的那个决定」：能确定装得上的排最前，拿不准的次之，
/// 已经装了的不必再装，确凿装不上的沉底但仍然列出（玩家有权知道它为什么不在候选里）。
fn tier(state: MatchState) -> u8 {
    match state {
        MatchState::Compatible => 0,
        MatchState::Maybe => 1,
        MatchState::Installed => 2,
        MatchState::Incompatible => 3,
    }
}

/// 从版本列表里为一组实例事实挑最合适的版本，并给出该实例的整体判定。
///
/// `versions` 必须已按发布时间倒序：本函数取「第一个能用的」即认作最新可用版本，顺序错了择优就错了。
/// 一旦命中确定匹配立刻返回，不再往下翻旧版本。
///
/// 全部版本都对不上时取「最新那个版本的原因」作为该实例的说明：玩家最可能去试的就是最新版，
/// 拿一个陈年旧版的失败原因去解释当前状况只会误导。
fn pick_best(
    resource_type: ResourceType,
    versions: &[ModVersionInfo],
    instance_mc_version: Option<&str>,
    instance_loaders: &[String],
) -> (Compatibility, Option<ModVersionInfo>) {
    let mut newest_unknown: Option<(&ModVersionInfo, String)> = None;
    let mut newest_reason: Option<String> = None;

    for version in versions {
        match judge(
            resource_type,
            version,
            instance_mc_version,
            instance_loaders,
        ) {
            Compatibility::Match => return (Compatibility::Match, Some(version.clone())),
            Compatibility::Unknown { reason } => {
                if newest_unknown.is_none() {
                    newest_unknown = Some((version, reason));
                }
            }
            Compatibility::Mismatch { reason } => {
                if newest_reason.is_none() {
                    newest_reason = Some(reason);
                }
            }
        }
    }

    if let Some((version, reason)) = newest_unknown {
        return (Compatibility::Unknown { reason }, Some(version.clone()));
    }
    match newest_reason {
        Some(reason) => (Compatibility::Mismatch { reason }, None),
        // 工程一个版本都没有：没东西可装是确凿事实，如实说明，不含糊成「无法判断」。
        None => (
            Compatibility::Mismatch {
                reason: "该工程没有可用版本".to_owned(),
            },
            None,
        ),
    }
}

/// 只判调用方指定的那一个版本（落位层的版本下拉选了具体版本时）。
fn judge_pinned(
    resource_type: ResourceType,
    version: &ModVersionInfo,
    instance_mc_version: Option<&str>,
    instance_loaders: &[String],
) -> (Compatibility, Option<ModVersionInfo>) {
    let compatibility = judge(
        resource_type,
        version,
        instance_mc_version,
        instance_loaders,
    );
    let best = match compatibility {
        Compatibility::Mismatch { .. } => None,
        _ => Some(version.clone()),
    };
    (compatibility, best)
}

/// 实例基于哪个 MC 版本；认不出返回 `None`。
///
/// 走 aurora-version 的完整识别链（inheritsFrom -> clientVersion -> 严格 id -> --fml.mcVersion
/// -> 库坐标 -> id 内嵌子串），与更新检查、依赖计划同一口径。
///
/// 只看 `inheritsFrom`、取不到就回落实例 id 的代价很实际：有些启动器会把加载器 JSON 与原版
/// JSON 合并成一份自包含文件，没有 `inheritsFrom`，于是实例名（`1.20.1-Forge_47.4.20(方块日志)`）
/// 被当成 MC 版本号拿去和 Mod 的 game_versions 求交，永远交不上——整个落位矩阵全判「不兼容」。
pub(crate) fn instance_mc_version(version: &DiscoveredVersion) -> Option<String> {
    identify_mc_version(&version.json)
        .value
        .filter(|v| !v.is_empty())
}

/// 实例已装加载器的小写技术名。OptiFine / LiteLoader 这类也照实列出，由 [`classify`] 自行取舍——
/// 这里的职责是陈述实例事实，不是替判定做筛选。
pub(crate) fn instance_loaders(version: &DiscoveredVersion) -> Vec<String> {
    version
        .loaders
        .iter()
        .map(|loader| loader.kind.as_str().to_ascii_lowercase())
        .collect()
}

/// 实例已装的 Mod 加载器（认不出的名字，即 OptiFine 这类非 Mod 加载器，已剔除）。
pub(crate) fn instance_mod_loaders(version: &DiscoveredVersion) -> Vec<ModLoader> {
    version
        .loaders
        .iter()
        .filter_map(|info| parse_loader_name(info.kind.as_str()))
        .collect()
}

impl Aurora {
    /// 为某工程算出全部已装实例的匹配矩阵，按「兼容 > 可能可行 > 已安装 > 不兼容」排序，
    /// 同档内按实例 id 字典序，保证顺序稳定（UI 默认选中第一项）。
    ///
    /// `mod_version_id` 给出时整个矩阵只按这一个版本判定（落位层的版本下拉选了具体版本）；
    /// 为 `None` 时每个实例各自挑最合适的版本。
    ///
    /// `resource_type` 决定判定口径：Mod 看加载器与 MC 版本，资源包、光影、数据包只看 MC 版本。
    /// 整合包与插件不装进已有实例，传入即报 [`CoreError::InvalidResourceTarget`]。
    ///
    /// 工程版本列表整场只拉一次，之后每个实例都在本地判定；逐实例的「装没装」要读卷宗与扫 mods 目录，
    /// 有界并发执行。逐实例发请求会让装了十来个实例的玩家在点开安装弹层时等上十几个网络来回，还会
    /// 撞上平台限流把后半截请求打成失败。
    pub async fn match_instances(
        &self,
        platform: Platform,
        project_id: &str,
        resource_type: ResourceType,
        mod_version_id: Option<&str>,
    ) -> Result<Vec<InstanceMatch>> {
        if matches!(resource_type, ResourceType::Modpack | ResourceType::Plugin) {
            return Err(CoreError::InvalidResourceTarget(format!(
                "{resource_type:?} 不装进已有实例，没有落位矩阵"
            )));
        }
        // 先扫本地：一个实例都没有时连网络都不必打。矩阵本来就要覆盖全部实例，这里的全量扫描是
        // 必需而不是浪费。
        let scan = discover_versions(self.game_dir()).await?;
        if scan.versions.is_empty() {
            return Ok(Vec::new());
        }

        let (versions, pinned) = match mod_version_id {
            Some(id) => (
                vec![self.get_mod_version(platform, project_id, id).await?],
                true,
            ),
            None => {
                let mut versions = self
                    .list_mod_versions(platform, project_id, &[], &[])
                    .await?;
                // 择优依赖倒序，就地保证一次，不把本函数的正确性押在上游的排序承诺上。
                sort_by_published_desc(&mut versions);
                (versions, false)
            }
        };
        let versions = Arc::new(versions);
        // 资源包、光影、数据包没有卷宗，只能拿盘上的文件去对平台的版本文件，认出装的是哪个版本。
        // 指定了版本时也要整份列表：盘上装的若是别的版本，前端要据此判「可更新」而不是「未安装」。
        // 版本下拉刚拉过这份列表，这里多半命中版本列表缓存。
        let known = if pinned && resource_type != ResourceType::Mod {
            let mut all = self
                .list_mod_versions(platform, project_id, &[], &[])
                .await?;
            sort_by_published_desc(&mut all);
            Arc::new(all)
        } else {
            versions.clone()
        };
        let aurora = self.clone();
        let project = project_id.to_owned();

        let mut matches = bounded_map(scan.versions, local_concurrency(), move |discovered| {
            let aurora = aurora.clone();
            let versions = versions.clone();
            let known = known.clone();
            let project = project.clone();
            async move {
                let mc_version = instance_mc_version(&discovered);
                let loaders = instance_loaders(&discovered);
                let (compatibility, best_version) = if pinned {
                    judge_pinned(resource_type, &versions[0], mc_version.as_deref(), &loaders)
                } else {
                    pick_best(resource_type, &versions, mc_version.as_deref(), &loaders)
                };
                let id = discovered.id.clone();
                let installed = aurora
                    .installed_copy_of(discovered, platform, &project, resource_type, &known)
                    .await?;
                let state = match (&installed, &compatibility) {
                    (Some(_), _) => MatchState::Installed,
                    (None, Compatibility::Match) => MatchState::Compatible,
                    (None, Compatibility::Unknown { .. }) => MatchState::Maybe,
                    (None, Compatibility::Mismatch { .. }) => MatchState::Incompatible,
                };
                Ok(InstanceMatch {
                    version_id: id,
                    mc_version,
                    loaders,
                    state,
                    compatibility,
                    best_version,
                    installed,
                })
            }
        })
        .await?;

        matches.sort_by(|a, b| {
            tier(a.state)
                .cmp(&tier(b.state))
                .then_with(|| a.version_id.cmp(&b.version_id))
        });
        Ok(matches)
    }

    /// 该工程是否已装在这个实例里，按资源类型去游戏读取它的位置找：Mod 在卷宗与 mods 目录，
    /// 资源包在 `resourcepacks/`，光影在 `shaderpacks/`，数据包在任一存档的 `datapacks/`。
    /// `known` 是该工程的版本列表（发布时间倒序），资源包这类没有卷宗的靠它认出盘上的文件。
    async fn installed_copy_of(
        &self,
        discovered: DiscoveredVersion,
        platform: Platform,
        project_id: &str,
        resource_type: ResourceType,
        known: &[ModVersionInfo],
    ) -> Result<Option<InstalledCopy>> {
        let sub = match resource_type {
            ResourceType::Mod => {
                return self
                    .installed_mod_of(discovered, platform, project_id)
                    .await;
            }
            ResourceType::ResourcePack => "resourcepacks",
            ResourceType::Shader => "shaderpacks",
            ResourceType::DataPack => {
                let working = self.instance_dirs(&discovered).await?.working_dir;
                return find_data_pack(&working.join("saves"), known).await;
            }
            ResourceType::Modpack | ResourceType::Plugin => {
                return Err(CoreError::InvalidResourceTarget(format!(
                    "{resource_type:?} 不装进已有实例，没有已装文件"
                )));
            }
        };
        let working = self.instance_dirs(&discovered).await?.working_dir;
        Ok(find_pack_in(&working.join(sub), known)
            .await?
            .map(|version| InstalledCopy::of_version(version, None)))
    }

    /// Mod 是否已装在这个实例里：卷宗给身份，磁盘给存在性，两者都成立才算装了。
    ///
    /// 卷宗有而磁盘没有一律当没装——玩家手动删 jar 是完全合法的操作，拿一条陈旧记录告诉他「已安装」
    /// 会让他找不到那个根本不存在的文件。卷宗里一条都对不上时直接短路，不去扫盘。
    async fn installed_mod_of(
        &self,
        discovered: DiscoveredVersion,
        platform: Platform,
        project_id: &str,
    ) -> Result<Option<InstalledCopy>> {
        let ledger = self.ledger_store(&discovered.id).load().await?;
        // project_id 的命名空间是按平台分的（Modrinth 是字符串 id，CurseForge 是数字 modId），
        // 只比 project_id 会让两个平台的 id 有机会撞车，故平台也一起比。
        let candidates: Vec<InstalledCopy> = ledger
            .entries
            .iter()
            .filter(|entry| entry.platform == platform && entry.project_id == project_id)
            .map(|entry| InstalledCopy {
                file_name: entry.file_name.clone(),
                version_id: entry.version_id.clone(),
                version_number: entry.version_number.clone(),
                world: None,
            })
            .collect();
        if candidates.is_empty() {
            return Ok(None);
        }

        let dirs = self.instance_dirs(&discovered).await?;
        if !try_exists(&dirs.mods_dir).await? {
            return Ok(None);
        }
        let on_disk = scan_mods_dir_cached(&dirs.mods_dir, Some(&dirs.metadata_cache)).await?;
        let present: HashSet<&str> = on_disk
            .iter()
            .map(|installed| ledger_key(&installed.file_name))
            .collect();
        Ok(candidates
            .into_iter()
            .find(|copy| present.contains(copy.file_name.as_str())))
    }
}

/// 在一个资源目录里认出该工程的哪个版本装着；目录不存在即没装。
///
/// 没有卷宗，只能拿平台给的文件名比对：同名且大小对得上才算（同名的别家文件、解压开的同名目录都不是它）。
/// 几个版本共用同一个文件名与大小时再算 sha1 分辨，都对不上就不认。玩家改过名的文件认不出来，按没装处理。
async fn find_pack_in<'v>(
    dir: &Path,
    known: &'v [ModVersionInfo],
) -> Result<Option<&'v ModVersionInfo>> {
    let io = |source| -> CoreError {
        aurora_base::Error::Io {
            path: dir.to_owned(),
            source,
        }
        .into()
    };
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io(source)),
    };
    while let Some(entry) = entries.next_entry().await.map_err(io)? {
        let name = entry.file_name();
        // 平台给的文件名都是 UTF-8，转不过来的一定不是它。
        let Some(name) = name.to_str() else { continue };
        let named: Vec<&ModVersionInfo> = known.iter().filter(|v| v.file_name == name).collect();
        if named.is_empty() {
            continue;
        }
        let meta = entry.metadata().await.map_err(io)?;
        if !meta.is_file() {
            continue;
        }
        let sized: Vec<&ModVersionInfo> = named
            .into_iter()
            .filter(|v| v.file_size.is_none_or(|size| size == meta.len()))
            .collect();
        match sized.as_slice() {
            [] => {}
            [only] => return Ok(Some(only)),
            several => {
                let actual = aurora_base::fs::sha1_hex(entry.path()).await?;
                let hit = several.iter().find(|v| {
                    v.sha1
                        .as_deref()
                        .is_some_and(|sha1| sha1.eq_ignore_ascii_case(&actual))
                });
                if let Some(hit) = hit {
                    return Ok(Some(hit));
                }
            }
        }
    }
    Ok(None)
}

/// 数据包按存档生效：任一存档的 `datapacks/` 里有它即算已装，结果带上是哪个存档。几个存档都有时
/// 取目录名排在最前的那个，同一份盘面每次给出同一个答案。
async fn find_data_pack(saves: &Path, known: &[ModVersionInfo]) -> Result<Option<InstalledCopy>> {
    let io = |source| -> CoreError {
        aurora_base::Error::Io {
            path: saves.to_owned(),
            source,
        }
        .into()
    };
    let mut entries = match tokio::fs::read_dir(saves).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io(source)),
    };
    let mut worlds = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(io)? {
        // 结果要把存档名交给前端，装数据包也要传存档名：转不成 UTF-8 的存档名两头都用不了。
        let Ok(world) = entry.file_name().into_string() else {
            continue;
        };
        if entry.metadata().await.map_err(io)?.is_dir() {
            worlds.push(world);
        }
    }
    worlds.sort();
    for world in worlds {
        let datapacks = saves.join(&world).join("datapacks");
        if let Some(version) = find_pack_in(&datapacks, known).await? {
            return Ok(Some(InstalledCopy::of_version(version, Some(world))));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use crate::ledger::{Ledger, LedgerEntry, LedgerStore};
    use aurora_modplatform::ReleaseChannel;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn version(loaders: &[ModLoader], game_versions: &[&str]) -> ModVersionInfo {
        ModVersionInfo {
            version_id: "IZskiJmZ".to_owned(),
            project_id: "AANobbMI".to_owned(),
            platform: Platform::Modrinth,
            name: "Sodium 0.5.3".to_owned(),
            version_number: "mc1.20.1-0.5.3".to_owned(),
            release_channel: ReleaseChannel::Release,
            game_versions: game_versions.iter().map(|v| (*v).to_owned()).collect(),
            loaders: loaders.to_vec(),
            file_name: "sodium.jar".to_owned(),
            file_size: Some(204_800),
            sha1: Some("aabbcc".to_owned()),
            download_url: None,
            date_published: "2026-01-02T03:04:05Z".to_owned(),
            dependencies: Vec::new(),
        }
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn unknown(reason: &str) -> Compatibility {
        Compatibility::Unknown {
            reason: reason.to_owned(),
        }
    }

    fn mismatch(reason: &str) -> Compatibility {
        Compatibility::Mismatch {
            reason: reason.to_owned(),
        }
    }

    #[test]
    fn full_metadata_hit_is_match() {
        let v = version(&[ModLoader::Fabric], &["1.20.1", "1.20.2"]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &names(&["fabric"])),
            Compatibility::Match
        );
    }

    #[test]
    fn loader_name_comparison_is_case_insensitive() {
        let v = version(&[ModLoader::NeoForge], &["1.21"]);
        assert_eq!(
            classify(&v, Some("1.21"), &names(&["NeoForge"])),
            Compatibility::Match
        );
        assert_eq!(
            classify(&v, Some("1.21"), &names(&["neo-forge"])),
            Compatibility::Match
        );
    }

    #[test]
    fn multi_loader_version_matches_on_any_overlap() {
        // 版本同时支持 Fabric 与 Quilt，实例只有 Quilt：交集非空即通过。
        let v = version(&[ModLoader::Fabric, ModLoader::Quilt], &["1.20.1"]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &names(&["quilt"])),
            Compatibility::Match
        );
    }

    #[test]
    fn vanilla_instance_rejects_loader_requiring_version() {
        let v = version(&[ModLoader::Forge], &["1.20.1"]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &[]),
            mismatch("该实例未安装 Mod 加载器")
        );
    }

    #[test]
    fn optifine_only_instance_counts_as_no_mod_loader() {
        // OptiFine 不是 Mod 加载器：应给「未安装 Mod 加载器」，而不是列出它做对比。
        let v = version(&[ModLoader::Forge], &["1.20.1"]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &names(&["optifine"])),
            mismatch("该实例未安装 Mod 加载器")
        );
    }

    #[test]
    fn disjoint_loaders_name_both_sides_in_reason() {
        let v = version(&[ModLoader::Fabric, ModLoader::Quilt], &["1.20.1"]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &names(&["forge"])),
            mismatch("需要 Fabric/Quilt，该实例装的是 Forge")
        );
    }

    #[test]
    fn reason_uses_canonical_loader_spelling() {
        let v = version(&[ModLoader::NeoForge], &["1.21"]);
        // 文案里必须是 NeoForge / Forge 的规范写法，而非小写技术名。
        assert_eq!(
            classify(&v, Some("1.21"), &names(&["forge"])),
            mismatch("需要 NeoForge，该实例装的是 Forge")
        );
    }

    #[test]
    fn loader_mismatch_wins_over_game_version_mismatch() {
        // 两维都对不上时先报加载器：加载器是更硬的门槛，换个 Mod 版本也解决不了。
        let v = version(&[ModLoader::Forge], &["1.19.2"]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &names(&["fabric"])),
            mismatch("需要 Forge，该实例装的是 Fabric")
        );
    }

    #[test]
    fn game_version_miss_reports_instance_version() {
        let v = version(&[ModLoader::Fabric], &["1.19.2", "1.19.4"]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &names(&["fabric"])),
            mismatch("不支持 MC 1.20.1")
        );
    }

    #[test]
    fn game_version_match_is_exact_not_prefix() {
        // "1.20" 与 "1.20.1" 是两个 MC 版本，前缀相同不等于兼容。
        let v = version(&[ModLoader::Fabric], &["1.20"]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &names(&["fabric"])),
            mismatch("不支持 MC 1.20.1")
        );
        let snapshot = version(&[ModLoader::Fabric], &["24w14a"]);
        assert_eq!(
            classify(&snapshot, Some("24w14a"), &names(&["fabric"])),
            Compatibility::Match
        );
    }

    #[test]
    fn missing_game_versions_is_unknown_with_reason() {
        let v = version(&[ModLoader::Fabric], &[]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &names(&["fabric"])),
            unknown("平台没有标注这个版本支持的 MC 版本")
        );
    }

    #[test]
    fn missing_loaders_is_unknown_even_on_vanilla_instance() {
        // 平台没标加载器时不能反推「这是原版 Mod」，也不能反推「装不了」，只能说不知道。
        let v = version(&[], &["1.20.1"]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &names(&["forge"])),
            unknown("平台没有标注这个版本支持的加载器")
        );
        assert_eq!(
            classify(&v, Some("1.20.1"), &[]),
            unknown("平台没有标注这个版本支持的加载器")
        );
    }

    #[test]
    fn missing_loaders_still_rejects_wrong_game_version() {
        // 加载器缺失不该让 MC 版本这一维也失效：能判的仍要判。
        let v = version(&[], &["1.19.2"]);
        assert_eq!(
            classify(&v, Some("1.20.1"), &names(&["forge"])),
            mismatch("不支持 MC 1.20.1")
        );
    }

    #[test]
    fn both_dimensions_missing_is_unknown() {
        let v = version(&[], &[]);
        assert!(matches!(
            classify(&v, Some("1.20.1"), &[]),
            Compatibility::Unknown { .. }
        ));
    }

    /// 认不出版本时只判加载器，版本维度归 Unknown——绝不拿没把握的版本号造出「不支持 MC X」。
    #[test]
    fn classify_without_instance_mc_version_falls_back_to_unknown() {
        let v = version(&[ModLoader::Fabric], &["1.20.1"]);
        assert_eq!(
            classify(&v, None, &names(&["fabric"])),
            unknown("认不出该实例基于哪个 MC 版本，无法确认是否适配")
        );
        // 加载器仍然照判：这一维不依赖 MC 版本。
        assert!(matches!(
            classify(&v, None, &names(&["forge"])),
            Compatibility::Mismatch { .. }
        ));
    }

    #[test]
    fn compatibility_and_state_serialize_with_ipc_shape() {
        assert_eq!(
            serde_json::to_value(Compatibility::Match).unwrap(),
            serde_json::json!({ "kind": "match" })
        );
        assert_eq!(
            serde_json::to_value(unknown("x")).unwrap(),
            serde_json::json!({ "kind": "unknown", "reason": "x" })
        );
        assert_eq!(
            serde_json::to_value(mismatch("不支持 MC 1.20.1")).unwrap(),
            serde_json::json!({ "kind": "mismatch", "reason": "不支持 MC 1.20.1" })
        );
        for (state, name) in [
            (MatchState::Compatible, "compatible"),
            (MatchState::Maybe, "maybe"),
            (MatchState::Installed, "installed"),
            (MatchState::Incompatible, "incompatible"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), name);
        }
    }

    #[test]
    fn instance_match_serializes_with_ipc_field_names() {
        let entry = InstanceMatch {
            version_id: "1.20.1-fabric".to_owned(),
            mc_version: Some("1.20.1".to_owned()),
            loaders: names(&["fabric"]),
            state: MatchState::Installed,
            compatibility: Compatibility::Match,
            best_version: Some(version(&[ModLoader::Fabric], &["1.20.1"])),
            installed: Some(InstalledCopy {
                file_name: "sodium.jar".to_owned(),
                version_id: "old".to_owned(),
                version_number: None,
                world: None,
            }),
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["version_id"], "1.20.1-fabric");
        assert_eq!(json["mc_version"], "1.20.1");
        assert_eq!(json["loaders"][0], "fabric");
        assert_eq!(json["state"], "installed");
        assert_eq!(json["compatibility"]["kind"], "match");
        assert_eq!(json["best_version"]["version_id"], "IZskiJmZ");
        assert_eq!(json["installed"]["file_name"], "sodium.jar");
        assert_eq!(json["installed"]["version_id"], "old");
        assert_eq!(json["installed"]["version_number"], serde_json::Value::Null);
        // 键始终在：Mod 没有存档，给 null 而不是省掉。
        assert_eq!(json["installed"]["world"], serde_json::Value::Null);
        assert!(json["installed"].as_object().unwrap().contains_key("world"));
    }

    // ---- 择优与实例事实抽取 ----

    /// 造一个指定发布年份的版本，其余维度由调用方给定。择优只关心相对新旧，年份足以区分。
    fn dated(id: &str, year: u16, loaders: &[ModLoader], mc: &[&str]) -> ModVersionInfo {
        ModVersionInfo {
            version_id: id.to_owned(),
            date_published: format!("{year}-06-01T00:00:00Z"),
            file_name: format!("{id}.jar"),
            ..version(loaders, mc)
        }
    }

    #[test]
    fn pick_best_takes_newest_matching_version_not_merely_first_compatible() {
        let versions = vec![
            dated("newest", 2026, &[ModLoader::Fabric], &["1.20.1"]),
            dated("older", 2025, &[ModLoader::Fabric], &["1.20.1"]),
        ];
        let (compat, best) = pick_best(
            ResourceType::Mod,
            &versions,
            Some("1.20.1"),
            &names(&["fabric"]),
        );
        assert_eq!(compat, Compatibility::Match);
        assert_eq!(best.unwrap().version_id, "newest");
    }

    #[test]
    fn pick_best_skips_newer_mismatches_to_reach_a_match() {
        let versions = vec![
            dated("too-new", 2026, &[ModLoader::Fabric], &["1.21"]),
            dated("fits", 2025, &[ModLoader::Fabric], &["1.20.1"]),
        ];
        let (compat, best) = pick_best(
            ResourceType::Mod,
            &versions,
            Some("1.20.1"),
            &names(&["fabric"]),
        );
        assert_eq!(compat, Compatibility::Match);
        assert_eq!(best.unwrap().version_id, "fits");
    }

    #[test]
    fn pick_best_prefers_certain_match_over_newer_unknown() {
        // 元数据缺失的新版只是「可能可行」，确定能装的旧版才是更该默认选中的那个。
        let versions = vec![
            dated("no-metadata", 2026, &[], &[]),
            dated("certain", 2025, &[ModLoader::Fabric], &["1.20.1"]),
        ];
        let (compat, best) = pick_best(
            ResourceType::Mod,
            &versions,
            Some("1.20.1"),
            &names(&["fabric"]),
        );
        assert_eq!(compat, Compatibility::Match);
        assert_eq!(best.unwrap().version_id, "certain");
    }

    #[test]
    fn pick_best_falls_back_to_newest_unknown_with_its_reason() {
        let versions = vec![
            dated("wrong-mc", 2026, &[ModLoader::Fabric], &["1.21"]),
            dated("no-loaders", 2025, &[], &["1.20.1"]),
            dated("older-unknown", 2024, &[ModLoader::Fabric], &[]),
        ];
        let (compat, best) = pick_best(
            ResourceType::Mod,
            &versions,
            Some("1.20.1"),
            &names(&["fabric"]),
        );
        assert_eq!(compat, unknown("平台没有标注这个版本支持的加载器"));
        // 软提示也要给最新的那个候选。
        assert_eq!(best.unwrap().version_id, "no-loaders");
    }

    #[test]
    fn pick_best_reports_newest_versions_reason_when_all_mismatch() {
        let versions = vec![
            dated("newest", 2026, &[ModLoader::Fabric], &["1.21"]),
            dated("ancient", 2019, &[ModLoader::Forge], &["1.12.2"]),
        ];
        let (compat, best) = pick_best(
            ResourceType::Mod,
            &versions,
            Some("1.20.1"),
            &names(&["fabric"]),
        );
        assert_eq!(compat, mismatch("不支持 MC 1.20.1"));
        // 不兼容时不给候选版本：让 UI 无从把一个装不上的版本渲染成可安装项。
        assert!(best.is_none());
    }

    #[test]
    fn pick_best_on_empty_version_list_states_the_project_has_none() {
        let (compat, best) = pick_best(ResourceType::Mod, &[], Some("1.20.1"), &names(&["fabric"]));
        assert_eq!(compat, mismatch("该工程没有可用版本"));
        assert!(best.is_none());
    }

    #[test]
    fn resources_are_judged_by_game_version_alone() {
        // 标了 Forge 的资源包文件：原版实例、Fabric 实例照样能用
        let tagged = version(&[ModLoader::Forge], &["1.20.1"]);
        for loaders in [names(&[]), names(&["fabric"]), names(&["optifine"])] {
            for kind in [
                ResourceType::ResourcePack,
                ResourceType::Shader,
                ResourceType::DataPack,
            ] {
                assert_eq!(
                    judge(kind, &tagged, Some("1.20.1"), &loaders),
                    Compatibility::Match
                );
            }
        }
        // 没标加载器不是「拿不准」：资源根本不看这一维
        let bare = version(&[], &["1.20.1"]);
        assert_eq!(
            judge(ResourceType::ResourcePack, &bare, Some("1.20.1"), &[]),
            Compatibility::Match
        );
        assert_eq!(
            judge(
                ResourceType::Mod,
                &bare,
                Some("1.20.1"),
                &names(&["fabric"])
            ),
            unknown("平台没有标注这个版本支持的加载器")
        );
        // 同一个版本按 Mod 判仍然要加载器对上
        assert_eq!(
            judge(
                ResourceType::Mod,
                &tagged,
                Some("1.20.1"),
                &names(&["fabric"])
            ),
            mismatch("需要 Forge，该实例装的是 Fabric")
        );
    }

    #[test]
    fn game_version_dimension_keeps_its_three_outcomes() {
        assert_eq!(
            classify_game_version(&version(&[], &["1.20.1", "1.20.2"]), Some("1.20.2")),
            Compatibility::Match
        );
        assert_eq!(
            classify_game_version(&version(&[], &["1.20.1"]), Some("1.19.2")),
            mismatch("不支持 MC 1.19.2")
        );
        assert_eq!(
            classify_game_version(&version(&[], &[]), Some("1.20.1")),
            unknown("平台没有标注这个版本支持的 MC 版本")
        );
        assert_eq!(
            classify_game_version(&version(&[], &["1.20.1"]), None),
            unknown("认不出该实例基于哪个 MC 版本，无法确认是否适配")
        );
    }

    #[test]
    fn pick_best_for_resource_takes_newest_fitting_game_version() {
        let versions = vec![
            dated("too-new", 2026, &[], &["1.21"]),
            dated("fits", 2025, &[], &["1.20.1"]),
            dated("older", 2024, &[], &["1.20.1"]),
        ];
        let (compat, best) = pick_best(ResourceType::Shader, &versions, Some("1.20.1"), &[]);
        assert_eq!(compat, Compatibility::Match);
        assert_eq!(best.unwrap().version_id, "fits");
    }

    #[test]
    fn pinned_version_is_judged_alone() {
        let v = dated("pinned", 2020, &[ModLoader::Forge], &["1.20.1"]);
        let (compat, best) =
            judge_pinned(ResourceType::Mod, &v, Some("1.20.1"), &names(&["fabric"]));
        assert_eq!(compat, mismatch("需要 Forge，该实例装的是 Fabric"));
        assert!(best.is_none());
        let (compat, best) =
            judge_pinned(ResourceType::Mod, &v, Some("1.20.1"), &names(&["forge"]));
        assert_eq!(compat, Compatibility::Match);
        assert_eq!(best.unwrap().version_id, "pinned");
    }

    /// 用一段版本 JSON 造出发现结果（路径不参与本组断言，取占位值）。
    fn discovered(id: &str, json: &str) -> DiscoveredVersion {
        let parsed = aurora_version::VersionJson::from_json_str(json).expect("测试版本 JSON 合法");
        let loaders = aurora_version::detect_loaders(&parsed);
        let dir = std::path::PathBuf::from("versions").join(id);
        DiscoveredVersion {
            id: id.to_owned(),
            json_path: dir.join(format!("{id}.json")),
            jar_path: dir.join(format!("{id}.jar")),
            dir,
            json: parsed,
            loaders,
        }
    }

    #[test]
    fn instance_mc_version_prefers_inherits_from() {
        let v = discovered(
            "fabric-loader-0.15.11-1.20.1",
            r#"{"id":"fabric-loader-0.15.11-1.20.1","inheritsFrom":"1.20.1","type":"release",
                "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.11"}]}"#,
        );
        assert_eq!(instance_mc_version(&v).as_deref(), Some("1.20.1"));
    }

    #[test]
    fn instance_mc_version_reads_plain_and_blank_inherits() {
        let vanilla = discovered("1.21", r#"{"id":"1.21","type":"release"}"#);
        assert_eq!(instance_mc_version(&vanilla).as_deref(), Some("1.21"));

        // 空串不能当成有效父版本，否则该实例的 MC 版本会变成空串。
        let blank = discovered(
            "24w14a",
            r#"{"id":"24w14a","inheritsFrom":"","type":"snapshot"}"#,
        );
        assert_eq!(instance_mc_version(&blank).as_deref(), Some("24w14a"));
    }

    /// 自包含的整合版本 JSON（没有 inheritsFrom），实例名还带中文与括号。必须从库坐标里认出
    /// 1.20.1，而不是把整个实例名当版本号：认错版本会让落位矩阵里每个实例都判「不兼容」。
    #[test]
    fn instance_mc_version_identifies_self_contained_forge_json() {
        let v = discovered(
            "1.20.1-Forge_47.4.20(方块日志)",
            r#"{"id":"1.20.1-Forge_47.4.20(方块日志)","type":"release",
                "libraries":[{"name":"net.minecraftforge:forge:1.20.1-47.4.20"}]}"#,
        );
        assert_eq!(instance_mc_version(&v).as_deref(), Some("1.20.1"));
    }

    #[test]
    fn instance_loaders_are_lowercase_kind_names() {
        let v = discovered(
            "1.20.1-forge-optifine",
            r#"{"id":"1.20.1-forge-optifine","inheritsFrom":"1.20.1","type":"release",
                "libraries":[{"name":"net.minecraftforge:forge:1.20.1-47.2.0"},
                             {"name":"optifine:OptiFine:1.20.1_HD_U_I6"}]}"#,
        );
        // 探测顺序固定为 Forge 先于 OptiFine；非 Mod 加载器也如实列出，取舍交给 classify。
        assert_eq!(instance_loaders(&v), names(&["forge", "optifine"]));
        // Mod 加载器视图剔除 OptiFine。
        assert_eq!(instance_mod_loaders(&v), vec![ModLoader::Forge]);

        let vanilla = discovered("1.21", r#"{"id":"1.21","type":"release"}"#);
        assert!(instance_loaders(&vanilla).is_empty());
    }

    // ---- 实例匹配矩阵（端到端，平台走本地 mock）----

    /// 各加载器的特征库坐标，[`aurora_version::detect_loaders`] 据此识别实例装了什么。
    const FABRIC_LIB: &str = "net.fabricmc:fabric-loader:0.15.11";
    const QUILT_LIB: &str = "org.quiltmc:quilt-loader:0.26.0";
    const FORGE_LIB: &str = "net.minecraftforge:forge:1.20.1-47.2.0";

    /// 在 versions/<id>/<id>.json 落一份带指定父版本与加载器库的版本 JSON。
    async fn put_instance(mc: &std::path::Path, id: &str, inherits: &str, library: &str) {
        let dir = mc.join("versions").join(id);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join(format!("{id}.json")),
            format!(
                r#"{{"id":"{id}","inheritsFrom":"{inherits}","type":"release","mainClass":"m",
                     "libraries":[{{"name":"{library}"}}]}}"#
            ),
        )
        .await
        .unwrap();
    }

    /// 给某实例写一条 sodium 的安装记录，并在其 mods 目录里落下 `disk_files` 指定的文件。
    async fn put_ledger_and_disk(mc: &std::path::Path, id: &str, disk_files: &[&str]) {
        let version_dir = mc.join("versions").join(id);
        let mut ledger = Ledger::default();
        ledger.upsert(LedgerEntry {
            file_name: "sodium-0.5.jar".to_owned(),
            platform: Platform::Modrinth,
            project_id: "sodium".to_owned(),
            version_id: "new".to_owned(),
            version_number: Some("0.5".to_owned()),
            title: Some("Sodium".to_owned()),
            icon_url: None,
            sha1: None,
            installed_at: 1_754_000_000,
            installed_as_dependency_of: None,
        });
        LedgerStore::for_version_dir(&version_dir)
            .save(&ledger)
            .await
            .unwrap();

        let mods_dir = version_dir.join("mods");
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        for name in disk_files {
            tokio::fs::write(mods_dir.join(name), b"jar").await.unwrap();
        }
    }

    /// 两个版本的工程：新版支持 Fabric/Quilt + 1.20.1，旧版没标加载器、只标 1.19.2。
    const SODIUM_VERSIONS: &str = r#"[
        {"id":"new","project_id":"sodium","name":"Sodium 0.5","version_number":"0.5",
         "version_type":"release","date_published":"2026-02-01T00:00:00Z",
         "game_versions":["1.20.1"],"loaders":["fabric","quilt"],
         "files":[{"hashes":{"sha1":"aa"},"url":"https://example.invalid/sodium-0.5.jar",
                   "filename":"sodium-0.5.jar","primary":true,"size":3}]},
        {"id":"old","project_id":"sodium","name":"Sodium 0.4","version_number":"0.4",
         "version_type":"release","date_published":"2025-01-01T00:00:00Z",
         "game_versions":["1.19.2"],
         "files":[{"hashes":{"sha1":"bb"},"url":"https://example.invalid/sodium-0.4.jar",
                   "filename":"sodium-0.4.jar","primary":true,"size":3}]}
    ]"#;

    async fn matrix_fixture(mc: &std::path::Path) {
        // id 刻意让「不兼容/可能可行」的字典序排在「兼容」之前，逼出档位优先于字典序。
        put_instance(mc, "a-fabric-1.19.2", "1.19.2", FABRIC_LIB).await;
        put_instance(mc, "a-quilt-1.20.1", "1.20.1", QUILT_LIB).await;
        put_instance(mc, "b-fabric-1.20.1", "1.20.1", FABRIC_LIB).await;
        put_instance(mc, "c-forge-1.20.1", "1.20.1", FORGE_LIB).await;
        put_instance(mc, "d-forge-1.18.2", "1.18.2", FORGE_LIB).await;

        // 卷宗有、磁盘没有：磁盘是权威，判为未安装。
        put_ledger_and_disk(mc, "a-quilt-1.20.1", &["other.jar"]).await;
        // 卷宗与磁盘都有：已安装。
        put_ledger_and_disk(mc, "b-fabric-1.20.1", &["sodium-0.5.jar"]).await;
        // 禁用态仍算已装，只是被关掉了。
        put_ledger_and_disk(mc, "c-forge-1.20.1", &["sodium-0.5.jar.disabled"]).await;
    }

    fn isolated(mc: &std::path::Path, base: String) -> Aurora {
        let mut aurora =
            Aurora::for_test(AuroraConfig::default(), mc.to_path_buf(), mc.to_path_buf());
        aurora.set_isolation_policy(aurora_instance::IsolationPolicy::All);
        aurora.with_modrinth_base(base)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn match_instances_yields_four_states_and_joins_ledger_against_disk() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/project/sodium/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string(SODIUM_VERSIONS))
            // 版本列表整场只能拉一次：改成逐实例发请求，这条期望即挂（五个实例会打五次）。
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        matrix_fixture(&mc).await;

        let matches = isolated(&mc, server.uri())
            .match_instances(Platform::Modrinth, "sodium", ResourceType::Mod, None)
            .await
            .unwrap();

        let ids: Vec<(&str, MatchState)> = matches
            .iter()
            .map(|m| (m.version_id.as_str(), m.state))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("a-quilt-1.20.1", MatchState::Compatible),
                ("a-fabric-1.19.2", MatchState::Maybe),
                ("b-fabric-1.20.1", MatchState::Installed),
                ("c-forge-1.20.1", MatchState::Installed),
                ("d-forge-1.18.2", MatchState::Incompatible),
            ]
        );

        // 兼容：Quilt 实例命中新版（工程同时支持 Fabric/Quilt），卷宗有而磁盘无仍算没装。
        assert_eq!(matches[0].compatibility, Compatibility::Match);
        assert_eq!(matches[0].mc_version.as_deref(), Some("1.20.1"));
        assert_eq!(matches[0].loaders, names(&["quilt"]));
        assert_eq!(matches[0].best_version.as_ref().unwrap().version_id, "new");
        assert_eq!(matches[0].installed, None);

        // 可能可行：1.19.2 实例只有旧版能沾边，而旧版没标加载器 -> 软提示放行并说明原因。
        assert_eq!(
            matches[1].compatibility,
            unknown("平台没有标注这个版本支持的加载器")
        );
        assert_eq!(matches[1].best_version.as_ref().unwrap().version_id, "old");

        // 已安装：卷宗与磁盘 join，带出已装版本号；禁用态也算。
        let installed = matches[2].installed.as_ref().unwrap();
        assert_eq!(installed.file_name, "sodium-0.5.jar");
        assert_eq!(installed.version_id, "new");
        assert_eq!(installed.version_number.as_deref(), Some("0.5"));
        assert_eq!(
            matches[3].installed.as_ref().unwrap().file_name,
            "sodium-0.5.jar"
        );
        // 已装但判定不兼容：判定照实保留，结论按「已安装」。
        assert_eq!(
            matches[3].compatibility,
            mismatch("需要 Fabric/Quilt，该实例装的是 Forge")
        );

        // 不兼容：两个版本都对不上，说明取自最新版的原因，不给候选版本。
        assert_eq!(
            matches[4].compatibility,
            mismatch("需要 Fabric/Quilt，该实例装的是 Forge")
        );
        assert!(matches[4].best_version.is_none());
        assert_eq!(matches[4].installed, None);
    }

    /// 指定了具体版本：只拉这一个版本（单版本端点），整个矩阵按它判定。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn match_instances_with_pinned_version_judges_only_that_version() {
        let server = MockServer::start().await;
        let old: serde_json::Value =
            serde_json::from_str::<serde_json::Value>(SODIUM_VERSIONS).unwrap()[1].clone();
        Mock::given(method("GET"))
            .and(path("/version/old"))
            .respond_with(ResponseTemplate::new(200).set_body_json(old))
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        put_instance(&mc, "fabric-1.20.1", "1.20.1", FABRIC_LIB).await;
        put_instance(&mc, "fabric-1.19.2", "1.19.2", FABRIC_LIB).await;

        let matches = isolated(&mc, server.uri())
            .match_instances(Platform::Modrinth, "sodium", ResourceType::Mod, Some("old"))
            .await
            .unwrap();
        assert_eq!(matches[0].version_id, "fabric-1.19.2");
        assert_eq!(matches[0].state, MatchState::Maybe);
        assert_eq!(matches[0].best_version.as_ref().unwrap().version_id, "old");
        assert_eq!(matches[1].version_id, "fabric-1.20.1");
        assert_eq!(matches[1].state, MatchState::Incompatible);
        assert_eq!(matches[1].compatibility, mismatch("不支持 MC 1.20.1"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn match_instances_without_any_instance_skips_the_network_entirely() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/project/sodium/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string(SODIUM_VERSIONS))
            // 没有实例就没有判定对象，一次请求都不该发。
            .expect(0)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let aurora = isolated(&mc, server.uri());
        assert!(
            aurora
                .match_instances(Platform::Modrinth, "sodium", ResourceType::Mod, None)
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// Modrinth 给资源包版本标的加载器是 `minecraft`，不是 Mod 加载器。
    const FAITHFUL_VERSIONS: &str = r#"[
        {"id":"f32","project_id":"faithful","name":"Faithful 1.20.1","version_number":"1.20.1-r5",
         "version_type":"release","date_published":"2026-02-01T00:00:00Z",
         "game_versions":["1.20.1"],"loaders":["minecraft"],
         "files":[{"hashes":{"sha1":"cc"},"url":"https://example.invalid/faithful.zip",
                   "filename":"faithful.zip","primary":true,"size":3}]}
    ]"#;

    /// 资源包由游戏本体读取：不论实例装没装、装的哪种 Mod 加载器，MC 版本对上就是兼容。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resource_pack_matrix_judges_game_version_only() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/project/faithful/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string(FAITHFUL_VERSIONS))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        put_instance(&mc, "fabric-1.20.1", "1.20.1", FABRIC_LIB).await;
        put_instance(&mc, "forge-1.20.1", "1.20.1", FORGE_LIB).await;
        put_instance(&mc, "fabric-1.19.2", "1.19.2", FABRIC_LIB).await;
        let vanilla = mc.join("versions").join("1.20.1");
        tokio::fs::create_dir_all(&vanilla).await.unwrap();
        tokio::fs::write(
            vanilla.join("1.20.1.json"),
            r#"{"id":"1.20.1","type":"release","mainClass":"m","libraries":[]}"#,
        )
        .await
        .unwrap();

        let matches = isolated(&mc, server.uri())
            .match_instances(
                Platform::Modrinth,
                "faithful",
                ResourceType::ResourcePack,
                None,
            )
            .await
            .unwrap();
        let rows: Vec<(&str, MatchState, &Compatibility)> = matches
            .iter()
            .map(|m| (m.version_id.as_str(), m.state, &m.compatibility))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("1.20.1", MatchState::Compatible, &Compatibility::Match),
                (
                    "fabric-1.20.1",
                    MatchState::Compatible,
                    &Compatibility::Match
                ),
                (
                    "forge-1.20.1",
                    MatchState::Compatible,
                    &Compatibility::Match
                ),
                (
                    "fabric-1.19.2",
                    MatchState::Incompatible,
                    &mismatch("不支持 MC 1.19.2")
                ),
            ]
        );
        assert_eq!(matches[0].best_version.as_ref().unwrap().version_id, "f32");
    }

    /// 一个 Modrinth 版本：文件名、大小与 sha1 是在盘上认出已装文件的依据。
    fn pack_version(
        id: &str,
        project: &str,
        published: &str,
        loader: &str,
        file_name: &str,
        sha1: &str,
        size: u64,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id, "project_id": project, "name": id, "version_number": format!("v-{id}"),
            "version_type": "release", "date_published": published,
            "game_versions": ["1.20.1"], "loaders": [loader],
            "files": [{"hashes": {"sha1": sha1}, "url": format!("https://example.invalid/{file_name}"),
                       "filename": file_name, "primary": true, "size": size}]
        })
    }

    async fn put_file(path: std::path::PathBuf, bytes: &[u8]) {
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(path, bytes).await.unwrap();
    }

    async fn mount_project(server: &MockServer, project: &str, versions: serde_json::Value) {
        Mock::given(method("GET"))
            .and(path(format!("/project/{project}/version")))
            .respond_with(ResponseTemplate::new(200).set_body_json(versions))
            .mount(server)
            .await;
    }

    fn state_of<'m>(matches: &'m [InstanceMatch], id: &str) -> &'m InstanceMatch {
        matches
            .iter()
            .find(|m| m.version_id == id)
            .unwrap_or_else(|| panic!("矩阵里没有 {id}"))
    }

    /// 资源包、光影没有卷宗：在游戏读取它们的目录里按平台给的文件名与大小认出装的是哪个版本，
    /// 装的是旧版时照样算已装（前端据此判「可更新」）；放错目录、同名但大小不对都不算。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resource_packs_and_shaders_are_found_in_the_directories_the_game_reads() {
        let server = MockServer::start().await;
        mount_project(
            &server,
            "faithful",
            serde_json::json!([
                pack_version(
                    "r5",
                    "faithful",
                    "2026-02-01T00:00:00Z",
                    "minecraft",
                    "faithful-r5.zip",
                    "55",
                    5
                ),
                pack_version(
                    "r4",
                    "faithful",
                    "2025-02-01T00:00:00Z",
                    "minecraft",
                    "faithful-r4.zip",
                    "44",
                    4
                ),
            ]),
        )
        .await;
        mount_project(
            &server,
            "complementary",
            serde_json::json!([pack_version(
                "s1",
                "complementary",
                "2026-01-01T00:00:00Z",
                "iris",
                "Complementary_r5.3.zip",
                "66",
                6
            )]),
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        for id in ["a-old", "b-latest", "c-wrong-size", "d-in-mods", "e-none"] {
            put_instance(&mc, id, "1.20.1", FABRIC_LIB).await;
        }
        let dir = |id: &str| mc.join("versions").join(id);
        put_file(dir("a-old").join("resourcepacks/faithful-r4.zip"), b"rrrr").await;
        put_file(
            dir("b-latest").join("resourcepacks/faithful-r5.zip"),
            b"rrrrr",
        )
        .await;
        put_file(
            dir("c-wrong-size").join("resourcepacks/faithful-r5.zip"),
            b"rrr",
        )
        .await;
        put_file(dir("d-in-mods").join("mods/faithful-r5.zip"), b"rrrrr").await;
        // 同名的目录（解压开的资源包）不是这份文件。
        tokio::fs::create_dir_all(dir("e-none").join("resourcepacks/faithful-r5.zip"))
            .await
            .unwrap();
        put_file(
            dir("b-latest").join("shaderpacks/Complementary_r5.3.zip"),
            b"ssssss",
        )
        .await;
        put_file(
            dir("a-old").join("resourcepacks/Complementary_r5.3.zip"),
            b"ssssss",
        )
        .await;

        let aurora = isolated(&mc, server.uri());
        let packs = aurora
            .match_instances(
                Platform::Modrinth,
                "faithful",
                ResourceType::ResourcePack,
                None,
            )
            .await
            .unwrap();
        for (id, state) in [
            ("a-old", MatchState::Installed),
            ("b-latest", MatchState::Installed),
            ("c-wrong-size", MatchState::Compatible),
            ("d-in-mods", MatchState::Compatible),
            ("e-none", MatchState::Compatible),
        ] {
            assert_eq!(state_of(&packs, id).state, state, "{id}");
        }
        // 装的是旧版：带出旧版的标识与版本号，最佳版本仍是新版，前端据两者不同判「可更新」。
        let old = state_of(&packs, "a-old");
        assert_eq!(
            old.installed,
            Some(InstalledCopy {
                file_name: "faithful-r4.zip".to_owned(),
                version_id: "r4".to_owned(),
                version_number: Some("v-r4".to_owned()),
                world: None,
            })
        );
        assert_eq!(old.best_version.as_ref().unwrap().version_id, "r5");
        let latest = state_of(&packs, "b-latest").installed.as_ref().unwrap();
        assert_eq!(latest.version_id, "r5");
        assert_eq!(state_of(&packs, "c-wrong-size").installed, None);

        let shaders = aurora
            .match_instances(
                Platform::Modrinth,
                "complementary",
                ResourceType::Shader,
                None,
            )
            .await
            .unwrap();
        assert_eq!(state_of(&shaders, "b-latest").state, MatchState::Installed);
        assert_eq!(
            state_of(&shaders, "b-latest")
                .installed
                .as_ref()
                .unwrap()
                .file_name,
            "Complementary_r5.3.zip"
        );
        // 光影文件放进了资源包目录：游戏不会把它当光影读，不算装了。
        assert_eq!(state_of(&shaders, "a-old").state, MatchState::Compatible);
    }

    /// 指定了版本时，盘上装着别的版本也要认出来：已装带出旧版，最佳版本是指定的那个。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pinned_resource_pack_still_recognises_another_installed_version() {
        let server = MockServer::start().await;
        let r5 = pack_version(
            "r5",
            "faithful",
            "2026-02-01T00:00:00Z",
            "minecraft",
            "faithful-r5.zip",
            "55",
            5,
        );
        let r4 = pack_version(
            "r4",
            "faithful",
            "2025-02-01T00:00:00Z",
            "minecraft",
            "faithful-r4.zip",
            "44",
            4,
        );
        Mock::given(method("GET"))
            .and(path("/version/r5"))
            .respond_with(ResponseTemplate::new(200).set_body_json(r5.clone()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/project/faithful/version"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([r5, r4])))
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        put_instance(&mc, "old", "1.20.1", FABRIC_LIB).await;
        put_instance(&mc, "none", "1.20.1", FABRIC_LIB).await;
        put_file(
            mc.join("versions/old/resourcepacks/faithful-r4.zip"),
            b"rrrr",
        )
        .await;

        let matches = isolated(&mc, server.uri())
            .match_instances(
                Platform::Modrinth,
                "faithful",
                ResourceType::ResourcePack,
                Some("r5"),
            )
            .await
            .unwrap();
        let old = state_of(&matches, "old");
        assert_eq!(old.state, MatchState::Installed);
        assert_eq!(old.installed.as_ref().unwrap().version_id, "r4");
        assert_eq!(old.best_version.as_ref().unwrap().version_id, "r5");
        assert_eq!(state_of(&matches, "none").state, MatchState::Compatible);
    }

    /// 几个版本的文件同名同大小：按 sha1 认出装的是哪一个；都对不上就不算装了。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn same_named_versions_are_told_apart_by_sha1() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("resourcepacks");
        put_file(dir.join("pack.zip"), b"AAAA").await;
        let actual = aurora_base::fs::sha1_hex(dir.join("pack.zip"))
            .await
            .unwrap();
        let info = |id: &str, sha1: &str| ModVersionInfo {
            version_id: id.to_owned(),
            file_name: "pack.zip".to_owned(),
            file_size: Some(4),
            sha1: Some(sha1.to_owned()),
            ..version(&[], &["1.20.1"])
        };

        let known = [
            info("v2", "0000000000000000000000000000000000000000"),
            info("v1", &actual.to_ascii_uppercase()),
        ];
        let hit = find_pack_in(&dir, &known).await.unwrap();
        assert_eq!(hit.map(|v| v.version_id.as_str()), Some("v1"));

        let strangers = [
            info("v2", "0000000000000000000000000000000000000000"),
            info("v1", "1111111111111111111111111111111111111111"),
        ];
        assert_eq!(find_pack_in(&dir, &strangers).await.unwrap(), None);
        // 目录不存在：没装，不是错误。
        assert_eq!(
            find_pack_in(&tmp.path().join("shaderpacks"), &known)
                .await
                .unwrap(),
            None
        );
    }

    /// 数据包装在存档里：任一存档的 datapacks 有它即算已装。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn data_packs_are_found_in_any_world() {
        let server = MockServer::start().await;
        mount_project(
            &server,
            "terralith",
            serde_json::json!([pack_version(
                "t1",
                "terralith",
                "2026-01-01T00:00:00Z",
                "datapack",
                "Terralith_2.5.zip",
                "77",
                7
            )]),
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        for id in ["in-world", "other-pack", "no-saves"] {
            put_instance(&mc, id, "1.20.1", FABRIC_LIB).await;
        }
        let saves = |id: &str| mc.join("versions").join(id).join("saves");
        tokio::fs::create_dir_all(saves("in-world").join("Alpha"))
            .await
            .unwrap();
        put_file(
            saves("in-world").join("Gamma/datapacks/Terralith_2.5.zip"),
            b"ttttttt",
        )
        .await;
        put_file(
            saves("in-world").join("Beta/datapacks/Terralith_2.5.zip"),
            b"ttttttt",
        )
        .await;
        put_file(
            saves("other-pack").join("Alpha/datapacks/other.zip"),
            b"ttttttt",
        )
        .await;

        let matches = isolated(&mc, server.uri())
            .match_instances(
                Platform::Modrinth,
                "terralith",
                ResourceType::DataPack,
                None,
            )
            .await
            .unwrap();
        assert_eq!(state_of(&matches, "in-world").state, MatchState::Installed);
        // Beta 与 Gamma 都有：取目录名排在前面的 Beta，Alpha 没有 datapacks 目录不影响。
        assert_eq!(
            state_of(&matches, "in-world").installed,
            Some(InstalledCopy {
                file_name: "Terralith_2.5.zip".to_owned(),
                version_id: "t1".to_owned(),
                version_number: Some("v-t1".to_owned()),
                world: Some("Beta".to_owned()),
            })
        );
        assert_eq!(
            state_of(&matches, "other-pack").state,
            MatchState::Compatible
        );
        assert_eq!(state_of(&matches, "no-saves").state, MatchState::Compatible);

        let json = serde_json::to_value(state_of(&matches, "in-world")).unwrap();
        assert_eq!(json["installed"]["world"], "Beta");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modpack_and_plugin_have_no_matrix() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            // 类型不成立就不该去问平台
            .expect(0)
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        put_instance(&mc, "fabric-1.20.1", "1.20.1", FABRIC_LIB).await;
        let aurora = isolated(&mc, server.uri());
        for kind in [ResourceType::Modpack, ResourceType::Plugin] {
            let err = aurora
                .match_instances(Platform::Modrinth, "pack", kind, None)
                .await
                .unwrap_err();
            assert!(
                matches!(err, CoreError::InvalidResourceTarget(_)),
                "{kind:?} 得到 {err:?}"
            );
        }
    }
}
