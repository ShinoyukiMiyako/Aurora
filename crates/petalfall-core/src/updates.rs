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
//! 请求量是这里的头号约束：一个实例几十上百个 Mod，逐个问平台立刻撞上限流。Modrinth 侧是一次按哈希
//! 取当前版本，加上按当前发布通道分组、每组一次的按哈希取最新版本（全是正式版时就是一次）；CurseForge
//! 侧与锁定了版本的 Mod 逐工程查版本列表，有界并发且走版本列表缓存。
//!
//! 玩家的更新设置在这里生效：忽略更新的 Mod 不进任何查询；锁定版本的只报不晚于锁定版本的更新；推给
//! 玩家的候选只能与当前装的同一发布通道或更稳定（装正式版只报正式版）。

use std::collections::{BTreeMap, HashMap};

use petalfall_modplatform::{
    BodyFormat, CurseForgeClient, CurseForgeFile, CurseForgeFingerprintMatch, InstalledMod,
    ModHashes, ModLoader, ModVersionInfo, ModrinthVersion, Platform, ReleaseChannel, hash_mod_file,
};
use serde::Serialize;

use crate::compat::{
    instance_mc_version, instance_mod_loaders, is_fabric_twin, prefer_quilt_builds,
};
use crate::deps::project_gone;
use crate::error::{CoreError, Result};
use crate::facade::Petalfall;
use crate::ledger::{LedgerEntry, UpdateHold};
use crate::modfs::{
    NETWORK_CONCURRENCY, bounded_map, ledger_key, local_concurrency, lock_mods_dir, present, refuse,
};
use crate::mods::{InstanceDirs, mod_file_path, scan_installed};

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

/// 某个版本的更新日志。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModChangelog {
    /// 平台版本标识（即请求的那个版本）。
    pub version_id: String,
    /// 正文格式：Modrinth 为 Markdown，CurseForge 为 HTML。
    pub format: BodyFormat,
    /// 正文；作者没写（平台给空或纯空白）为 `None`。
    pub body: Option<String>,
}

/// 一组批量查更新的目标：SHA-1 -> (启用态文件名, 卷宗条目)。
type BatchTargets = HashMap<String, (String, LedgerEntry)>;

/// 走 Modrinth 批量查更新的条目：按哈希一次问完，平台按通道过滤。
///
/// 锁定了版本的不走这条：批量端点只给「最新的那一个」，比锁定版本新时就无从知道锁定范围内有没有
/// 更新，得拿版本列表在本地挑。
fn batch_update_target(entry: &LedgerEntry) -> bool {
    entry.platform == Platform::Modrinth && entry.update_hold.is_none()
}

/// 当前通道认不出时按正式版处理：最保守，只会少报测试版，不会把正式版玩家推上不稳定的构建。
fn current_channel(current: Option<&ModrinthVersion>) -> ReleaseChannel {
    current
        .and_then(|version| ReleaseChannel::from_modrinth(&version.version_type))
        .unwrap_or(ReleaseChannel::Release)
}

/// 一个刚被哈希反查认出来的文件。
struct Identified {
    key: String,
    info: ModVersionInfo,
    sha1: String,
    modified_ms: i64,
}

impl Petalfall {
    /// 检查该实例可更新的 Mod。
    ///
    /// 有身份走精确查，无身份先做一轮哈希反查补身份（补上的身份写回卷宗，下次不必再查）。返回顺序按
    /// 文件名字典序，保证 UI 列表稳定。新旧一律按发布时间比，绝不比版本号字符串：两个平台的版本号
    /// 各家一套格式，字典序比出来的「更新」随时可能是一次降级。
    pub async fn check_updates(&self, version_id: &str) -> Result<Vec<UpdateCandidate>> {
        self.check_updates_with(version_id, || self.curseforge_client())
            .await
    }

