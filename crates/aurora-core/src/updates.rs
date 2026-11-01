//! 存量身份反查与更新检查。
//!
//! 更新检查的前提是知道「磁盘上这个 jar 是谁」。经本启动器装的 Mod 在卷宗里有身份；手动丢进 `mods/`
//! 的、别的启动器留下的则没有——这类要靠文件哈希反查：Modrinth 用 SHA-1、CurseForge 用 MurmurHash2
//! 指纹，两条通道各一次批量请求，查到就把身份补回卷宗。
//!
//! 反查不到不算错误。本地自制 Mod、私有构建本就没有平台来源，报错只会把「我有几个私货」变成「更新
//! 检查整个不能用」。这类文件安静跳过。
//!
//! 原版实例（未装任何 Mod 加载器）直接返回空：没有加载器就不会有 Mod 在跑，扫它纯属浪费一轮网络请求。
//!
//! 请求量是这里的头号约束：一个实例几十上百个 Mod，逐个问平台立刻撞上限流。Modrinth 侧全程只有两次
//! 批量请求（按哈希取当前版本、按哈希取最新版本），CurseForge 侧逐工程查文件列表，有界并发且走版本
//! 列表缓存。

use std::collections::{BTreeMap, HashMap};

use aurora_modplatform::{
    CurseForgeClient, CurseForgeFile, CurseForgeFingerprintMatch, InstalledMod, ModHashes,
    ModVersionInfo, ModrinthVersion, Platform, hash_mod_file,
};
use serde::Serialize;

use crate::compat::{instance_mc_version, instance_mod_loaders};
use crate::error::{CoreError, Result};
use crate::facade::Aurora;
use crate::ledger::LedgerEntry;
use crate::modfs::{
    NETWORK_CONCURRENCY, bounded_map, ledger_key, local_concurrency, lock_mods_dir,
};
use crate::mods::scan_installed;

/// 一个可更新项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateCandidate {
    /// 启用态文件名，即与卷宗 join 的键（磁盘上处于禁用态时会多一个 `.disabled` 后缀）。
    pub file_name: String,
    /// 工程标题；卷宗里没记为 `None`。
    pub title: Option<String>,
    /// 当前已装的版本标识。
    pub current_version_id: String,
    /// 当前已装的版本号；卷宗里没记为 `None`。
    pub current_version_number: Option<String>,
    /// 该实例可用的最新版本。
    pub latest: ModVersionInfo,
}

/// 一个刚被哈希反查认出来的文件。
struct Identified {
    key: String,
    info: ModVersionInfo,
    sha1: String,
    modified_ms: i64,
}

impl Aurora {
    /// 检查该实例可更新的 Mod。
    ///
    /// 有身份走精确查，无身份先做一轮哈希反查补身份（补上的身份写回卷宗，下次不必再查）。返回顺序按
    /// 文件名字典序，保证 UI 列表稳定。新旧一律按发布时间比，绝不比版本号字符串：两个平台的版本号
    /// 各家一套格式，字典序比出来的「更新」随时可能是一次降级。
    pub async fn check_updates(&self, version_id: &str) -> Result<Vec<UpdateCandidate>> {
        self.check_updates_with(version_id, || self.curseforge_client())
            .await
    }

