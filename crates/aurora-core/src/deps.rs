//! 依赖图与安装计划。
//!
//! 安装一个 Mod 往往要连带装它的前置。这里把「要装哪些」先算成一份可检视的计划再落盘，而不是边下
//! 边解析：计划算完才知道总共几个文件、哪些其实已经装过、哪些依赖压根找不到匹配版本——这些都必须
//! 在玩家按下确认之前摆到他面前。
//!
//! 三条决策：
//!
//! 一、只自动收 Required 依赖。Optional 装了未必想要，Incompatible 装了必炸，Embedded 已经打包在
//! 主文件里再装一份会重复加载。这几类一律跳过，但跳过的事实要写进 [`InstallPlan::skipped`] 如实告知。
//!
//! 二、找不到匹配版本的依赖不中断整个计划。主 Mod 仍然可以装，代价（大概率启动即崩）由 UI 明说，
//! 决定权交还玩家——直接失败会把「我只是想试试」这种完全合理的诉求也一并堵死。
//!
//! 三、实例里已经装着的前置（任何版本）不动，计划项标成已满足。作者没钉版本就是「有就行」，
//! 启动器擅自把玩家现有的前置换成最新版，换来的可能是一个别的 Mod 不认的版本；要升级走更新检查。
//! 装着的那一版在平台上已经下架也一样算已满足，计划只按卷宗列出它（[`PlannedItem::delisted`]）。
//! 玩家给这个前置设了更新检查（忽略或锁定）时，作者钉了版本也不换，计划如实说明：更新不走确认计划，
//! 换了玩家都不知道，他的设置就成了摆设。

use std::collections::HashSet;
use std::path::Path;

use aurora_modplatform::{DependencyKind, ModLoader, ModVersionInfo, Platform, ReleaseChannel};
use serde::Serialize;

use crate::compat::{
    Compatibility, classify, instance_loaders, instance_mc_version, instance_mod_loaders,
};
use crate::error::{CoreError, Result};
use crate::facade::Aurora;
use crate::ledger::{Ledger, LedgerEntry, UpdateHold};
use crate::modfs::present;
use crate::modversions::sort_by_published_desc;
use crate::starter::{FABRIC_API_PROJECT, QFAPI_PROJECT};

/// 计划里的一项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlannedItem {
    /// 待安装的版本。
    pub version: ModVersionInfo,
    /// 工程标题；平台没返回为 `None`。
    pub title: Option<String>,
    /// 工程图标地址；平台没给为 `None`。
    pub icon_url: Option<String>,
    /// 因谁被带进来（project_id）；用户主动装的为 `None`。
    pub required_by: Option<String>,
    /// 该实例里已装着这一项，本次跳过下载。主项指同工程同版本；前置指同工程的任意版本。
    pub already_satisfied: bool,
    /// 实例里装着的这一版在平台上已经找不到（下架或删除），只出现在已满足的前置上；为假时不序列化，
    /// 其余计划项的形状不变。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub delisted: bool,
}

/// 一次安装的完整计划。
///
/// `items[0]` 恒为用户主动选的那个（`required_by` 为 `None`），其余为按依赖关系展开的前置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstallPlan {
    /// 待安装项，主 Mod 在前，依赖在后。
    pub items: Vec<PlannedItem>,
    /// 被跳过的依赖说明（每条一句中文），供 UI 如实告知而不是假装没有。
    pub skipped: Vec<String>,
    /// `skipped` 里说必需前置的那几条：被保留、已下架、没有适配版本或无从解析。更新不走确认计划，这几条
    /// 要随结果带回去告诉玩家。可选、内嵌、工具类与不兼容声明不算：它们每次更新都在，混进来就成了噪声。
    /// 只在后端流转，确认计划的界面读完整的 `skipped`。
    #[serde(skip)]
    pub unmet: Vec<String>,
}

/// 判定依赖版本所需的实例事实。
struct InstanceFacts {
    /// 实例的 MC 版本；版本 JSON 给不出任何线索时为 `None`。
    mc_version: Option<String>,
    /// 已装加载器的小写名。OptiFine 这类非 Mod 加载器也在其中，由 [`classify`] 自行忽略。
    loaders: Vec<String>,
    /// 下推给平台的加载器过滤条件（认不出的名字已剔除）。
    mod_loaders: Vec<ModLoader>,
}

/// 一条跳过说明。先记工程标识，等整份计划的标题批量取回后再渲染成句子：
/// 依赖声明只带标识不带名字，逐条去问平台要名字就是逐条一次请求。
enum SkipNote {
    MissingProjectId {
        file_name: String,
    },
    PinnedGone {
        project_id: String,
        version_id: String,
    },
    NoCompatibleVersion {
        project_id: String,
    },
    ProjectGone {
        project_id: String,
    },
    HeldBack {
        project_id: String,
        file_name: String,
    },
    PinOlderThanInstalled {
        project_id: String,
        file_name: String,
    },
    PinIncompatible {
        project_id: String,
        file_name: String,
    },
    Optional {
        project_id: Option<String>,
    },
    Incompatible {
        file_name: String,
        project_id: Option<String>,
    },
    Embedded {
        file_name: String,
        project_id: Option<String>,
    },
    Tool {
        project_id: Option<String>,
    },
}

impl SkipNote {
    /// 这条说的是必需前置没有照办，而不是一条本来就不要求装的声明。
    fn is_required(&self) -> bool {
        matches!(
            self,
            SkipNote::MissingProjectId { .. }
                | SkipNote::PinnedGone { .. }
                | SkipNote::NoCompatibleVersion { .. }
                | SkipNote::ProjectGone { .. }
                | SkipNote::HeldBack { .. }
        )
    }

    fn project_id(&self) -> Option<&str> {
        match self {
            SkipNote::MissingProjectId { .. } => None,
            SkipNote::PinnedGone { project_id, .. }
            | SkipNote::NoCompatibleVersion { project_id }
            | SkipNote::ProjectGone { project_id }
            | SkipNote::HeldBack { project_id, .. }
            | SkipNote::PinOlderThanInstalled { project_id, .. }
            | SkipNote::PinIncompatible { project_id, .. } => Some(project_id),
            SkipNote::Optional { project_id }
            | SkipNote::Incompatible { project_id, .. }
            | SkipNote::Embedded { project_id, .. }
            | SkipNote::Tool { project_id } => project_id.as_deref(),
        }
    }

    /// 渲染成给玩家看的一句话；`name` 把工程标识换成标题，取不到标题时原样显示标识——宁可显示一串
    /// id，也不能因为名字取不到就把这条依赖从说明里抹掉。
    fn render(&self, name: impl Fn(Option<&str>) -> String) -> String {
        match self {
            SkipNote::MissingProjectId { file_name } => {
                format!("{file_name} 的一条必需前置没有给出工程标识，无法自动解析")
            }
            SkipNote::PinnedGone {
                project_id,
                version_id,
            } => format!(
                "前置 {} 指定的版本 {version_id} 在平台上已不存在，未加入计划",
                name(Some(project_id))
            ),
            SkipNote::NoCompatibleVersion { project_id } => format!(
                "前置 {} 没有适配该实例的版本，未加入计划",
                name(Some(project_id))
            ),
            SkipNote::ProjectGone { project_id } => format!(
                "前置 {} 在平台上已不存在，未加入计划",
                name(Some(project_id))
            ),
            SkipNote::HeldBack {
                project_id,
                file_name,
            } => format!(
                "前置 {} 按你的更新设置保留现有版本，未换成 {file_name} 指定的版本",
                name(Some(project_id))
            ),
            SkipNote::PinOlderThanInstalled {
                project_id,
                file_name,
            } => format!(
                "前置 {} 保留现有的较新版本，未换成 {file_name} 指定的旧版本",
                name(Some(project_id))
            ),
            SkipNote::PinIncompatible {
                project_id,
                file_name,
            } => format!(
                "{file_name} 指定的前置 {} 版本不适配这个实例，已改用适配的版本",
                name(Some(project_id))
            ),
            SkipNote::Optional { project_id } => format!(
                "可选前置 {} 未自动安装，需要时手动添加",
                name(project_id.as_deref())
            ),
            SkipNote::Incompatible {
                file_name,
                project_id,
            } => format!(
                "{file_name} 声明与 {} 不兼容，未做任何处理",
                name(project_id.as_deref())
            ),
            SkipNote::Embedded {
                file_name,
                project_id,
            } => format!(
                "内嵌前置 {} 已打包在 {file_name} 内，无需单独安装",
                name(project_id.as_deref())
            ),
            SkipNote::Tool { project_id } => {
                format!("工具类关联 {} 未自动安装", name(project_id.as_deref()))
            }
        }
    }
}

/// 作者钉的前置版本为什么没被采用。
enum PinRejection {
    OlderThanInstalled,
    Incompatible,
}

impl PinRejection {
    fn note(self, project_id: String, file_name: String) -> SkipNote {
        match self {
            PinRejection::OlderThanInstalled => SkipNote::PinOlderThanInstalled {
                project_id,
                file_name,
            },
            PinRejection::Incompatible => SkipNote::PinIncompatible {
                project_id,
                file_name,
            },
        }
    }
}

/// 一条必需依赖的解析结果。
enum Resolved {
    /// 选中的版本与它是否已装在实例里。
    Chosen(Box<ModVersionInfo>, bool),
    /// 实例里装着、平台上已找不到的那一版，只剩卷宗里的记录。
    Delisted(Box<LedgerEntry>),
    /// 没有可用版本，附跳过说明。
    Skipped(SkipNote),
}

