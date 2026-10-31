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

use std::collections::HashSet;
use std::path::Path;

use aurora_modplatform::{DependencyKind, ModLoader, ModVersionInfo, Platform};
use serde::Serialize;

use crate::compat::{
    Compatibility, classify, instance_loaders, instance_mc_version, instance_mod_loaders,
};
use crate::error::{CoreError, Result};
use crate::facade::Aurora;
use crate::ledger::{Ledger, LedgerEntry};
use crate::modfs::present;
use crate::modversions::sort_by_published_desc;

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
    fn project_id(&self) -> Option<&str> {
        match self {
            SkipNote::MissingProjectId { .. } => None,
            SkipNote::PinnedGone { project_id, .. }
            | SkipNote::NoCompatibleVersion { project_id } => Some(project_id),
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
                format!("{file_name} 的一条必需依赖没有给出工程标识，无法自动解析")
            }
            SkipNote::PinnedGone {
                project_id,
                version_id,
            } => format!(
                "依赖 {} 指定的版本 {version_id} 在平台上已不存在，未加入计划",
                name(Some(project_id))
            ),
            SkipNote::NoCompatibleVersion { project_id } => format!(
                "依赖 {} 没有适配该实例的版本，未加入计划",
                name(Some(project_id))
            ),
            SkipNote::Optional { project_id } => format!(
                "可选依赖 {} 未自动安装，需要时请手动添加",
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
                "内嵌依赖 {} 已打包在 {file_name} 内，无需单独安装",
                name(project_id.as_deref())
            ),
            SkipNote::Tool { project_id } => {
                format!("工具类关联 {} 未自动安装", name(project_id.as_deref()))
            }
        }
    }
}

/// 一条必需依赖的解析结果。
enum Resolved {
    /// 选中的版本与它是否已装在实例里。
    Chosen(Box<ModVersionInfo>, bool),
    /// 没有可用版本，附跳过说明。
    Skipped(SkipNote),
}

impl Aurora {
    /// 解析依赖并产出安装计划。
    ///
    /// 栈式深度优先展开，`visited` 按 project_id 去重：真实数据里存在 A 依赖 B、B 又反过来声明依赖 A
    /// 的环（两个 Mod 互相集成时很常见），不去重会直接死循环。同一工程被多个父项要求时也只进计划一次。
    ///
    /// 网络故障与平台报错照常冒泡：那是「查不到」而非「没有」，把它压成一条 skipped 说明会让玩家以为
    /// 依赖真的不存在。
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
        let mut stack: Vec<(ModVersionInfo, Option<String>, bool)> =
            vec![(root, None, root_satisfied)];

        while let Some((version, required_by, satisfied)) = stack.pop() {
            let mut children: Vec<(ModVersionInfo, Option<String>, bool)> = Vec::new();

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
                        // 已展开过（含环）就不再进计划：它要么已在 items 里，要么已被判为不可用。
                        if !visited.insert(dep_project.clone()) {
                            continue;
                        }
                        match self
                            .resolve_required(
                                platform,
                                &dep_project,
                                dep.version_id.as_deref(),
                                &facts,
                                &ledger,
                                &dirs.mods_dir,
                            )
                            .await?
                        {
                            Resolved::Chosen(chosen, installed) => {
                                children.push((
                                    *chosen,
                                    Some(version.project_id.clone()),
                                    installed,
                                ));
                            }
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
            items.push(PlannedItem {
                version,
                title: None,
                icon_url: None,
                required_by,
                already_satisfied: satisfied,
            });
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
            None => "未标明工程的依赖项".to_owned(),
        };
        let skipped = notes.iter().map(|note| note.render(name)).collect();
        Ok(InstallPlan { items, skipped })
    }

