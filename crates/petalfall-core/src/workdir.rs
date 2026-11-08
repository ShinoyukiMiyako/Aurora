//! 实例工作目录的唯一解析入口。
//!
//! 「启动读哪个目录」「装 Mod 写哪个目录」「扫描 mods 看哪个目录」必须是同一个答案。版本级隔离覆盖
//! 只在这里读取：若各处自己算，覆盖只在一侧生效就会让两个目录分叉，玩家遇到的是「装了却不生效」
//! ——一种没有任何报错、全靠自己发现的静默失效。

use std::path::{Path, PathBuf};

use petalfall_instance::{
    DiscoveredVersion, IsolationOverride, ResolvedIsolation, VERSIONS_DIR, VersionSettings,
    VersionSettingsStore,
};
use petalfall_launch::resolve_game_directory;
use petalfall_version::{VersionJson, detect_loaders};

use crate::error::Result;
use crate::facade::Petalfall;

impl Petalfall {
    /// 版本目录 `versions/<id>`（不检查是否存在）。
    pub fn version_dir(&self, version_id: &str) -> PathBuf {
        self.game_dir().join(VERSIONS_DIR).join(version_id)
    }

    /// 读取版本级设置：缺文件即全默认，文件损坏则冒泡——悄悄重置会丢掉用户的设置，比报错更糟。
    pub async fn version_settings(&self, version_id: &str) -> Result<VersionSettings> {
        Ok(
            VersionSettingsStore::for_version_dir(&self.version_dir(version_id))
                .load()
                .await?,
        )
    }

    /// 解析某实例的运行工作目录：只读这一个实例的 JSON 与设置，不扫整个 `versions/`。
    ///
    /// 启动、Mod 管理、实例内容与打开文件夹都走这里。id 不安全报 `InvalidId`，目录不在报
    /// [`CoreError::VersionNotInstalled`]，目录在而版本 JSON 缺失或损坏报 `Broken`。
    pub async fn resolve_working_dir(&self, version_id: &str) -> Result<ResolvedIsolation> {
        let target = self.instance_version(version_id).await?;
        let settings = self.version_settings(version_id).await?;
        self.resolve_working_dir_from(
            version_id,
            settings.isolation,
            target.has_mod_loader(),
            target.is_release(),
        )
        .await
    }

    /// 解析某版本的运行工作目录，版本事实（是否装加载器、是否正式版）由调用方提供。
    ///
    /// 这是本 crate 唯一调用 [`resolve_game_directory`] 的地方；需要知道某版本工作目录的功能都走这里。
    pub(crate) async fn resolve_working_dir_from(
        &self,
        version_id: &str,
        over: IsolationOverride,
        has_mod_loader: bool,
        is_release: bool,
    ) -> Result<ResolvedIsolation> {
        Ok(resolve_game_directory(
            self.game_dir(),
            version_id,
            self.config().isolation_policy,
            over,
            has_mod_loader,
            is_release,
        )
        .await?)
    }
}

/// `versions_dir/<id>/<id>.json` 的路径。
pub(crate) fn version_json_path(versions_dir: &Path, id: &str) -> PathBuf {
    versions_dir.join(id).join(format!("{id}.json"))
}

/// 读一个版本 JSON：文件不存在为 `None`。按字节直接解析，非法 UTF-8 与非法 JSON 同样报解析错误，
/// 与版本列表把它标为损坏的判据一致。
pub(crate) async fn read_version_json(
    versions_dir: &Path,
    id: &str,
) -> Result<Option<VersionJson>> {
    let path = version_json_path(versions_dir, id);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(petalfall_base::Error::Io { path, source }.into()),
    };
    let json = serde_json::from_slice(&bytes).map_err(|source| petalfall_version::Error::Json {
        context: "版本 JSON",
        source,
    })?;
    Ok(Some(json))
}