    /// [`Aurora::check_updates`] 的本体。`curseforge` 构造 CurseForge 客户端，只用来判断 CurseForge
    /// 那部分能不能查；文件列表照旧经版本列表缓存取。生产传 [`Aurora::curseforge_client`]：有没有 key
    /// 取决于构建与进程环境，测试要稳定地造出「没有 key」只能从这里注入。
    async fn check_updates_with(
        &self,
        version_id: &str,
        curseforge: impl FnOnce() -> Result<CurseForgeClient>,
    ) -> Result<Vec<UpdateCandidate>> {
        let instance = self.resolve_instance(version_id).await?;
        // 只装了 OptiFine 的实例同样没有 Mod 加载器：OptiFine 不认 mods 目录里的 Mod。
        let loaders = instance_mod_loaders(&instance);
        if loaders.is_empty() {
            return Ok(Vec::new());
        }
        // 认不出实例的 MC 版本就没有兼容判定的基准，任何「最新版」都只是猜测。宁可不报，也不推一个
        // 可能启动不了的包。
        let Some(mc_version) = instance_mc_version(&instance) else {
            return Ok(Vec::new());
        };
        let dirs = self.instance_dirs(&instance).await?;
        let installed = scan_installed(&dirs).await?;
        if installed.is_empty() {
            return Ok(Vec::new());
        }
        let mut ledger = self.ledger_store(version_id).load().await?;

        // 磁盘是权威：待查集合来自重扫结果，并按启用态文件名去重——同名的启用副本与禁用副本指向同一条
        // 卷宗身份，不该产出两条重复的更新项。
        let mut files: BTreeMap<String, &InstalledMod> = BTreeMap::new();
        for item in &installed {
            files
                .entry(ledger_key(&item.file_name).to_owned())
                .or_insert(item);
        }

        // 要现算哈希的只有两类：卷宗里没有身份的（反查用），以及卷宗没记 SHA-1 的 Modrinth 条目（批量
        // 查更新按 SHA-1 索引）。已有身份的文件不重算。
        let to_hash: Vec<(String, std::path::PathBuf)> = files
            .iter()
            .filter(|(key, _)| match ledger.find(key) {
                None => true,
                Some(entry) => entry.platform == Platform::Modrinth && entry.sha1.is_none(),
            })
            .map(|(key, item)| (key.clone(), item.path.clone()))
            .collect();
        let hashed: HashMap<String, ModHashes> =
            bounded_map(to_hash, local_concurrency(), |(key, path)| async move {
                Ok((key, hash_mod_file(&path).await?))
            })
            .await?
            .into_iter()
            .collect();

        let mut known_modrinth: HashMap<String, String> = HashMap::new();
        let mut unknown: Vec<String> = Vec::new();
        for key in files.keys() {
            match ledger.find(key) {
                None => unknown.push(key.clone()),
                Some(entry) if entry.platform == Platform::Modrinth => {
                    let sha1 = match &entry.sha1 {
                        Some(sha1) => sha1.clone(),
                        None => hashed
                            .get(key)
                            .map(|h| h.sha1.clone())
                            .expect("卷宗没记 SHA-1 的 Modrinth 条目在上面已经补算过"),
                    };
                    known_modrinth.insert(key.clone(), sha1);
                }
                Some(_) => {}
            }
        }

        // 一次批量请求同时服务两件事：给无身份的文件反查身份，给已知身份的文件取「当前版本」的发布
        // 时间，供下面判断平台给的「最新」是不是真的更新。
        let modrinth = self.modrinth_client();
        let mut lookup: Vec<String> = unknown
            .iter()
            .map(|key| hashed[key].sha1.clone())
            .chain(known_modrinth.values().cloned())
            .collect();
        lookup.sort();
        lookup.dedup();
        let by_hash = modrinth.versions_by_hashes(&lookup).await?;

        let identified = self.identify(&unknown, &hashed, &files, &by_hash).await?;
        if !identified.is_empty() {
            ledger = self
                .record_identities(version_id, &dirs.mods_dir, identified)
                .await?;
        }

        let mut modrinth_targets: HashMap<String, (String, LedgerEntry)> = HashMap::new();
        let mut curseforge_targets: Vec<(String, LedgerEntry)> = Vec::new();
        for key in files.keys() {
            let Some(entry) = ledger.find(key) else {
                continue;
            };
            match entry.platform {
                Platform::Modrinth => {
                    let sha1 = known_modrinth
                        .get(key)
                        .cloned()
                        .or_else(|| entry.sha1.clone())
                        .expect("反查补上的 Modrinth 身份一定带实测 SHA-1");
                    modrinth_targets.insert(sha1, (key.clone(), entry.clone()));
                }
                Platform::CurseForge => curseforge_targets.push((key.clone(), entry.clone())),
            }
        }

        let mut candidates = Vec::new();
        if !modrinth_targets.is_empty() {
            let hashes: Vec<String> = modrinth_targets.keys().cloned().collect();
            let latest = modrinth
                .latest_versions_by_hashes(&hashes, &loaders, &[mc_version.as_str()])
                .await?;
            for (hash, version) in latest {
                let Some((file_name, entry)) = modrinth_targets.get(&hash) else {
                    continue;
                };
                // 端点返回的是该文件在本实例加载器/版本下的最新兼容版本，可能正是当前这个。
                if version.id == entry.version_id {
                    continue;
                }
                let Some(info) = version.to_version_info() else {
                    continue;
                };
                // 玩家装的可能是比「最新兼容」更新的测试版或别的加载器的构建：平台给回的那个反而更旧，
                // 推给他就是一次降级。
                if let Some(current) = by_hash.get(&hash)
                    && info.date_published <= current.date_published
                {
                    continue;
                }
                candidates.push(UpdateCandidate {
                    file_name: file_name.clone(),
                    title: entry.title.clone(),
                    current_version_id: entry.version_id.clone(),
                    current_version_number: entry.version_number.clone(),
                    latest: info,
                });
            }
        }

        if !curseforge_targets.is_empty() && curseforge_ready(curseforge, curseforge_targets.len())?
        {
            let aurora = self.clone();
            let found = bounded_map(
                curseforge_targets,
                NETWORK_CONCURRENCY,
                move |(key, entry)| {
                    let aurora = aurora.clone();
                    let mc_version = mc_version.clone();
                    let loaders = loaders.clone();
                    async move {
                        let versions = aurora
                            .list_mod_versions(
                                Platform::CurseForge,
                                &entry.project_id,
                                &[mc_version],
                                &loaders,
                            )
                            .await?;
                        Ok(newer_curseforge_version(&versions, &entry).map(|latest| {
                            UpdateCandidate {
                                file_name: key,
                                title: entry.title.clone(),
                                current_version_id: entry.version_id.clone(),
                                current_version_number: entry.version_number.clone(),
                                latest: latest.clone(),
                            }
                        }))
                    }
                },
            )
            .await?;
            candidates.extend(found.into_iter().flatten());
        }

        candidates.sort_by(|a, b| a.file_name.cmp(&b.file_name));
        Ok(candidates)
    }