impl PlannedItem {
    /// 平台上取到的版本进计划；标题与图标等整份计划算完后批量补。
    fn from_platform(
        version: ModVersionInfo,
        required_by: Option<String>,
        already_satisfied: bool,
    ) -> Self {
        Self {
            version,
            title: None,
            icon_url: None,
            required_by,
            already_satisfied,
            delisted: false,
        }
    }

    /// 已装、但平台上已找不到的前置：只按卷宗列出，不替玩家换版本，也不展开它的前置。
    ///
    /// 版本视图只填卷宗记着的事实（版本 id、工程、平台、文件名、sha1、版本号），发布通道、适配版本、
    /// 加载器、大小、直链、发布时间与依赖都只有平台知道：空着给出，发布通道按正式版给出。这一形态
    /// 恒为已满足，既不参与择优也不下载，这些字段没有读者。卷宗没记版本号时用版本 id 顶上，展示名
    /// 用文件名：玩家在 mods 目录里认得的就是它。标题与图标先取卷宗那份，平台上工程还在时再被
    /// 平台的覆盖。
    fn from_ledger(entry: LedgerEntry, required_by: String) -> Self {
        let version = ModVersionInfo {
            version_number: entry
                .version_number
                .unwrap_or_else(|| entry.version_id.clone()),
            version_id: entry.version_id,
            project_id: entry.project_id,
            platform: entry.platform,
            name: entry.file_name.clone(),
            release_channel: ReleaseChannel::Release,
            game_versions: Vec::new(),
            loaders: Vec::new(),
            file_name: entry.file_name,
            file_size: None,
            sha1: entry.sha1,
            download_url: None,
            date_published: String::new(),
            dependencies: Vec::new(),
        };
        Self {
            version,
            title: entry.title,
            icon_url: entry.icon_url,
            required_by: Some(required_by),
            already_satisfied: true,
            delisted: true,
        }
    }
}

impl Aurora {
    /// 解析依赖并产出安装计划。
    ///
    /// 栈式深度优先展开，`visited` 按 project_id 去重：真实数据里存在 A 依赖 B、B 又反过来声明依赖 A
    /// 的环（两个 Mod 互相集成时很常见），不去重会直接死循环。同一工程被多个父项要求时也只进计划一次。
    ///
    /// 网络故障与平台报错照常冒泡：那是「查不到」而非「没有」，把它压成一条 skipped 说明会让玩家以为
    /// 依赖真的不存在。平台明确回了「没有这个工程」才算没有（见 [`project_gone`]）。
    pub async fn plan_install(
        &self,
        version_id: &str,
        platform: Platform,
        project_id: &str,
        mod_version_id: &str,
    ) -> Result<InstallPlan> {
        // 先把本地事实拿全：实例不存在时在触网之前就短路。
        let instance = self.resolve_instance(version_id).await?;
        let facts = InstanceFacts {
            mc_version: instance_mc_version(&instance),
            loaders: instance_loaders(&instance),
            mod_loaders: instance_mod_loaders(&instance),
        };
        let dirs = self.instance_dirs(&instance).await?;
        let ledger = self.ledger_store(version_id).load().await?;

        // 主项按版本 id 精确取（单版本端点），不做择优、也不带实例过滤：玩家在版本下拉里选了哪个就是
        // 哪个。带上过滤条件会把他刻意选的「不完全匹配但想试试」的版本筛没，然后报一句「版本不存在」。
        let root = self
            .get_mod_version(platform, project_id, mod_version_id)
            .await?;

        let mut items: Vec<PlannedItem> = Vec::new();
        let mut notes: Vec<SkipNote> = Vec::new();
        // 去重键取平台返回的规范 project_id，而不是入参——入参可能是 slug，与依赖声明里的 id 对不上。
        let mut visited: HashSet<String> = HashSet::from([root.project_id.clone()]);
        let root_satisfied = installed_exact(&ledger, &dirs.mods_dir, &root).await?;
        let mut stack: Vec<PlannedItem> =
            vec![PlannedItem::from_platform(root, None, root_satisfied)];

        while let Some(item) = stack.pop() {
            let version = &item.version;
            let mut children: Vec<PlannedItem> = Vec::new();

            for dep in &version.dependencies {
                let dep_project = dep.project_id.clone();
                match dep.kind {
                    DependencyKind::Required => {
                        let Some(dep_project) = dep_project else {
                            notes.push(SkipNote::MissingProjectId {
                                file_name: version.file_name.clone(),
                            });
                            continue;
                        };
                        // 换成 QFAPI 时作者钉的是 Fabric API 的版本，对 QFAPI 没有意义，一并丢掉。
                        let stand_in =
                            quilt_stand_in(platform, &dep_project, &facts, &ledger, &dirs.mods_dir)
                                .await?;
                        let mut author_pin = match stand_in {
                            Some(_) => None,
                            None => dep.version_id.as_deref(),
                        };
                        let dep_project = stand_in.map_or(dep_project, str::to_owned);
                        // 已展开过（含环）就不再进计划：它要么已在 items 里，要么已被判为不可用。
                        if !visited.insert(dep_project.clone()) {
                            continue;
                        }
                        if let Some(wanted) = author_pin
                            && held_back(&ledger, &dirs.mods_dir, platform, &dep_project, wanted)
                                .await?
                        {
                            notes.push(SkipNote::HeldBack {
                                project_id: dep_project.clone(),
                                file_name: version.file_name.clone(),
                            });
                            author_pin = None;
                        }
                        let (resolved, rejected) = self
                            .resolve_required(
                                platform,
                                &dep_project,
                                author_pin,
                                &facts,
                                &ledger,
                                &dirs.mods_dir,
                            )
                            .await?;
                        notes.extend(rejected.map(|rejection| {
                            rejection.note(dep_project.clone(), version.file_name.clone())
                        }));
                        match resolved {
                            Resolved::Chosen(chosen, installed) => {
                                children.push(PlannedItem::from_platform(
                                    *chosen,
                                    Some(version.project_id.clone()),
                                    installed,
                                ));
                            }
                            Resolved::Delisted(entry) => children
                                .push(PlannedItem::from_ledger(*entry, version.project_id.clone())),
                            Resolved::Skipped(note) => notes.push(note),
                        }
                    }
                    DependencyKind::Optional => notes.push(SkipNote::Optional {
                        project_id: dep_project,
                    }),
                    DependencyKind::Incompatible => notes.push(SkipNote::Incompatible {
                        file_name: version.file_name.clone(),
                        project_id: dep_project,
                    }),
                    DependencyKind::Embedded => notes.push(SkipNote::Embedded {
                        file_name: version.file_name.clone(),
                        project_id: dep_project,
                    }),
                    DependencyKind::Tool => notes.push(SkipNote::Tool {
                        project_id: dep_project,
                    }),
                }
            }

            // 反序压栈，让出栈顺序与依赖声明顺序一致：计划是给人看的，顺序抖动会让人以为算错了。
            for child in children.into_iter().rev() {
                stack.push(child);
            }
            items.push(item);
        }

        // 整份计划的标题一次取齐：计划项与跳过说明里提到的工程合成一个批次。
        let mut wanted: Vec<String> = items
            .iter()
            .map(|item| item.version.project_id.clone())
            .chain(
                notes
                    .iter()
                    .filter_map(|n| n.project_id().map(str::to_owned)),
            )
            .collect();
        wanted.sort();
        wanted.dedup();
        let infos = self.project_infos(platform, &wanted).await?;
        for item in &mut items {
            if let Some(info) = infos.get(&item.version.project_id) {
                item.title = Some(info.title.clone());
                item.icon_url = info.icon_url.clone();
            }
        }
        let name = |id: Option<&str>| match id {
            Some(id) => infos
                .get(id)
                .map_or_else(|| id.to_owned(), |info| info.title.clone()),
            None => "未标明工程的前置".to_owned(),
        };
        let skipped = notes.iter().map(|note| note.render(name)).collect();
        let unmet = notes
            .iter()
            .filter(|note| note.is_required())
            .map(|note| note.render(name))
            .collect();
        Ok(InstallPlan {
            items,
            skipped,
            unmet,
        })
    }

    /// 解析一条必需依赖，连同作者钉的版本没被采用的原因（有的话）一起交回。
    ///
    /// 依赖声明里带了精确版本号时优先采用，不再择优：实例里没有这个前置时，那是作者测过的搭配。但它
    /// 说的是「发版时用的这一版」，不是「只能用这一版」，所以有两种情况不照做，见 [`Aurora::reject_pin`]。
    /// 没钉版本或钉的版本没被采用时，走 [`Aurora::resolve_unpinned`]。
    async fn resolve_required(
        &self,
        platform: Platform,
        dep_project: &str,
        pinned: Option<&str>,
        facts: &InstanceFacts,
        ledger: &Ledger,
        mods_dir: &Path,
    ) -> Result<(Resolved, Option<PinRejection>)> {
        let mut rejected = None;
        if let Some(pinned) = pinned {
            match self.get_mod_version(platform, dep_project, pinned).await {
                Ok(version) => {
                    let installed = installed_exact(ledger, mods_dir, &version).await?;
                    if !installed {
                        rejected = self.reject_pin(&version, facts, ledger, mods_dir).await?;
                    }
                    if rejected.is_none() {
                        return Ok((Resolved::Chosen(Box::new(version), installed), None));
                    }
                }
                // 「作者钉的版本没了」与「这个实例用不上任何版本」是两回事，玩家该拿到哪一种，取决于他
                // 接下来是去找替代 Mod 还是去换实例。
                Err(CoreError::ModVersionNotFound { .. }) => {
                    let resolved = match installed_version(
                        ledger,
                        mods_dir,
                        platform,
                        dep_project,
                        Some(pinned),
                    )
                    .await?
                    {
                        Some(entry) => Resolved::Delisted(Box::new(entry.clone())),
                        None => Resolved::Skipped(SkipNote::PinnedGone {
                            project_id: dep_project.to_owned(),
                            version_id: pinned.to_owned(),
                        }),
                    };
                    return Ok((resolved, None));
                }
                Err(other) => return Err(other),
            }
        }
        let resolved = self
            .resolve_unpinned(platform, dep_project, facts, ledger, mods_dir)
            .await?;
        // 什么都没选上时，跳过说明已经说清了，再说「已改用适配的版本」就是假话。
        if matches!(resolved, Resolved::Skipped(_)) {
            rejected = None;
        }
        Ok((resolved, rejected))
    }

