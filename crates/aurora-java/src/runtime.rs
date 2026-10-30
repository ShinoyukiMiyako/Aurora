//! Mojang `java_runtime` 清单的下载与安装（architecture.md aurora-java 小节 v1 项）。
//!
//! 流程：拉 `all.json`（平台 -> 组件 -> 条目）→ 按目标主版本挑组件 → 拉该组件的文件清单
//! → 逐个文件按 raw 直链下载、sha1 校验后原子落盘。所有远端 URL 都先经 aurora-base 的镜像
//! 改写（官方源直连或 BMCLAPI 镜像），HTTP 客户端由外部注入以便单测走本地 mock。
//!
//! sha1 校验放在内存里、且在重试闭包内完成：校验不符会冒泡成 aurora-base 的 `HashMismatch`
//! （可重试），于是一次损坏下载会自动重新拉取，而不是把坏文件留在盘上。

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};

use aurora_base::mirror::{self, MirrorSource};
use aurora_base::retry::{RetryPolicy, retry_async};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::version::JavaVersion;

/// Mojang Java 运行时总清单（`all.json`）默认地址。
///
/// 该 gamecore 哈希路径是社区长期稳定的公开入口；piston-meta 域名在 aurora-base 镜像表中，
/// 走 BMCLAPI 时会被改写到镜像的同路径。
pub const MOJANG_JAVA_RUNTIME_ALL: &str =
    "https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

/// `all.json` 顶层结构：平台键 -> 组件名 -> 该组件的条目列表。
///
/// 用 `BTreeMap` 保证遍历顺序确定（组件挑选与文件下载都靠它稳定）。
pub type JavaRuntimeManifest = BTreeMap<String, BTreeMap<String, Vec<RuntimeComponent>>>;

/// 一个运行时组件条目。只保留下载与匹配需要的字段，其余（availability/size/released）忽略。
#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeComponent {
    /// 指向该组件文件清单的引用（含清单自身的 sha1 与地址）。
    pub manifest: ManifestRef,
    /// 组件版本，`name` 形如 `17.0.8`，据此推主版本做匹配。
    pub version: ComponentVersion,
}

/// 组件文件清单的引用。
#[derive(Debug, Clone, Deserialize)]
pub struct ManifestRef {
    /// 清单文件自身的 sha1（下载后据此校验清单未损坏）。
    pub sha1: String,
    /// 清单文件地址（官方域名，下载前经镜像改写）。
    pub url: String,
}

/// 组件版本。
#[derive(Debug, Clone, Deserialize)]
pub struct ComponentVersion {
    /// 版本名，形如 `17.0.8`。
    pub name: String,
}

/// 组件文件清单：相对路径 -> 条目。
#[derive(Debug, Clone, Deserialize)]
pub struct ComponentFiles {
    /// 每个键是相对安装根的路径（以 `/` 分隔）。
    pub files: BTreeMap<String, FileEntry>,
}

/// 文件清单里的一个条目，按 `type` 内部标签区分。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum FileEntry {
    /// 普通文件，含 raw/lzma 下载信息与可执行标记。
    File {
        /// 下载信息（只用 raw 直链）。
        downloads: FileDownloads,
        /// 是否需要可执行权限（Unix 生效，Windows 无意义）。
        #[serde(default)]
        executable: bool,
    },
    /// 目录，需显式创建（覆盖清单里的空目录）。
    Directory,
    /// 符号链接，`target` 是链接目标（仅 mac/linux 运行时会出现）。
    Link {
        /// 链接指向的目标（相对路径）。
        target: String,
    },
}

/// 文件的下载信息。只取 raw（未压缩直链），不处理 lzma，避免引入解压依赖。
#[derive(Debug, Clone, Deserialize)]
pub struct FileDownloads {
    /// 未压缩的原始文件下载引用。
    pub raw: DownloadRef,
}

/// 单个可下载对象的引用。
#[derive(Debug, Clone, Deserialize)]
pub struct DownloadRef {
    /// 对象 sha1（下载后逐文件校验）。
    pub sha1: String,
    /// 对象直链（官方域名，下载前经镜像改写）。
    pub url: String,
}

/// 一次成功安装的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledRuntime {
    /// 组件名，如 `java-runtime-gamma`。
    pub component: String,
    /// 组件版本（由清单声明的 `version.name` 解析）。
    pub version: JavaVersion,
    /// 安装后 java 可执行文件的绝对路径。
    pub java_executable: PathBuf,
}

