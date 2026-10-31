//! 资源包、光影、数据包（以及 Mod）从平台装进实例。
//!
//! 每种资源落到实例工作目录下各自的位置：资源包 `resourcepacks/`、光影 `shaderpacks/`、
//! 数据包 `saves/<存档>/datapacks/`（数据包只对单个存档生效，必须指明装进哪个存档）、Mod `mods/`。
//! 工作目录与启动时同一套隔离判定（[`Aurora::resolve_working_dir`]），装进去的东西启动后才找得到。
//!
//! 平台给的文件名直接拼进落盘路径，必须先验成单个安全的文件名：一个带 `..` 或路径分隔符的
//! 文件名就能把文件写到实例目录之外。

use std::path::{Path, PathBuf};

use aurora_download::DownloadTask;
use aurora_modplatform::{CurseForgeClient, ModrinthClient, Platform, ResourceType};

use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Aurora;

/// 一次资源安装的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceInstallOutcome {
    /// 落盘的文件名。
    pub file_name: String,
    /// 文件完整路径。
    pub path: PathBuf,
    /// 来源平台。
    pub platform: Platform,
    /// 资源类型。
    pub resource_type: ResourceType,
    /// 数据包装进的存档；其余类型为 `None`。
    pub world: Option<String>,
}

/// 一次资源安装的目标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceTarget<'a> {
    /// 实例（版本目录名）。
    pub version_id: &'a str,
    /// 资源类型；整合包与插件不在此列。
    pub resource_type: ResourceType,
    /// 数据包装进的存档目录名；其余类型必须为 `None`。
    pub world: Option<&'a str>,
}

impl Aurora {
    /// 把平台上某工程的一个版本（Modrinth 版本 id / CurseForge 文件 id）装进实例里该类型的目录。
    ///
    /// 先在本地定位目标目录（实例不存在、存档不存在都在触网前报错），再取平台文件、校验文件名、
    /// 经批量下载池落盘（带 sha1 与大小契约，不符即重下换源）。
    pub async fn install_resource(
        &self,
        target: ResourceTarget<'_>,
        platform: Platform,
        project_id: &str,
        file_version_id: &str,
        events: Option<&EventSink>,
    ) -> Result<ResourceInstallOutcome> {
        let dir = self.resource_dir(target).await?;
        emit(
            events,
            CoreEvent::stage(format!(
                "准备从 {} 安装到 {}",
                platform.display_name(),
                target.version_id
            )),
        );
        let (file_name, task) = self
            .platform_file_task(platform, project_id, file_version_id, &dir)
            .await?;
        let dest = task.dest.clone();
        emit(events, CoreEvent::stage(format!("开始下载 {file_name}")));
        let report = self
            .download_pool_reporting(events)
            .download_all(vec![task], None)
            .await?;
        if let Some(failure) = report.failures.into_iter().next() {
            return Err(failure.error.into());
        }
        emit(
            events,
            CoreEvent::stage(format!("{file_name} 已安装到 {}", dest.display())),
        );
        Ok(ResourceInstallOutcome {
            file_name,
            path: dest,
            platform,
            resource_type: target.resource_type,
            world: target.world.map(str::to_owned),
        })
    }