    /// 作者钉的版本不该照做时给出原因；实例里已经是这一版时不用问。
    ///
    /// 一是这一版明确不适配实例：Modrinth 的钉版本常常只是作者发版时的构建环境，旧版 AppleSkin 钉的
    /// Fabric API 0.83.0+1.20 只认 1.20，装进 1.20.1 实例后加载器直接拒绝启动。
    /// 二是实例里已有不比它旧的版本：前置是实例里所有 Mod 共用的，往回换会让别的 Mod 要求的版本不再
    /// 满足，玩家只是装一个 Mod，实例却再也起不来。已装的那一版在平台上找不到时比不出先后，同样不换。
    async fn reject_pin(
        &self,
        pin: &ModVersionInfo,
        facts: &InstanceFacts,
        ledger: &Ledger,
        mods_dir: &Path,
    ) -> Result<Option<PinRejection>> {
        if matches!(judge(pin, facts), Compatibility::Mismatch { .. }) {
            return Ok(Some(PinRejection::Incompatible));
        }
        let Some(entry) =
            installed_version(ledger, mods_dir, pin.platform, &pin.project_id, None).await?
        else {
            return Ok(None);
        };
        match self
            .get_mod_version(pin.platform, &pin.project_id, &entry.version_id)
            .await
        {
            Ok(current) if current.date_published < pin.date_published => Ok(None),
            Ok(_) | Err(CoreError::ModVersionNotFound { .. }) => {
                Ok(Some(PinRejection::OlderThanInstalled))
            }
            Err(other) => Err(other),
        }
    }

    /// 解析一条没钉版本（或钉的版本没被采用）的必需依赖：实例里已有同工程的文件就沿用它，否则择优。
    ///
    /// 实例里装着的那一版在平台上已经找不到（下架或删除）时照样算已满足：文件就在 mods 目录里，能不能
    /// 用由玩家现有的整套 Mod 说了算；拿平台上另一版顶替是替他换版本，让整份计划失败则连主 Mod 也装
    /// 不上。只有「找不到这个版本」这样处理，网络与别的平台错误照常冒泡。
    async fn resolve_unpinned(
        &self,
        platform: Platform,
        dep_project: &str,
        facts: &InstanceFacts,
        ledger: &Ledger,
        mods_dir: &Path,
    ) -> Result<Resolved> {
        if let Some(entry) =
            installed_version(ledger, mods_dir, platform, dep_project, None).await?
        {
            return match self
                .get_mod_version(platform, dep_project, &entry.version_id)
                .await
            {
                Ok(version) => Ok(Resolved::Chosen(Box::new(version), true)),
                Err(CoreError::ModVersionNotFound { .. }) => {
                    Ok(Resolved::Delisted(Box::new(entry.clone())))
                }
                Err(other) => Err(other),
            };
        }

        // 把实例事实作为过滤条件带下去。这不是为了省流量：CurseForge 的文件列表最多翻 10 页（500 个文件），
        // 文件更多的前置不带条件查会被截断，截掉的部分可能正好有唯一适配本实例的文件，结果是「明明有版本
        // 却报没有适配版本」；带上条件，平台先筛过再分页。缓存里有完整的不过滤列表时由它本地代答。
        let game_versions: Vec<String> = facts.mc_version.clone().into_iter().collect();
        let listed = self
            .list_mod_versions(platform, dep_project, &game_versions, &facts.mod_loaders)
            .await;
        let candidates = match listed {
            Ok(candidates) => candidates,
            Err(err) if project_gone(&err) => {
                return Ok(Resolved::Skipped(SkipNote::ProjectGone {
                    project_id: dep_project.to_owned(),
                }));
            }
            Err(err) => return Err(err),
        };
        Ok(match pick_latest_compatible(candidates, facts) {
            Some(chosen) => Resolved::Chosen(Box::new(chosen), false),
            None => Resolved::Skipped(SkipNote::NoCompatibleVersion {
                project_id: dep_project.to_owned(),
            }),
        })
    }
}

/// Quilt 实例上顶替 Fabric API 这条前置的工程；不用顶替时为 `None`。
///
/// Fabric Mod 写的前置是 Fabric API，而 Quilt 上这个位置由 QFAPI 占着：它声明自己提供 fabric-api，
/// Fabric API 本身在平台上只标 fabric，按原样解析只能得到一句假的「没有适配版本」。实例里已经装着
/// Fabric API 时不换，再添一份 QFAPI 只会重复加载。工程 id 只记了 Modrinth 的。
async fn quilt_stand_in(
    platform: Platform,
    dep_project: &str,
    facts: &InstanceFacts,
    ledger: &Ledger,
    mods_dir: &Path,
) -> Result<Option<&'static str>> {
    if platform != Platform::Modrinth
        || dep_project != FABRIC_API_PROJECT
        || !facts.mod_loaders.contains(&ModLoader::Quilt)
    {
        return Ok(None);
    }
    let has_fabric_api = installed_version(ledger, mods_dir, platform, dep_project, None)
        .await?
        .is_some();
    Ok((!has_fabric_api).then_some(QFAPI_PROJECT))
}

/// 这个错误说的是不是工程在平台上已经没有了。
///
/// 版本列表端点对没有的工程回 404，id 不成形的 CurseForge 工程在触网前就判为未找到。断网、限流、5xx
/// 是「查不到」而不是「没有」，不算在内。
pub(crate) fn project_gone(err: &CoreError) -> bool {
    matches!(
        err,
        CoreError::ModPlatform(aurora_modplatform::Error::Status { status: 404, .. })
            | CoreError::ModVersionNotFound { .. }
    )
}

/// 从候选里挑该实例可用的最新版本。
///
/// 显式再排一次而不是依赖上游返回顺序：择优的全部意义就是「最新」，这条前提不该跨模块靠约定维持。
/// 判定不为 Mismatch 即可用——[`Compatibility::Unknown`]（平台没给元数据）按放行处理，与落位层的
/// 软提示口径一致。通道从最稳定的挑起，与更新检查、开局 Mod 同一条底线：玩家没选过测试版，不能因为
/// 它是某个 Mod 的前置就带进来。
fn pick_latest_compatible(
    mut candidates: Vec<ModVersionInfo>,
    facts: &InstanceFacts,
) -> Option<ModVersionInfo> {
    sort_by_published_desc(&mut candidates);
    candidates.retain(|version| !matches!(judge(version, facts), Compatibility::Mismatch { .. }));
    let best = ReleaseChannel::Alpha
        .admitted()
        .iter()
        .find_map(|channel| {
            candidates
                .iter()
                .position(|version| version.release_channel == *channel)
        })?;
    Some(candidates.swap_remove(best))
}

/// 按实例事实判定某版本是否可用。MC 版本识别不出时交 `None` 给 [`classify`]：只判加载器，落在
/// [`Compatibility::Unknown`]——因为我们不知道而把候选判成「不支持 MC」是惩罚玩家。
fn judge(version: &ModVersionInfo, facts: &InstanceFacts) -> Compatibility {
    classify(version, facts.mc_version.as_deref(), &facts.loaders)
}

