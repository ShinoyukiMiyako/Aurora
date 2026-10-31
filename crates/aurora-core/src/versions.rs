//! 版本清单抓取与本地已安装版本发现。

use aurora_install::VanillaInstaller;
use aurora_instance::{VersionScan, discover_versions};
use aurora_version::VersionManifest;

use crate::error::Result;
use crate::facade::{Aurora, make_context};

impl Aurora {
    /// 抓取远端版本清单（version_manifest_v2）。地址已按「版本列表源」策略选官方或镜像。
    pub async fn list_manifest(&self) -> Result<VersionManifest> {
        let layout = self.layout();
        let pool = self.download_pool();
        let policy = self.retry_policy();
        let http = self.http();
        let cx = make_context(&http, &pool, &layout, self.runtime(), &policy);
        let manifest = VanillaInstaller::new(cx)
            .with_manifest_url(self.manifest_url())
            .fetch_manifest()
            .await?;
        Ok(manifest)
    }

    /// 扫描当前游戏目录下已安装的版本（含出错版本单列）。
    pub async fn list_installed(&self) -> Result<VersionScan> {
        let scan = discover_versions(self.game_dir()).await?;
        Ok(scan)
    }
}

#[cfg(test)]
mod tests {
    use crate::config::AuroraConfig;
    use crate::facade::Aurora;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn aurora_for(server: &MockServer, game_dir: std::path::PathBuf) -> Aurora {
        Aurora::for_test(AuroraConfig::default(), game_dir.clone(), game_dir)
            .with_manifest_url(format!("{}/manifest.json", server.uri()))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_manifest_parses_remote_versions() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{
                    "latest": {"release":"1.21","snapshot":"24w21b"},
                    "versions": [
                        {"id":"1.21","type":"release","url":"https://piston-meta.mojang.com/v/1.21.json",
                         "time":"2024-06-13T08:24:03+00:00","releaseTime":"2024-06-13T08:24:03+00:00",
                         "sha1":"abc"},
                        {"id":"24w21b","type":"snapshot","url":"https://piston-meta.mojang.com/v/24w21b.json",
                         "time":"2024-05-24T12:00:00+00:00","releaseTime":"2024-05-24T11:00:00+00:00"}
                    ]
                }"#,
            ))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_for(&server, tmp.path().to_path_buf());
        let manifest = aurora.list_manifest().await.unwrap();

        assert_eq!(manifest.latest.release, "1.21");
        assert_eq!(manifest.versions.len(), 2);
        let release = manifest.latest_release().unwrap();
        assert_eq!(release.id, "1.21");
        assert_eq!(release.sha1.as_deref(), Some("abc"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_installed_discovers_local_versions() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        let vdir = mc.join("versions").join("1.21");
        tokio::fs::create_dir_all(&vdir).await.unwrap();
        tokio::fs::write(
            vdir.join("1.21.json"),
            r#"{"id":"1.21","type":"release","mainClass":"net.minecraft.client.main.Main"}"#,
        )
        .await
        .unwrap();

        let aurora = Aurora::for_test(AuroraConfig::default(), mc.to_path_buf(), mc.to_path_buf());
        let scan = aurora.list_installed().await.unwrap();
        assert_eq!(scan.versions.len(), 1);
        assert_eq!(scan.versions[0].id, "1.21");
        assert!(scan.broken.is_empty());
    }
}