/// Mojang Java 运行时安装器。
///
/// 持有注入的 HTTP 客户端、清单地址、镜像源与重试策略。清单地址与镜像源都可注入，
/// 使单测能把整条链路指向本地 mock（`Official` 源下镜像改写为恒等，mock URL 原样透传）。
pub struct JavaRuntimeInstaller {
    client: reqwest::Client,
    manifest_url: String,
    source: MirrorSource,
    policy: RetryPolicy,
    cancel: Option<CancellationToken>,
}

impl JavaRuntimeInstaller {
    /// 用注入的客户端创建安装器，默认走官方源与默认重试策略。
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            manifest_url: MOJANG_JAVA_RUNTIME_ALL.to_owned(),
            source: MirrorSource::default(),
            policy: RetryPolicy::default(),
            cancel: None,
        }
    }

    /// 挂取消令牌：每个文件开始前检查，网络等待中触发即放弃该请求，以 [`Error::Cancelled`] 返回。
    ///
    /// 文件内容先整份读进内存、校验通过后才原子落盘，丢弃进行中的请求不会留下半截文件。
    pub fn with_cancel(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    /// 覆盖清单地址（测试指向 mock，或改用其它 gamecore 入口）。
    pub fn with_manifest_url(mut self, url: impl Into<String>) -> Self {
        self.manifest_url = url.into();
        self
    }

    /// 设定镜像源（官方直连 / BMCLAPI）。
    pub fn with_source(mut self, source: MirrorSource) -> Self {
        self.source = source;
        self
    }

    /// 覆盖重试策略。
    pub fn with_retry_policy(mut self, policy: RetryPolicy) -> Self {
        self.policy = policy;
        self
    }

    /// 拉取并解析 `all.json` 总清单。
    pub async fn fetch_manifest(&self) -> Result<JavaRuntimeManifest> {
        let url = mirror::rewrite(&self.manifest_url, self.source)?;
        let bytes = self.get_bytes(&url).await?;
        parse_json(&bytes, "java-runtime all.json")
    }

    /// 为当前平台安装匹配 `required_major` 的运行时到 `install_dir`。
    pub async fn install(&self, required_major: u32, install_dir: &Path) -> Result<InstalledRuntime> {
        self.install_for_platform(required_major, current_platform(), install_dir)
            .await
    }

    /// 显式指定平台键的安装入口（测试用 `windows-x64` 注入，避开真实平台判定）。
    pub async fn install_for_platform(
        &self,
        required_major: u32,
        platform: &str,
        install_dir: &Path,
    ) -> Result<InstalledRuntime> {
        let manifest = self.fetch_manifest().await?;
        let platform_map = manifest
            .get(platform)
            .ok_or_else(|| Error::UnsupportedPlatform(platform.to_owned()))?;
        let (component_name, component) = select_component(platform_map, required_major)
            .ok_or(Error::NoRuntimeForMajor {
                major: required_major,
            })?;

        let files = self.fetch_component_files(component).await?;
        self.download_files(&files, install_dir).await?;

        let java_rel = locate_java_executable(&files).ok_or(Error::MissingJavaExecutable)?;
        let version =
            JavaVersion::parse(&component.version.name).ok_or_else(|| Error::JavaVersionParse {
                output: component.version.name.clone(),
            })?;
        Ok(InstalledRuntime {
            component: component_name.to_owned(),
            version,
            java_executable: install_dir.join(java_rel),
        })
    }

    /// 拉取并校验某组件的文件清单（含对清单自身的 sha1 校验）。
    async fn fetch_component_files(&self, component: &RuntimeComponent) -> Result<ComponentFiles> {
        let url = mirror::rewrite(&component.manifest.url, self.source)?;
        let bytes = self
            .get_verified_bytes(&url, &component.manifest.sha1)
            .await?;
        parse_json(&bytes, "java-runtime component manifest")
    }

    /// 逐个文件下载落盘：目录建目录、文件校验后原子写、链接建符号链接。
    async fn download_files(&self, files: &ComponentFiles, install_dir: &Path) -> Result<()> {
        for (rel, entry) in &files.files {
            if self
                .cancel
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            {
                return Err(Error::Cancelled);
            }
            let target = install_dir.join(rel_to_path(rel));
            match entry {
                FileEntry::Directory => {
                    tokio::fs::create_dir_all(&target)
                        .await
                        .map_err(|source| aurora_base::Error::Io {
                            path: target.clone(),
                            source,
                        })?;
                }
                FileEntry::File {
                    downloads,
                    executable,
                } => {
                    let url = mirror::rewrite(&downloads.raw.url, self.source)?;
                    let bytes = self.get_verified_bytes(&url, &downloads.raw.sha1).await?;
                    aurora_base::fs::atomic_write(&target, &bytes).await?;
                    set_executable(&target, *executable)?;
                }
                FileEntry::Link { target: link_target } => {
                    create_symlink(link_target, &target)?;
                }
            }
        }
        Ok(())
    }

    /// 在取消令牌下等待一次网络读取；令牌先触发即返回 [`Error::Cancelled`]。
    async fn until_cancelled<T>(&self, fut: impl Future<Output = Result<T>>) -> Result<T> {
        match &self.cancel {
            Some(token) => token
                .run_until_cancelled(fut)
                .await
                .unwrap_or(Err(Error::Cancelled)),
            None => fut.await,
        }
    }

    /// 带重试地 GET 一个 URL 的响应体（不校验哈希，用于 all.json 这类无预置哈希的清单）。
    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>> {
        let client = &self.client;
        let fetch = retry_async(&self.policy, move || async move {
            let resp = client
                .get(url)
                .send()
                .await
                .map_err(|source| Error::Http {
                    url: url.to_owned(),
                    source,
                })?;
            let resp = resp.error_for_status().map_err(|source| Error::Http {
                url: url.to_owned(),
                source,
            })?;
            let bytes = resp.bytes().await.map_err(|source| Error::Http {
                url: url.to_owned(),
                source,
            })?;
            Ok::<Vec<u8>, Error>(bytes.to_vec())
        });
        self.until_cancelled(fetch).await
    }

    /// 带重试地 GET 并做 sha1 校验；校验不符冒泡为可重试的 `HashMismatch`，从而自动重下。
    async fn get_verified_bytes(&self, url: &str, expected_sha1: &str) -> Result<Vec<u8>> {
        let client = &self.client;
        let fetch = retry_async(&self.policy, move || async move {
            let resp = client
                .get(url)
                .send()
                .await
                .map_err(|source| Error::Http {
                    url: url.to_owned(),
                    source,
                })?;
            let resp = resp.error_for_status().map_err(|source| Error::Http {
                url: url.to_owned(),
                source,
            })?;
            let bytes = resp
                .bytes()
                .await
                .map_err(|source| Error::Http {
                    url: url.to_owned(),
                    source,
                })?
                .to_vec();
            verify_bytes_sha1(&bytes, expected_sha1)?;
            Ok::<Vec<u8>, Error>(bytes)
        });
        self.until_cancelled(fetch).await
    }
}

