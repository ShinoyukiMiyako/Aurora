//! 模组安装到实例 + 本地模组管理。
//!
//! 门面把 aurora-modplatform 的双平台客户端（Modrinth / CurseForge）与本地 `mods/` 目录管理串起来：
//! 按平台取到目标版本的主文件，落到「该实例的 mods 目录」，再复用 aurora-modplatform 的本地扫描与
//! 启禁切换。实例的 mods 目录不是固定的 `.minecraft/mods`——它随版本隔离策略走：隔离版本落到
//! `versions/<id>/mods`，共享版本落到 `.minecraft/mods`，与启动时 [`Aurora::launch_account`] 计算工作
//! 目录的规则完全一致（同一份 [`aurora_launch::resolve_game_directory`]），避免「装进去的 mod 启动时
//! 不生效」。

use std::path::PathBuf;

use aurora_download::DownloadTask;
use aurora_instance::{IsolationOverride, discover_versions};
use aurora_launch::resolve_game_directory;
use aurora_modplatform::{
    CurseForgeClient, InstalledMod, ModrinthClient, Platform, disable_mod, enable_mod,
    scan_mods_dir,
};

use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Aurora;

/// 一次模组安装的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModInstallOutcome {
    /// 落盘的模组文件名。
    pub file_name: String,
    /// 模组文件完整路径。
    pub path: PathBuf,
    /// 来源平台。
    pub platform: Platform,
}

impl Aurora {
    /// 把某平台上的一个模组版本安装到指定实例的 mods 目录。
    ///
    /// `project_id` / `mod_version_id` 的语义随平台而定：Modrinth 为工程 id/slug 与版本 id；CurseForge
    /// 为数字 modId 与 fileId（以十进制字符串传入）。取到主文件后经批量下载池落盘（带 sha1/大小完整性
    /// 契约，不符即重下换源）。下载失败会冒泡为 [`CoreError::Download`]，不静默。
    pub async fn install_mod(
        &self,
        version_id: &str,
        platform: Platform,
        project_id: &str,
        mod_version_id: &str,
        events: Option<&EventSink>,
    ) -> Result<ModInstallOutcome> {
        // 先定位实例 mods 目录：这一步会校验版本确已安装，未装则短路，不打无谓的网络请求。
        let mods_dir = self.resolve_mods_dir(version_id).await?;
        emit(
            events,
            CoreEvent::stage(format!("准备从 {} 安装模组到 {version_id}", platform.display_name())),
        );

        let (file_name, task) = match platform {
            Platform::Modrinth => {
                self.modrinth_task(project_id, mod_version_id, &mods_dir).await?
            }
            Platform::CurseForge => {
                self.curseforge_task(project_id, mod_version_id, &mods_dir).await?
            }
        };
        let dest = task.dest.clone();
        emit(events, CoreEvent::stage(format!("开始下载模组 {file_name}")));

        let report = self
            .download_pool_reporting(events)
            .download_all(vec![task], None)
            .await?;
        // 单文件批量：有失败即冒泡其最终错误（重试换源后仍失败），绝不当作成功。
        if let Some(failure) = report.failures.into_iter().next() {
            return Err(failure.error.into());
        }

        emit(
            events,
            CoreEvent::stage(format!("模组 {file_name} 已安装到 {}", dest.display())),
        );
        Ok(ModInstallOutcome {
            file_name,
            path: dest,
            platform,
        })
    }