/// 同工程同版本是否已装在此实例（卷宗有记录，且其文件确实在磁盘上，禁用态也算）。
async fn installed_exact(
    ledger: &Ledger,
    mods_dir: &Path,
    version: &ModVersionInfo,
) -> Result<bool> {
    for entry in &ledger.entries {
        if entry.platform == version.platform
            && entry.project_id == version.project_id
            && entry.version_id == version.version_id
            && present(mods_dir, &entry.file_name).await?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 该工程的某一版（`version_id` 为 `None` 时任意版本）是否已装在此实例；装着就返回那条卷宗记录。
/// 磁盘是权威：卷宗有而文件不在不算。
async fn installed_version<'a>(
    ledger: &'a Ledger,
    mods_dir: &Path,
    platform: Platform,
    project_id: &str,
    version_id: Option<&str>,
) -> Result<Option<&'a LedgerEntry>> {
    for entry in &ledger.entries {
        if entry.platform == platform
            && entry.project_id == project_id
            && version_id.is_none_or(|wanted| entry.version_id == wanted)
            && present(mods_dir, &entry.file_name).await?
        {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}

/// 实例里装着这个工程，玩家设了更新检查，而作者要的 `wanted` 不在他允许的范围内。
///
/// 锁定的上限要比发布时间才知道谁先谁后，这里为此多问一次平台不值：只放行锁定的那一版。
async fn held_back(
    ledger: &Ledger,
    mods_dir: &Path,
    platform: Platform,
    project_id: &str,
    wanted: &str,
) -> Result<bool> {
    let Some(entry) = installed_version(ledger, mods_dir, platform, project_id, None).await? else {
        return Ok(false);
    };
    Ok(entry.version_id != wanted
        && match &entry.update_hold {
            None => false,
            Some(UpdateHold::Ignored) => true,
            Some(UpdateHold::Pinned { version_id }) => version_id != wanted,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use aurora_modplatform::ReleaseChannel;
    use std::collections::HashMap;
    use wiremock::matchers::{method, path, query_param, query_param_is_missing};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn version(project_id: &str, version_id: &str) -> ModVersionInfo {
        ModVersionInfo {
            version_id: version_id.to_owned(),
            project_id: project_id.to_owned(),
            platform: Platform::Modrinth,
            name: "Sodium 0.5.3".to_owned(),
            version_number: "mc1.20.1-0.5.3".to_owned(),
            release_channel: ReleaseChannel::Release,
            game_versions: vec!["1.20.1".to_owned()],
            loaders: Vec::new(),
            file_name: format!("{project_id}.jar"),
            file_size: None,
            sha1: None,
            download_url: None,
            date_published: "2026-01-02T03:04:05Z".to_owned(),
            dependencies: Vec::new(),
        }
    }

    /// 一条 Modrinth 版本 JSON。`deps` 直接拼进 `dependencies` 数组（可为空串）。
    fn modrinth_version(
        id: &str,
        project: &str,
        date: &str,
        game_versions: &[&str],
        loaders: &[&str],
        deps: &str,
    ) -> String {
        let game_versions = serde_json::to_string(game_versions).unwrap();
        let loaders = serde_json::to_string(loaders).unwrap();
        format!(
            r#"{{"id":"{id}","project_id":"{project}","name":"{project} {id}",
                "version_number":"{id}","version_type":"release","date_published":"{date}",
                "game_versions":{game_versions},"loaders":{loaders},"dependencies":[{deps}],
                "files":[{{"hashes":{{"sha1":"aabbcc"}},"url":"https://example.invalid/{id}.jar",
                    "filename":"{project}-{id}.jar","primary":true,"size":1024}}]}}"#
        )
    }

    /// 挂载某工程的版本列表端点，以及其中每个版本的单版本端点；顺带挂一个兜底的工程摘要端点
    /// （优先级最低，测试自己挂的摘要端点优先命中）。
    async fn mount_versions(server: &MockServer, project: &str, versions: &[String]) {
        let body = format!("[{}]", versions.join(","));
        Mock::given(method("GET"))
            .and(path(format!("/project/{project}/version")))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(server)
            .await;
        for raw in versions {
            let value: serde_json::Value = serde_json::from_str(raw).unwrap();
            let id = value["id"].as_str().unwrap().to_owned();
            Mock::given(method("GET"))
                .and(path(format!("/version/{id}")))
                .respond_with(ResponseTemplate::new(200).set_body_json(value))
                .mount(server)
                .await;
        }
        Mock::given(method("GET"))
            .and(path("/projects"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .with_priority(200)
            .mount(server)
            .await;
    }

    /// 落一个 Fabric 实例：inheritsFrom 给出 MC 1.20.1，库坐标让加载器探测命中 Fabric。
    async fn put_fabric_instance(mc: &Path, id: &str) {
        let dir = mc.join("versions").join(id);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join(format!("{id}.json")),
            format!(
                r#"{{"id":"{id}","inheritsFrom":"1.20.1","type":"release",
                    "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                    "libraries":[{{"name":"net.fabricmc:fabric-loader:0.15.11"}}]}}"#
            ),
        )
        .await
        .unwrap();
    }

    /// 落一个 Quilt 实例：与 Fabric 实例同形，库坐标让加载器探测命中 Quilt。
    async fn put_quilt_instance(mc: &Path, id: &str) {
        let dir = mc.join("versions").join(id);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join(format!("{id}.json")),
            format!(
                r#"{{"id":"{id}","inheritsFrom":"1.20.1","type":"release",
                    "mainClass":"org.quiltmc.loader.impl.launch.knot.KnotClient",
                    "libraries":[{{"name":"org.quiltmc:quilt-loader:0.30.2"}}]}}"#
            ),
        )
        .await
        .unwrap();
    }

    fn aurora_at(mc: &Path, modrinth_base: String) -> Aurora {
        let mut aurora =
            Aurora::for_test(AuroraConfig::default(), mc.to_path_buf(), mc.to_path_buf());
        aurora.set_isolation_policy(aurora_instance::IsolationPolicy::All);
        aurora.with_modrinth_base(modrinth_base)
    }

    fn entry(file_name: &str, project_id: &str, version_id: &str) -> LedgerEntry {
        LedgerEntry {
            file_name: file_name.to_owned(),
            platform: Platform::Modrinth,
            project_id: project_id.to_owned(),
            version_id: version_id.to_owned(),
            version_number: None,
            title: None,
            icon_url: None,
            sha1: None,
            installed_at: 1_754_000_000,
            installed_as_dependency_of: None,
            update_hold: None,
        }
    }

    #[test]
    fn plan_serializes_with_ipc_field_names() {
        let plan = InstallPlan {
            items: vec![
                PlannedItem {
                    version: version("AANobbMI", "IZskiJmZ"),
                    title: Some("Sodium".to_owned()),
                    icon_url: Some("https://cdn.example.invalid/s.png".to_owned()),
                    required_by: None,
                    already_satisfied: false,
                    delisted: false,
                },
                PlannedItem {
                    version: version("P7dR8mSH", "QwErTyUi"),
                    title: None,
                    icon_url: None,
                    required_by: Some("AANobbMI".to_owned()),
                    already_satisfied: true,
                    delisted: false,
                },
            ],
            skipped: vec!["可选前置 Mod Menu 未自动安装，需要时手动添加".to_owned()],
            unmet: vec!["前置 Lib 没有适配该实例的版本，未加入计划".to_owned()],
        };

        let json = serde_json::to_value(&plan).unwrap();
        // 确认计划的界面读完整的 skipped，这份子集不下发。
        assert!(json.get("unmet").is_none());
        assert_eq!(json["items"][0]["required_by"], serde_json::Value::Null);
        assert_eq!(json["items"][0]["already_satisfied"], false);
        assert_eq!(json["items"][0]["title"], "Sodium");
        assert_eq!(
            json["items"][0]["icon_url"],
            "https://cdn.example.invalid/s.png"
        );
        assert_eq!(json["items"][0]["version"]["version_id"], "IZskiJmZ");
        assert_eq!(json["items"][1]["required_by"], "AANobbMI");
        assert_eq!(json["items"][1]["already_satisfied"], true);
        assert_eq!(json["items"][1]["title"], serde_json::Value::Null);
        assert_eq!(
            json["skipped"][0],
            "可选前置 Mod Menu 未自动安装，需要时手动添加"
        );
    }

    #[test]
    fn empty_plan_keeps_both_arrays_present() {
        // UI 直接读 items/skipped 的长度，字段不能因为空而消失。
        let json = serde_json::to_value(InstallPlan {
            items: Vec::new(),
            skipped: Vec::new(),
            unmet: Vec::new(),
        })
        .unwrap();
        assert_eq!(json["items"], serde_json::json!([]));
        assert_eq!(json["skipped"], serde_json::json!([]));
    }

    #[test]
    fn skip_notes_prefer_titles_and_fall_back_to_ids() {
        let titles: HashMap<String, String> =
            HashMap::from([("modmenu".to_owned(), "Mod Menu".to_owned())]);
        let name = |id: Option<&str>| match id {
            Some(id) => titles.get(id).cloned().unwrap_or_else(|| id.to_owned()),
            None => "未标明工程的前置".to_owned(),
        };
        assert_eq!(
            SkipNote::Optional {
                project_id: Some("modmenu".to_owned())
            }
            .render(name),
            "可选前置 Mod Menu 未自动安装，需要时手动添加"
        );
        assert_eq!(
            SkipNote::Tool {
                project_id: Some("unknown-id".to_owned())
            }
            .render(name),
            "工具类关联 unknown-id 未自动安装"
        );
        assert_eq!(
            SkipNote::Embedded {
                file_name: "a.jar".to_owned(),
                project_id: None
            }
            .render(name),
            "内嵌前置 未标明工程的前置 已打包在 a.jar 内，无需单独安装"
        );
    }

    /// 无依赖的工程：计划里只有玩家选的那一项，标题图标来自工程摘要。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn plan_without_dependencies_contains_only_the_chosen_version() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .and(query_param("ids", r#"["sodium"]"#))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"[{"id":"sodium","title":"Sodium","description":"d","project_type":"mod",
                     "downloads":1,"icon_url":"https://cdn.example.invalid/sodium.png"}]"#,
            ))
            .expect(1)
            .mount(&server)
            .await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                "",
            )],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].version.version_id, "v1");
        assert_eq!(plan.items[0].version.file_name, "sodium-v1.jar");
        assert_eq!(plan.items[0].title.as_deref(), Some("Sodium"));
        assert_eq!(
            plan.items[0].icon_url.as_deref(),
            Some("https://cdn.example.invalid/sodium.png")
        );
        assert_eq!(plan.items[0].required_by, None);
        assert!(!plan.items[0].already_satisfied);
        assert!(plan.skipped.is_empty());
    }

    /// 必需依赖被收进计划，且取的是「适配本实例的最新版本」而非全局最新。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn required_dependency_resolves_to_newest_compatible_version() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","dependency_type":"required"}"#,
            )],
        )
        .await;
        mount_versions(
            &server,
            "fabric-api",
            &[
                // 全局最新，但只支持 1.21：不能被选中。
                modrinth_version(
                    "for-1-21",
                    "fabric-api",
                    "2026-06-01T00:00:00Z",
                    &["1.21"],
                    &["fabric"],
                    "",
                ),
                modrinth_version(
                    "for-1-20-1-new",
                    "fabric-api",
                    "2026-02-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                ),
                modrinth_version(
                    "for-1-20-1-old",
                    "fabric-api",
                    "2025-02-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                ),
            ],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 2);
        assert_eq!(plan.items[0].version.version_id, "v1");
        assert_eq!(plan.items[1].version.project_id, "fabric-api");
        assert_eq!(plan.items[1].version.version_id, "for-1-20-1-new");
        assert_eq!(plan.items[1].required_by, Some("sodium".to_owned()));
        assert!(!plan.items[1].already_satisfied);
        assert!(plan.skipped.is_empty());
    }

    /// A 依赖 B、B 反过来依赖 A：必须收敛成两项，且不重复展开。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cyclic_dependencies_do_not_loop_forever() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "alpha",
            &[modrinth_version(
                "a1",
                "alpha",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"beta","dependency_type":"required"}"#,
            )],
        )
        .await;
        mount_versions(
            &server,
            "beta",
            &[modrinth_version(
                "b1",
                "beta",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"alpha","dependency_type":"required"}"#,
            )],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "alpha", "a1")
            .await
            .unwrap();

        let planned: Vec<&str> = plan
            .items
            .iter()
            .map(|item| item.version.project_id.as_str())
            .collect();
        assert_eq!(planned, vec!["alpha", "beta"]);
        assert!(plan.skipped.is_empty());
    }

    /// 非必需依赖一律不自动安装，但每一条都要在 skipped 里说清楚，能取到标题就用标题。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn non_required_dependencies_are_skipped_with_reasons() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"[{"id":"modmenu","title":"Mod Menu","description":"d","project_type":"mod","downloads":1}]"#,
            ))
            .mount(&server)
            .await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                concat!(
                    r#"{"project_id":"modmenu","dependency_type":"optional"},"#,
                    r#"{"project_id":"optifabric","dependency_type":"incompatible"},"#,
                    r#"{"project_id":"cloth-config","dependency_type":"embedded"}"#
                ),
            )],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(
            plan.skipped,
            vec![
                "可选前置 Mod Menu 未自动安装，需要时手动添加".to_owned(),
                "sodium-v1.jar 声明与 optifabric 不兼容，未做任何处理".to_owned(),
                "内嵌前置 cloth-config 已打包在 sodium-v1.jar 内，无需单独安装".to_owned(),
            ]
        );
        assert_eq!(plan.unmet, Vec::<String>::new());
    }

    /// 依赖没有适配本实例的版本：进 skipped 说明，主 Mod 仍留在计划里。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dependency_without_compatible_version_is_skipped_but_main_stays() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","dependency_type":"required"}"#,
            )],
        )
        .await;
        mount_versions(
            &server,
            "fabric-api",
            &[
                modrinth_version(
                    "old",
                    "fabric-api",
                    "2024-01-01T00:00:00Z",
                    &["1.19.2"],
                    &["fabric"],
                    "",
                ),
                modrinth_version(
                    "forge-only",
                    "fabric-api",
                    "2026-05-01T00:00:00Z",
                    &["1.20.1"],
                    &["forge"],
                    "",
                ),
            ],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].version.version_id, "v1");
        assert_eq!(
            plan.skipped,
            vec!["前置 fabric-api 没有适配该实例的版本，未加入计划".to_owned()]
        );
        assert_eq!(plan.unmet, plan.skipped);
    }

    /// 依赖钉死了精确版本：原样采用（走单版本端点），不因为有更新的版本就改口。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pinned_dependency_version_is_taken_verbatim() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","version_id":"pinned","dependency_type":"required"}"#,
            )],
        )
        .await;
        mount_versions(
            &server,
            "fabric-api",
            &[
                modrinth_version(
                    "newer",
                    "fabric-api",
                    "2026-06-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                ),
                modrinth_version(
                    "pinned",
                    "fabric-api",
                    "2025-01-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                ),
            ],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 2);
        assert_eq!(plan.items[1].version.version_id, "pinned");
        assert!(plan.skipped.is_empty());
    }

    /// 一个标了 Fabric 与 Quilt、把 Fabric API 钉在旧版的 Mod，加上平台上的 Fabric API 与 QFAPI。
    /// 真实数据：AppleSkin 2.5.0+mc1.20 钉的 Fabric API 只标 fabric，Quilt 实例上永远不适配。
    async fn mount_quilt_dependency_case(server: &MockServer) {
        let dep = format!(
            r#"{{"project_id":"{FABRIC_API_PROJECT}","version_id":"fapi-pinned","dependency_type":"required"}}"#
        );
        mount_versions(
            server,
            "appleskin",
            &[modrinth_version(
                "v1",
                "appleskin",
                "2026-01-01T00:00:00Z",
                &["1.20", "1.20.1"],
                &["fabric", "quilt"],
                &dep,
            )],
        )
        .await;
        mount_versions(
            server,
            FABRIC_API_PROJECT,
            &[modrinth_version(
                "fapi-pinned",
                FABRIC_API_PROJECT,
                "2025-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                "",
            )],
        )
        .await;
        mount_versions(
            server,
            QFAPI_PROJECT,
            &[
                modrinth_version(
                    "qfapi-old",
                    QFAPI_PROJECT,
                    "2025-06-01T00:00:00Z",
                    &["1.20.1"],
                    &["quilt"],
                    "",
                ),
                modrinth_version(
                    "qfapi-new",
                    QFAPI_PROJECT,
                    "2026-02-01T00:00:00Z",
                    &["1.20.1"],
                    &["quilt"],
                    "",
                ),
            ],
        )
        .await;
    }

    /// Quilt 实例里的 QFAPI 就是 Fabric API 那个前置：算已满足，不报「没有适配版本」，版本也不动。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quilt_instance_with_qfapi_counts_as_having_fabric_api() {
        let server = MockServer::start().await;
        mount_quilt_dependency_case(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        put_quilt_instance(tmp.path(), "1.20.1-quilt").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        let mut ledger = Ledger::default();
        ledger.upsert(entry("qfapi.jar", QFAPI_PROJECT, "qfapi-old"));
        aurora
            .ledger_store("1.20.1-quilt")
            .save(&ledger)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.20.1-quilt").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("qfapi.jar"), b"jar")
            .await
            .unwrap();

        let plan = aurora
            .plan_install("1.20.1-quilt", Platform::Modrinth, "appleskin", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 2);
        assert_eq!(plan.items[1].version.project_id, QFAPI_PROJECT);
        assert_eq!(plan.items[1].version.version_id, "qfapi-old");
        assert_eq!(plan.items[1].required_by, Some("appleskin".to_owned()));
        assert!(plan.items[1].already_satisfied);
        assert_eq!(plan.skipped, Vec::<String>::new());
        assert_eq!(plan.unmet, Vec::<String>::new());
    }

    /// 没装 QFAPI 的 Quilt 实例：前置落到适配实例的最新 QFAPI 上，作者钉的 Fabric API 版本与它无关。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quilt_instance_without_qfapi_gets_it_for_a_fabric_api_dependency() {
        let server = MockServer::start().await;
        mount_quilt_dependency_case(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        put_quilt_instance(tmp.path(), "1.20.1-quilt").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-quilt", Platform::Modrinth, "appleskin", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 2);
        assert_eq!(plan.items[1].version.project_id, QFAPI_PROJECT);
        assert_eq!(plan.items[1].version.version_id, "qfapi-new");
        assert!(!plan.items[1].already_satisfied);
        assert_eq!(plan.skipped, Vec::<String>::new());
    }

    /// Quilt 实例里已经装着 Fabric API（从别处搬来的老实例）：沿用它，不再添一份 QFAPI。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quilt_instance_that_already_has_fabric_api_keeps_it() {
        let server = MockServer::start().await;
        mount_quilt_dependency_case(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        put_quilt_instance(tmp.path(), "1.20.1-quilt").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        let mut ledger = Ledger::default();
        ledger.upsert(entry("fapi.jar", FABRIC_API_PROJECT, "fapi-pinned"));
        aurora
            .ledger_store("1.20.1-quilt")
            .save(&ledger)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.20.1-quilt").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("fapi.jar"), b"jar")
            .await
            .unwrap();

        let plan = aurora
            .plan_install("1.20.1-quilt", Platform::Modrinth, "appleskin", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 2);
        assert_eq!(plan.items[1].version.project_id, FABRIC_API_PROJECT);
        assert!(plan.items[1].already_satisfied);
    }

    /// Fabric 实例照旧：前置就是 Fabric API，不会被换成 QFAPI。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fabric_instance_never_swaps_fabric_api_for_qfapi() {
        let server = MockServer::start().await;
        mount_quilt_dependency_case(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "appleskin", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items[1].version.project_id, FABRIC_API_PROJECT);
    }

    /// 钉死的版本在平台上已被删除：说明具体是哪个版本没了，而不是笼统说「找不到」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pinned_dependency_version_gone_reports_which_version() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","version_id":"gone","dependency_type":"required"}"#,
            )],
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/version/gone"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(
            plan.skipped,
            vec!["前置 fabric-api 指定的版本 gone 在平台上已不存在，未加入计划".to_owned()]
        );
    }

    /// 必需依赖没给工程标识：无从解析，如实记一条而不是当没看见。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn required_dependency_without_project_id_is_reported() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"file_name":"some-lib.jar","dependency_type":"required"}"#,
            )],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(
            plan.skipped,
            vec!["sodium-v1.jar 的一条必需前置没有给出工程标识，无法自动解析".to_owned()]
        );
    }

    /// already_satisfied 以磁盘为准：卷宗有记录但文件不在就是没装；禁用态文件仍然算装了。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn already_satisfied_follows_disk_not_ledger() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","dependency_type":"required"}"#,
            )],
        )
        .await;
        mount_versions(
            &server,
            "fabric-api",
            &[modrinth_version(
                "ok1",
                "fabric-api",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                "",
            )],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        // 卷宗声称两个都装过。
        let mut ledger = Ledger::default();
        ledger.upsert(entry("sodium-v1.jar", "sodium", "v1"));
        ledger.upsert(entry("fabric-api-ok1.jar", "fabric-api", "ok1"));
        aurora
            .ledger_store("1.20.1-fabric")
            .save(&ledger)
            .await
            .unwrap();

        // 磁盘上只有主 Mod，且是禁用态。
        let mods_dir = aurora.resolve_mods_dir("1.20.1-fabric").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("sodium-v1.jar.disabled"), b"jar")
            .await
            .unwrap();

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();
        assert_eq!(plan.items.len(), 2);
        assert!(plan.items[0].already_satisfied);
        // 卷宗有、磁盘没有：必须判为未装，否则这个依赖永远补不回来。
        assert!(!plan.items[1].already_satisfied);

        tokio::fs::write(mods_dir.join("fabric-api-ok1.jar"), b"jar")
            .await
            .unwrap();
        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();
        assert!(plan.items[1].already_satisfied);
    }

    /// 前置已装着一个旧版本：沿用玩家现有的那份（标为已满足），不擅自换成平台最新版。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn installed_dependency_of_any_version_is_kept() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","dependency_type":"required"}"#,
            )],
        )
        .await;
        mount_versions(
            &server,
            "fabric-api",
            &[
                modrinth_version(
                    "newest",
                    "fabric-api",
                    "2026-06-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                ),
                modrinth_version(
                    "old",
                    "fabric-api",
                    "2025-01-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                ),
            ],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        let mut ledger = Ledger::default();
        ledger.upsert(entry("fabric-api-old.jar", "fabric-api", "old"));
        aurora
            .ledger_store("1.20.1-fabric")
            .save(&ledger)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.20.1-fabric").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("fabric-api-old.jar"), b"jar")
            .await
            .unwrap();

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();
        assert_eq!(plan.items.len(), 2);
        assert_eq!(plan.items[1].version.version_id, "old");
        assert!(plan.items[1].already_satisfied);
    }

    /// 必需前置的工程在平台上没了、实例里也没装：记一条说明，主 Mod 照常进计划。这与「没有适配版本」
    /// 同属决策二，让整份计划失败等于连主 Mod 的更新也做不了。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn required_dependency_whose_project_is_gone_is_skipped() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"gone-lib","dependency_type":"required"}"#,
            )],
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/project/gone-lib/version"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].version.version_id, "v1");
        assert_eq!(
            plan.skipped,
            vec!["前置 gone-lib 在平台上已不存在，未加入计划".to_owned()]
        );
    }

    /// 前置版本列表的别的失败是「查不到」：照常冒泡，不说成工程没了。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dependency_listing_failure_other_than_404_bubbles() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"flaky-lib","dependency_type":"required"}"#,
            )],
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/project/flaky-lib/version"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let err = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::ModPlatform(aurora_modplatform::Error::Status { status: 403, .. })
            ),
            "实得 {err:?}"
        );
    }

    /// 作者钉了 `fabric-api` 的版本 pinned，而实例里装着 current 且设了 `hold`：落一份这样的实例，
    /// 返回算出的计划。
    async fn plan_with_held_dependency(hold: UpdateHold) -> InstallPlan {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","version_id":"pinned","dependency_type":"required"}"#,
            )],
        )
        .await;
        mount_versions(
            &server,
            "fabric-api",
            &[
                modrinth_version(
                    "pinned",
                    "fabric-api",
                    "2026-06-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                ),
                modrinth_version(
                    "current",
                    "fabric-api",
                    "2026-01-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                ),
            ],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        let mut kept = entry("fabric-api-current.jar", "fabric-api", "current");
        kept.update_hold = Some(hold);
        let mut ledger = Ledger::default();
        ledger.upsert(kept);
        aurora
            .ledger_store("1.20.1-fabric")
            .save(&ledger)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.20.1-fabric").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("fabric-api-current.jar"), b"jar")
            .await
            .unwrap();

        aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap()
    }

    /// 玩家忽略了这个前置的更新：作者钉的版本不替他换，保留现有版本并说明。更新不走确认计划，换了
    /// 他都不知道。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ignored_dependency_keeps_its_version_against_an_author_pin() {
        let plan = plan_with_held_dependency(UpdateHold::Ignored).await;

        assert_eq!(plan.items.len(), 2);
        let dep = &plan.items[1];
        assert_eq!(dep.version.version_id, "current");
        assert!(dep.already_satisfied);
        assert!(!dep.delisted);
        assert_eq!(
            plan.skipped,
            vec![
                "前置 fabric-api 按你的更新设置保留现有版本，未换成 sodium-v1.jar 指定的版本"
                    .to_owned()
            ]
        );
    }

    /// 玩家锁定的上限不是作者钉的那一版：同样不替他换。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn locked_dependency_keeps_its_version_unless_the_pin_matches() {
        let plan = plan_with_held_dependency(UpdateHold::Pinned {
            version_id: "current".to_owned(),
        })
        .await;
        assert_eq!(plan.items[1].version.version_id, "current");
        assert!(plan.items[1].already_satisfied);
        assert_eq!(plan.skipped.len(), 1);

        // 锁定的正是作者要的版本：这次替换在玩家允许的范围内，照常进计划。
        let plan = plan_with_held_dependency(UpdateHold::Pinned {
            version_id: "pinned".to_owned(),
        })
        .await;
        assert_eq!(plan.items[1].version.version_id, "pinned");
        assert!(!plan.items[1].already_satisfied);
        assert!(plan.skipped.is_empty());
    }

    /// 主 Mod 钉了 `fabric-api` 的 pinned，平台上另有一个 2025 年发布的 current，实例里按 `installed`
    /// 装着（卷宗记的版本 id）。返回算出的计划。
    async fn plan_with_author_pin(
        pin_date: &str,
        pin_games: &[&str],
        installed: Option<&str>,
    ) -> InstallPlan {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "appleskin",
            &[modrinth_version(
                "v1",
                "appleskin",
                "2023-06-08T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","version_id":"pinned","dependency_type":"required"}"#,
            )],
        )
        .await;
        mount_versions(
            &server,
            "fabric-api",
            &[
                modrinth_version(
                    "current",
                    "fabric-api",
                    "2025-01-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                ),
                modrinth_version("pinned", "fabric-api", pin_date, pin_games, &["fabric"], ""),
            ],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        if let Some(version_id) = installed {
            let mut ledger = Ledger::default();
            ledger.upsert(entry("fabric-api.jar", "fabric-api", version_id));
            aurora
                .ledger_store("1.20.1-fabric")
                .save(&ledger)
                .await
                .unwrap();
            let mods_dir = aurora.resolve_mods_dir("1.20.1-fabric").await.unwrap();
            tokio::fs::create_dir_all(&mods_dir).await.unwrap();
            tokio::fs::write(mods_dir.join("fabric-api.jar"), b"jar")
                .await
                .unwrap();
        }

        aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "appleskin", "v1")
            .await
            .unwrap()
    }

    /// 作者钉的是发版时用的版本，不是「只能用这一版」：实例里已有更新的前置时不往回换。真实数据里
    /// 旧版 AppleSkin 钉了 Fabric API 0.83，照做就把别的 Mod 依赖的 0.92 换掉了，实例再也起不来。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn author_pin_never_downgrades_an_installed_dependency() {
        let plan = plan_with_author_pin("2023-06-08T00:00:00Z", &["1.20.1"], Some("current")).await;

        let dep = &plan.items[1];
        assert_eq!(dep.version.version_id, "current");
        assert!(dep.already_satisfied);
        assert_eq!(
            plan.skipped,
            vec![
                "前置 fabric-api 保留现有的较新版本，未换成 appleskin-v1.jar 指定的旧版本"
                    .to_owned()
            ]
        );
    }

    /// 作者要的比实例里的新：这是真需要，照常换上去。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn author_pin_newer_than_the_installed_dependency_is_taken() {
        let plan = plan_with_author_pin("2026-06-01T00:00:00Z", &["1.20.1"], Some("current")).await;

        let dep = &plan.items[1];
        assert_eq!(dep.version.version_id, "pinned");
        assert!(!dep.already_satisfied);
        assert!(plan.skipped.is_empty());
    }

    /// 作者钉的版本明确不支持这个实例的游戏版本（AppleSkin 2.5.0 钉的 Fabric API 0.83.0+1.20 只认
    /// 1.20）：装上去游戏起不来，改走没钉版本时的择优。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn author_pin_for_another_game_version_falls_back_to_a_compatible_one() {
        let plan = plan_with_author_pin("2023-06-08T00:00:00Z", &["1.20"], None).await;

        let dep = &plan.items[1];
        assert_eq!(dep.version.version_id, "current");
        assert!(!dep.already_satisfied);
        assert_eq!(
            plan.skipped,
            vec![
                "appleskin-v1.jar 指定的前置 fabric-api 版本不适配这个实例，已改用适配的版本"
                    .to_owned()
            ]
        );
    }

    /// 钉的版本不适配，平台上也没有别的版本适配：只说没有可用的版本，不能再说「已改用」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn author_pin_with_nothing_compatible_reports_only_that() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "appleskin",
            &[modrinth_version(
                "v1",
                "appleskin",
                "2023-06-08T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","version_id":"pinned","dependency_type":"required"}"#,
            )],
        )
        .await;
        mount_versions(
            &server,
            "fabric-api",
            &[modrinth_version(
                "pinned",
                "fabric-api",
                "2023-05-30T00:00:00Z",
                &["1.20"],
                &["fabric"],
                "",
            )],
        )
        .await;
        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "appleskin", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(
            plan.skipped,
            vec!["前置 fabric-api 没有适配该实例的版本，未加入计划".to_owned()]
        );
    }

    /// 不适配的钉版本遇上实例里已有的前置：同样不换。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn author_pin_for_another_game_version_keeps_the_installed_dependency() {
        let plan = plan_with_author_pin("2026-06-01T00:00:00Z", &["1.20"], Some("current")).await;

        let dep = &plan.items[1];
        assert_eq!(dep.version.version_id, "current");
        assert!(dep.already_satisfied);
        assert_eq!(plan.skipped.len(), 1);
    }

    /// 实例里已经是作者钉的那一版：什么说明都不用。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn author_pin_already_installed_needs_no_note() {
        let plan = plan_with_author_pin("2023-06-08T00:00:00Z", &["1.20"], Some("pinned")).await;

        let dep = &plan.items[1];
        assert_eq!(dep.version.version_id, "pinned");
        assert!(dep.already_satisfied);
        assert!(plan.skipped.is_empty());
    }

    /// 实例里那一版已从平台下架，比不出谁新：不替玩家换，照常按卷宗列出。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn author_pin_leaves_a_delisted_installed_dependency_alone() {
        let plan =
            plan_with_author_pin("2023-06-08T00:00:00Z", &["1.20.1"], Some("delisted")).await;

        let dep = &plan.items[1];
        assert_eq!(dep.version.version_id, "delisted");
        assert!(dep.delisted && dep.already_satisfied);
        assert_eq!(plan.skipped.len(), 1);
    }

    /// 前置已装着的那一版在平台上已下架（单版本端点 404）：照常算已满足，计划只按卷宗列出它，不去
    /// 平台上另挑一个版本，也不让整份计划失败。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn installed_dependency_delisted_from_platform_stays_satisfied() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","dependency_type":"required"}"#,
            )],
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/version/delisted"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;
        // 平台上另有可用版本：不能拿它顶替玩家装着的那份。
        Mock::given(method("GET"))
            .and(path("/project/fabric-api/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                "[{}]",
                modrinth_version(
                    "replacement",
                    "fabric-api",
                    "2026-06-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                )
            )))
            .expect(0)
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        let mut kept = entry("fabric-api-0.92.0.jar", "fabric-api", "delisted");
        kept.version_number = Some("0.92.0+1.20.1".to_owned());
        kept.title = Some("Fabric API".to_owned());
        kept.icon_url = Some("https://cdn.example.invalid/fabric.png".to_owned());
        kept.sha1 = Some("0123456789abcdef0123456789abcdef01234567".to_owned());
        let mut ledger = Ledger::default();
        ledger.upsert(kept);
        aurora
            .ledger_store("1.20.1-fabric")
            .save(&ledger)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.20.1-fabric").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        // 禁用态也算装着。
        tokio::fs::write(mods_dir.join("fabric-api-0.92.0.jar.disabled"), b"jar")
            .await
            .unwrap();

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 2);
        assert!(!plan.items[0].delisted);
        let dep = &plan.items[1];
        assert!(dep.already_satisfied);
        assert!(dep.delisted);
        assert_eq!(dep.required_by.as_deref(), Some("sodium"));
        assert_eq!(dep.version.platform, Platform::Modrinth);
        assert_eq!(dep.version.project_id, "fabric-api");
        assert_eq!(dep.version.version_id, "delisted");
        assert_eq!(dep.version.version_number, "0.92.0+1.20.1");
        assert_eq!(dep.version.file_name, "fabric-api-0.92.0.jar");
        assert_eq!(
            dep.version.sha1.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert!(dep.version.dependencies.is_empty());
        assert_eq!(dep.version.download_url, None);
        // 平台上连工程摘要都取不到时，名字与图标取卷宗记下的那份。
        assert_eq!(dep.title.as_deref(), Some("Fabric API"));
        assert_eq!(
            dep.icon_url.as_deref(),
            Some("https://cdn.example.invalid/fabric.png")
        );
        assert!(plan.skipped.is_empty());

        let json = serde_json::to_value(&plan).unwrap();
        assert_eq!(json["items"][1]["delisted"], true);
        // 只在这一形态上出现，其余计划项的形状不变。
        assert!(json["items"][0].get("delisted").is_none());
    }

    /// 卷宗没记版本号的已下架前置：版本号退到版本 id；平台上工程还在时名字以平台为准。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delisted_dependency_without_version_number_uses_version_id_and_platform_title() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"[{"id":"fabric-api","title":"Fabric API","description":"d","project_type":"mod",
                     "downloads":1,"icon_url":"https://cdn.example.invalid/now.png"}]"#,
            ))
            .mount(&server)
            .await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","dependency_type":"required"}"#,
            )],
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/version/gone1"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        let mut kept = entry("fabric-api.jar", "fabric-api", "gone1");
        kept.title = Some("旧标题".to_owned());
        let mut ledger = Ledger::default();
        ledger.upsert(kept);
        aurora
            .ledger_store("1.20.1-fabric")
            .save(&ledger)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.20.1-fabric").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("fabric-api.jar"), b"jar")
            .await
            .unwrap();

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();
        let dep = &plan.items[1];
        assert!(dep.delisted && dep.already_satisfied);
        assert_eq!(dep.version.version_number, "gone1");
        assert_eq!(dep.title.as_deref(), Some("Fabric API"));
        assert_eq!(
            dep.icon_url.as_deref(),
            Some("https://cdn.example.invalid/now.png")
        );
    }

    /// 作者钉的版本已下架，而实例里装的恰好就是这一版：同样算已满足，不报「指定的版本已不存在」。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pinned_dependency_delisted_but_installed_stays_satisfied() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","version_id":"pinned","dependency_type":"required"}"#,
            )],
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/version/pinned"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        let mut ledger = Ledger::default();
        ledger.upsert(entry("fabric-api-pinned.jar", "fabric-api", "pinned"));
        aurora
            .ledger_store("1.20.1-fabric")
            .save(&ledger)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.20.1-fabric").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("fabric-api-pinned.jar"), b"jar")
            .await
            .unwrap();

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();
        assert_eq!(plan.items.len(), 2);
        assert!(plan.items[1].delisted && plan.items[1].already_satisfied);
        assert_eq!(plan.items[1].version.version_id, "pinned");
        assert!(plan.skipped.is_empty());

        // 装着的是同工程的另一版时，钉的那一版仍是「已不存在」，照旧如实说明。
        let mut ledger = Ledger::default();
        ledger.upsert(entry("fabric-api-other.jar", "fabric-api", "other"));
        aurora
            .ledger_store("1.20.1-fabric")
            .save(&ledger)
            .await
            .unwrap();
        tokio::fs::write(mods_dir.join("fabric-api-other.jar"), b"jar")
            .await
            .unwrap();
        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();
        assert_eq!(plan.items.len(), 1);
        assert_eq!(
            plan.skipped,
            vec!["前置 fabric-api 指定的版本 pinned 在平台上已不存在，未加入计划".to_owned()]
        );
    }

    /// 已装前置的版本查询不是 404 而是别的平台错误：那是「查不到」，照常冒泡，不当成已下架。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn installed_dependency_lookup_failure_other_than_not_found_still_errors() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                r#"{"project_id":"fabric-api","dependency_type":"required"}"#,
            )],
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/version/kept"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        let mut ledger = Ledger::default();
        ledger.upsert(entry("fabric-api.jar", "fabric-api", "kept"));
        aurora
            .ledger_store("1.20.1-fabric")
            .save(&ledger)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.20.1-fabric").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("fabric-api.jar"), b"jar")
            .await
            .unwrap();

        let err = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::ModPlatform(aurora_modplatform::Error::Status { status: 403, .. })
            ),
            "实得 {err:?}"
        );
    }

    /// 端到端：前置已下架时装 Mod 照常完成，只下载主项，装着的前置原样不动。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_mod_proceeds_when_installed_dependency_is_delisted() {
        use sha1::Digest;

        let server = MockServer::start().await;
        let payload = b"sodium-jar-bytes".to_vec();
        let sha1: String = sha1::Sha1::digest(&payload)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let root = format!(
            r#"{{"id":"v1","project_id":"sodium","name":"Sodium v1","version_number":"v1",
                "version_type":"release","date_published":"2026-01-01T00:00:00Z",
                "game_versions":["1.20.1"],"loaders":["fabric"],
                "dependencies":[{{"project_id":"fabric-api","dependency_type":"required"}}],
                "files":[{{"hashes":{{"sha1":"{sha1}"}},"url":"{}/files/sodium-v1.jar",
                    "filename":"sodium-v1.jar","primary":true,"size":{}}}]}}"#,
            server.uri(),
            payload.len()
        );
        Mock::given(method("GET"))
            .and(path("/version/v1"))
            .respond_with(ResponseTemplate::new(200).set_body_string(root))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/version/delisted"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/files/sodium-v1.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(payload.clone()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        let mut ledger = Ledger::default();
        ledger.upsert(entry("fabric-api-old.jar", "fabric-api", "delisted"));
        aurora
            .ledger_store("1.20.1-fabric")
            .save(&ledger)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.20.1-fabric").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("fabric-api-old.jar"), b"kept-dependency")
            .await
            .unwrap();

        let outcome = aurora
            .install_mod("1.20.1-fabric", Platform::Modrinth, "sodium", "v1", None)
            .await
            .unwrap();
        assert_eq!(outcome.file_name, "sodium-v1.jar");
        assert_eq!(
            tokio::fs::read(mods_dir.join("sodium-v1.jar"))
                .await
                .unwrap(),
            payload
        );
        assert_eq!(
            tokio::fs::read(mods_dir.join("fabric-api-old.jar"))
                .await
                .unwrap(),
            b"kept-dependency"
        );
        let ledger = aurora.ledger_store("1.20.1-fabric").load().await.unwrap();
        assert_eq!(
            ledger.find("sodium-v1.jar").map(|e| e.version_id.as_str()),
            Some("v1")
        );
        let kept = ledger
            .find("fabric-api-old.jar")
            .expect("前置的卷宗记录原样保留");
        assert_eq!(kept.version_id, "delisted");
    }

    /// 卷宗里同工程但版本号不同：主项不算已满足（要装的是另一个版本，即一次更新）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn different_version_of_same_project_is_not_satisfied() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v2",
                "sodium",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                "",
            )],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());
        let mut ledger = Ledger::default();
        ledger.upsert(entry("sodium-v1.jar", "sodium", "v1"));
        aurora
            .ledger_store("1.20.1-fabric")
            .save(&ledger)
            .await
            .unwrap();
        let mods_dir = aurora.resolve_mods_dir("1.20.1-fabric").await.unwrap();
        tokio::fs::create_dir_all(&mods_dir).await.unwrap();
        tokio::fs::write(mods_dir.join("sodium-v1.jar"), b"jar")
            .await
            .unwrap();

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v2")
            .await
            .unwrap();
        assert_eq!(plan.items.len(), 1);
        assert!(!plan.items[0].already_satisfied);
    }

    /// 原版实例（无加载器）：要加载器的依赖判为不兼容，进 skipped。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn vanilla_instance_finds_no_loader_dependent_version() {
        let server = MockServer::start().await;
        mount_versions(
            &server,
            "sodium",
            &[modrinth_version(
                "v1",
                "sodium",
                "2026-01-01T00:00:00Z",
                &[],
                &[],
                r#"{"project_id":"fabric-api","dependency_type":"required"}"#,
            )],
        )
        .await;
        mount_versions(
            &server,
            "fabric-api",
            &[modrinth_version(
                "ok1",
                "fabric-api",
                "2026-01-01T00:00:00Z",
                &["1.20.1"],
                &["fabric"],
                "",
            )],
        )
        .await;

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("versions").join("1.20.1");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join("1.20.1.json"),
            r#"{"id":"1.20.1","type":"release","mainClass":"net.minecraft.client.main.Main"}"#,
        )
        .await
        .unwrap();
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();

        assert_eq!(plan.items.len(), 1);
        assert_eq!(
            plan.skipped,
            vec!["前置 fabric-api 没有适配该实例的版本，未加入计划".to_owned()]
        );
    }

    /// 平台上没有请求的主版本：冒泡 ModVersionNotFound，不产出一份空计划。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unknown_mod_version_errors() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/version/nope"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        match aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "nope")
            .await
            .unwrap_err()
        {
            CoreError::ModVersionNotFound {
                project_id,
                version_id,
                ..
            } => {
                assert_eq!(project_id, "sodium");
                assert_eq!(version_id, "nope");
            }
            other => panic!("期望 ModVersionNotFound，得到 {other:?}"),
        }
    }

    /// 实例本地未安装：在触网之前就短路。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn uninstalled_instance_errors_before_network() {
        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path(), server.uri());

        let err = aurora
            .plan_install("ghost", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::VersionNotInstalled { id } if id == "ghost"));
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    /// 依赖查询必须把实例的 MC 版本与加载器下推给平台；主项走单版本端点，不经过任何列表过滤。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn instance_filters_are_pushed_down_for_dependencies_only() {
        let server = MockServer::start().await;
        let root = modrinth_version(
            "v1",
            "sodium",
            "2026-01-01T00:00:00Z",
            &["1.20.1"],
            &["fabric"],
            r#"{"project_id":"fabric-api","dependency_type":"required"}"#,
        );
        Mock::given(method("GET"))
            .and(path("/version/v1"))
            .respond_with(ResponseTemplate::new(200).set_body_string(root))
            .expect(1)
            .mount(&server)
            .await;
        // 主项的列表端点一次都不该被问到。
        Mock::given(method("GET"))
            .and(path("/project/sodium/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .expect(0)
            .mount(&server)
            .await;
        // 依赖端点只接受带上本实例事实的请求。
        Mock::given(method("GET"))
            .and(path("/project/fabric-api/version"))
            .and(query_param("game_versions", r#"["1.20.1"]"#))
            .and(query_param("loaders", r#"["fabric"]"#))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                "[{}]",
                modrinth_version(
                    "ok1",
                    "fabric-api",
                    "2026-01-01T00:00:00Z",
                    &["1.20.1"],
                    &["fabric"],
                    "",
                )
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/project/fabric-api/version"))
            .and(query_param_is_missing("game_versions"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        put_fabric_instance(tmp.path(), "1.20.1-fabric").await;
        let aurora = aurora_at(tmp.path(), server.uri());

        let plan = aurora
            .plan_install("1.20.1-fabric", Platform::Modrinth, "sodium", "v1")
            .await
            .unwrap();
        assert_eq!(plan.items.len(), 2);
        assert_eq!(plan.items[1].version.version_id, "ok1");
    }

    #[test]
    fn judge_ignores_mc_dimension_when_instance_version_is_unidentifiable() {
        let unknown_mc = InstanceFacts {
            mc_version: None,
            loaders: vec!["fabric".to_owned()],
            mod_loaders: vec![ModLoader::Fabric],
        };
        let mut fabric_1_21 = version("fabric-api", "x");
        fabric_1_21.game_versions = vec!["1.21".to_owned()];
        fabric_1_21.loaders = vec![ModLoader::Fabric];
        assert!(matches!(
            judge(&fabric_1_21, &unknown_mc),
            Compatibility::Unknown { .. }
        ));

        let mut forge_only = fabric_1_21.clone();
        forge_only.loaders = vec![ModLoader::Forge];
        assert_eq!(
            judge(&forge_only, &unknown_mc),
            Compatibility::Mismatch {
                reason: "需要 Forge，该实例装的是 Fabric".to_owned()
            }
        );

        let known_mc = InstanceFacts {
            mc_version: Some("1.20.1".to_owned()),
            loaders: vec!["fabric".to_owned()],
            mod_loaders: vec![ModLoader::Fabric],
        };
        assert_eq!(
            judge(&fabric_1_21, &known_mc),
            Compatibility::Mismatch {
                reason: "不支持 MC 1.20.1".to_owned()
            }
        );
    }

    #[test]
    fn pick_latest_compatible_orders_by_date_not_input_order() {
        let facts = InstanceFacts {
            mc_version: Some("1.20.1".to_owned()),
            loaders: vec!["fabric".to_owned()],
            mod_loaders: vec![ModLoader::Fabric],
        };
        let mut older = version("fabric-api", "older");
        older.loaders = vec![ModLoader::Fabric];
        older.date_published = "2025-01-01T00:00:00Z".to_owned();
        let mut newer = version("fabric-api", "newer");
        newer.loaders = vec![ModLoader::Fabric];
        newer.date_published = "2026-01-01T00:00:00Z".to_owned();
        let mut incompatible = version("fabric-api", "incompatible");
        incompatible.loaders = vec![ModLoader::Forge];
        incompatible.date_published = "2026-12-01T00:00:00Z".to_owned();

        let picked = pick_latest_compatible(
            vec![older.clone(), incompatible.clone(), newer.clone()],
            &facts,
        )
        .expect("应选出兼容版本");
        assert_eq!(picked.version_id, "newer");

        assert!(pick_latest_compatible(vec![incompatible], &facts).is_none());
        assert!(pick_latest_compatible(Vec::new(), &facts).is_none());
    }

    /// 新装的前置与更新检查同一条底线：有正式版就不把测试版带进来，没有才退到测试版、内测版。
    #[test]
    fn pick_latest_compatible_prefers_the_most_stable_channel() {
        let facts = InstanceFacts {
            mc_version: Some("1.20.1".to_owned()),
            loaders: vec!["fabric".to_owned()],
            mod_loaders: vec![ModLoader::Fabric],
        };
        let build = |id: &str, channel: ReleaseChannel, date: &str| {
            let mut item = version("fabric-api", id);
            item.loaders = vec![ModLoader::Fabric];
            item.release_channel = channel;
            item.date_published = date.to_owned();
            item
        };
        let alpha = build("alpha", ReleaseChannel::Alpha, "2026-09-01T00:00:00Z");
        let beta = build("beta", ReleaseChannel::Beta, "2026-06-01T00:00:00Z");
        let old_release = build("r1", ReleaseChannel::Release, "2025-01-01T00:00:00Z");
        let new_release = build("r2", ReleaseChannel::Release, "2026-01-01T00:00:00Z");

        let id = |list: Vec<ModVersionInfo>| {
            pick_latest_compatible(list, &facts).map(|picked| picked.version_id)
        };
        assert_eq!(
            id(vec![
                alpha.clone(),
                old_release,
                beta.clone(),
                new_release.clone()
            ])
            .as_deref(),
            Some("r2")
        );
        assert_eq!(
            id(vec![alpha.clone(), beta]).as_deref(),
            Some("beta"),
            "没有正式版时取测试版，不取更新的内测版"
        );
        assert_eq!(id(vec![alpha]).as_deref(), Some("alpha"));

        // 正式版不适配这个实例时不算数，退到适配的测试版。
        let mut wrong_loader = new_release;
        wrong_loader.loaders = vec![ModLoader::Forge];
        let beta = build("beta", ReleaseChannel::Beta, "2026-06-01T00:00:00Z");
        assert_eq!(id(vec![wrong_loader, beta]).as_deref(), Some("beta"));
    }
}