    /// 解析一条必需依赖。
    ///
    /// 依赖声明里带了精确版本号时原样采用、不再择优：那是 Mod 作者钉死的搭配，启动器凭「更新」二字
    /// 推翻它，换来的通常是一个作者从未测过的组合。没钉版本时，实例里已有同工程的文件就沿用它。
    async fn resolve_required(
        &self,
        platform: Platform,
        dep_project: &str,
        pinned: Option<&str>,
        facts: &InstanceFacts,
        ledger: &Ledger,
        mods_dir: &Path,
    ) -> Result<Resolved> {
        if let Some(pinned) = pinned {
            return match self.get_mod_version(platform, dep_project, pinned).await {
                Ok(version) => {
                    let installed = installed_exact(ledger, mods_dir, &version).await?;
                    Ok(Resolved::Chosen(Box::new(version), installed))
                }
                // 「作者钉的版本没了」与「这个实例用不上任何版本」是两回事，玩家该拿到哪一种，取决于他
                // 接下来是去找替代 Mod 还是去换实例。
                Err(CoreError::ModVersionNotFound { .. }) => {
                    Ok(Resolved::Skipped(SkipNote::PinnedGone {
                        project_id: dep_project.to_owned(),
                        version_id: pinned.to_owned(),
                    }))
                }
                Err(other) => Err(other),
            };
        }

        if let Some(entry) = installed_any(ledger, mods_dir, platform, dep_project).await? {
            let version = self
                .get_mod_version(platform, dep_project, &entry.version_id)
                .await?;
            return Ok(Resolved::Chosen(Box::new(version), true));
        }

        // 把实例事实作为过滤条件带下去。这不是为了省流量：CurseForge 的文件端点是分页的，只取首页，
        // 一个动辄几百个文件的前置不带条件查，首页可能一个适配本实例的文件都没有，结果是「明明有版本
        // 却报没有适配版本」。
        let game_versions: Vec<String> = facts.mc_version.clone().into_iter().collect();
        let candidates = self
            .list_mod_versions(platform, dep_project, &game_versions, &facts.mod_loaders)
            .await?;
        Ok(match pick_latest_compatible(candidates, facts) {
            Some(chosen) => Resolved::Chosen(Box::new(chosen), false),
            None => Resolved::Skipped(SkipNote::NoCompatibleVersion {
                project_id: dep_project.to_owned(),
            }),
        })
    }
}

/// 从候选里挑该实例可用的最新版本。
///
/// 显式再排一次而不是依赖上游返回顺序：择优的全部意义就是「最新」，这条前提不该跨模块靠约定维持。
/// 判定不为 Mismatch 即可用——[`Compatibility::Unknown`]（平台没给元数据）按放行处理，与落位层的
/// 软提示口径一致。
fn pick_latest_compatible(
    mut candidates: Vec<ModVersionInfo>,
    facts: &InstanceFacts,
) -> Option<ModVersionInfo> {
    sort_by_published_desc(&mut candidates);
    candidates
        .into_iter()
        .find(|version| !matches!(judge(version, facts), Compatibility::Mismatch { .. }))
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

/// 该工程的任意版本是否已装在此实例；装着就返回那条卷宗记录。磁盘是权威：卷宗有而文件不在不算。
async fn installed_any<'a>(
    ledger: &'a Ledger,
    mods_dir: &Path,
    platform: Platform,
    project_id: &str,
) -> Result<Option<&'a LedgerEntry>> {
    for entry in &ledger.entries {
        if entry.platform == platform
            && entry.project_id == project_id
            && present(mods_dir, &entry.file_name).await?
        {
            return Ok(Some(entry));
        }
    }
    Ok(None)
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
                },
                PlannedItem {
                    version: version("P7dR8mSH", "QwErTyUi"),
                    title: None,
                    icon_url: None,
                    required_by: Some("AANobbMI".to_owned()),
                    already_satisfied: true,
                },
            ],
            skipped: vec!["可选依赖 Mod Menu 未自动安装，需要时请手动添加".to_owned()],
        };

        let json = serde_json::to_value(&plan).unwrap();
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
            "可选依赖 Mod Menu 未自动安装，需要时请手动添加"
        );
    }

    #[test]
    fn empty_plan_keeps_both_arrays_present() {
        // UI 直接读 items/skipped 的长度，字段不能因为空而消失。
        let json = serde_json::to_value(InstallPlan {
            items: Vec::new(),
            skipped: Vec::new(),
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
            None => "未标明工程的依赖项".to_owned(),
        };
        assert_eq!(
            SkipNote::Optional {
                project_id: Some("modmenu".to_owned())
            }
            .render(name),
            "可选依赖 Mod Menu 未自动安装，需要时请手动添加"
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
            "内嵌依赖 未标明工程的依赖项 已打包在 a.jar 内，无需单独安装"
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
                "可选依赖 Mod Menu 未自动安装，需要时请手动添加".to_owned(),
                "sodium-v1.jar 声明与 optifabric 不兼容，未做任何处理".to_owned(),
                "内嵌依赖 cloth-config 已打包在 sodium-v1.jar 内，无需单独安装".to_owned(),
            ]
        );
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
            vec!["依赖 fabric-api 没有适配该实例的版本，未加入计划".to_owned()]
        );
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
            vec!["依赖 fabric-api 指定的版本 gone 在平台上已不存在，未加入计划".to_owned()]
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
            vec!["sodium-v1.jar 的一条必需依赖没有给出工程标识，无法自动解析".to_owned()]
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
            vec!["依赖 fabric-api 没有适配该实例的版本，未加入计划".to_owned()]
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
}
