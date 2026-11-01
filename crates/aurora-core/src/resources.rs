//! 资源包、光影、数据包从平台装进实例。
//!
//! 每种资源落到实例工作目录下各自的位置：资源包 `resourcepacks/`、光影 `shaderpacks/`、
//! 数据包 `saves/<存档>/datapacks/`（数据包只对单个存档生效，必须指明装进哪个存档）。Mod 不走这里，
//! 见 [`ResourceTarget::resource_type`]。
//! 工作目录与启动时同一套隔离判定（[`Aurora::resolve_working_dir`]），装进去的东西启动后才找得到。
//!
//! 平台给的文件名直接拼进落盘路径，必须先验成单个安全的文件名：一个带 `..` 或路径分隔符的
//! 文件名就能把文件写到实例目录之外。

use std::path::{Path, PathBuf};

use aurora_download::DownloadTask;
use aurora_modplatform::{CurseForgeClient, ModrinthClient, Platform, ResourceType};

use crate::blocked::{BlockedFile, single_blocked};
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
    /// 资源类型；整合包、插件与 Mod 不在此列。Mod 要经 `install_mod`：那条路径占住 mods 目录、
    /// 写卷宗与历史、先探测游戏是否占着同名文件，直接下载到 mods/ 会无备份地覆盖玩家的同名 jar，
    /// 装进来的 Mod 也没有来源，查不了更新、回滚不了。
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
        let (dir, landing) = self.resource_dir(target).await?;
        emit(
            events,
            CoreEvent::stage(format!(
                "准备从 {} 安装到 {}",
                platform.display_name(),
                target.version_id
            )),
        );
        let (file_name, task) = self
            .platform_file_task(platform, project_id, file_version_id, &dir, &landing)
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

    /// 资源该落到的目录，以及它相对工作目录、正斜杠分隔的写法（受限文件的落点用）；数据包的存档在这里
    /// 校验存在。
    async fn resource_dir(&self, target: ResourceTarget<'_>) -> Result<(PathBuf, String)> {
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
            (ResourceType::Mod, None) => {
                return Err(CoreError::InvalidResourceTarget(
                    "Mod 要经 install_mod 安装，不能作为单个资源装进实例".to_owned(),
                ));
            }
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
            Dest::Sub(sub) => return Ok((working.join(sub), sub.to_owned())),
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
        Ok((
            world_dir.join("datapacks"),
            format!("saves/{world}/datapacks"),
        ))
    }

    /// 取平台上一个版本（文件）的主文件，生成落到 `dir` 下的下载任务。CurseForge 的任务挂上下载凭据。
    /// `landing` 是 `dir` 给用户看的相对写法：文件受限时它是受限文件的落点目录。
    pub(crate) async fn platform_file_task(
        &self,
        platform: Platform,
        project_id: &str,
        file_version_id: &str,
        dir: &Path,
        landing: &str,
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
                let credential = self.curseforge_credential(&client)?;
                let task = match file.to_download_task(&dest) {
                    Some(task) => task,
                    None => match curseforge_download_url(&client, mod_id, file_id).await? {
                        Some(url) => task_for_file_url(url, &dest, &file),
                        None => {
                            let destination = join_landing(landing, &file_name);
                            return Err(single_blocked(&client, mod_id, |project| {
                                BlockedFile::new(project, &file, destination)
                            })
                            .await);
                        }
                    },
                };
                Ok((file_name, task.with_credential(credential)))
            }
        }
    }
}

/// 文件对象没给下载地址时向 download-url 端点要。作者禁止第三方分发时该端点拒绝（403/404）或给空串，
/// 返回 `None`：调用方把它报成「需要到网页手动下载」，而不是笼统的请求失败。
pub(crate) async fn curseforge_download_url(
    client: &CurseForgeClient,
    mod_id: u32,
    file_id: u32,
) -> Result<Option<String>> {
    match client.file_download_url(mod_id, file_id).await {
        Ok(url) if !url.trim().is_empty() => Ok(Some(url)),
        Ok(_)
        | Err(aurora_modplatform::Error::Status {
            status: 403 | 404, ..
        }) => Ok(None),
        Err(other) => Err(other.into()),
    }
}

/// download-url 端点给的地址换成下载任务，带上文件对象里的大小与 sha1 契约。
pub(crate) fn task_for_file_url(
    url: String,
    dest: &Path,
    file: &aurora_modplatform::CurseForgeFile,
) -> DownloadTask {
    let mut task = DownloadTask::new(url, dest);
    if let Some(size) = file.file_length {
        task = task.with_size(size);
    }
    if let Some(sha1) = file.sha1() {
        task = task.with_sha1(sha1.to_owned());
    }
    task
}