    /// [`Petalfall::check_updates`] 的本体。`curseforge` 构造 CurseForge 客户端，只用来判断 CurseForge
    /// 那部分能不能查；文件列表照旧经版本列表缓存取。生产传 [`Petalfall::curseforge_client`]：有没有 key
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
        self.check_scanned(
            version_id, &dirs, &installed, loaders, mc_version, curseforge,
        )
        .await
    }

    /// 拿一次扫描结果查更新。扫描与这里之间隔着时间，`installed` 里的文件此刻不一定还在。
    async fn check_scanned(
        &self,
        version_id: &str,
        dirs: &InstanceDirs,
        installed: &[InstalledMod],
        loaders: Vec<ModLoader>,
        mc_version: String,
        curseforge: impl FnOnce() -> Result<CurseForgeClient>,
    ) -> Result<Vec<UpdateCandidate>> {
        let mut ledger = self.ledger_store(version_id).load().await?;

        // 磁盘是权威：待查集合来自重扫结果，并按启用态文件名去重——同名的启用副本与禁用副本指向同一条
        // 卷宗身份，不该产出两条重复的更新项。
        let mut files: BTreeMap<String, &InstalledMod> = BTreeMap::new();
        for item in installed {
            files
                .entry(ledger_key(&item.file_name).to_owned())
                .or_insert(item);
        }

        // 要现算哈希的只有两类：卷宗里没有身份的（反查用），以及卷宗没记 SHA-1、要走批量查更新的 Modrinth
        // 条目（批量查更新按 SHA-1 索引）。已有身份的文件不重算，忽略更新与锁定版本的也用不着哈希。
        let to_hash: Vec<(String, std::path::PathBuf)> = files
            .iter()
            .filter(|(key, _)| match ledger.find(key) {
                None => true,
                Some(entry) => batch_update_target(entry) && entry.sha1.is_none(),
            })
            .map(|(key, item)| (key.clone(), item.path.clone()))
            .collect();
        let hashing = bounded_map(to_hash, local_concurrency(), |(key, path)| async move {
            Ok((key, hash_unless_gone(&path).await?))
        })
        .await?;
        let mut hashed: HashMap<String, ModHashes> = HashMap::with_capacity(hashing.len());
        for (key, hashes) in hashing {
            match hashes {
                Some(hashes) => {
                    hashed.insert(key, hashes);
                }
                // 从待查集合里摘掉：下面按集合取哈希时不用再分「没算」与「算不出」。
                None => {
                    files.remove(&key);
                }
            }
        }

        let mut known_modrinth: HashMap<String, String> = HashMap::new();
        let mut unknown: Vec<String> = Vec::new();
        for key in files.keys() {
            match ledger.find(key) {
                None => unknown.push(key.clone()),
                Some(entry) if batch_update_target(entry) => {
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

        // 一次批量请求同时服务三件事：给无身份的文件反查身份，给已知身份的文件取「当前版本」的发布时间
        // 与发布通道，供下面分组查询并判断平台给的「最新」是不是真的更新。
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

        // 按当前发布通道分组：同组的放行通道相同，一次请求即可下推过滤。组按通道从稳到不稳排列，请求
        // 顺序因此固定。
        let mut modrinth_groups: Vec<(ReleaseChannel, BatchTargets)> = Vec::new();
        let mut listed_targets: Vec<(String, LedgerEntry)> = Vec::new();
        for key in files.keys() {
            let Some(entry) = ledger.find(key) else {
                continue;
            };
            if entry.update_hold == Some(UpdateHold::Ignored) {
                continue;
            }
            // 批量查更新要拿「当前版本」的发布时间与通道作比较，只有这一轮按哈希问过当前版本的才走批量。
            // 反查写回身份时重读了卷宗，首轮读时设着更新检查、期间被恢复的 Mod 没被问过（也可能没记
            // SHA-1），这一轮改走版本列表在本地挑，不拿缺了基准的批量结果去猜。
            let asked_sha1 = known_modrinth
                .get(key)
                .or(entry.sha1.as_ref())
                .filter(|sha1| lookup.binary_search(sha1).is_ok())
                .cloned();
            let (true, Some(sha1)) = (batch_update_target(entry), asked_sha1) else {
                listed_targets.push((key.clone(), entry.clone()));
                continue;
            };
            let channel = current_channel(by_hash.get(&sha1));
            let slot = match modrinth_groups.iter().position(|(c, _)| *c == channel) {
                Some(index) => index,
                None => {
                    modrinth_groups.push((channel, HashMap::new()));
                    modrinth_groups.len() - 1
                }
            };
            modrinth_groups[slot]
                .1
                .insert(sha1, (key.clone(), entry.clone()));
        }
        modrinth_groups.sort_by_key(|(channel, _)| channel.admitted().len());

        let mut candidates = Vec::new();
        for (channel, targets) in &modrinth_groups {
            let hashes: Vec<String> = targets.keys().cloned().collect();
            let latest = modrinth
                .latest_versions_by_hashes(
                    &hashes,
                    &loaders,
                    &[mc_version.as_str()],
                    channel.admitted(),
                )
                .await?;
            for (hash, version) in latest {
                let Some((file_name, entry)) = targets.get(&hash) else {
                    continue;
                };
                // 端点返回的是该文件在本实例加载器/版本下的最新兼容版本，可能正是当前这个。
                if version.id == entry.version_id {
                    continue;
                }
                let Some(info) = version.to_version_info() else {
                    continue;
                };
                // 通道过滤已经下推，这里再校一遍：服务端忽略了过滤条件时，不能因此把测试版推给正式版玩家。
                if !channel.admits(info.release_channel) {
                    continue;
                }
                // 玩家装的可能是比「最新兼容」更新的测试版或别的加载器的构建：平台给回的那个反而更旧，
                // 推给他就是一次降级。
                if let Some(current) = by_hash.get(&hash)
                    && info.date_published <= current.date_published
                {
                    continue;
                }
                // 端点按时间只给一个，分不出同一发布的 quilt 构建：Quilt 实例拿到只标 fabric 的结果时，
                // 改走版本列表在本地挑。
                if loaders.contains(&ModLoader::Quilt) && !info.loaders.contains(&ModLoader::Quilt)
                {
                    listed_targets.push((file_name.clone(), entry.clone()));
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

        // 走版本列表的还有锁定了版本的 Modrinth 来源，没有 key 时查不了的只是 CurseForge 那几个。
        let curseforge_pending = listed_targets
            .iter()
            .filter(|(_, entry)| entry.platform == Platform::CurseForge)
            .count();
        if curseforge_pending > 0 && !curseforge_ready(curseforge, curseforge_pending)? {
            listed_targets.retain(|(_, entry)| entry.platform != Platform::CurseForge);
        }

        if !listed_targets.is_empty() {
            let petalfall = self.clone();
            let found = bounded_map(listed_targets, NETWORK_CONCURRENCY, move |(key, entry)| {
                let petalfall = petalfall.clone();
                let mc_version = mc_version.clone();
                let loaders = loaders.clone();
                async move {
                    let listed = petalfall
                        .list_mod_versions(
                            entry.platform,
                            &entry.project_id,
                            &[mc_version],
                            &loaders,
                        )
                        .await;
                    let mut versions = match listed {
                        Ok(versions) => versions,
                        // 工程下架后这一项没有更新可报，与 Modrinth 批量查询里查无此哈希是同一结果；
                        // 让它报错的话，一个下架的 Mod 会连累整个实例查不了更新。
                        Err(err) if project_gone(&err) => {
                            tracing::info!(
                                platform = entry.platform.display_name(),
                                project_id = %entry.project_id,
                                "工程在平台上已不存在，跳过这个 Mod 的更新检查"
                            );
                            return Ok(None);
                        }
                        Err(err) => return Err(err),
                    };
                    prefer_quilt_builds(&mut versions, &loaders);
                    Ok(
                        pick_update(&versions, &entry.version_id, entry.update_hold.as_ref()).map(
                            |latest| UpdateCandidate {
                                file_name: key,
                                title: entry.title.clone(),
                                current_version_id: entry.version_id.clone(),
                                current_version_number: entry.version_number.clone(),
                                latest: latest.clone(),
                            },
                        ),
                    )
                }
            })
            .await?;
            candidates.extend(found.into_iter().flatten());
        }

        candidates.sort_by(|a, b| a.file_name.cmp(&b.file_name));
        Ok(candidates)
    }

    /// 取实例里某个 Mod 的某个平台版本的更新日志，供更新预览展开查看。
    ///
    /// `file_name` 是列表里的磁盘文件名（禁用态也认），工程身份从卷宗取，`mod_version_id` 必须属于这个
    /// 工程。只读：不占实例锁、不写卷宗，也不缓存，只有玩家展开那一项时才取。
    pub async fn mod_update_changelog(
        &self,
        version_id: &str,
        file_name: &str,
        mod_version_id: &str,
    ) -> Result<ModChangelog> {
        let dirs = self.resolved_dirs(version_id).await?;
        let path = mod_file_path(&dirs.mods_dir, file_name)?;
        let ledger = self.ledger_store(version_id).load().await?;
        let entry = ledger.find(ledger_key(file_name)).ok_or_else(|| {
            refuse(
                &path,
                std::io::ErrorKind::NotFound,
                format!("{file_name} 没有平台来源记录，取不到更新日志"),
            )
        })?;
        let not_found = || CoreError::ModVersionNotFound {
            platform: entry.platform.display_name(),
            project_id: entry.project_id.clone(),
            version_id: mod_version_id.to_owned(),
        };
        let (format, body) = match entry.platform {
            Platform::Modrinth => {
                // 版本 id 全局唯一，平台照样会返回别家工程的版本；不核对工程就会把别人的日志当成这个
                // Mod 的更新说明给玩家看。
                let changelog = self
                    .modrinth_client()
                    .version_changelog(mod_version_id)
                    .await?
                    .filter(|changelog| changelog.project_id == entry.project_id)
                    .ok_or_else(not_found)?;
                (BodyFormat::Markdown, changelog.changelog)
            }
            Platform::CurseForge => {
                // 两个 id 在平台上都是数字；不是数字的串不可能对应任何文件，不必为它触网。
                let (Ok(mod_id), Ok(file_id)) = (
                    entry.project_id.parse::<u32>(),
                    mod_version_id.parse::<u32>(),
                ) else {
                    return Err(not_found());
                };
                let body = self
                    .curseforge_client()?
                    .file_changelog(mod_id, file_id)
                    .await?
                    .ok_or_else(not_found)?;
                (BodyFormat::Html, Some(body))
            }
        };
        Ok(ModChangelog {
            version_id: mod_version_id.to_owned(),
            format,
            body: body.filter(|text| !text.trim().is_empty()),
        })
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
            // 持着锁再看一眼：锁外那段时间里文件可能已被移除，不留对不上文件的身份记录。
            if ledger.find(&item.key).is_some() || !present(mods_dir, &item.key).await? {
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
                update_hold: None,
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
            Err(CoreError::ModPlatform(petalfall_modplatform::Error::CurseForgeKeyMissing)) => {
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

/// 算一个文件的双通道哈希；文件已经不在了返回 `None`。
///
/// 待查集合来自更早的那次扫描：玩家可能在资源管理器里删了文件，启停与移除也能和检查更新同时进行。没了
/// 的文件没有更新可报，让它报错会连累整个实例查不了更新。占用、权限这类读取失败不算：文件还在，漏查了
/// 玩家不会知道，照常冒泡。
async fn hash_unless_gone(path: &std::path::Path) -> Result<Option<ModHashes>> {
    match hash_mod_file(path).await {
        Ok(hashes) => Ok(Some(hashes)),
        Err(petalfall_modplatform::Error::Base(petalfall_base::Error::Io { source, .. }))
            if source.kind() == std::io::ErrorKind::NotFound =>
        {
            tracing::info!(path = %path.display(), "文件在检查更新途中不见了，跳过");
            Ok(None)
        }
        Err(err) => Err(err.into()),
    }
}

/// CurseForge 来源的更新查不查得了。
///
/// 未配置 API key 时这部分整体跳过并记 info：缺一把可选的钥匙不该让 Modrinth 那部分已经查到的更新
/// 一并丢掉，与 [`Petalfall::curseforge_fingerprint_lookup`] 停用指纹反查是同一约定。构造客户端的其它
/// 失败照常冒泡。
fn curseforge_ready(
    curseforge: impl FnOnce() -> Result<CurseForgeClient>,
    pending: usize,
) -> Result<bool> {
    match curseforge() {
        Ok(_) => Ok(true),
        Err(CoreError::ModPlatform(petalfall_modplatform::Error::CurseForgeKeyMissing)) => {
            tracing::info!(
                pending,
                "未配置 CurseForge API key，跳过 CurseForge 来源 Mod 的更新检查"
            );
            Ok(false)
        }
        Err(other) => Err(other),
    }
}

/// 从版本列表（已按发布时间倒序）里挑出该推给玩家的更新；没有返回 `None`。
///
/// 候选必须同时满足：不是当前版本、通道被当前版本的通道放行、发布时间严格晚于当前版本、锁定了版本时
/// 不晚于锁定版本。当前版本不在列表里（平台下架，或当初就装错了版本）或没有发布时间时无从证明「更新」，
/// 不猜；锁定的版本不在列表里同理，没有上限就不报，不当作没锁。
pub(crate) fn pick_update<'a>(
    versions: &'a [ModVersionInfo],
    current_version_id: &str,
    hold: Option<&UpdateHold>,
) -> Option<&'a ModVersionInfo> {
    let ceiling = match hold {
        Some(UpdateHold::Ignored) => return None,
        Some(UpdateHold::Pinned { version_id }) => Some(
            versions
                .iter()
                .find(|v| v.version_id == *version_id)?
                .date_published
                .as_str(),
        ),
        None => None,
    };
    let current = versions
        .iter()
        .find(|v| v.version_id == current_version_id)
        .filter(|v| !v.date_published.is_empty())?;
    versions.iter().find(|candidate| {
        candidate.version_id != current.version_id
            // 同一发布的另一份构建只是传得晚，换过去什么都没更新。
            && !is_fabric_twin(candidate, current)
            && current.release_channel.admits(candidate.release_channel)
            && !candidate.date_published.is_empty()
            && candidate.date_published > current.date_published
            && ceiling.is_none_or(|limit| candidate.date_published.as_str() <= limit)
    })
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
    use crate::config::PetalfallConfig;
    use crate::ledger::Ledger;
    use petalfall_instance::IsolationPolicy;
    use petalfall_modplatform::ReleaseChannel;
    use sha1::{Digest, Sha1};
    use std::path::{Path, PathBuf};
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Fabric 实例：inheritsFrom 给出 MC 版本，fabric-loader 库触发加载器探测。
    const FABRIC_JSON: &str = r#"{"id":"1.20.1-fabric","inheritsFrom":"1.20.1","type":"release",
        "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
        "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.11"}]}"#;
    /// Quilt 实例：与 Fabric 实例同形，quilt-loader 库触发加载器探测。
    const QUILT_JSON: &str = r#"{"id":"1.20.1-quilt","inheritsFrom":"1.20.1","type":"release",
        "mainClass":"org.quiltmc.loader.impl.launch.knot.KnotClient",
        "libraries":[{"name":"org.quiltmc:quilt-loader:0.26.0"}]}"#;
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

    fn petalfall_at(mc: &Path, base: &str) -> Petalfall {
        let mut petalfall = Petalfall::for_test(
            PetalfallConfig::default(),
            mc.to_path_buf(),
            mc.to_path_buf(),
        );
        petalfall.set_isolation_policy(IsolationPolicy::All);
        // CurseForge 端点也指向 mock：测试机若恰好配了 API key，也不会打到生产端点。
        petalfall
            .with_modrinth_base(base)
            .with_curseforge_base(base)
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
            update_hold: None,
        }
    }

    async fn save_ledger(petalfall: &Petalfall, version_id: &str, entries: Vec<LedgerEntry>) {
        let mut ledger = Ledger::default();
        for entry in entries {
            ledger.upsert(entry);
        }
        petalfall
            .ledger_store(version_id)
            .save(&ledger)
            .await
            .unwrap();
    }

    /// 一条正式版的 Modrinth 版本 JSON（含单个主文件）。
    fn modrinth_version(
        id: &str,
        project_id: &str,
        version_number: &str,
        date: &str,
        file_name: &str,
        sha1: &str,
    ) -> String {
        modrinth_version_typed(
            id,
            project_id,
            version_number,
            date,
            file_name,
            sha1,
            "release",
        )
    }

    /// 一条指定发布通道的 Modrinth 版本 JSON（含单个主文件）。
    fn modrinth_version_typed(
        id: &str,
        project_id: &str,
        version_number: &str,
        date: &str,
        file_name: &str,
        sha1: &str,
        version_type: &str,
    ) -> String {
        format!(
            r#"{{"id":"{id}","project_id":"{project_id}","name":"{file_name}",
                "version_number":"{version_number}","version_type":"{version_type}",
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
                "game_versions": ["1.20.1"],
                "version_types": ["release"]
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

        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
            "1.20.1-fabric",
            vec![
                ledger_entry("sodium-0.5.3.jar", "AANobbMI", "old1", None),
                ledger_entry("lithium.jar", "gvQqBUqZ", "l1", Some(&other_sha1)),
            ],
        )
        .await;

        let found = petalfall.check_updates("1.20.1-fabric").await.unwrap();
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

    /// 把版本 JSON 的加载器换成 `loaders`（JSON 数组）。
    fn on_loaders(version: String, loaders: &str) -> String {
        version.replace(
            r#""loaders":["fabric"]"#,
            &format!(r#""loaders":{loaders}"#),
        )
    }

    /// Quilt 实例上跑一次更新检查：玩家装着 `current`，批量端点回 `latest`，版本列表回 `listed`。
    async fn quilt_updates(
        current: impl FnOnce(&str) -> String,
        latest: String,
        listed: impl FnOnce(&str) -> Vec<String>,
    ) -> Vec<UpdateCandidate> {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-quilt", QUILT_JSON).await;
        let (_, sha1) = put_mod(mc, "1.20.1-quilt", "installed.jar", b"installed").await;

        let server = MockServer::start().await;
        mount_post(
            &server,
            "/version_files",
            format!(r#"{{"{sha1}":{}}}"#, current(&sha1)),
        )
        .await;
        Mock::given(method("POST"))
            .and(path("/version_files/update"))
            .and(body_partial_json(serde_json::json!({
                "loaders": ["quilt", "fabric"],
                "game_versions": ["1.20.1"]
            })))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(format!(r#"{{"{sha1}":{latest}}}"#)),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/project/AANobbMI/version"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(format!("[{}]", listed(&sha1).join(","))),
            )
            .mount(&server)
            .await;

        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
            "1.20.1-quilt",
            vec![ledger_entry(
                "installed.jar",
                "AANobbMI",
                "current",
                Some(&sha1),
            )],
        )
        .await;
        petalfall.check_updates("1.20.1-quilt").await.unwrap()
    }

    /// 真实数据：AppleSkin 2.5.0+mc1.20 之后的版本只标 fabric，只拿 quilt 去问平台就报不出更新。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quilt_instance_is_offered_a_fabric_only_update() {
        let current = |sha1: &str| {
            on_loaders(
                modrinth_version(
                    "current",
                    "AANobbMI",
                    "2.5.0+mc1.20",
                    "2023-06-08T00:00:00Z",
                    "installed.jar",
                    sha1,
                ),
                r#"["fabric","quilt"]"#,
            )
        };
        let newest = modrinth_version(
            "newest",
            "AANobbMI",
            "2.5.2+mc1.20.1",
            "2026-01-24T00:00:00Z",
            "appleskin-2.5.2.jar",
            "bb",
        );

        let found =
            quilt_updates(current, newest.clone(), |sha1| vec![newest, current(sha1)]).await;

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].current_version_id, "current");
        assert_eq!(found[0].latest.version_id, "newest");
    }

    /// 装着 quilt 构建时，同一发布晚几分钟传的 fabric 构建不是更新。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quilt_build_is_not_updated_to_its_fabric_twin() {
        let current = |sha1: &str| {
            on_loaders(
                modrinth_version(
                    "current",
                    "AANobbMI",
                    "1.4.0+quilt",
                    "2026-01-01T00:00:00Z",
                    "installed.jar",
                    sha1,
                ),
                r#"["quilt"]"#,
            )
        };
        let twin = modrinth_version(
            "twin",
            "AANobbMI",
            "1.4.0+fabric",
            "2026-01-01T00:05:00Z",
            "twin.jar",
            "bb",
        );

        let found = quilt_updates(current, twin.clone(), |sha1| vec![twin, current(sha1)]).await;

        assert_eq!(found, Vec::new());
    }

    /// 批量端点按时间只给一个，同一发布的 quilt 构建被更晚传的 fabric 构建压住：要报 quilt 那份。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quilt_instance_updates_to_the_quilt_build_of_a_new_release() {
        let current = |sha1: &str| {
            on_loaders(
                modrinth_version(
                    "current",
                    "AANobbMI",
                    "1.3.0+quilt",
                    "2025-01-01T00:00:00Z",
                    "installed.jar",
                    sha1,
                ),
                r#"["quilt"]"#,
            )
        };
        let fabric = modrinth_version(
            "fabric",
            "AANobbMI",
            "1.4.0+fabric",
            "2026-01-01T00:05:00Z",
            "fabric.jar",
            "bb",
        );
        let quilt = on_loaders(
            modrinth_version(
                "quilt",
                "AANobbMI",
                "1.4.0+quilt",
                "2026-01-01T00:00:00Z",
                "quilt.jar",
                "cc",
            ),
            r#"["quilt"]"#,
        );

        let found = quilt_updates(current, fabric.clone(), |sha1| {
            vec![fabric, quilt, current(sha1)]
        })
        .await;

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].latest.version_id, "quilt");
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

        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
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
            petalfall
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

        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
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
            petalfall
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

        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
            "1.20.1-fabric",
            vec![ledger_entry("sodium-0.5.3.jar", "AANobbMI", "old1", None)],
        )
        .await;
        assert!(
            petalfall
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
        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
            "1.20.1",
            vec![ledger_entry("sodium.jar", "AANobbMI", "old1", None)],
        )
        .await;

        assert!(petalfall.check_updates("1.20.1").await.unwrap().is_empty());
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

        let petalfall = petalfall_at(mc, &server.uri());
        let found = petalfall.check_updates("1.20.1-fabric").await.unwrap();
        assert_eq!(found.len(), 1);
        // 禁用态文件按启用态名字报出（卷宗的 join 键）。
        assert_eq!(found[0].file_name, "mystery.jar");
        assert_eq!(found[0].current_version_id, "old1");
        assert_eq!(found[0].title.as_deref(), Some("Sodium"));
        assert_eq!(found[0].latest.version_id, "new2");

        let ledger = petalfall
            .ledger_store("1.20.1-fabric")
            .load()
            .await
            .unwrap();
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
        let listed = petalfall.list_mods("1.20.1-fabric").await.unwrap();
        assert_eq!(
            listed[0].source.as_ref().unwrap().title.as_deref(),
            Some("Sodium")
        );
    }

    /// 哈希算完到写卷宗之间文件被删了：不留一条对不上文件的身份记录。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_file_removed_while_identifying_leaves_no_ledger_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (jar, sha1) = put_mod(mc, "1.20.1-fabric", "mystery.jar", b"mystery-payload").await;

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
                    "mystery.jar",
                    &sha1
                )
            ),
        )
        .await;
        mount_post(&server, "/version_files/update", "{}".to_owned()).await;
        // 工程信息是写卷宗前最后一个请求：玩家在这时移除了文件。
        Mock::given(method("GET"))
            .and(path("/projects"))
            .respond_with(move |_: &wiremock::Request| {
                std::fs::remove_file(&jar).unwrap();
                ResponseTemplate::new(200).set_body_string(
                    r#"[{"id":"AANobbMI","title":"Sodium","description":"d","project_type":"mod",
                         "downloads":1,"icon_url":null}]"#,
                )
            })
            .mount(&server)
            .await;

        let petalfall = petalfall_at(mc, &server.uri());
        petalfall.check_updates("1.20.1-fabric").await.unwrap();

        let ledger = petalfall
            .ledger_store("1.20.1-fabric")
            .load()
            .await
            .unwrap();
        assert!(ledger.find("mystery.jar").is_none());
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

        let petalfall = petalfall_at(mc, &server.uri());
        assert!(
            petalfall
                .check_updates("1.20.1-fabric")
                .await
                .unwrap()
                .is_empty()
        );
        let ledger_path = petalfall.ledger_store("1.20.1-fabric").path().to_path_buf();
        assert!(!tokio::fs::try_exists(&ledger_path).await.unwrap());
        // 没有任何已知身份，最新版本查询一次都不该发。
        let requests = server.received_requests().await.unwrap();
        assert_eq!(count_requests(&requests, "/version_files/update"), 0);
    }

    /// 扫描之后、算哈希之前文件没了（玩家在资源管理器里删了，或并发的移除抢了先）：那个文件不报更新，
    /// 其余 Mod 照常。两类都要补算：卷宗里没有身份的，与卷宗没记 SHA-1 的 Modrinth 条目。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn files_gone_after_the_scan_are_skipped_not_fatal() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, sha1) = put_mod(mc, "1.20.1-fabric", "sodium-0.5.3.jar", b"sodium-payload").await;
        let (unknown, _) = put_mod(mc, "1.20.1-fabric", "dropped-in.jar", b"dropped").await;
        let (known, _) = put_mod(mc, "1.20.1-fabric", "lithium.jar", b"lithium").await;

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
                    "sodium-0.6.0.jar",
                    "bb"
                )
            ),
        )
        .await;

        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
            "1.20.1-fabric",
            vec![
                ledger_entry("sodium-0.5.3.jar", "AANobbMI", "old1", None),
                ledger_entry("lithium.jar", "gvQqBUqZ", "l1", None),
            ],
        )
        .await;

        let dirs = petalfall.resolved_dirs("1.20.1-fabric").await.unwrap();
        let scanned = scan_installed(&dirs).await.unwrap();
        assert_eq!(scanned.len(), 3);
        tokio::fs::remove_file(&unknown).await.unwrap();
        tokio::fs::remove_file(&known).await.unwrap();

        let found = petalfall
            .check_scanned(
                "1.20.1-fabric",
                &dirs,
                &scanned,
                vec![ModLoader::Fabric],
                "1.20.1".to_owned(),
                key_missing,
            )
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_name, "sodium-0.5.3.jar");
        assert_eq!(found[0].latest.version_id, "new2");
        // 只问还在的那个文件，没了的文件不进任何查询。
        let requests = server.received_requests().await.unwrap();
        let asked = requests
            .iter()
            .find(|r| r.url.path() == "/version_files")
            .unwrap();
        let asked: serde_json::Value = serde_json::from_slice(&asked.body).unwrap();
        assert_eq!(asked["hashes"], serde_json::json!([sha1]));
    }

    /// 读不出的文件不等于没了：占用、权限这类失败照常冒泡，否则这个 Mod 的更新会被悄悄漏报。
    #[tokio::test]
    async fn hash_failures_other_than_not_found_still_surface() {
        let tmp = tempfile::tempdir().unwrap();
        let err = hash_unless_gone(tmp.path()).await.unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::ModPlatform(petalfall_modplatform::Error::Base(_))
            ),
            "目录不是文件，读取失败要原样报出来，得到 {err:?}"
        );
        assert!(
            hash_unless_gone(&tmp.path().join("gone.jar"))
                .await
                .unwrap()
                .is_none()
        );
    }

    /// 一个实例里同时有 Modrinth 与 CurseForge 来源的 Mod：后者的卷宗条目是 JEI（238222，文件 100）。
    async fn mixed_platform_instance(mc: &Path, server: &MockServer) -> Petalfall {
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
        let petalfall = petalfall_at(mc, &server.uri());
        let mut jei = ledger_entry("jei-100.jar", "238222", "100", None);
        jei.platform = Platform::CurseForge;
        jei.title = Some("JEI".to_owned());
        save_ledger(
            &petalfall,
            "1.20.1-fabric",
            vec![
                ledger_entry("sodium-0.5.3.jar", "AANobbMI", "old1", Some(&sha1)),
                jei,
            ],
        )
        .await;
        petalfall
    }

    fn key_missing() -> Result<petalfall_modplatform::CurseForgeClient> {
        Err(CoreError::ModPlatform(
            petalfall_modplatform::Error::CurseForgeKeyMissing,
        ))
    }

    /// 当前构建没有 CurseForge API key：CurseForge 那部分跳过，Modrinth 查到的更新照常给出，
    /// 一个 CurseForge 请求都不发。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_without_curseforge_key_keeps_modrinth_results() {
        let tmp = tempfile::tempdir().unwrap();
        let server = MockServer::start().await;
        let petalfall = mixed_platform_instance(tmp.path(), &server).await;

        let found = petalfall
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

    /// 没有 key 时跳过的只是 CurseForge 来源：锁定了版本的 Modrinth Mod 同走版本列表，不能跟着一起丢掉。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_without_curseforge_key_keeps_pinned_modrinth_mods() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, sha1) = put_mod(mc, "1.20.1-fabric", "sodium.jar", b"sodium").await;
        put_mod(mc, "1.20.1-fabric", "jei-100.jar", b"jei-payload").await;

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/project/AANobbMI/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                "[{},{}]",
                modrinth_version(
                    "v2",
                    "AANobbMI",
                    "0.6",
                    "2026-06-01T00:00:00Z",
                    "sodium-0.6.jar",
                    "c2"
                ),
                modrinth_version(
                    "v1",
                    "AANobbMI",
                    "0.5",
                    "2026-01-01T00:00:00Z",
                    "sodium.jar",
                    &sha1
                )
            )))
            .mount(&server)
            .await;
        let petalfall = petalfall_at(mc, &server.uri());
        let mut jei = ledger_entry("jei-100.jar", "238222", "100", None);
        jei.platform = Platform::CurseForge;
        let pinned = LedgerEntry {
            update_hold: Some(UpdateHold::Pinned {
                version_id: "v2".to_owned(),
            }),
            ..ledger_entry("sodium.jar", "AANobbMI", "v1", Some(&sha1))
        };
        save_ledger(&petalfall, "1.20.1-fabric", vec![pinned, jei]).await;

        let found = petalfall
            .check_updates_with("1.20.1-fabric", key_missing)
            .await
            .unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_name, "sodium.jar");
        assert_eq!(found[0].current_version_id, "v1");
        assert_eq!(found[0].latest.version_id, "v2");
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
        let petalfall = mixed_platform_instance(tmp.path(), &server).await;

        let err = petalfall
            .check_updates_with("1.20.1-fabric", || {
                Err(CoreError::ModPlatform(
                    petalfall_modplatform::Error::Status {
                        url: "https://api.curseforge.com".to_owned(),
                        status: 500,
                    },
                ))
            })
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::ModPlatform(petalfall_modplatform::Error::Status { status: 500, .. })
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
        let petalfall = mixed_platform_instance(tmp.path(), &server)
            .await
            .with_curseforge_key("test-key");

        let found = petalfall.check_updates("1.20.1-fabric").await.unwrap();
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

    /// 走版本列表的工程在平台上没了（CurseForge 来源、锁定了版本的 Modrinth 来源）：这一项没有更新可报，
    /// 别的 Mod 查到的更新照常给出。一个下架的 Mod 不能让整个实例查不了更新。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delisted_project_only_drops_its_own_update() {
        let tmp = tempfile::tempdir().unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/project/gone/version"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;
        let petalfall = mixed_platform_instance(tmp.path(), &server)
            .await
            .with_curseforge_key("test-key");
        put_mod(tmp.path(), "1.20.1-fabric", "gone.jar", b"gone-payload").await;
        let store = petalfall.ledger_store("1.20.1-fabric");
        let mut ledger = store.load().await.unwrap();
        ledger.upsert(LedgerEntry {
            update_hold: Some(UpdateHold::Pinned {
                version_id: "v2".to_owned(),
            }),
            ..ledger_entry("gone.jar", "gone", "v1", Some("aa"))
        });
        store.save(&ledger).await.unwrap();

        let found = petalfall.check_updates("1.20.1-fabric").await.unwrap();

        let names: Vec<&str> = found.iter().map(|c| c.file_name.as_str()).collect();
        assert_eq!(names, vec!["sodium-0.5.3.jar"]);
        assert_eq!(found[0].latest.version_id, "new2");
    }

    /// 版本列表别的失败不是「工程没了」：照常冒泡，不能把查不到说成没有更新。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn listing_failure_other_than_404_still_fails_the_check() {
        let tmp = tempfile::tempdir().unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;
        let petalfall = mixed_platform_instance(tmp.path(), &server)
            .await
            .with_curseforge_key("test-key");

        let err = petalfall.check_updates("1.20.1-fabric").await.unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::ModPlatform(petalfall_modplatform::Error::Status { status: 403, .. })
            ),
            "实得 {err:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn check_updates_on_uninstalled_version_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path(), "http://127.0.0.1:1");
        let err = petalfall.check_updates("ghost").await.unwrap_err();
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

    fn channel_version(id: &str, date: &str, channel: ReleaseChannel) -> ModVersionInfo {
        ModVersionInfo {
            release_channel: channel,
            ..cf_version(id, date)
        }
    }

    fn picked<'a>(
        list: &'a [ModVersionInfo],
        current: &str,
        hold: Option<&UpdateHold>,
    ) -> Option<&'a str> {
        pick_update(list, current, hold).map(|v| v.version_id.as_str())
    }

    #[test]
    fn pick_update_requires_a_strictly_newer_publish_date() {
        let newest = cf_version("200", "2026-06-01T00:00:00Z");
        let current = cf_version("100", "2026-01-01T00:00:00Z");

        let list = vec![newest.clone(), current.clone()];
        assert_eq!(picked(&list, "100", None), Some("200"));
        // 已是最新。
        assert_eq!(picked(std::slice::from_ref(&current), "100", None), None);
        // 当前版本不在兼容列表里：拿不到它的发布时间，不猜。
        assert_eq!(picked(std::slice::from_ref(&newest), "100", None), None);
        // 同一时刻发布：不算更新。
        let same_time = cf_version("200", "2026-01-01T00:00:00Z");
        assert_eq!(picked(&[same_time, current.clone()], "100", None), None);
        // 最新版缺发布时间：无从证明是更新。
        let undated = cf_version("200", "");
        assert_eq!(picked(&[undated, current], "100", None), None);
        assert_eq!(picked(&[], "100", None), None);
        // 当前版本缺发布时间（CurseForge 的 fileDate 可缺）：什么都比空串大，放过去就可能是一次降级。
        let current_undated = cf_version("100", "");
        assert_eq!(picked(&[newest, current_undated], "100", None), None);
    }

    #[test]
    fn pick_update_respects_the_current_release_channel() {
        use ReleaseChannel::{Alpha, Beta, Release};
        // 当前是正式版、更新的只有测试版：不报。
        let list = vec![
            channel_version("beta2", "2026-06-01T00:00:00Z", Beta),
            channel_version("rel1", "2026-01-01T00:00:00Z", Release),
        ];
        assert_eq!(picked(&list, "rel1", None), None);

        // 当前是正式版：跳过更新的测试版，挑出比当前新的正式版。
        let list = vec![
            channel_version("beta3", "2026-08-01T00:00:00Z", Beta),
            channel_version("rel2", "2026-06-01T00:00:00Z", Release),
            channel_version("rel1", "2026-01-01T00:00:00Z", Release),
        ];
        assert_eq!(picked(&list, "rel1", None), Some("rel2"));

        // 当前是测试版：更新的测试版照报。
        let list = vec![
            channel_version("beta2", "2026-06-01T00:00:00Z", Beta),
            channel_version("beta1", "2026-01-01T00:00:00Z", Beta),
        ];
        assert_eq!(picked(&list, "beta1", None), Some("beta2"));
        // 当前是测试版：预览版不报。
        let list = vec![
            channel_version("alpha2", "2026-06-01T00:00:00Z", Alpha),
            channel_version("beta1", "2026-01-01T00:00:00Z", Beta),
        ];
        assert_eq!(picked(&list, "beta1", None), None);

        // 当前是预览版：三种通道都可以。
        for channel in [Release, Beta, Alpha] {
            let list = vec![
                channel_version("next", "2026-06-01T00:00:00Z", channel),
                channel_version("alpha1", "2026-01-01T00:00:00Z", Alpha),
            ];
            assert_eq!(picked(&list, "alpha1", None), Some("next"), "{channel:?}");
        }
    }

    #[test]
    fn pick_update_honours_ignore_and_pin() {
        let list = vec![
            cf_version("v3", "2026-09-01T00:00:00Z"),
            cf_version("v2", "2026-06-01T00:00:00Z"),
            cf_version("v1", "2026-01-01T00:00:00Z"),
        ];
        assert_eq!(picked(&list, "v1", None), Some("v3"));
        assert_eq!(picked(&list, "v1", Some(&UpdateHold::Ignored)), None);
        let pin = |v: &str| UpdateHold::Pinned {
            version_id: v.to_owned(),
        };
        // 锁定到 v2：列表里有 v3 也只报 v2。
        assert_eq!(picked(&list, "v1", Some(&pin("v2"))), Some("v2"));
        // 锁定到当前版本：不报。
        assert_eq!(picked(&list, "v1", Some(&pin("v1"))), None);
        // 锁定的版本不在列表里：没有上限可依，不报，也不当作没锁。
        assert_eq!(picked(&list, "v1", Some(&pin("ghost"))), None);
        // 锁定到 v3：上限放开到最新。
        assert_eq!(picked(&list, "v1", Some(&pin("v3"))), Some("v3"));
    }

    /// 忽略更新的 Mod 不出现在结果里，任何查询都不带它；实例里只剩它时一个请求都不发。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ignored_mod_is_skipped_without_requesting_its_update() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, sodium_sha1) = put_mod(mc, "1.20.1-fabric", "sodium.jar", b"sodium").await;
        let (_, lithium_sha1) = put_mod(mc, "1.20.1-fabric", "lithium.jar", b"lithium").await;

        let server = MockServer::start().await;
        mount_post(
            &server,
            "/version_files",
            format!(
                r#"{{"{lithium_sha1}":{}}}"#,
                modrinth_version(
                    "l1",
                    "gvQqBUqZ",
                    "0.1",
                    "2025-01-01T00:00:00Z",
                    "lithium.jar",
                    &lithium_sha1
                )
            ),
        )
        .await;
        // 服务端两个哈希都答：被忽略的那个即便出现在响应里也不能被报出。
        mount_post(
            &server,
            "/version_files/update",
            format!(
                r#"{{"{lithium_sha1}":{},"{sodium_sha1}":{}}}"#,
                modrinth_version(
                    "l2",
                    "gvQqBUqZ",
                    "0.2",
                    "2026-06-01T00:00:00Z",
                    "lithium-0.2.jar",
                    "cc"
                ),
                modrinth_version(
                    "s2",
                    "AANobbMI",
                    "0.6",
                    "2026-06-01T00:00:00Z",
                    "sodium-0.6.jar",
                    "dd"
                )
            ),
        )
        .await;

        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
            "1.20.1-fabric",
            vec![
                LedgerEntry {
                    update_hold: Some(UpdateHold::Ignored),
                    ..ledger_entry("sodium.jar", "AANobbMI", "s1", Some(&sodium_sha1))
                },
                ledger_entry("lithium.jar", "gvQqBUqZ", "l1", Some(&lithium_sha1)),
            ],
        )
        .await;

        let found = petalfall.check_updates("1.20.1-fabric").await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_name, "lithium.jar");
        assert_eq!(found[0].latest.version_id, "l2");

        let requests = server.received_requests().await.unwrap();
        assert_eq!(count_requests(&requests, "/version_files/update"), 1);
        for request in &requests {
            let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(
                body["hashes"],
                serde_json::json!([lithium_sha1.clone()]),
                "{} 不该带上被忽略的 Mod",
                request.url.path()
            );
        }

        // 只剩被忽略的那个：不发任何请求。
        tokio::fs::remove_file(mc.join("versions/1.20.1-fabric/mods/lithium.jar"))
            .await
            .unwrap();
        server.reset().await;
        assert!(
            petalfall
                .check_updates("1.20.1-fabric")
                .await
                .unwrap()
                .is_empty()
        );
        assert!(server.received_requests().await.unwrap().is_empty());
    }

    /// Modrinth 上锁定了版本的 Mod 走版本列表在本地挑：候选里有更新的 v3 也只报 v2，锁在当前版本就不报，
    /// 批量查更新不带它。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pinned_mod_never_goes_past_its_pinned_version() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, sha1) = put_mod(mc, "1.20.1-fabric", "sodium.jar", b"sodium").await;

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/project/AANobbMI/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                "[{},{},{}]",
                modrinth_version(
                    "v3",
                    "AANobbMI",
                    "0.7",
                    "2026-09-01T00:00:00Z",
                    "sodium-0.7.jar",
                    "c3"
                ),
                modrinth_version(
                    "v2",
                    "AANobbMI",
                    "0.6",
                    "2026-06-01T00:00:00Z",
                    "sodium-0.6.jar",
                    "c2"
                ),
                modrinth_version(
                    "v1",
                    "AANobbMI",
                    "0.5",
                    "2026-01-01T00:00:00Z",
                    "sodium.jar",
                    &sha1
                )
            )))
            .mount(&server)
            .await;

        let petalfall = petalfall_at(mc, &server.uri());
        let pinned = |v: &str| LedgerEntry {
            update_hold: Some(UpdateHold::Pinned {
                version_id: v.to_owned(),
            }),
            ..ledger_entry("sodium.jar", "AANobbMI", "v1", Some(&sha1))
        };
        save_ledger(&petalfall, "1.20.1-fabric", vec![pinned("v2")]).await;

        let found = petalfall.check_updates("1.20.1-fabric").await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].current_version_id, "v1");
        assert_eq!(found[0].latest.version_id, "v2");
        let requests = server.received_requests().await.unwrap();
        assert_eq!(count_requests(&requests, "/version_files/update"), 0);
        assert_eq!(count_requests(&requests, "/version_files"), 0);
        assert_eq!(count_requests(&requests, "/project/AANobbMI/version"), 1);

        save_ledger(&petalfall, "1.20.1-fabric", vec![pinned("v1")]).await;
        assert!(
            petalfall
                .check_updates("1.20.1-fabric")
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// 收到请求时先改写卷宗再答：模拟玩家在更新检查的网络往返期间点了「恢复检查更新」。
    struct RewriteLedgerThenRespond {
        ledger_path: PathBuf,
        ledger: Vec<u8>,
        body: String,
    }

    impl wiremock::Respond for RewriteLedgerThenRespond {
        fn respond(&self, _: &wiremock::Request) -> ResponseTemplate {
            std::fs::write(&self.ledger_path, &self.ledger).unwrap();
            ResponseTemplate::new(200).set_body_string(self.body.clone())
        }
    }

    /// 首轮读卷宗时设着更新检查的两个 Mod，在反查写回身份重读卷宗前被恢复了检查：没被问过当前版本，
    /// 这一轮走版本列表在本地挑。没记 SHA-1 的那个不会因此让整次检查崩掉；批量端点给回的旧构建也不会
    /// 因为缺了当前版本的发布时间而被当成更新报出。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn holds_lifted_mid_check_fall_back_to_the_version_list() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, iris_sha1) = put_mod(mc, "1.20.1-fabric", "iris.jar", b"iris").await;
        let (_, lithium_sha1) = put_mod(mc, "1.20.1-fabric", "lithium.jar", b"lithium").await;
        put_mod(mc, "1.20.1-fabric", "sodium.jar", b"sodium").await;

        let server = MockServer::start().await;
        let petalfall = petalfall_at(mc, &server.uri());
        let held = |entry: LedgerEntry, hold: UpdateHold| LedgerEntry {
            update_hold: Some(hold),
            ..entry
        };
        let sodium = ledger_entry("sodium.jar", "AANobbMI", "s1", None);
        let iris = ledger_entry("iris.jar", "YL57xq9U", "i1", Some(&iris_sha1));
        save_ledger(
            &petalfall,
            "1.20.1-fabric",
            vec![
                held(
                    sodium.clone(),
                    UpdateHold::Pinned {
                        version_id: "s1".to_owned(),
                    },
                ),
                held(iris.clone(), UpdateHold::Ignored),
            ],
        )
        .await;
        let mut lifted = Ledger::default();
        lifted.upsert(sodium);
        lifted.upsert(iris);

        Mock::given(method("POST"))
            .and(path("/version_files"))
            .respond_with(RewriteLedgerThenRespond {
                ledger_path: petalfall.ledger_store("1.20.1-fabric").path().to_path_buf(),
                ledger: serde_json::to_vec(&lifted).unwrap(),
                body: format!(
                    r#"{{"{lithium_sha1}":{}}}"#,
                    modrinth_version(
                        "l1",
                        "gvQqBUqZ",
                        "0.1",
                        "2025-01-01T00:00:00Z",
                        "lithium.jar",
                        &lithium_sha1
                    )
                ),
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .mount(&server)
            .await;
        // 批量端点给 iris 回一个比当前更旧的构建：走批量就会被当成「更新」。
        mount_post(
            &server,
            "/version_files/update",
            format!(
                r#"{{"{iris_sha1}":{}}}"#,
                modrinth_version(
                    "i0",
                    "YL57xq9U",
                    "1.6",
                    "2025-01-01T00:00:00Z",
                    "iris-1.6.jar",
                    "e0"
                )
            ),
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/project/AANobbMI/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                "[{},{}]",
                modrinth_version(
                    "s2",
                    "AANobbMI",
                    "0.6",
                    "2026-06-01T00:00:00Z",
                    "sodium-0.6.jar",
                    "c2"
                ),
                modrinth_version(
                    "s1",
                    "AANobbMI",
                    "0.5",
                    "2026-01-01T00:00:00Z",
                    "sodium.jar",
                    "c1"
                )
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/project/YL57xq9U/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                "[{},{}]",
                modrinth_version(
                    "i1",
                    "YL57xq9U",
                    "1.7",
                    "2026-06-01T00:00:00Z",
                    "iris.jar",
                    &iris_sha1
                ),
                modrinth_version(
                    "i0",
                    "YL57xq9U",
                    "1.6",
                    "2025-01-01T00:00:00Z",
                    "iris-1.6.jar",
                    "e0"
                )
            )))
            .mount(&server)
            .await;

        let found = petalfall.check_updates("1.20.1-fabric").await.unwrap();
        assert_eq!(
            found
                .iter()
                .map(|c| (c.file_name.as_str(), c.latest.version_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("sodium.jar", "s2")]
        );

        let requests = server.received_requests().await.unwrap();
        assert_eq!(count_requests(&requests, "/project/AANobbMI/version"), 1);
        assert_eq!(count_requests(&requests, "/project/YL57xq9U/version"), 1);
        let update: Vec<serde_json::Value> = requests
            .iter()
            .filter(|r| r.url.path() == "/version_files/update")
            .map(|r| serde_json::from_slice(&r.body).unwrap())
            .collect();
        assert_eq!(update.len(), 1);
        assert_eq!(update[0]["hashes"], serde_json::json!([lithium_sha1]));
        // 反查补上的身份照常写回，恢复检查的设置不被覆盖。
        let ledger = petalfall
            .ledger_store("1.20.1-fabric")
            .load()
            .await
            .unwrap();
        assert_eq!(ledger.find("lithium.jar").unwrap().version_id, "l1");
        assert_eq!(ledger.find("sodium.jar").unwrap().update_hold, None);
        assert_eq!(ledger.find("iris.jar").unwrap().update_hold, None);
    }

    /// 当前一个正式版、一个测试版：按通道分两组各请求一次，每组的 version_types 恰为它放行的通道。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modrinth_update_requests_are_grouped_by_current_channel() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, sodium_sha1) = put_mod(mc, "1.20.1-fabric", "sodium.jar", b"sodium").await;
        let (_, iris_sha1) = put_mod(mc, "1.20.1-fabric", "iris.jar", b"iris").await;

        let server = MockServer::start().await;
        mount_post(
            &server,
            "/version_files",
            format!(
                r#"{{"{sodium_sha1}":{},"{iris_sha1}":{}}}"#,
                modrinth_version_typed(
                    "s1",
                    "AANobbMI",
                    "0.5",
                    "2026-01-01T00:00:00Z",
                    "sodium.jar",
                    &sodium_sha1,
                    "release"
                ),
                modrinth_version_typed(
                    "i1",
                    "YL57xq9U",
                    "1.8-beta.1",
                    "2026-01-01T00:00:00Z",
                    "iris.jar",
                    &iris_sha1,
                    "beta"
                )
            ),
        )
        .await;
        Mock::given(method("POST"))
            .and(path("/version_files/update"))
            .and(body_partial_json(serde_json::json!({
                "hashes": [sodium_sha1.clone()],
                "version_types": ["release"]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"{sodium_sha1}":{}}}"#,
                modrinth_version(
                    "s2",
                    "AANobbMI",
                    "0.6",
                    "2026-06-01T00:00:00Z",
                    "sodium-0.6.jar",
                    "aa"
                )
            )))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/version_files/update"))
            .and(body_partial_json(serde_json::json!({
                "hashes": [iris_sha1.clone()],
                "version_types": ["release", "beta"]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"{iris_sha1}":{}}}"#,
                modrinth_version_typed(
                    "i2",
                    "YL57xq9U",
                    "1.9-beta.1",
                    "2026-06-01T00:00:00Z",
                    "iris-1.9.jar",
                    "bb",
                    "beta"
                )
            )))
            .expect(1)
            .mount(&server)
            .await;

        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
            "1.20.1-fabric",
            vec![
                ledger_entry("sodium.jar", "AANobbMI", "s1", Some(&sodium_sha1)),
                ledger_entry("iris.jar", "YL57xq9U", "i1", Some(&iris_sha1)),
            ],
        )
        .await;

        let found = petalfall.check_updates("1.20.1-fabric").await.unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].file_name, "iris.jar");
        assert_eq!(found[0].latest.version_id, "i2");
        assert_eq!(found[0].latest.release_channel, ReleaseChannel::Beta);
        assert_eq!(found[1].file_name, "sodium.jar");
        assert_eq!(found[1].latest.version_id, "s2");

        let requests = server.received_requests().await.unwrap();
        assert_eq!(count_requests(&requests, "/version_files/update"), 2);
        assert_eq!(requests.len(), 3);
        // 先正式版组、后测试版组，各自的通道列表一字不差。
        let sent: Vec<serde_json::Value> = requests
            .iter()
            .filter(|r| r.url.path() == "/version_files/update")
            .map(|r| {
                serde_json::from_slice::<serde_json::Value>(&r.body).unwrap()["version_types"]
                    .clone()
            })
            .collect();
        assert_eq!(
            sent,
            vec![
                serde_json::json!(["release"]),
                serde_json::json!(["release", "beta"])
            ]
        );
    }

    /// 服务端没理会通道过滤、给正式版玩家回了一个测试版：本地再校一遍，不报。当前版本平台不认识时
    /// 按正式版处理。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn beta_returned_for_a_release_install_is_dropped_locally() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;
        let (_, sha1) = put_mod(mc, "1.20.1-fabric", "sodium.jar", b"sodium").await;

        let server = MockServer::start().await;
        // 当前版本平台查不到：通道无从得知，按正式版处理。
        mount_post(&server, "/version_files", "{}".to_owned()).await;
        Mock::given(method("POST"))
            .and(path("/version_files/update"))
            .and(body_partial_json(
                serde_json::json!({ "version_types": ["release"] }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"{sha1}":{}}}"#,
                modrinth_version_typed(
                    "beta2",
                    "AANobbMI",
                    "0.7-beta",
                    "2026-06-01T00:00:00Z",
                    "sodium-beta.jar",
                    "bb",
                    "beta"
                )
            )))
            .expect(1)
            .mount(&server)
            .await;

        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
            "1.20.1-fabric",
            vec![ledger_entry("sodium.jar", "AANobbMI", "s1", Some(&sha1))],
        )
        .await;
        assert!(
            petalfall
                .check_updates("1.20.1-fabric")
                .await
                .unwrap()
                .is_empty()
        );
    }

    fn io_refusal(err: &CoreError) -> (std::io::ErrorKind, String) {
        match err {
            CoreError::Base(petalfall_base::Error::Io { source, .. }) => {
                (source.kind(), source.to_string())
            }
            other => panic!("期望 IO 拒绝，得到 {other:?}"),
        }
    }

    /// Modrinth 来源：取该版本的 Markdown 日志；禁用态文件名也认；空白日志为 None；别家工程的版本与
    /// 不存在的版本都报版本找不到。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn modrinth_changelog_is_markdown_and_must_belong_to_the_project() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;

        let server = MockServer::start().await;
        let mount_version =
            |id: &'static str, project: &'static str, changelog: serde_json::Value| {
                Mock::given(method("GET"))
                    .and(path(format!("/version/{id}")))
                    .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                        "id": id,
                        "project_id": project,
                        "changelog": changelog
                    })))
                    .expect(1)
            };
        mount_version(
            "new2",
            "AANobbMI",
            serde_json::json!("## 0.6.0\n- 修复渲染错误\n- 提升帧率"),
        )
        .mount(&server)
        .await;
        mount_version("blank", "AANobbMI", serde_json::json!("  \n\t "))
            .mount(&server)
            .await;
        mount_version("null", "AANobbMI", serde_json::Value::Null)
            .mount(&server)
            .await;
        mount_version("other", "P7dR8mSH", serde_json::json!("别家的日志"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/version/ghost"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;

        let petalfall = petalfall_at(mc, &server.uri());
        save_ledger(
            &petalfall,
            "1.20.1-fabric",
            vec![ledger_entry("sodium.jar", "AANobbMI", "old1", None)],
        )
        .await;

        let got = petalfall
            .mod_update_changelog("1.20.1-fabric", "sodium.jar.disabled", "new2")
            .await
            .unwrap();
        assert_eq!(
            got,
            ModChangelog {
                version_id: "new2".to_owned(),
                format: BodyFormat::Markdown,
                body: Some("## 0.6.0\n- 修复渲染错误\n- 提升帧率".to_owned()),
            }
        );
        for empty in ["blank", "null"] {
            let got = petalfall
                .mod_update_changelog("1.20.1-fabric", "sodium.jar", empty)
                .await
                .unwrap();
            assert_eq!(got.body, None, "{empty}");
            assert_eq!(got.format, BodyFormat::Markdown);
        }
        for wrong in ["other", "ghost"] {
            let err = petalfall
                .mod_update_changelog("1.20.1-fabric", "sodium.jar", wrong)
                .await
                .unwrap_err();
            match err {
                CoreError::ModVersionNotFound {
                    platform,
                    project_id,
                    version_id,
                } => {
                    assert_eq!(platform, Platform::Modrinth.display_name());
                    assert_eq!(project_id, "AANobbMI");
                    assert_eq!(version_id, wrong);
                }
                other => panic!("期望版本找不到，得到 {other:?}"),
            }
        }
        assert_eq!(server.received_requests().await.unwrap().len(), 5);
    }

    /// CurseForge 来源：请求 /v1/mods/{modId}/files/{fileId}/changelog 取 HTML；非数字的版本标识不触网
    /// 直接报版本找不到；卷宗里没有来源的文件以 IO 拒绝。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_changelog_is_html_and_unknown_files_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.20.1-fabric", FABRIC_JSON).await;

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/238222/files/5001/changelog"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": "<p>JEI 15.3</p><ul><li>修复配方查找</li></ul>"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let petalfall = petalfall_at(mc, &server.uri()).with_curseforge_key("test-key");
        save_ledger(
            &petalfall,
            "1.20.1-fabric",
            vec![LedgerEntry {
                platform: Platform::CurseForge,
                ..ledger_entry("jei.jar", "238222", "4000", None)
            }],
        )
        .await;

        let got = petalfall
            .mod_update_changelog("1.20.1-fabric", "jei.jar", "5001")
            .await
            .unwrap();
        assert_eq!(got.version_id, "5001");
        assert_eq!(got.format, BodyFormat::Html);
        assert_eq!(
            got.body.as_deref(),
            Some("<p>JEI 15.3</p><ul><li>修复配方查找</li></ul>")
        );

        let err = petalfall
            .mod_update_changelog("1.20.1-fabric", "jei.jar", "not-a-number")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::ModVersionNotFound { project_id, version_id, .. }
                if project_id == "238222" && version_id == "not-a-number"),
            "{err:?}"
        );

        let err = petalfall
            .mod_update_changelog("1.20.1-fabric", "manual.jar", "5001")
            .await
            .unwrap_err();
        let (kind, reason) = io_refusal(&err);
        assert_eq!(kind, std::io::ErrorKind::NotFound);
        assert!(reason.contains("manual.jar 没有平台来源记录"), "{reason}");

        let err = petalfall
            .mod_update_changelog("1.20.1-fabric", "config.toml", "5001")
            .await
            .unwrap_err();
        assert_eq!(io_refusal(&err).0, std::io::ErrorKind::InvalidInput);

        // 只有第一次真的请求了平台。
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
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