/// 由已读到的版本 JSON 拼出与版本扫描结果同构的版本事实，隔离判定与扫描得出的答案一致。
pub(crate) fn discovered(versions_dir: &Path, id: &str, json: VersionJson) -> DiscoveredVersion {
    let dir = versions_dir.join(id);
    DiscoveredVersion {
        id: id.to_owned(),
        json_path: version_json_path(versions_dir, id),
        jar_path: dir.join(format!("{id}.jar")),
        dir,
        loaders: detect_loaders(&json),
        json,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PetalfallConfig;
    use crate::error::CoreError;
    use petalfall_instance::IsolationPolicy;

    #[tokio::test]
    async fn version_override_beats_global_policy() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().join(".minecraft");
        std::fs::create_dir_all(mc.join("versions").join("1.21")).unwrap();
        let mut petalfall = Petalfall::for_test(
            PetalfallConfig::default(),
            tmp.path().to_path_buf(),
            mc.clone(),
        );
        petalfall.set_isolation_policy(IsolationPolicy::Disabled);

        let shared = petalfall
            .resolve_working_dir_from("1.21", IsolationOverride::FollowGlobal, false, true)
            .await
            .unwrap();
        assert_eq!(shared.working_dir, mc);
        assert!(!shared.isolated);

        let isolated = petalfall
            .resolve_working_dir_from("1.21", IsolationOverride::Enabled, false, true)
            .await
            .unwrap();
        assert_eq!(isolated.working_dir, mc.join("versions").join("1.21"));
        assert!(isolated.isolated);
    }

    fn put_version(mc: &Path, id: &str, json: &str) {
        let dir = mc.join("versions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.json")), json).unwrap();
    }

    #[tokio::test]
    async fn resolve_working_dir_reads_facts_and_override_from_one_version() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().join(".minecraft");
        put_version(
            &mc,
            "1.21",
            r#"{"id":"1.21","type":"release","mainClass":"m"}"#,
        );
        put_version(
            &mc,
            "fabric-1.21",
            r#"{"id":"fabric-1.21","inheritsFrom":"1.21","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.0"}]}"#,
        );
        put_version(
            &mc,
            "24w14a",
            r#"{"id":"24w14a","type":"snapshot","mainClass":"m"}"#,
        );
        let petalfall = Petalfall::for_test(
            PetalfallConfig::default(),
            tmp.path().to_path_buf(),
            mc.clone(),
        );

        // 默认档位隔离加载器版本与非正式版，原版正式版共用根目录。
        assert_eq!(
            petalfall
                .resolve_working_dir("1.21")
                .await
                .unwrap()
                .working_dir,
            mc
        );
        assert_eq!(
            petalfall
                .resolve_working_dir("fabric-1.21")
                .await
                .unwrap()
                .working_dir,
            mc.join("versions").join("fabric-1.21")
        );
        assert_eq!(
            petalfall
                .resolve_working_dir("24w14a")
                .await
                .unwrap()
                .working_dir,
            mc.join("versions").join("24w14a")
        );

        // 版本级覆盖压过全局档位。
        let meta = mc
            .join("versions")
            .join("1.21")
            .join(petalfall_instance::PETALFALL_META_DIR);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(meta.join("settings.json"), r#"{"isolation":"enabled"}"#).unwrap();
        assert_eq!(
            petalfall
                .resolve_working_dir("1.21")
                .await
                .unwrap()
                .working_dir,
            mc.join("versions").join("1.21")
        );
    }

    #[tokio::test]
    async fn resolve_working_dir_reports_missing_and_broken_versions() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().join(".minecraft");
        put_version(&mc, "broken", "{ not json");
        let petalfall =
            Petalfall::for_test(PetalfallConfig::default(), tmp.path().to_path_buf(), mc);
        assert!(matches!(
            petalfall.resolve_working_dir("ghost").await.unwrap_err(),
            CoreError::VersionNotInstalled { id } if id == "ghost"
        ));
        assert!(matches!(
            petalfall.resolve_working_dir("broken").await.unwrap_err(),
            CoreError::Instance(crate::InstanceError::Broken { id, .. }) if id == "broken"
        ));
    }

    #[tokio::test]
    async fn corrupt_settings_file_is_an_error_not_a_reset() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().join(".minecraft");
        let meta = mc
            .join("versions")
            .join("1.21")
            .join(petalfall_instance::PETALFALL_META_DIR);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(meta.join("settings.json"), "{ broken").unwrap();
        let petalfall =
            Petalfall::for_test(PetalfallConfig::default(), tmp.path().to_path_buf(), mc);
        assert!(petalfall.version_settings("1.21").await.is_err());
    }
}