    /// 资源该落到的目录；数据包的存档在这里校验存在。
    async fn resource_dir(&self, target: ResourceTarget<'_>) -> Result<PathBuf> {
        enum Dest<'a> {
            Sub(&'static str),
            World(&'a str),
        }
        let dest = match (target.resource_type, target.world) {
            (ResourceType::DataPack, Some(world)) => Dest::World(world),
            (ResourceType::DataPack, None) => {
                return Err(CoreError::InvalidResourceTarget(
                    "数据包要指明装进哪个存档".to_owned(),
                ));
            }
            (_, Some(_)) => {
                return Err(CoreError::InvalidResourceTarget(
                    "只有数据包需要指定存档".to_owned(),
                ));
            }
            (ResourceType::Mod, None) => Dest::Sub("mods"),
            (ResourceType::ResourcePack, None) => Dest::Sub("resourcepacks"),
            (ResourceType::Shader, None) => Dest::Sub("shaderpacks"),
            (other @ (ResourceType::Modpack | ResourceType::Plugin), None) => {
                return Err(CoreError::InvalidResourceTarget(format!(
                    "{other:?} 不能作为单个资源装进实例"
                )));
            }
        };
        if let Dest::World(world) = dest
            && !is_safe_file_name(world)
        {
            return Err(CoreError::InvalidResourceTarget(format!(
                "存档名不合法：{world}"
            )));
        }
        let working = self
            .resolve_working_dir(target.version_id)
            .await?
            .working_dir;
        let world = match dest {
            Dest::Sub(sub) => return Ok(working.join(sub)),
            Dest::World(world) => world,
        };
        let world_dir = working.join("saves").join(world);
        let is_dir = match tokio::fs::metadata(&world_dir).await {
            Ok(meta) => meta.is_dir(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
            Err(source) => {
                return Err(aurora_base::Error::Io {
                    path: world_dir,
                    source,
                }
                .into());
            }
        };
        if !is_dir {
            return Err(CoreError::WorldNotFound {
                version_id: target.version_id.to_owned(),
                world: world.to_owned(),
            });
        }
        Ok(world_dir.join("datapacks"))
    }

    /// 取平台上一个版本（文件）的主文件，生成落到 `dir` 下的下载任务。
    pub(crate) async fn platform_file_task(
        &self,
        platform: Platform,
        project_id: &str,
        file_version_id: &str,
        dir: &Path,
    ) -> Result<(String, DownloadTask)> {
        let not_found = || CoreError::ModVersionNotFound {
            platform: platform.display_name(),
            project_id: project_id.to_owned(),
            version_id: file_version_id.to_owned(),
        };
        match platform {
            Platform::Modrinth => {
                let client = ModrinthClient::new(self.http()).with_base_url(self.modrinth_base());
                let version = client
                    .version(file_version_id)
                    .await?
                    .ok_or_else(not_found)?;
                let file = version.primary_file().ok_or_else(not_found)?;
                let file_name = checked_file_name(platform, &file.filename)?;
                let task = file.to_download_task(dir.join(&file_name));
                Ok((file_name, task))
            }
            Platform::CurseForge => {
                let invalid = || CoreError::InvalidProjectId {
                    platform: platform.display_name(),
                    project_id: format!("{project_id}/{file_version_id}"),
                };
                let mod_id: u32 = project_id.parse().map_err(|_| invalid())?;
                let file_id: u32 = file_version_id.parse().map_err(|_| invalid())?;
                let client = self.curseforge_client()?;
                let file = client
                    .mod_file(mod_id, file_id)
                    .await?
                    .ok_or_else(not_found)?;
                let file_name = checked_file_name(platform, &file.file_name)?;
                let dest = dir.join(&file_name);
                let task = match file.to_download_task(&dest) {
                    Some(task) => task,
                    None => {
                        let url =
                            curseforge_download_url(&client, mod_id, file_id, &file_name).await?;
                        let mut task = DownloadTask::new(url, &dest);
                        if let Some(size) = file.file_length {
                            task = task.with_size(size);
                        }
                        if let Some(sha1) = file.sha1() {
                            task = task.with_sha1(sha1.to_owned());
                        }
                        task
                    }
                };
                Ok((file_name, task))
            }
        }
    }
}

/// 文件对象没给下载地址时向 download-url 端点要；作者禁止第三方分发时该端点拒绝（403/404），
/// 报成「需要到网页手动下载」，而不是笼统的请求失败。
pub(crate) async fn curseforge_download_url(
    client: &CurseForgeClient,
    mod_id: u32,
    file_id: u32,
    file_name: &str,
) -> Result<String> {
    match client.file_download_url(mod_id, file_id).await {
        Ok(url) if !url.trim().is_empty() => Ok(url),
        Ok(_)
        | Err(aurora_modplatform::Error::Status {
            status: 403 | 404, ..
        }) => Err(CoreError::FileDistributionBlocked {
            files: vec![file_name.to_owned()],
        }),
        Err(other) => Err(other.into()),
    }
}

/// 平台给的文件名只能是单个普通文件名，否则拒收。
fn checked_file_name(platform: Platform, raw: &str) -> Result<String> {
    if is_safe_file_name(raw) {
        Ok(raw.to_owned())
    } else {
        Err(CoreError::UnsafeFileName {
            platform: platform.display_name(),
            file_name: raw.to_owned(),
        })
    }
}

/// 是否为可以直接拼进路径的单个文件或目录名：非空、不是 `.` / `..`、不含路径分隔符、盘符冒号
/// 与控制字符、不以空格或点结尾（Windows 会悄悄去掉它们，落盘名与预期不一致）。
pub(crate) fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.ends_with([' ', '.'])
        && !name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':') || c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use aurora_instance::IsolationPolicy;
    use sha1::{Digest, Sha1};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn put_version(mc: &Path, id: &str) {
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
        Sha1::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    async fn mount_modrinth_version(server: &MockServer, id: &str, file: &str, bytes: &[u8]) {
        Mock::given(method("GET"))
            .and(path(format!("/version/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": id, "project_id": "proj", "name": id, "version_number": "1.0",
                "version_type": "release", "date_published": "2026-01-01T00:00:00Z",
                "files": [{"hashes": {"sha1": sha1_hex(bytes)}, "url": format!("{}/{file}", server.uri()),
                           "filename": file, "primary": true, "size": bytes.len()}]
            })))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/{file}")))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.to_vec()))
            .mount(server)
            .await;
    }

