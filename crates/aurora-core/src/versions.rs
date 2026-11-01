//! 版本清单抓取与本地已安装版本发现。

use aurora_install::VanillaInstaller;
use aurora_instance::{VersionScan, discover_versions};
use aurora_version::VersionManifest;

use crate::error::Result;
use crate::facade::{Aurora, make_context};

impl Aurora {
    /// 抓取远端版本清单（version_manifest_v2）。按「版本列表源」的源计划在官方与镜像之间逐源回退；
    /// 只读测速缓存、不现测：新建实例页首屏走这里，不能被探针超时拖住。
    pub async fn list_manifest(&self) -> Result<VersionManifest> {
        let layout = self.layout();
        let pool = self.download_pool();
        let policy = self.retry_policy();
        let http = self.http();
        let cx = make_context(
            &http,
            &pool,
            &layout,
            self.runtime(),
            &policy,
            self.cancel_token(),
        );
        let manifest = VanillaInstaller::new(cx)
            .with_manifest_url(self.manifest_url())
            .with_sources(self.source_plan(self.config().version_list_source))
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
    use std::sync::Arc;
    use std::time::Duration;

    use crate::config::{AuroraConfig, DownloadSourcePolicy};
    use crate::error::CoreError;
    use crate::facade::Aurora;
    use crate::sources::tests::Routes;
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

    const MANIFEST_PATH: &str = "/mc/game/version_manifest_v2.json";

    /// 官方与镜像钉到两台 mock，两项源策略都是尽量官方。清单的「官方地址」用解析不了的域名：源计划
    /// 没生效、直接请求它时测试当场失败，不会连到真实网络。
    fn aurora_routed(
        official: &MockServer,
        mirror: &MockServer,
        game_dir: std::path::PathBuf,
    ) -> Aurora {
        let config = AuroraConfig {
            download_source: DownloadSourcePolicy::OfficialFirst,
            version_list_source: DownloadSourcePolicy::OfficialFirst,
            ..AuroraConfig::default()
        };
        Aurora::for_test(config, game_dir.clone(), game_dir)
            .with_source_routes(
                Arc::new(Routes {
                    official: official.uri(),
                    mirror: mirror.uri(),
                }),
                Duration::from_secs(600),
                Duration::from_secs(2),
            )
            .with_manifest_url(format!("https://meta.invalid{MANIFEST_PATH}"))
    }

    /// 官方清单持续 503：还有镜像可换，试一次就换过去，返回镜像上的版本列表。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_manifest_falls_back_to_mirror_when_official_is_down() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(MANIFEST_PATH))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&official)
            .await;
        Mock::given(method("GET"))
            .and(path(MANIFEST_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"latest":{"release":"1.21.1","snapshot":"24w40a"},
                    "versions":[
                        {"id":"24w40a","type":"snapshot","url":"https://piston-meta.mojang.com/v1/24w40a.json","time":"t","releaseTime":"t"},
                        {"id":"1.21.1","type":"release","url":"https://piston-meta.mojang.com/v1/1.21.1.json","time":"t","releaseTime":"t"}
                    ]}"#,
            ))
            .expect(1)
            .mount(&mirror)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let manifest = aurora_routed(&official, &mirror, tmp.path().to_path_buf())
            .list_manifest()
            .await
            .unwrap();
        assert_eq!(manifest.latest.release, "1.21.1");
        let ids: Vec<&str> = manifest.versions.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["24w40a", "1.21.1"]);
    }

    /// 两个源都失败：错误的原因链里先后能看到官方与镜像各自的地址与原因。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_manifest_failing_everywhere_reports_both_sources_in_order() {
        let official = MockServer::start().await;
        let mirror = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(MANIFEST_PATH))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&official)
            .await;
        Mock::given(method("GET"))
            .and(path(MANIFEST_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>维护中</html>"))
            .expect(1)
            .mount(&mirror)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let err = aurora_routed(&official, &mirror, tmp.path().to_path_buf())
            .list_manifest()
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::Install(aurora_install::Error::AllSourcesFailed { .. })
            ),
            "实际：{err:?}"
        );
        let mut chain = Vec::new();
        let mut layer: Option<&(dyn std::error::Error + 'static)> = Some(&err);
        while let Some(current) = layer {
            chain.push(current.to_string());
            layer = current.source();
        }
        let text = chain.join(
            "
",
        );
        let official_url = format!("{}{MANIFEST_PATH}", official.uri());
        let mirror_url = format!("{}{MANIFEST_PATH}", mirror.uri());
        let official_at = text.find(&official_url).expect("原因链里应有官方地址");
        let mirror_at = text.find(&mirror_url).expect("原因链里应有镜像地址");
        assert!(official_at < mirror_at, "{text}");
        assert!(text.contains("404"), "官方的失败原因要带状态码：{text}");
        assert!(
            chain
                .last()
                .is_some_and(|cause| cause.contains("expected value")),
            "最底层应是镜像报文的解析错误：{chain:?}"
        );
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