    /// 给无身份的文件定身份：先看 Modrinth 批量结果，剩下认不出的合成一次 CurseForge 指纹批量匹配。
    ///
    /// 反过来先打 CurseForge 会让绝大多数 Modrinth 用户白白多发一个需要 API key 的请求。
    async fn identify(
        &self,
        unknown: &[String],
        hashed: &HashMap<String, ModHashes>,
        files: &BTreeMap<String, &InstalledMod>,
        by_hash: &HashMap<String, ModrinthVersion>,
    ) -> Result<Vec<Identified>> {
        let mut identified = Vec::new();
        let mut pending: Vec<(&String, &ModHashes)> = Vec::new();
        for key in unknown {
            let hashes = &hashed[key];
            match by_hash
                .get(&hashes.sha1)
                .and_then(ModrinthVersion::to_version_info)
            {
                Some(info) => identified.push(Identified {
                    key: key.clone(),
                    info,
                    sha1: hashes.sha1.clone(),
                    modified_ms: files[key].modified_ms,
                }),
                None => pending.push((key, hashes)),
            }
        }

        let fingerprints: Vec<u32> = pending
            .iter()
            .map(|(_, h)| h.curseforge_fingerprint)
            .collect();
        let curseforge = self.curseforge_fingerprint_lookup(&fingerprints).await?;
        for (key, hashes) in pending {
            // 两条通道都认不出：本地自制 Mod、私有构建本就没有平台来源。
            let Some(file) = curseforge.get(&hashes.curseforge_fingerprint) else {
                continue;
            };
            identified.push(Identified {
                key: key.clone(),
                info: file.to_version_info(),
                sha1: hashes.sha1.clone(),
                modified_ms: files[key].modified_ms,
            });
        }
        Ok(identified)
    }

    /// 把反查到的身份写回卷宗，返回写入后的卷宗。
    ///
    /// 网络请求都在锁外做完，只有「重读卷宗 - 补条目 - 写回」这一小段持锁：更新检查动辄几秒，不该让
    /// 玩家同时点的移除排在它后面干等。重读是必须的——锁外那段时间里卷宗可能已被别的操作改过，拿旧
    /// 副本写回会抹掉那次改动；期间已经有了身份的文件以新卷宗为准，不覆盖。
    async fn record_identities(
        &self,
        version_id: &str,
        mods_dir: &std::path::Path,
        identified: Vec<Identified>,
    ) -> Result<crate::ledger::Ledger> {
        // 平台枚举不可哈希，按平台分两张表；工程标识只在各自平台内唯一。
        let mut titles: Vec<(Platform, HashMap<String, crate::modversions::ProjectInfo>)> =
            Vec::with_capacity(2);
        for platform in [Platform::Modrinth, Platform::CurseForge] {
            let mut ids: Vec<String> = identified
                .iter()
                .filter(|item| item.info.platform == platform)
                .map(|item| item.info.project_id.clone())
                .collect();
            if ids.is_empty() {
                continue;
            }
            ids.sort();
            ids.dedup();
            titles.push((platform, self.project_infos(platform, &ids).await?));
        }

        let _guard = lock_mods_dir(mods_dir).await;
        let store = self.ledger_store(version_id);
        let mut ledger = store.load().await?;
        let mut changed = false;
        for item in identified {
            if ledger.find(&item.key).is_some() {
                continue;
            }
            let info = titles
                .iter()
                .find(|(platform, _)| *platform == item.info.platform)
                .and_then(|(_, table)| table.get(&item.info.project_id));
            ledger.upsert(LedgerEntry {
                file_name: item.key,
                platform: item.info.platform,
                project_id: item.info.project_id,
                version_id: item.info.version_id,
                version_number: Some(item.info.version_number),
                title: info.map(|i| i.title.clone()),
                icon_url: info.and_then(|i| i.icon_url.clone()),
                // 记本地实测的 SHA-1 而非平台声明值：卷宗里的哈希用来指认「磁盘上这个文件」。
                sha1: Some(item.sha1),
                // 真实安装时刻早已不可考，落盘时间是唯一与它相关的事实；写「现在」会让卷宗声称一个两年
                // 前装的 Mod 是刚装的。
                installed_at: item.modified_ms.div_euclid(1000),
                // 反查只能确定「这个文件是谁」，无从得知它当初是主动装的还是被依赖带进来的。
                installed_as_dependency_of: None,
            });
            changed = true;
        }
        if changed {
            store.save(&ledger).await?;
        }
        Ok(ledger)
    }