/// 当前平台的运行时清单键。以 `windows-x64` 为主目标，其余平台尽力而为映射。
pub fn current_platform() -> &'static str {
    platform_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// 纯映射函数：把 `(os, arch)` 映射为 Mojang 清单的平台键，便于单测覆盖。
fn platform_for(os: &str, arch: &str) -> &'static str {
    match (os, arch) {
        ("windows", "x86_64") => "windows-x64",
        ("windows", "x86") => "windows-x86",
        ("windows", "aarch64") => "windows-arm64",
        ("linux", "x86") => "linux-i386",
        ("linux", _) => "linux",
        ("macos", "aarch64") => "mac-os-arm64",
        ("macos", _) => "mac-os",
        _ => "unknown",
    }
}

/// 在某平台的组件表里挑主版本匹配的组件；多个匹配（如 beta/gamma 同为 17）取版本号最高者。
fn select_component(
    platform_map: &BTreeMap<String, Vec<RuntimeComponent>>,
    required_major: u32,
) -> Option<(&str, &RuntimeComponent)> {
    platform_map
        .iter()
        .filter_map(|(name, entries)| best_entry(entries).map(|comp| (name.as_str(), comp)))
        .filter(|(_, comp)| {
            JavaVersion::parse(&comp.version.name).map(|v| v.major) == Some(required_major)
        })
        .max_by(|(_, a), (_, b)| {
            JavaVersion::parse(&a.version.name).cmp(&JavaVersion::parse(&b.version.name))
        })
}