    fn aurora(mc: &Path, policy: IsolationPolicy, base: &str) -> Aurora {
        let mut aurora =
            Aurora::for_test(AuroraConfig::default(), mc.to_path_buf(), mc.to_path_buf());
        aurora.set_isolation_policy(policy);
        aurora.with_modrinth_base(base).with_curseforge_base(base)
    }

    /// 资源包落到隔离工作目录的 resourcepacks/，光影落到 shaderpacks/，内容与平台一致。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resource_pack_and_shader_land_in_their_own_directories() {
        let server = MockServer::start().await;
        mount_modrinth_version(&server, "rp1", "Faithful.zip", b"resource-pack").await;
        mount_modrinth_version(&server, "sh1", "Complementary.zip", b"shader-pack").await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21.1").await;
        let aurora = aurora(mc, IsolationPolicy::All, &server.uri());

        let rp = aurora
            .install_resource(
                ResourceTarget {
                    version_id: "1.21.1",
                    resource_type: ResourceType::ResourcePack,
                    world: None,
                },
                Platform::Modrinth,
                "faithful",
                "rp1",
                None,
            )
            .await
            .unwrap();
        let expected = mc.join("versions/1.21.1/resourcepacks/Faithful.zip");
        assert_eq!(rp.path, expected);
        assert_eq!(rp.resource_type, ResourceType::ResourcePack);
        assert_eq!(rp.world, None);
        assert_eq!(tokio::fs::read(&expected).await.unwrap(), b"resource-pack");