    /// 扫描指定实例的 mods 目录，列出已装模组（含禁用态）。
    ///
    /// 目录尚不存在（该版本从未装过模组）返回空列表——这是「零已装模组」的正常态，而非错误；真实
    /// IO 故障（如权限不足）仍向上冒泡。
    pub async fn list_mods(&self, version_id: &str) -> Result<Vec<InstalledMod>> {
        let mods_dir = self.resolve_mods_dir(version_id).await?;
        let exists = tokio::fs::try_exists(&mods_dir)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: mods_dir.clone(),
                source,
            })?;
        if !exists {
            return Ok(Vec::new());
        }
        Ok(scan_mods_dir(&mods_dir).await?)
    }

    /// 启用或禁用指定实例里的某个模组，返回切换后的新路径。
    ///
    /// `file_name` 应为 [`Aurora::list_mods`] 返回的磁盘文件名（禁用态带 `.disabled` 后缀）。启禁以
    /// 文件重命名实现；目标名已存在（同名启用/禁用副本冲突）会冒泡 [`aurora_modplatform`] 的冲突错误。
    pub async fn set_mod_enabled(
        &self,
        version_id: &str,
        file_name: &str,
        enabled: bool,
    ) -> Result<PathBuf> {
        let mods_dir = self.resolve_mods_dir(version_id).await?;
        let path = mods_dir.join(file_name);
        let switched = if enabled {
            enable_mod(&path).await?
        } else {
            disable_mod(&path).await?
        };
        Ok(switched)
    }

    /// 解析某已安装版本对应的实例 mods 目录（`<工作目录>/mods`）。
    ///
    /// 工作目录由版本隔离判定决定，与启动链路 [`aurora_launch::resolve_game_directory`] 同源：先发现
    /// 版本拿到「是否装加载器 / 是否正式版」两项事实，再按全局隔离档位（版本级取跟随全局）算出隔离与
    /// 否。版本本地未安装返回 [`CoreError::VersionNotInstalled`]。
    async fn resolve_mods_dir(&self, version_id: &str) -> Result<PathBuf> {
        let scan = discover_versions(self.game_dir()).await?;
        let target = scan
            .versions
            .iter()
            .find(|v| v.id == version_id)
            .ok_or_else(|| CoreError::VersionNotInstalled {
                id: version_id.to_owned(),
            })?;
        let resolved = resolve_game_directory(
            self.game_dir(),
            version_id,
            self.config().isolation_policy,
            IsolationOverride::FollowGlobal,
            target.has_mod_loader(),
            target.is_release(),
        )
        .await?;
        Ok(resolved.working_dir.join("mods"))
    }

    /// Modrinth：列出工程版本，取 `mod_version_id` 对应版本的主文件，生成下载任务。
    async fn modrinth_task(
        &self,
        project_id: &str,
        mod_version_id: &str,
        mods_dir: &std::path::Path,
    ) -> Result<(String, DownloadTask)> {
        let client = ModrinthClient::new(self.http()).with_base_url(self.modrinth_base());
        // Modrinth 无「按版本 id 单取」端点，故列出工程全部版本后按 id 精确匹配。
        let version = client
            .versions(project_id, &[], &[])
            .await?
            .into_iter()
            .find(|v| v.id == mod_version_id)
            .ok_or_else(|| CoreError::ModVersionNotFound {
                platform: Platform::Modrinth.display_name(),
                project_id: project_id.to_owned(),
                version_id: mod_version_id.to_owned(),
            })?;
        let file = version
            .primary_file()
            .ok_or_else(|| CoreError::ModVersionNotFound {
                platform: Platform::Modrinth.display_name(),
                project_id: project_id.to_owned(),
                version_id: mod_version_id.to_owned(),
            })?;
        let dest = mods_dir.join(&file.filename);
        Ok((file.filename.clone(), file.to_download_task(dest)))
    }

    /// CurseForge：列出工程文件，取 `file_id` 对应文件，生成下载任务（downloadUrl 为空时走直链兜底）。
    async fn curseforge_task(
        &self,
        project_id: &str,
        mod_version_id: &str,
        mods_dir: &std::path::Path,
    ) -> Result<(String, DownloadTask)> {
        // CurseForge 的 id 是数字；非数字串不可能对应任何文件，直接判为未找到。
        let not_found = || CoreError::ModVersionNotFound {
            platform: Platform::CurseForge.display_name(),
            project_id: project_id.to_owned(),
            version_id: mod_version_id.to_owned(),
        };
        let mod_id: u32 = project_id.parse().map_err(|_| not_found())?;
        let file_id: u32 = mod_version_id.parse().map_err(|_| not_found())?;

        let client = CurseForgeClient::from_env(self.http())?.with_base_url(self.curseforge_base());
        let file = client
            .mod_files(mod_id, None, None)
            .await?
            .into_iter()
            .find(|f| f.id == file_id)
            .ok_or_else(not_found)?;
        let dest = mods_dir.join(&file.file_name);

        // 文件对象自带 downloadUrl 时直接用；为空则走 download-url 端点取直链兜底，并补上完整性契约。
        let task = match file.to_download_task(&dest) {
            Some(task) => task,
            None => {
                let url = client.file_download_url(mod_id, file_id).await?;
                let mut task = DownloadTask::new(url, &dest);
                if let Some(size) = file.file_length {
                    task = task.with_size(size);
                }
                if let Some(sha1) = file.sha1() {
                    task = task.with_sha1(sha1.to_string());
                }
                task
            }
        };
        Ok((file.file_name.clone(), task))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use aurora_instance::IsolationPolicy;
    use sha1::{Digest, Sha1};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 在 versions/<id>/<id>.json 落一份最小合法版本 JSON（正式原版，不装加载器）。
    async fn put_version(mc: &std::path::Path, id: &str) {
        let dir = mc.join("versions").join(id);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join(format!("{id}.json")),
            format!(r#"{{"id":"{id}","type":"release","mainClass":"m"}}"#),
        )
        .await
        .unwrap();
    }

    fn sha1_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha1::new();
        hasher.update(bytes);
        hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// 全隔离档位下装 Modrinth 模组：文件落到 versions/<id>/mods（实例隔离目录），随后能扫出、可启禁。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_modrinth_mod_lands_in_isolated_mods_dir_then_lists_and_toggles() {
        let server = MockServer::start().await;
        let base = server.uri();
        let jar_bytes = b"sodium-jar-payload".to_vec();
        let sha1 = sha1_hex(&jar_bytes);

        // 工程版本列表：含目标版本 modver1，主文件 sodium.jar 走 mock 直链，带 sha1/大小契约。
        let versions_body = format!(
            r#"[{{"id":"modver1","project_id":"sodium","name":"Sodium 0.5",
                "version_number":"0.5","version_type":"release",
                "date_published":"2026-01-01T00:00:00Z",
                "files":[{{"hashes":{{"sha1":"{sha1}"}},"url":"{base}/sodium.jar",
                    "filename":"sodium.jar","primary":true,"size":{}}}]}}]"#,
            jar_bytes.len()
        );
        Mock::given(method("GET"))
            .and(path("/project/sodium/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string(versions_body))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/sodium.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(jar_bytes.clone()))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        put_version(&mc, "1.21").await;

        let mut aurora = Aurora::for_test(AuroraConfig::default(), mc.clone(), mc.clone());
        aurora.set_isolation_policy(IsolationPolicy::All);
        let aurora = aurora.with_modrinth_base(base);

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let outcome = aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "modver1", Some(&tx))
            .await
            .unwrap();

        // 隔离档位 All -> 工作目录进版本文件夹 -> mods 落 versions/1.21/mods。
        let expected = mc.join("versions").join("1.21").join("mods").join("sodium.jar");
        assert_eq!(outcome.file_name, "sodium.jar");
        assert_eq!(outcome.path, expected);
        assert_eq!(outcome.platform, Platform::Modrinth);
        // 文件确已落盘且内容一致。
        assert_eq!(tokio::fs::read(&expected).await.unwrap(), jar_bytes);

        // list_mods 能扫出这枚模组，且为启用态。
        let listed = aurora.list_mods("1.21").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].file_name, "sodium.jar");
        assert!(listed[0].enabled);

        // 禁用：文件重命名为 .disabled 后缀，原文件消失。
        let disabled = aurora.set_mod_enabled("1.21", "sodium.jar", false).await.unwrap();
        assert_eq!(disabled.file_name().unwrap(), "sodium.jar.disabled");
        assert!(!tokio::fs::try_exists(&expected).await.unwrap());
        assert!(tokio::fs::try_exists(&disabled).await.unwrap());
        let listed = aurora.list_mods("1.21").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].file_name, "sodium.jar.disabled");
        assert!(!listed[0].enabled);

        // 重新启用：回到原文件名。
        let enabled = aurora
            .set_mod_enabled("1.21", "sodium.jar.disabled", true)
            .await
            .unwrap();
        assert_eq!(enabled, expected);
        assert!(tokio::fs::try_exists(&expected).await.unwrap());

        // 至少发出「已安装」阶段事件。
        drop(tx);
        let mut stages = Vec::new();
        while let Some(ev) = rx.recv().await {
            if let CoreEvent::Stage(s) = ev {
                stages.push(s);
            }
        }
        assert!(stages.iter().any(|s| s.contains("模组 sodium.jar 已安装")));
    }

    /// 共享档位（关闭隔离）下装模组：文件落到 .minecraft/mods 根，验证 mods 目录随隔离策略切换。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_lands_in_shared_root_mods_when_isolation_disabled() {
        let server = MockServer::start().await;
        let base = server.uri();
        let jar_bytes = b"lithium-jar".to_vec();
        let sha1 = sha1_hex(&jar_bytes);
        let versions_body = format!(
            r#"[{{"id":"v1","project_id":"lithium","name":"Lithium","version_number":"0.11",
                "version_type":"release","date_published":"2026-01-01T00:00:00Z",
                "files":[{{"hashes":{{"sha1":"{sha1}"}},"url":"{base}/lithium.jar",
                    "filename":"lithium.jar","primary":true,"size":{}}}]}}]"#,
            jar_bytes.len()
        );
        Mock::given(method("GET"))
            .and(path("/project/lithium/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string(versions_body))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/lithium.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(jar_bytes.clone()))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        put_version(&mc, "1.21").await;

        // 关闭隔离：正式原版共享 .minecraft 根 -> mods 落 .minecraft/mods。
        let mut aurora = Aurora::for_test(AuroraConfig::default(), mc.clone(), mc.clone());
        aurora.set_isolation_policy(IsolationPolicy::Disabled);
        let aurora = aurora.with_modrinth_base(base);

        let outcome = aurora
            .install_mod("1.21", Platform::Modrinth, "lithium", "v1", None)
            .await
            .unwrap();
        assert_eq!(outcome.path, mc.join("mods").join("lithium.jar"));
        assert_eq!(tokio::fs::read(&outcome.path).await.unwrap(), jar_bytes);
    }

    /// 未安装的版本：install_mod 在触网前就冒泡 VersionNotInstalled。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_into_uninstalled_version_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        let aurora = Aurora::for_test(AuroraConfig::default(), mc.clone(), mc);

        let err = aurora
            .install_mod("ghost", Platform::Modrinth, "sodium", "modver1", None)
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::VersionNotInstalled { id } if id == "ghost"));
    }

    /// 平台上找不到请求的版本 id：冒泡 ModVersionNotFound。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_missing_platform_version_errors() {
        let server = MockServer::start().await;
        // 工程存在但版本列表里没有请求的 id。
        Mock::given(method("GET"))
            .and(path("/project/sodium/version"))
            .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        put_version(&mc, "1.21").await;
        let aurora = Aurora::for_test(AuroraConfig::default(), mc.clone(), mc)
            .with_modrinth_base(server.uri());

        let err = aurora
            .install_mod("1.21", Platform::Modrinth, "sodium", "does-not-exist", None)
            .await
            .unwrap_err();
        match err {
            CoreError::ModVersionNotFound {
                project_id,
                version_id,
                ..
            } => {
                assert_eq!(project_id, "sodium");
                assert_eq!(version_id, "does-not-exist");
            }
            other => panic!("期望 ModVersionNotFound，得到 {other:?}"),
        }
    }

    /// 从未装过模组的版本：list_mods 返回空列表而非报错。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_mods_on_version_without_mods_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().to_path_buf();
        put_version(&mc, "1.21").await;
        let aurora = Aurora::for_test(AuroraConfig::default(), mc.clone(), mc);

        let listed = aurora.list_mods("1.21").await.unwrap();
        assert!(listed.is_empty());
    }
}