/// 取一个组件里版本号最高的条目（通常只有一条）。
fn best_entry(entries: &[RuntimeComponent]) -> Option<&RuntimeComponent> {
    entries
        .iter()
        .max_by(|a, b| JavaVersion::parse(&a.version.name).cmp(&JavaVersion::parse(&b.version.name)))
}

/// 从文件清单里定位 java 可执行文件的相对路径（`bin/java` 或 `bin/java.exe`）。
fn locate_java_executable(files: &ComponentFiles) -> Option<PathBuf> {
    files
        .files
        .iter()
        .find(|(rel, entry)| {
            matches!(entry, FileEntry::File { .. })
                && (rel.ends_with("bin/java.exe") || rel.ends_with("bin/java"))
        })
        .map(|(rel, _)| rel_to_path(rel))
}

/// 把清单里以 `/` 分隔的相对路径转成本平台 `PathBuf`。
fn rel_to_path(rel: &str) -> PathBuf {
    rel.split('/').collect()
}

/// 反序列化 JSON，失败时带上是哪份报文的上下文。
fn parse_json<T: serde::de::DeserializeOwned>(bytes: &[u8], context: &str) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|source| Error::Json {
        context: context.to_owned(),
        source,
    })
}

/// 内存内 sha1 校验；不符返回 aurora-base 的 `HashMismatch`（可重试）。
fn verify_bytes_sha1(bytes: &[u8], expected: &str) -> Result<()> {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let actual = base16ct::lower::encode_string(&hasher.finalize());
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(aurora_base::Error::HashMismatch {
            algorithm: "SHA-1",
            expected: expected.to_owned(),
            actual,
        }
        .into())
    }
}

/// 给文件加可执行权限（仅 Unix 需要；Windows 无此概念，空操作）。
#[cfg(unix)]
fn set_executable(path: &Path, executable: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if !executable {
        return Ok(());
    }
    let mut perms = std::fs::metadata(path)
        .map_err(|source| aurora_base::Error::Io {
            path: path.to_path_buf(),
            source,
        })?
        .permissions();
    perms.set_mode(perms.mode() | 0o111);
    std::fs::set_permissions(path, perms).map_err(|source| aurora_base::Error::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path, _executable: bool) -> Result<()> {
    Ok(())
}

/// 建立符号链接（Windows 运行时清单不含链接，此路为跨平台完整性兜底）。
fn create_symlink(target: &str, link: &Path) -> Result<()> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|source| aurora_base::Error::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    symlink_impl(target, link)
}

#[cfg(unix)]
fn symlink_impl(target: &str, link: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link).map_err(|source| aurora_base::Error::Io {
        path: link.to_path_buf(),
        source,
    })?;
    Ok(())
}