/// 相对目录与文件名拼成正斜杠分隔的落点；目录为空时就是文件名。
pub(crate) fn join_landing(landing: &str, file_name: &str) -> String {
    if landing.is_empty() {
        file_name.to_owned()
    } else {
        format!("{landing}/{file_name}")
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
pub fn is_safe_file_name(name: &str) -> bool {
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

    /// Mod 也不行：直接下到 mods/ 会绕过 Mod 管理，同名 jar 被无备份地覆盖。目录里原有的文件不动。
    #[tokio::test]
    async fn modpack_plugin_and_mod_are_not_single_resources() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21.1").await;
        let mods = mc.join("versions/1.21.1/mods");
        tokio::fs::create_dir_all(&mods).await.unwrap();
        tokio::fs::write(mods.join("sodium.jar"), b"player-patched")
            .await
            .unwrap();
        let aurora = aurora(mc, IsolationPolicy::All, "http://127.0.0.1:9");
        for resource_type in [
            ResourceType::Modpack,
            ResourceType::Plugin,
            ResourceType::Mod,
        ] {
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
            assert!(
                matches!(err, CoreError::InvalidResourceTarget(_)),
                "{resource_type:?}：{err:?}"
            );
        }
        assert_eq!(
            tokio::fs::read(mods.join("sodium.jar")).await.unwrap(),
            b"player-patched"
        );
    }

    /// CurseForge 资源包没有下载地址、download-url 端点也拒绝时，报成需要手动下载：多问一次工程拼出网页链接，
    /// 落点是这次安装的 resourcepacks/，哈希与大小照文件对象给；什么都不下载。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_blocked_resource_is_reported_with_its_page_and_landing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/123/files/456"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {
                    "id": 456, "modId": 123, "displayName": "Pack", "fileName": "pack.zip",
                    "hashes": [{"value": "0f4a890d07402280686a518579fa9fa02309e315", "algo": 1}],
                    "downloadUrl": null, "fileLength": 10, "fileFingerprint": 778
                }})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/123/files/456/download-url"))
            .respond_with(ResponseTemplate::new(403))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/123"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {
                    "id": 123, "name": "Pack", "slug": "pack", "summary": "", "classId": 12,
                    "links": {"websiteUrl": "https://www.curseforge.com/minecraft/texture-packs/pack/"}
                }})),
            )
            .expect(1)
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path();
        put_version(mc, "1.21.1").await;
        let aurora = aurora(mc, IsolationPolicy::All, &server.uri()).with_curseforge_key("k");

        let err = aurora
            .install_resource(
                ResourceTarget {
                    version_id: "1.21.1",
                    resource_type: ResourceType::ResourcePack,
                    world: None,
                },
                Platform::CurseForge,
                "123",
                "456",
                None,
            )
            .await
            .unwrap_err();
        let CoreError::FileDistributionBlocked { files } = &err else {
            panic!("实际：{err:?}");
        };
        assert_eq!(
            files,
            &[BlockedFile {
                project_id: 123,
                file_id: 456,
                file_name: "pack.zip".into(),
                web_url: "https://www.curseforge.com/minecraft/texture-packs/pack/files/456".into(),
                destination: "resourcepacks/pack.zip".into(),
                sha1: Some("0f4a890d07402280686a518579fa9fa02309e315".into()),
                fingerprint: 778,
                size: Some(10),
            }]
        );
        assert_eq!(
            err.to_string(),
            "这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：pack.zip"
        );
        assert!(!mc.join("versions/1.21.1/resourcepacks/pack.zip").exists());
        server.verify().await;
    }

    /// CurseForge 的任务（含 download-url 兜底出来的）都挂 CurseForge 凭据，Modrinth 的任务不挂。数据包的
    /// 落点写法带上存档。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn curseforge_tasks_carry_the_download_credential_and_modrinth_tasks_do_not() {
        let server = MockServer::start().await;
        let uri = server.uri();
        mount_modrinth_version(&server, "rp1", "Faithful.zip", b"rp").await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/7/files/70"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {
                    "id": 70, "modId": 7, "displayName": "d", "fileName": "direct.zip",
                    "downloadUrl": format!("{uri}/cdn/direct.zip"), "fileLength": 2
                }})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/8/files/80"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": {
                    "id": 80, "modId": 8, "displayName": "f", "fileName": "fallback.zip",
                    "downloadUrl": null, "fileLength": 3
                }})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/mods/8/files/80/download-url"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": format!("{uri}/cdn/fallback.zip")})),
            )
            .mount(&server)
            .await;
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora(tmp.path(), IsolationPolicy::All, &uri).with_curseforge_key("k");
        let dir = tmp.path().join("rp");

        let (_, modrinth) = aurora
            .platform_file_task(Platform::Modrinth, "faithful", "rp1", &dir, "resourcepacks")
            .await
            .unwrap();
        assert!(modrinth.credential.is_none());
        for (project, file, url) in [
            ("7", "70", format!("{uri}/cdn/direct.zip")),
            ("8", "80", format!("{uri}/cdn/fallback.zip")),
        ] {
            let (_, task) = aurora
                .platform_file_task(Platform::CurseForge, project, file, &dir, "resourcepacks")
                .await
                .unwrap();
            assert_eq!(task.url, url);
            let credential = task.credential.as_ref().expect("CurseForge 任务应带凭据");
            assert_eq!(
                credential.realm(),
                aurora_download::CredentialRealm::CurseForge
            );
            assert_eq!(credential.header_name().as_str(), "x-api-key");
        }
        assert_eq!(
            join_landing("saves/新的世界/datapacks", "a.zip"),
            "saves/新的世界/datapacks/a.zip"
        );
        assert_eq!(join_landing("", "a.zip"), "a.zip");
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