    /// 批量指纹反查，返回「指纹 -> 命中文件」。
    ///
    /// 未配置 CurseForge API key 时这条反查通道整体停用，返回空表：缺一把可选的钥匙不该连带毁掉
    /// Modrinth 通道，这与聚合搜索「无 key 即禁用该源」是同一约定。其它错误照常冒泡。
    async fn curseforge_fingerprint_lookup(
        &self,
        fingerprints: &[u32],
    ) -> Result<HashMap<u32, CurseForgeFile>> {
        if fingerprints.is_empty() {
            return Ok(HashMap::new());
        }
        let client = match self.curseforge_client() {
            Ok(client) => client,
            Err(CoreError::ModPlatform(aurora_modplatform::Error::CurseForgeKeyMissing)) => {
                tracing::info!("未配置 CurseForge API key，跳过指纹反查");
                return Ok(HashMap::new());
            }
            Err(other) => return Err(other),
        };
        Ok(index_by_fingerprint(
            client.fingerprint_matches(fingerprints).await?,
        ))
    }
}

/// CurseForge 来源的更新查不查得了。
///
/// 未配置 API key 时这部分整体跳过并记 info：缺一把可选的钥匙不该让 Modrinth 那部分已经查到的更新
/// 一并丢掉，与 [`Aurora::curseforge_fingerprint_lookup`] 停用指纹反查是同一约定。构造客户端的其它
/// 失败照常冒泡。
fn curseforge_ready(
    curseforge: impl FnOnce() -> Result<CurseForgeClient>,
    pending: usize,
) -> Result<bool> {
    match curseforge() {
        Ok(_) => Ok(true),
        Err(CoreError::ModPlatform(aurora_modplatform::Error::CurseForgeKeyMissing)) => {
            tracing::info!(
                pending,
                "未配置 CurseForge API key，跳过 CurseForge 来源 Mod 的更新检查"
            );
            Ok(false)
        }
        Err(other) => Err(other),
    }
}

/// 从 CurseForge 版本列表（已按发布时间倒序）里挑出比当前更新的那个。
///
/// 当前装的版本不在该实例的兼容列表里（平台下架，或当初就装错了版本）时拿不到它的发布时间，无从证明
/// 「更新」，不猜。
fn newer_curseforge_version<'a>(
    versions: &'a [ModVersionInfo],
    entry: &LedgerEntry,
) -> Option<&'a ModVersionInfo> {
    let latest = versions.first()?;
    if latest.version_id == entry.version_id {
        return None;
    }
    let current = versions.iter().find(|v| v.version_id == entry.version_id)?;
    if latest.date_published.is_empty() || latest.date_published <= current.date_published {
        return None;
    }
    Some(latest)
}