#[cfg(windows)]
fn symlink_impl(target: &str, link: &Path) -> Result<()> {
    std::os::windows::fs::symlink_file(target, link).map_err(|source| aurora_base::Error::Io {
        path: link.to_path_buf(),
        source,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha1::{Digest, Sha1};
    use std::time::Duration;
    use wiremock::matchers::{method, path as match_path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    fn sha1_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha1::new();
        hasher.update(bytes);
        base16ct::lower::encode_string(&hasher.finalize())
    }

    fn fast_installer(client: reqwest::Client, base: &str) -> JavaRuntimeInstaller {
        // 小延迟、关 jitter，让含重试的测试跑得快且确定。
        let policy = RetryPolicy {
            max_attempts: 3,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(4),
            multiplier: 2.0,
            jitter: false,
        };
        JavaRuntimeInstaller::new(client)
            .with_manifest_url(format!("{base}/all.json"))
            .with_source(MirrorSource::Official)
            .with_retry_policy(policy)
    }

    // ---- 纯函数：平台映射 / 路径 / 组件挑选 ----

    #[test]
    fn platform_mapping_covers_targets() {
        assert_eq!(platform_for("windows", "x86_64"), "windows-x64");
        assert_eq!(platform_for("windows", "x86"), "windows-x86");
        assert_eq!(platform_for("windows", "aarch64"), "windows-arm64");
        assert_eq!(platform_for("linux", "x86_64"), "linux");
        assert_eq!(platform_for("linux", "x86"), "linux-i386");
        assert_eq!(platform_for("macos", "aarch64"), "mac-os-arm64");
        assert_eq!(platform_for("macos", "x86_64"), "mac-os");
        assert_eq!(platform_for("freebsd", "x86_64"), "unknown");
    }

    #[test]
    fn rel_to_path_splits_forward_slashes() {
        assert_eq!(
            rel_to_path("bin/java.exe"),
            ["bin", "java.exe"].iter().collect::<PathBuf>()
        );
    }

    #[test]
    fn select_component_picks_matching_major_highest_version() {
        let json = r#"{
            "java-runtime-beta":  [{"manifest":{"sha1":"aa","url":"u1"},"version":{"name":"17.0.1"}}],
            "java-runtime-gamma": [{"manifest":{"sha1":"bb","url":"u2"},"version":{"name":"17.0.8"}}],
            "java-runtime-delta": [{"manifest":{"sha1":"cc","url":"u3"},"version":{"name":"21.0.3"}}]
        }"#;
        let map: BTreeMap<String, Vec<RuntimeComponent>> = serde_json::from_str(json).unwrap();

        let (name, comp) = select_component(&map, 17).unwrap();
        assert_eq!(name, "java-runtime-gamma", "17 应选版本更高的 gamma");
        assert_eq!(comp.version.name, "17.0.8");

        let (name, _) = select_component(&map, 21).unwrap();
        assert_eq!(name, "java-runtime-delta");

        assert!(select_component(&map, 8).is_none(), "无 8 应返回 None");
    }

    // ---- 完整下载安装：本地 mock ----

    /// 起 mock 并挂好 all.json、两个组件清单、各自的对象文件；返回 (server, 期望内容)。
    async fn mount_full_manifest(server: &MockServer) -> (Vec<u8>, Vec<u8>) {
        let base = server.uri();

        // 组件对象内容（用字符串，sha1 直接对其字节计算）。
        let gamma_java = b"MZ-fake-gamma-java-exe".to_vec();
        let gamma_lib = b"fake-gamma-lib-rt".to_vec();
        let delta_java = b"MZ-fake-delta-java-exe".to_vec();

        // gamma 组件清单（含一个目录、一个可执行 java、一个普通 lib 文件）。
        let gamma_manifest = format!(
            r#"{{"files":{{
                "bin":{{"type":"directory"}},
                "bin/java.exe":{{"type":"file","executable":true,"downloads":{{"raw":{{"sha1":"{}","size":{},"url":"{}/objects/gamma-java"}}}}}},
                "lib/rt":{{"type":"file","downloads":{{"raw":{{"sha1":"{}","size":{},"url":"{}/objects/gamma-lib"}}}}}}
            }}}}"#,
            sha1_hex(&gamma_java),
            gamma_java.len(),
            base,
            sha1_hex(&gamma_lib),
            gamma_lib.len(),
            base,
        );
        let delta_manifest = format!(
            r#"{{"files":{{
                "bin/java.exe":{{"type":"file","executable":true,"downloads":{{"raw":{{"sha1":"{}","size":{},"url":"{}/objects/delta-java"}}}}}}
            }}}}"#,
            sha1_hex(&delta_java),
            delta_java.len(),
            base,
        );

        // all.json 引用两个组件清单（附上清单自身 sha1），并混入一个 linux 平台证明平台过滤。
        let all_json = format!(
            r#"{{
                "windows-x64":{{
                    "java-runtime-gamma":[{{"availability":{{"group":4,"progress":100}},"manifest":{{"sha1":"{}","size":{},"url":"{}/gamma.json"}},"version":{{"name":"17.0.8","released":"2023-07-18"}}}}],
                    "java-runtime-delta":[{{"manifest":{{"sha1":"{}","size":{},"url":"{}/delta.json"}},"version":{{"name":"21.0.3"}}}}]
                }},
                "linux":{{
                    "java-runtime-gamma":[{{"manifest":{{"sha1":"deadbeef","url":"{}/should-not-fetch"}},"version":{{"name":"17.0.8"}}}}]
                }}
            }}"#,
            sha1_hex(gamma_manifest.as_bytes()),
            gamma_manifest.len(),
            base,
            sha1_hex(delta_manifest.as_bytes()),
            delta_manifest.len(),
            base,
            base,
        );

        mount_get(server, "/all.json", all_json).await;
        mount_get(server, "/gamma.json", gamma_manifest).await;
        mount_get(server, "/delta.json", delta_manifest).await;
        mount_get_bytes(server, "/objects/gamma-java", gamma_java.clone()).await;
        mount_get_bytes(server, "/objects/gamma-lib", gamma_lib.clone()).await;
        mount_get_bytes(server, "/objects/delta-java", delta_java.clone()).await;

        (gamma_java, gamma_lib)
    }

    async fn mount_get(server: &MockServer, p: &str, body: String) {
        Mock::given(method("GET"))
            .and(match_path(p))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(server)
            .await;
    }

    async fn mount_get_bytes(server: &MockServer, p: &str, body: Vec<u8>) {
        Mock::given(method("GET"))
            .and(match_path(p))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(server)
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_downloads_verifies_and_lands_files() {
        let server = MockServer::start().await;
        let (gamma_java, gamma_lib) = mount_full_manifest(&server).await;

        let client = aurora_base::http::build_client().expect("客户端应构建成功");
        let installer = fast_installer(client, &server.uri());
        let dir = tempfile::tempdir().unwrap();

        let installed = installer
            .install_for_platform(17, "windows-x64", dir.path())
            .await
            .expect("安装应成功");

        assert_eq!(installed.component, "java-runtime-gamma");
        assert_eq!(installed.version.major, 17);
        assert_eq!(installed.version.security, 8);
        let expected_exe = dir.path().join("bin").join("java.exe");
        assert_eq!(installed.java_executable, expected_exe);

        // 文件真实落盘且内容与下载对象一致。
        assert_eq!(std::fs::read(&expected_exe).unwrap(), gamma_java);
        assert_eq!(
            std::fs::read(dir.path().join("lib").join("rt")).unwrap(),
            gamma_lib
        );
    }

    /// 组件文件下载卡住时取消：1000 ms 内以 Cancelled 返回，卡住的那个文件不落盘。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_during_slow_file_returns_cancelled_quickly() {
        let server = MockServer::start().await;
        let base = server.uri();
        let java = b"MZ-slow-java".to_vec();
        let manifest = format!(
            r#"{{"files":{{
                "bin/java.exe":{{"type":"file","executable":true,"downloads":{{"raw":{{"sha1":"{}","size":{},"url":"{}/objects/slow-java"}}}}}}
            }}}}"#,
            sha1_hex(&java),
            java.len(),
            base,
        );
        let all_json = format!(
            r#"{{"windows-x64":{{"java-runtime-gamma":[{{"manifest":{{"sha1":"{}","size":{},"url":"{}/gamma.json"}},"version":{{"name":"17.0.8"}}}}]}}}}"#,
            sha1_hex(manifest.as_bytes()),
            manifest.len(),
            base,
        );
        mount_get(&server, "/all.json", all_json).await;
        mount_get(&server, "/gamma.json", manifest).await;
        Mock::given(method("GET"))
            .and(match_path("/objects/slow-java"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(java)
                    .set_delay(Duration::from_secs(30)),
            )
            .mount(&server)
            .await;

        let token = CancellationToken::new();
        let client = aurora_base::http::build_client().expect("客户端应构建成功");
        let installer = fast_installer(client, &base).with_cancel(token.clone());
        let dir = tempfile::tempdir().unwrap();
        let install_dir = dir.path().to_path_buf();
        let install = tokio::spawn(async move {
            installer
                .install_for_platform(17, "windows-x64", &install_dir)
                .await
        });

        // 等到卡住的那个对象请求已经发出，再取消。
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let requests = server.received_requests().await.unwrap_or_default();
            if requests
                .iter()
                .any(|r| r.url.path() == "/objects/slow-java")
            {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "对象请求未发出");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let cancelled_at = std::time::Instant::now();
        token.cancel();
        let err = install.await.unwrap().unwrap_err();

        assert!(err.is_cancelled(), "应为取消，实际：{err:?}");
        assert!(cancelled_at.elapsed() < Duration::from_millis(1000));
        assert!(!dir.path().join("bin").join("java.exe").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_selects_delta_for_major_21() {
        let server = MockServer::start().await;
        mount_full_manifest(&server).await;

        let client = aurora_base::http::build_client().unwrap();
        let installer = fast_installer(client, &server.uri());
        let dir = tempfile::tempdir().unwrap();

        let installed = installer
            .install_for_platform(21, "windows-x64", dir.path())
            .await
            .expect("安装 21 应成功");
        assert_eq!(installed.component, "java-runtime-delta");
        assert_eq!(installed.version.major, 21);
        assert!(dir.path().join("bin").join("java.exe").is_file());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unsupported_platform_errors() {
        let server = MockServer::start().await;
        mount_full_manifest(&server).await;
        let client = aurora_base::http::build_client().unwrap();
        let installer = fast_installer(client, &server.uri());
        let dir = tempfile::tempdir().unwrap();

        let err = installer
            .install_for_platform(17, "solaris-sparc", dir.path())
            .await
            .unwrap_err();
        assert!(matches!(err, Error::UnsupportedPlatform(p) if p == "solaris-sparc"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_major_errors() {
        let server = MockServer::start().await;
        mount_full_manifest(&server).await;
        let client = aurora_base::http::build_client().unwrap();
        let installer = fast_installer(client, &server.uri());
        let dir = tempfile::tempdir().unwrap();

        let err = installer
            .install_for_platform(8, "windows-x64", dir.path())
            .await
            .unwrap_err();
        assert!(matches!(err, Error::NoRuntimeForMajor { major: 8 }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn corrupt_object_exhausts_retries_with_hash_mismatch() {
        let server = MockServer::start().await;
        let base = server.uri();

        // 组件清单声明的 java sha1 与实际下发字节不符，触发 HashMismatch 重试直至耗尽。
        let real_bytes = b"whatever-bytes".to_vec();
        let gamma_manifest = format!(
            r#"{{"files":{{"bin/java.exe":{{"type":"file","downloads":{{"raw":{{"sha1":"{}","url":"{}/objects/gamma-java"}}}}}}}}}}"#,
            "0000000000000000000000000000000000000000", base,
        );
        let all_json = format!(
            r#"{{"windows-x64":{{"java-runtime-gamma":[{{"manifest":{{"sha1":"{}","url":"{}/gamma.json"}},"version":{{"name":"17.0.8"}}}}]}}}}"#,
            sha1_hex(gamma_manifest.as_bytes()),
            base,
        );
        mount_get(&server, "/all.json", all_json).await;
        mount_get(&server, "/gamma.json", gamma_manifest).await;
        mount_get_bytes(&server, "/objects/gamma-java", real_bytes).await;

        let client = aurora_base::http::build_client().unwrap();
        let installer = fast_installer(client, &base);
        let dir = tempfile::tempdir().unwrap();

        let err = installer
            .install_for_platform(17, "windows-x64", dir.path())
            .await
            .unwrap_err();
        // sha1 不符经 aurora-base 冒泡为 Base(HashMismatch)。
        assert!(
            matches!(err, Error::Base(aurora_base::Error::HashMismatch { algorithm, .. }) if algorithm == "SHA-1"),
            "应因 sha1 不符失败，实际: {err:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transient_5xx_is_retried_then_succeeds() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let server = MockServer::start().await;
        let base = server.uri();

        let gamma_java = b"MZ-fake".to_vec();
        let gamma_manifest = format!(
            r#"{{"files":{{"bin/java.exe":{{"type":"file","downloads":{{"raw":{{"sha1":"{}","url":"{}/objects/gamma-java"}}}}}}}}}}"#,
            sha1_hex(&gamma_java),
            base,
        );
        let all_json = format!(
            r#"{{"windows-x64":{{"java-runtime-gamma":[{{"manifest":{{"sha1":"{}","url":"{}/gamma.json"}},"version":{{"name":"17.0.8"}}}}]}}}}"#,
            sha1_hex(gamma_manifest.as_bytes()),
            base,
        );

        // all.json 第一次返回 503，之后 200：验证 5xx 触发重试后成功。
        let counter = Arc::new(AtomicUsize::new(0));
        Mock::given(method("GET"))
            .and(match_path("/all.json"))
            .respond_with(move |_req: &Request| {
                if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                    ResponseTemplate::new(503)
                } else {
                    ResponseTemplate::new(200).set_body_string(all_json.clone())
                }
            })
            .mount(&server)
            .await;
        mount_get(&server, "/gamma.json", gamma_manifest).await;
        mount_get_bytes(&server, "/objects/gamma-java", gamma_java.clone()).await;

        let client = aurora_base::http::build_client().unwrap();
        let installer = fast_installer(client, &base);
        let dir = tempfile::tempdir().unwrap();

        let installed = installer
            .install_for_platform(17, "windows-x64", dir.path())
            .await
            .expect("首个 503 后重试应成功");
        assert_eq!(installed.component, "java-runtime-gamma");
        assert_eq!(std::fs::read(dir.path().join("bin").join("java.exe")).unwrap(), gamma_java);
    }
}