        let shader = aurora
            .install_resource(
                ResourceTarget {
                    version_id: "1.21.1",
                    resource_type: ResourceType::Shader,
                    world: None,
                },
                Platform::Modrinth,
                "complementary",
                "sh1",
                None,
            )
            .await
            .unwrap();
        let expected = mc.join("versions/1.21.1/shaderpacks/Complementary.zip");
        assert_eq!(shader.path, expected);
        assert_eq!(tokio::fs::read(&expected).await.unwrap(), b"shader-pack");
    }

    /// 关闭隔离时资源落在 .minecraft 根下的同名目录。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shared_instance_uses_root_directories() {
        let server = MockServer::start().await;
        mount_modrinth_version(&server, "rp1", "Faithful.zip", b"rp").await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21.1").await;
        let aurora = aurora(mc, IsolationPolicy::Disabled, &server.uri());
        let rp = aurora
            .install_resource(
                ResourceTarget {
                    version_id: "1.21.1",
                    resource_type: ResourceType::ResourcePack,
                    world: None,
                },
                Platform::Modrinth,
                "faithful",
                "rp1",
                None,
            )
            .await
            .unwrap();
        assert_eq!(rp.path, mc.join("resourcepacks/Faithful.zip"));
    }

    /// 数据包装进指定存档的 datapacks/；存档不存在、未指明存档、存档名越界都在触网前报错。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn data_pack_goes_into_the_named_world_and_bad_worlds_are_rejected() {
        let server = MockServer::start().await;
        mount_modrinth_version(&server, "dp1", "terralith.zip", b"datapack").await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21.1").await;
        tokio::fs::create_dir_all(mc.join("versions/1.21.1/saves/新的世界"))
            .await
            .unwrap();
        let aurora = aurora(mc, IsolationPolicy::All, &server.uri());
        let target = |world| ResourceTarget {
            version_id: "1.21.1",
            resource_type: ResourceType::DataPack,
            world,
        };

        let dp = aurora
            .install_resource(
                target(Some("新的世界")),
                Platform::Modrinth,
                "terralith",
                "dp1",
                None,
            )
            .await
            .unwrap();
        let expected = mc.join("versions/1.21.1/saves/新的世界/datapacks/terralith.zip");
        assert_eq!(dp.path, expected);
        assert_eq!(dp.world.as_deref(), Some("新的世界"));
        assert_eq!(tokio::fs::read(&expected).await.unwrap(), b"datapack");

        let missing = aurora
            .install_resource(
                target(Some("别的世界")),
                Platform::Modrinth,
                "terralith",
                "dp1",
                None,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&missing, CoreError::WorldNotFound { world, .. } if world == "别的世界"),
            "实际：{missing:?}"
        );
        for bad in ["..", "a/b", "..\\x", ""] {
            let err = aurora
                .install_resource(
                    target(Some(bad)),
                    Platform::Modrinth,
                    "terralith",
                    "dp1",
                    None,
                )
                .await
                .unwrap_err();
            assert!(
                matches!(err, CoreError::InvalidResourceTarget(_)),
                "{bad:?}：{err:?}"
            );
        }
        let no_world = aurora
            .install_resource(target(None), Platform::Modrinth, "terralith", "dp1", None)
            .await
            .unwrap_err();
        assert!(matches!(no_world, CoreError::InvalidResourceTarget(_)));
        // 越界的存档名没有在实例目录之外造出任何东西。
        assert!(!mc.join("versions/1.21.1/a").exists());
    }

    /// 平台给的文件名带路径分隔符时拒收，什么都不写。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn platform_file_name_with_traversal_is_rejected() {
        let server = MockServer::start().await;
        mount_modrinth_version(&server, "evil", "../../evil.zip", b"x").await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21.1").await;
        let aurora = aurora(mc, IsolationPolicy::All, &server.uri());
        let err = aurora
            .install_resource(
                ResourceTarget {
                    version_id: "1.21.1",
                    resource_type: ResourceType::ResourcePack,
                    world: None,
                },
                Platform::Modrinth,
                "p",
                "evil",
                None,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::UnsafeFileName { file_name, .. } if file_name == "../../evil.zip"),
            "实际：{err:?}"
        );
        assert!(!mc.join("evil.zip").exists());
        assert!(!mc.join("versions/evil.zip").exists());
    }

    #[tokio::test]
    async fn modpack_and_plugin_are_not_single_resources() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21.1").await;
        let aurora = aurora(mc, IsolationPolicy::All, "http://127.0.0.1:9");
        for resource_type in [ResourceType::Modpack, ResourceType::Plugin] {
            let err = aurora
                .install_resource(
                    ResourceTarget {
                        version_id: "1.21.1",
                        resource_type,
                        world: None,
                    },
                    Platform::Modrinth,
                    "p",
                    "v",
                    None,
                )
                .await
                .unwrap_err();
            assert!(matches!(err, CoreError::InvalidResourceTarget(_)));
        }
    }

    /// CurseForge 文件没有下载地址、download-url 端点也拒绝时，报成需要手动下载。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_blocked_distribution_is_reported_as_such() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/123/files/456"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {
                    "id": 456, "modId": 123, "displayName": "Pack", "fileName": "pack.zip",
                    "downloadUrl": null, "fileLength": 10
                }})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/123/files/456/download-url"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;
        let http = aurora_base::http::build_client().unwrap();
        let client = CurseForgeClient::new(http, "k").with_base_url(server.uri());
        let err = curseforge_download_url(&client, 123, 456, "pack.zip")
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::FileDistributionBlocked { files } if files == &["pack.zip".to_string()]),
            "实际：{err:?}"
        );
    }

    #[test]
    fn safe_file_names_exclude_traversal_separators_and_trailing_dots() {
        for ok in ["sodium-0.6.jar", "新的世界", "My World (2)", ".hidden"] {
            assert!(is_safe_file_name(ok), "{ok}");
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "C:x", "x.", "x ", "a\u{0}b"] {
            assert!(!is_safe_file_name(bad), "{bad:?}");
        }
    }
}