/// 把指纹匹配结果整理成「指纹 -> 命中文件」。
///
/// 只能按指纹 join：`exactMatches` 既不保证与请求同序，也可能比请求少。指纹在请求侧是 32 位，装不进
/// `u32` 的返回值不可能来自本次请求，丢弃而不是截断——截断会把一个陌生文件的身份错安到别的 jar 上。
fn index_by_fingerprint(matches: Vec<CurseForgeFingerprintMatch>) -> HashMap<u32, CurseForgeFile> {
    matches
        .into_iter()
        .filter_map(|hit| {
            u32::try_from(hit.file.file_fingerprint)
                .ok()
                .map(|fingerprint| (fingerprint, hit.file))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use crate::ledger::Ledger;
    use aurora_instance::IsolationPolicy;
    use aurora_modplatform::ReleaseChannel;
    use sha1::{Digest, Sha1};
    use std::path::{Path, PathBuf};
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Fabric 实例：inheritsFrom 给出 MC 版本，fabric-loader 库触发加载器探测。
    const FABRIC_JSON: &str = r#"{"id":"1.20.1-fabric","inheritsFrom":"1.20.1","type":"release",
        "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
        "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.11"}]}"#;
    /// 原版实例：无任何加载器库。
    const VANILLA_JSON: &str = r#"{"id":"1.20.1","type":"release","mainClass":"m","libraries":[]}"#;

    async fn put_version(mc: &Path, id: &str, json: &str) {
        let dir = mc.join("versions").join(id);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join(format!("{id}.json")), json)
            .await
            .unwrap();
    }

    /// 往实例的隔离 mods 目录放一个 jar，返回 (路径, sha1)。
    async fn put_mod(
        mc: &Path,
        version_id: &str,
        file_name: &str,
        bytes: &[u8],
    ) -> (PathBuf, String) {
        let dir = mc.join("versions").join(version_id).join("mods");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join(file_name);
        tokio::fs::write(&path, bytes).await.unwrap();
        let sha1 = Sha1::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        (path, sha1)
    }

    fn aurora_at(mc: &Path, base: &str) -> Aurora {
        let mut aurora =
            Aurora::for_test(AuroraConfig::default(), mc.to_path_buf(), mc.to_path_buf());
        aurora.set_isolation_policy(IsolationPolicy::All);
        // CurseForge 端点也指向 mock：测试机若恰好配了 API key，也不会打到生产端点。
        aurora.with_modrinth_base(base).with_curseforge_base(base)
    }

    fn ledger_entry(
        file_name: &str,
        project_id: &str,
        version_id: &str,
        sha1: Option<&str>,
    ) -> LedgerEntry {
        LedgerEntry {
            file_name: file_name.to_owned(),
            platform: Platform::Modrinth,
            project_id: project_id.to_owned(),
            version_id: version_id.to_owned(),
            version_number: Some("0.5.3".to_owned()),
            title: Some("Sodium".to_owned()),
            icon_url: None,
            sha1: sha1.map(str::to_owned),
            installed_at: 1_700_000_000,
            installed_as_dependency_of: None,
        }
    }

    async fn save_ledger(aurora: &Aurora, version_id: &str, entries: Vec<LedgerEntry>) {
        let mut ledger = Ledger::default();
        for entry in entries {
            ledger.upsert(entry);
        }
        aurora.ledger_store(version_id).save(&ledger).await.unwrap();
    }

    /// 一条 Modrinth 版本 JSON（含单个主文件）。
    fn modrinth_version(
        id: &str,
        project_id: &str,
        version_number: &str,
        date: &str,
        file_name: &str,
        sha1: &str,
    ) -> String {
        format!(
            r#"{{"id":"{id}","project_id":"{project_id}","name":"{file_name}",
                "version_number":"{version_number}","version_type":"release",
                "date_published":"{date}","game_versions":["1.20.1"],"loaders":["fabric"],
                "files":[{{"hashes":{{"sha1":"{sha1}"}},"url":"https://example.invalid/{file_name}",
                    "filename":"{file_name}","primary":true,"size":1024}}]}}"#
        )
    }

    async fn mount_post(server: &MockServer, route: &str, body: String) {
        Mock::given(method("POST"))
            .and(path(route.to_owned()))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(server)
            .await;
    }

    fn count_requests(requests: &[wiremock::Request], route: &str) -> usize {
        requests.iter().filter(|r| r.url.path() == route).count()
    }

    /// 卷宗里已有身份的 Mod：命中更新时如实给出「从哪个版本到哪个版本」，整个实例只打两次批量请求。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_reports_newer_version_for_known_mod() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, sha1) = put_mod(mc, "1.20.1-fabric", "sodium-0.5.3.jar", b"sodium-payload").await;
        let (_, other_sha1) = put_mod(mc, "1.20.1-fabric", "lithium.jar", b"lithium").await;

        let server = MockServer::start().await;
        mount_post(
            &server,
            "/version_files",
            format!(
                r#"{{"{sha1}":{}}}"#,
                modrinth_version(
                    "old1",
                    "AANobbMI",
                    "0.5.3",
                    "2025-01-01T00:00:00Z",
                    "sodium-0.5.3.jar",
                    &sha1
                )
            ),
        )
        .await;
        Mock::given(method("POST"))
            .and(path("/version_files/update"))
            .and(body_partial_json(serde_json::json!({
                "algorithm": "sha1",
                "loaders": ["fabric"],
                "game_versions": ["1.20.1"]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"{sha1}":{}}}"#,
                modrinth_version(
                    "new2",
                    "AANobbMI",
                    "0.6.0",
                    "2026-06-01T00:00:00Z",
                    "sodium-0.6.0.jar",
                    "bb"
                )
            )))
            .mount(&server)
            .await;

        let aurora = aurora_at(mc, &server.uri());
        save_ledger(
            &aurora,
            "1.20.1-fabric",
            vec![
                ledger_entry("sodium-0.5.3.jar", "AANobbMI", "old1", None),
                ledger_entry("lithium.jar", "gvQqBUqZ", "l1", Some(&other_sha1)),
            ],
        )
        .await;

        let found = aurora.check_updates("1.20.1-fabric").await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_name, "sodium-0.5.3.jar");
        assert_eq!(found[0].title.as_deref(), Some("Sodium"));
        assert_eq!(found[0].current_version_id, "old1");
        assert_eq!(found[0].current_version_number.as_deref(), Some("0.5.3"));
        assert_eq!(found[0].latest.version_id, "new2");
        assert_eq!(found[0].latest.file_name, "sodium-0.6.0.jar");
        assert_eq!(found[0].latest.release_channel, ReleaseChannel::Release);

        // 整个实例只该打一次「当前版本」与一次「最新版本」查询，而不是每个 Mod 一次。
        let requests = server.received_requests().await.unwrap();
        assert_eq!(count_requests(&requests, "/version_files"), 1);
        assert_eq!(count_requests(&requests, "/version_files/update"), 1);
        assert_eq!(requests.len(), 2);
    }

    /// 平台给回的「最新兼容版」比玩家正在用的还旧：不报更新，否则就是一次降级。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_never_offers_an_older_build_as_update() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, sha1) = put_mod(mc, "1.20.1-fabric", "sodium-beta.jar", b"beta").await;

        let server = MockServer::start().await;
        mount_post(
            &server,
            "/version_files",
            format!(
                r#"{{"{sha1}":{}}}"#,
                modrinth_version(
                    "beta",
                    "AANobbMI",
                    "0.7.0-beta",
                    "2026-08-01T00:00:00Z",
                    "sodium-beta.jar",
                    &sha1
                )
            ),
        )
        .await;
        mount_post(
            &server,
            "/version_files/update",
            format!(
                r#"{{"{sha1}":{}}}"#,
                modrinth_version(
                    "stable",
                    "AANobbMI",
                    "0.6.0",
                    "2026-06-01T00:00:00Z",
                    "sodium-0.6.0.jar",
                    "bb"
                )
            ),
        )
        .await;

        let aurora = aurora_at(mc, &server.uri());
        save_ledger(
            &aurora,
            "1.20.1-fabric",
            vec![ledger_entry(
                "sodium-beta.jar",
                "AANobbMI",
                "beta",
                Some(&sha1),
            )],
        )
        .await;
        assert!(
            aurora
                .check_updates("1.20.1-fabric")
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// 批量端点返回的就是当前已装的那个版本：已是最新，不报更新。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_skips_when_batch_returns_same_version() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, sha1) = put_mod(mc, "1.20.1-fabric", "lithium-0.9.0.jar", b"lithium-payload").await;

        let server = MockServer::start().await;
        mount_post(&server, "/version_files", "{}".to_owned()).await;
        mount_post(
            &server,
            "/version_files/update",
            format!(
                r#"{{"{sha1}":{}}}"#,
                modrinth_version(
                    "v090",
                    "AANobbMI",
                    "0.9.0",
                    "2026-06-01T00:00:00Z",
                    "lithium-0.9.0.jar",
                    "aa"
                )
            ),
        )
        .await;

        let aurora = aurora_at(mc, &server.uri());
        save_ledger(
            &aurora,
            "1.20.1-fabric",
            vec![ledger_entry(
                "lithium-0.9.0.jar",
                "AANobbMI",
                "v090",
                Some(&sha1),
            )],
        )
        .await;
        assert!(
            aurora
                .check_updates("1.20.1-fabric")
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// 响应里没有某个哈希：代表该文件无更新（或平台未收录），不是错误，也不该报更新。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_treats_missing_hash_in_response_as_no_update() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        put_mod(mc, "1.20.1-fabric", "sodium-0.5.3.jar", b"sodium-payload").await;

        let server = MockServer::start().await;
        mount_post(&server, "/version_files", "{}".to_owned()).await;
        mount_post(&server, "/version_files/update", "{}".to_owned()).await;

        let aurora = aurora_at(mc, &server.uri());
        save_ledger(
            &aurora,
            "1.20.1-fabric",
            vec![ledger_entry("sodium-0.5.3.jar", "AANobbMI", "old1", None)],
        )
        .await;
        assert!(
            aurora
                .check_updates("1.20.1-fabric")
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// 原版实例：直接返回空，且一个请求都不发（没有加载器就不会有 Mod 在跑）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_on_vanilla_instance_is_empty_without_any_request() {
        let server = MockServer::start().await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1", VANILLA_JSON).await;
        put_mod(mc, "1.20.1", "sodium.jar", b"sodium-payload").await;
        let aurora = aurora_at(mc, &server.uri());
        save_ledger(
            &aurora,
            "1.20.1",
            vec![ledger_entry("sodium.jar", "AANobbMI", "old1", None)],
        )
        .await;

        assert!(aurora.check_updates("1.20.1").await.unwrap().is_empty());
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    /// 手动丢进 mods/ 的 jar：先哈希反查补上身份（含标题图标），再据此查到更新，身份被写回卷宗。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_identifies_unknown_mod_by_hash_then_finds_update() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (jar, sha1) = put_mod(
            mc,
            "1.20.1-fabric",
            "mystery.jar.disabled",
            b"mystery-payload",
        )
        .await;
        let file = std::fs::File::options().write(true).open(&jar).unwrap();
        file.set_times(
            std::fs::FileTimes::new().set_modified(
                std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000),
            ),
        )
        .unwrap();
        drop(file);

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/version_files"))
            .and(body_partial_json(
                serde_json::json!({ "hashes": [sha1.clone()], "algorithm": "sha1" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"{sha1}":{}}}"#,
                modrinth_version(
                    "old1",
                    "AANobbMI",
                    "0.5.3",
                    "2025-01-01T00:00:00Z",
                    "mystery.jar",
                    &sha1
                )
            )))
            .expect(1)
            .mount(&server)
            .await;
        mount_post(
            &server,
            "/version_files/update",
            format!(
                r#"{{"{sha1}":{}}}"#,
                modrinth_version(
                    "new2",
                    "AANobbMI",
                    "0.6.0",
                    "2026-06-01T00:00:00Z",
                    "mystery-0.6.0.jar",
                    "bb"
                )
            ),
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"[{"id":"AANobbMI","title":"Sodium","description":"d","project_type":"mod",
                     "downloads":1,"icon_url":"https://cdn.example.invalid/sodium.png"}]"#,
            ))
            .mount(&server)
            .await;

        let aurora = aurora_at(mc, &server.uri());
        let found = aurora.check_updates("1.20.1-fabric").await.unwrap();
        assert_eq!(found.len(), 1);
        // 禁用态文件按启用态名字报出（卷宗的 join 键）。
        assert_eq!(found[0].file_name, "mystery.jar");
        assert_eq!(found[0].current_version_id, "old1");
        assert_eq!(found[0].title.as_deref(), Some("Sodium"));
        assert_eq!(found[0].latest.version_id, "new2");

        let ledger = aurora.ledger_store("1.20.1-fabric").load().await.unwrap();
        let entry = ledger.find("mystery.jar").expect("反查到的身份应写入卷宗");
        assert_eq!(entry.platform, Platform::Modrinth);
        assert_eq!(entry.project_id, "AANobbMI");
        assert_eq!(entry.version_id, "old1");
        assert_eq!(entry.version_number.as_deref(), Some("0.5.3"));
        assert_eq!(
            entry.icon_url.as_deref(),
            Some("https://cdn.example.invalid/sodium.png")
        );
        assert_eq!(entry.sha1.as_deref(), Some(sha1.as_str()));
        assert_eq!(entry.installed_at, 1_600_000_000);
        assert_eq!(entry.installed_as_dependency_of, None);

        // 列表随即带上来源与图标。
        let listed = aurora.list_mods("1.20.1-fabric").await.unwrap();
        assert_eq!(
            listed[0].source.as_ref().unwrap().title.as_deref(),
            Some("Sodium")
        );
    }

    /// 两条通道都认不出（本地自制 Mod）：不报更新，且不为此凭空生成卷宗文件。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unidentifiable_files_are_skipped_without_writing_a_ledger() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        put_mod(mc, "1.20.1-fabric", "my-private-build.jar", b"homemade").await;

        let server = MockServer::start().await;
        mount_post(&server, "/version_files", "{}".to_owned()).await;
        // 测试机若配了 CurseForge key，指纹通道也会走到这里；给一份空匹配保持结果确定。
        mount_post(
            &server,
            "/v1/fingerprints",
            r#"{"data":{"exactMatches":[]}}"#.to_owned(),
        )
        .await;

        let aurora = aurora_at(mc, &server.uri());
        assert!(
            aurora
                .check_updates("1.20.1-fabric")
                .await
                .unwrap()
                .is_empty()
        );
        let ledger_path = aurora.ledger_store("1.20.1-fabric").path().to_path_buf();
        assert!(!tokio::fs::try_exists(&ledger_path).await.unwrap());
        // 没有任何已知身份，最新版本查询一次都不该发。
        let requests = server.received_requests().await.unwrap();
        assert_eq!(count_requests(&requests, "/version_files/update"), 0);
    }

    /// 一个实例里同时有 Modrinth 与 CurseForge 来源的 Mod：后者的卷宗条目是 JEI（238222，文件 100）。
    async fn mixed_platform_instance(mc: &Path, server: &MockServer) -> Aurora {
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, sha1) = put_mod(mc, "1.20.1-fabric", "sodium-0.5.3.jar", b"sodium-payload").await;
        put_mod(mc, "1.20.1-fabric", "jei-100.jar", b"jei-payload").await;
        mount_post(
            server,
            "/version_files",
            format!(
                r#"{{"{sha1}":{}}}"#,
                modrinth_version(
                    "old1",
                    "AANobbMI",
                    "0.5.3",
                    "2025-01-01T00:00:00Z",
                    "sodium-0.5.3.jar",
                    &sha1
                )
            ),
        )
        .await;
        mount_post(
            server,
            "/version_files/update",
            format!(
                r#"{{"{sha1}":{}}}"#,
                modrinth_version(
                    "new2",
                    "AANobbMI",
                    "0.6.0",
                    "2026-06-01T00:00:00Z",
                    "sodium-0.6.0.jar",
                    "bb"
                )
            ),
        )
        .await;
        let aurora = aurora_at(mc, &server.uri());
        let mut jei = ledger_entry("jei-100.jar", "238222", "100", None);
        jei.platform = Platform::CurseForge;
        jei.title = Some("JEI".to_owned());
        save_ledger(
            &aurora,
            "1.20.1-fabric",
            vec![
                ledger_entry("sodium-0.5.3.jar", "AANobbMI", "old1", Some(&sha1)),
                jei,
            ],
        )
        .await;
        aurora
    }

    fn key_missing() -> Result<aurora_modplatform::CurseForgeClient> {
        Err(CoreError::ModPlatform(
            aurora_modplatform::Error::CurseForgeKeyMissing,
        ))
    }

    /// 当前构建没有 CurseForge API key：CurseForge 那部分跳过，Modrinth 查到的更新照常给出，
    /// 一个 CurseForge 请求都不发。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_without_curseforge_key_keeps_modrinth_results() {
        let tmp = tempfile::tempdir().unwrap();
        let server = MockServer::start().await;
        let aurora = mixed_platform_instance(tmp.path(), &server).await;

        let found = aurora
            .check_updates_with("1.20.1-fabric", key_missing)
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_name, "sodium-0.5.3.jar");
        assert_eq!(found[0].current_version_id, "old1");
        assert_eq!(found[0].latest.version_id, "new2");
        let requests = server.received_requests().await.unwrap();
        assert!(
            requests.iter().all(|r| !r.url.path().starts_with("/v1/")),
            "没有 key 时不该发出任何 CurseForge 请求：{:?}",
            requests.iter().map(|r| r.url.path()).collect::<Vec<_>>()
        );
    }

    /// 构造 CurseForge 客户端的别的失败不是「没配 key」，照常冒泡，不把它当成可以跳过的情形。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_surfaces_other_curseforge_client_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let server = MockServer::start().await;
        let aurora = mixed_platform_instance(tmp.path(), &server).await;

        let err = aurora
            .check_updates_with("1.20.1-fabric", || {
                Err(CoreError::ModPlatform(aurora_modplatform::Error::Status {
                    url: "https://api.curseforge.com".to_owned(),
                    status: 500,
                }))
            })
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::ModPlatform(aurora_modplatform::Error::Status { status: 500, .. })
            ),
            "实得 {err:?}"
        );
    }

    /// 配了 key：CurseForge 来源的 Mod 按文件列表比出更新，与 Modrinth 的结果合在一起按文件名排好。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_with_curseforge_key_reports_both_platforms() {
        let tmp = tempfile::tempdir().unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [
                    {
                        "id": 200, "modId": 238222, "displayName": "JEI 200",
                        "fileName": "jei-200.jar", "releaseType": 1,
                        "fileDate": "2026-06-01T00:00:00Z", "gameVersions": ["1.20.1", "Fabric"],
                        "downloadUrl": "https://cf.example.invalid/jei-200.jar"
                    },
                    {
                        "id": 100, "modId": 238222, "displayName": "JEI 100",
                        "fileName": "jei-100.jar", "releaseType": 1,
                        "fileDate": "2026-01-01T00:00:00Z", "gameVersions": ["1.20.1", "Fabric"]
                    }
                ]
            })))
            .mount(&server)
            .await;
        let aurora = mixed_platform_instance(tmp.path(), &server)
            .await
            .with_curseforge_key("test-key");

        let found = aurora.check_updates("1.20.1-fabric").await.unwrap();
        let names: Vec<(&str, &str)> = found
            .iter()
            .map(|c| (c.file_name.as_str(), c.latest.version_id.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![("jei-100.jar", "200"), ("sodium-0.5.3.jar", "new2")]
        );
        assert_eq!(found[0].title.as_deref(), Some("JEI"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_on_uninstalled_version_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path(), "http://127.0.0.1:1");
        let err = aurora.check_updates("ghost").await.unwrap_err();
        assert!(matches!(err, CoreError::VersionNotInstalled { id } if id == "ghost"));
    }

    fn cf_version(id: &str, date: &str) -> ModVersionInfo {
        ModVersionInfo {
            version_id: id.to_owned(),
            project_id: "238222".to_owned(),
            platform: Platform::CurseForge,
            name: id.to_owned(),
            version_number: id.to_owned(),
            release_channel: ReleaseChannel::Release,
            game_versions: vec!["1.20.1".to_owned()],
            loaders: Vec::new(),
            file_name: format!("{id}.jar"),
            file_size: None,
            sha1: None,
            download_url: None,
            date_published: date.to_owned(),
            dependencies: Vec::new(),
        }
    }

    #[test]
    fn curseforge_update_requires_a_strictly_newer_publish_date() {
        let mut entry = ledger_entry("jei.jar", "238222", "100", None);
        entry.platform = Platform::CurseForge;
        let newest = cf_version("200", "2026-06-01T00:00:00Z");
        let current = cf_version("100", "2026-01-01T00:00:00Z");

        let list = vec![newest.clone(), current.clone()];
        assert_eq!(
            newer_curseforge_version(&list, &entry).map(|v| v.version_id.as_str()),
            Some("200")
        );
        // 已是最新。
        assert!(newer_curseforge_version(std::slice::from_ref(&current), &entry).is_none());
        // 当前版本不在兼容列表里：拿不到它的发布时间，不猜。
        assert!(newer_curseforge_version(std::slice::from_ref(&newest), &entry).is_none());
        // 同一时刻发布：不算更新。
        let same_time = cf_version("200", "2026-01-01T00:00:00Z");
        assert!(newer_curseforge_version(&[same_time, current.clone()], &entry).is_none());
        // 最新版缺发布时间：无从证明是更新。
        let undated = cf_version("200", "");
        assert!(newer_curseforge_version(&[undated, current], &entry).is_none());
        assert!(newer_curseforge_version(&[], &entry).is_none());
    }

    #[test]
    fn fingerprint_index_joins_by_fingerprint_and_drops_out_of_range() {
        let matches: Vec<CurseForgeFingerprintMatch> = serde_json::from_str(
            r#"[
                {"id":238222,"file":{"id":4567,"modId":238222,"displayName":"JEI 15.2",
                    "fileName":"jei-15.2.jar","fileFingerprint":3608199863}},
                {"id":306612,"file":{"id":8901,"modId":306612,"displayName":"Fabric API",
                    "fileName":"fabric-api.jar","fileFingerprint":5000000000}}
            ]"#,
        )
        .unwrap();

        let index = index_by_fingerprint(matches);
        assert_eq!(index.len(), 1);
        assert_eq!(index.get(&3_608_199_863).unwrap().file_name, "jei-15.2.jar");
        assert_eq!(index.get(&3_608_199_863).unwrap().mod_id, 238_222);
        // 超出 u32 的指纹不可能来自本次请求：丢弃，绝不截断成 705_032_704 去错配。
        assert!(!index.contains_key(&705_032_704));
    }
}
