//! Mojang `java_runtime` 清单的下载与安装（architecture.md aurora-java 小节 v1 项）。
//!
//! 流程：拉 `all.json`（平台 -> 组件 -> 条目）→ 按目标主版本挑组件 → 拉该组件的文件清单，
//! 得到一份 [`RuntimePlan`]（每个文件的落盘路径、官方直链、sha1 与大小）。
//!
//! 文件本身由调用方下载：上层把计划转成批量下载任务（并发、换源、进度、已就绪文件按 sha1 跳过），
//! 下完再调 [`RuntimePlan::finalize`] 建目录、设可执行位、建链接。
//!
//! 组件清单的 sha1 校验放在内存里、且在重试闭包内完成：校验不符会冒泡成 aurora-base 的
//! `HashMismatch`（可重试），于是一次损坏的下载会自动重新拉取。

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
pub const MOJANG_JAVA_RUNTIME_ALL: &str = "https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

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
    /// 对象大小（字节）。清单通常都给，缺省时下载进度没有总字节数。
    #[serde(default)]
    pub size: Option<u64>,
    /// 对象直链（官方域名，下载前经镜像改写）。
    pub url: String,
}

/// 一次运行时安装要做的全部事情。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimePlan {
    /// 组件名，如 `java-runtime-gamma`。
    pub component: String,
    /// 组件版本（由清单声明的 `version.name` 解析）。
    pub version: JavaVersion,
    /// 安装后 java 可执行文件的绝对路径。
    pub java_executable: PathBuf,
    /// 要下载的文件，按清单里的相对路径排序。
    pub files: Vec<RuntimeFile>,
    /// 清单显式列出的目录（含空目录）。
    pub directories: Vec<PathBuf>,
    /// 符号链接（只有 mac/linux 运行时会出现）。
    pub links: Vec<RuntimeLink>,
}

/// 计划里的一个文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeFile {
    /// 落盘绝对路径。
    pub path: PathBuf,
    /// 官方直链（未经镜像改写；换源由下载方按自己的源策略做）。
    pub url: String,
    /// 期望 sha1。
    pub sha1: String,
    /// 期望大小（字节）。
    pub size: Option<u64>,
    /// 是否需要可执行权限（Unix 生效）。
    pub executable: bool,
}

/// 计划里的一个符号链接。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeLink {
    /// 链接本身的绝对路径。
    pub path: PathBuf,
    /// 链接指向的目标（清单原样给出的相对路径）。
    pub target: String,
}

impl RuntimePlan {
    /// 文件下载完之后收尾：建清单里的目录、给可执行文件加权限、建符号链接。
    ///
    /// 可重复调用：目录已在不报错，同名旧链接先删再建，重装同一运行时不会因为残留而失败。
    pub async fn finalize(&self) -> Result<()> {
        for dir in &self.directories {
            tokio::fs::create_dir_all(dir)
                .await
                .map_err(|source| aurora_base::Error::Io {
                    path: dir.clone(),
                    source,
                })?;
        }
        for file in &self.files {
            set_executable(&file.path, file.executable)?;
        }
        for link in &self.links {
            create_symlink(&link.target, &link.path)?;
        }
        Ok(())
    }

    /// 安装产物描述。
    pub fn installed(&self) -> InstalledRuntime {
        InstalledRuntime {
            component: self.component.clone(),
            version: self.version.clone(),
            java_executable: self.java_executable.clone(),
        }
    }
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

    /// 挂取消令牌：拉取清单的网络等待中触发即放弃该请求，以 [`Error::Cancelled`] 返回。
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

    /// 为当前平台给出安装匹配 `required_major` 的运行时到 `install_dir` 的计划。
    pub async fn plan(&self, required_major: u32, install_dir: &Path) -> Result<RuntimePlan> {
        self.plan_for_platform(required_major, current_platform(), install_dir)
            .await
    }

    /// 显式指定平台键的计划入口（测试用 `windows-x64` 注入，避开真实平台判定）。
    pub async fn plan_for_platform(
        &self,
        required_major: u32,
        platform: &str,
        install_dir: &Path,
    ) -> Result<RuntimePlan> {
        let manifest = self.fetch_manifest().await?;
        let platform_map = manifest
            .get(platform)
            .ok_or_else(|| Error::UnsupportedPlatform(platform.to_owned()))?;
        let (component_name, component) =
            select_component(platform_map, required_major).ok_or(Error::NoRuntimeForMajor {
                major: required_major,
            })?;

        let files = self.fetch_component_files(component).await?;
        let java_rel = locate_java_executable(&files)?.ok_or(Error::MissingJavaExecutable)?;
        let version =
            JavaVersion::parse(&component.version.name).ok_or_else(|| Error::JavaVersionParse {
                output: component.version.name.clone(),
            })?;
        build_plan(
            component_name,
            version,
            install_dir,
            &files,
            install_dir.join(java_rel),
        )
    }

    /// 拉取并校验某组件的文件清单（含对清单自身的 sha1 校验）。
    async fn fetch_component_files(&self, component: &RuntimeComponent) -> Result<ComponentFiles> {
        let url = mirror::rewrite(&component.manifest.url, self.source)?;
        let bytes = self
            .get_verified_bytes(&url, &component.manifest.sha1)
            .await?;
        parse_json(&bytes, "java-runtime component manifest")
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
            let resp = client.get(url).send().await.map_err(|source| Error::Http {
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
            let resp = client.get(url).send().await.map_err(|source| Error::Http {
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
    entries.iter().max_by(|a, b| {
        JavaVersion::parse(&a.version.name).cmp(&JavaVersion::parse(&b.version.name))
    })
}

/// 把组件文件清单摊成计划：相对路径落到 `install_dir` 下，清单的 BTreeMap 顺序即计划顺序。任何一条
/// 路径或链接目标会落到 `install_dir` 之外时整份计划作废，一个文件都不下。
fn build_plan(
    component: &str,
    version: JavaVersion,
    install_dir: &Path,
    files: &ComponentFiles,
    java_executable: PathBuf,
) -> Result<RuntimePlan> {
    let mut plan = RuntimePlan {
        component: component.to_owned(),
        version,
        java_executable,
        files: Vec::new(),
        directories: Vec::new(),
        links: Vec::new(),
    };
    for (rel, entry) in &files.files {
        let path = install_dir.join(rel_to_path(rel)?);
        match entry {
            FileEntry::Directory => plan.directories.push(path),
            FileEntry::File {
                downloads,
                executable,
            } => plan.files.push(RuntimeFile {
                path,
                url: downloads.raw.url.clone(),
                sha1: downloads.raw.sha1.clone(),
                size: downloads.raw.size,
                executable: *executable,
            }),
            FileEntry::Link { target } => {
                check_link_target(rel, target)?;
                plan.links.push(RuntimeLink {
                    path,
                    target: target.clone(),
                });
            }
        }
    }
    Ok(plan)
}

/// 从文件清单里定位 java 可执行文件的相对路径（`bin/java` 或 `bin/java.exe`）；清单里没有时 `Ok(None)`。
fn locate_java_executable(files: &ComponentFiles) -> Result<Option<PathBuf>> {
    files
        .files
        .iter()
        .find(|(rel, entry)| {
            matches!(entry, FileEntry::File { .. })
                && (rel.ends_with("bin/java.exe") || rel.ends_with("bin/java"))
        })
        .map(|(rel, _)| rel_to_path(rel))
        .transpose()
}

/// 把清单里以 `/` 分隔的相对路径转成本平台 `PathBuf`；能走出安装目录的报 [`Error::UnsafeRuntimePath`]。
fn rel_to_path(rel: &str) -> Result<PathBuf> {
    match unsafe_reason(rel) {
        Some(reason) => Err(Error::UnsafeRuntimePath {
            path: rel.to_owned(),
            reason,
        }),
        None => Ok(rel.split('/').collect()),
    }
}

/// 相对路径为什么不能拼进安装目录；能拼时 `None`。规则与版本域对库路径、资源逻辑名的判定一致（本 crate
/// 不依赖版本域，在这里单独实现）：Windows 上反斜杠也是分隔符，冒号引出盘符或备用数据流，段尾的点与空格
/// 会被悄悄去掉。
fn unsafe_reason(rel: &str) -> Option<&'static str> {
    if rel.is_empty() {
        return Some("为空");
    }
    if rel.starts_with('/') {
        return Some("是绝对路径");
    }
    if rel.contains('\\') {
        return Some("含反斜杠");
    }
    if rel.contains(':') {
        return Some("含冒号（盘符或备用数据流）");
    }
    rel.split('/').find_map(|segment| {
        if segment.is_empty() {
            Some("含空段")
        } else if segment == "." || segment == ".." {
            Some("含 . 或 .. 段")
        } else if segment.ends_with(['.', ' ']) {
            Some("有段以点或空格结尾")
        } else {
            None
        }
    })
}

/// 符号链接的目标相对链接所在目录解析（mac 运行时里 `../Home/lib/libjli.dylib` 这类），按段推演后不能
/// 越过安装目录的根，也不能是绝对路径或带盘符、反斜杠。
fn check_link_target(link: &str, target: &str) -> Result<()> {
    let escapes = || Error::UnsafeRuntimeLink {
        path: link.to_owned(),
        target: target.to_owned(),
    };
    if target.is_empty() || target.starts_with('/') || target.contains(['\\', ':']) {
        return Err(escapes());
    }
    // 链接自身所在目录的深度：`a/b/link` 在第 2 层。
    let mut depth = link.split('/').count() - 1;
    for segment in target.split('/') {
        match segment {
            "" | "." => {}
            ".." => depth = depth.checked_sub(1).ok_or_else(escapes)?,
            _ => depth += 1,
        }
    }
    Ok(())
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

/// 建立符号链接（Windows 运行时清单不含链接，此路为跨平台完整性兜底）。同名旧链接先删掉。
fn create_symlink(target: &str, link: &Path) -> Result<()> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|source| aurora_base::Error::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    if std::fs::symlink_metadata(link).is_ok() {
        std::fs::remove_file(link).map_err(|source| aurora_base::Error::Io {
            path: link.to_path_buf(),
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
            rel_to_path("bin/java.exe").unwrap(),
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

    /// 拉组件清单卡住时取消：1000 ms 内以 Cancelled 返回。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_while_fetching_the_component_manifest_returns_quickly() {
        let server = MockServer::start().await;
        let base = server.uri();
        let manifest = r#"{"files":{}}"#;
        let all_json = format!(
            r#"{{"windows-x64":{{"java-runtime-gamma":[{{"manifest":{{"sha1":"{}","size":{},"url":"{}/gamma.json"}},"version":{{"name":"17.0.8"}}}}]}}}}"#,
            sha1_hex(manifest.as_bytes()),
            manifest.len(),
            base,
        );
        mount_get(&server, "/all.json", all_json).await;
        Mock::given(method("GET"))
            .and(match_path("/gamma.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(manifest)
                    .set_delay(Duration::from_secs(30)),
            )
            .mount(&server)
            .await;

        let token = CancellationToken::new();
        let client = aurora_base::http::build_client().expect("客户端应构建成功");
        let installer = fast_installer(client, &base).with_cancel(token.clone());
        let dir = tempfile::tempdir().unwrap();
        let install_dir = dir.path().to_path_buf();
        let plan = tokio::spawn(async move {
            installer
                .plan_for_platform(17, "windows-x64", &install_dir)
                .await
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let requests = server.received_requests().await.unwrap_or_default();
            if requests.iter().any(|r| r.url.path() == "/gamma.json") {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "组件清单请求未发出");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let cancelled_at = std::time::Instant::now();
        token.cancel();
        let err = plan.await.unwrap().unwrap_err();

        assert!(err.is_cancelled(), "应为取消，实际：{err:?}");
        assert!(cancelled_at.elapsed() < Duration::from_millis(1000));
    }

    /// 计划给出每个文件的落盘路径、官方直链、sha1 与大小，且只拉清单、不下任何对象文件。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn plan_lists_files_without_downloading_objects() {
        let server = MockServer::start().await;
        let (gamma_java, gamma_lib) = mount_full_manifest(&server).await;
        let base = server.uri();
        let client = aurora_base::http::build_client().unwrap();
        let installer = fast_installer(client, &base);
        let dir = tempfile::tempdir().unwrap();

        let plan = installer
            .plan_for_platform(17, "windows-x64", dir.path())
            .await
            .expect("计划应成功");

        assert_eq!(plan.component, "java-runtime-gamma");
        assert_eq!(
            plan.java_executable,
            dir.path().join("bin").join("java.exe")
        );
        assert_eq!(plan.directories, vec![dir.path().join("bin")]);
        assert!(plan.links.is_empty());
        assert_eq!(
            plan.files,
            vec![
                RuntimeFile {
                    path: dir.path().join("bin").join("java.exe"),
                    url: format!("{base}/objects/gamma-java"),
                    sha1: sha1_hex(&gamma_java),
                    size: Some(gamma_java.len() as u64),
                    executable: true,
                },
                RuntimeFile {
                    path: dir.path().join("lib").join("rt"),
                    url: format!("{base}/objects/gamma-lib"),
                    sha1: sha1_hex(&gamma_lib),
                    size: Some(gamma_lib.len() as u64),
                    executable: false,
                },
            ]
        );
        let requests = server.received_requests().await.unwrap();
        assert!(
            !requests
                .iter()
                .any(|r| r.url.path().starts_with("/objects/")),
            "计划阶段不应下载对象文件"
        );
        assert!(!dir.path().join("bin").exists(), "计划阶段不落盘");

        plan.finalize().await.unwrap();
        assert!(dir.path().join("bin").is_dir(), "收尾应建出清单里的目录");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn plan_selects_delta_for_major_21() {
        let server = MockServer::start().await;
        mount_full_manifest(&server).await;

        let client = aurora_base::http::build_client().unwrap();
        let installer = fast_installer(client, &server.uri());
        let dir = tempfile::tempdir().unwrap();

        let plan = installer
            .plan_for_platform(21, "windows-x64", dir.path())
            .await
            .expect("21 的计划应成功");
        let installed = plan.installed();
        assert_eq!(installed.component, "java-runtime-delta");
        assert_eq!(installed.version.major, 21);
        assert_eq!(
            installed.java_executable,
            dir.path().join("bin").join("java.exe")
        );
        assert_eq!(plan.files.len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unsupported_platform_errors() {
        let server = MockServer::start().await;
        mount_full_manifest(&server).await;
        let client = aurora_base::http::build_client().unwrap();
        let installer = fast_installer(client, &server.uri());
        let dir = tempfile::tempdir().unwrap();

        let err = installer
            .plan_for_platform(17, "solaris-sparc", dir.path())
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
            .plan_for_platform(8, "windows-x64", dir.path())
            .await
            .unwrap_err();
        assert!(matches!(err, Error::NoRuntimeForMajor { major: 8 }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn corrupt_component_manifest_exhausts_retries_with_hash_mismatch() {
        let server = MockServer::start().await;
        let base = server.uri();

        // all.json 声明的组件清单 sha1 与实际下发的清单不符，触发 HashMismatch 重试直至耗尽。
        let gamma_manifest = r#"{"files":{}}"#.to_owned();
        let all_json = format!(
            r#"{{"windows-x64":{{"java-runtime-gamma":[{{"manifest":{{"sha1":"{}","url":"{}/gamma.json"}},"version":{{"name":"17.0.8"}}}}]}}}}"#,
            "0000000000000000000000000000000000000000", base,
        );
        mount_get(&server, "/all.json", all_json).await;
        mount_get(&server, "/gamma.json", gamma_manifest).await;

        let client = aurora_base::http::build_client().unwrap();
        let installer = fast_installer(client, &base);
        let dir = tempfile::tempdir().unwrap();

        let err = installer
            .plan_for_platform(17, "windows-x64", dir.path())
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

        let client = aurora_base::http::build_client().unwrap();
        let installer = fast_installer(client, &base);
        let dir = tempfile::tempdir().unwrap();

        let plan = installer
            .plan_for_platform(17, "windows-x64", dir.path())
            .await
            .expect("首个 503 后重试应成功");
        assert_eq!(plan.component, "java-runtime-gamma");
        assert_eq!(plan.files[0].sha1, sha1_hex(&gamma_java));
    }

    // ---- 清单路径越界：清单与文件 sha1 同源，恶意条目能把合法 sha1 的文件写到运行时目录之外 ----

    /// 递归列出目录下的全部文件与目录。
    fn entries_under(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            for entry in std::fs::read_dir(&current).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path.clone());
                }
                out.push(path);
            }
        }
        out
    }

    /// 挂一份只含给定文件条目的组件清单，返回 mock 地址。
    async fn mount_component(server: &MockServer, files: serde_json::Value) {
        let base = server.uri();
        let manifest = serde_json::json!({ "files": files }).to_string();
        let all_json = serde_json::json!({
            "windows-x64": {"java-runtime-gamma": [{
                "manifest": {"sha1": sha1_hex(manifest.as_bytes()), "url": format!("{base}/gamma.json")},
                "version": {"name": "17.0.8"}
            }]}
        })
        .to_string();
        mount_get(server, "/all.json", all_json).await;
        mount_get(server, "/gamma.json", manifest).await;
    }

    fn file_entry(base: &str) -> serde_json::Value {
        serde_json::json!({"type": "file", "downloads": {"raw": {
            "sha1": sha1_hex(b"x"), "size": 1, "url": format!("{base}/objects/x")
        }}})
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn manifest_paths_escaping_the_runtime_dir_are_rejected() {
        for (path, reason) in [
            ("../../escaped.dll", "含 . 或 .. 段"),
            ("bin/../../escaped.dll", "含 . 或 .. 段"),
            ("/abs/escaped.dll", "是绝对路径"),
            ("C:/Windows/escaped.dll", "含冒号（盘符或备用数据流）"),
            ("C:escaped.dll", "含冒号（盘符或备用数据流）"),
            ("bin\\..\\..\\escaped.dll", "含反斜杠"),
            ("bin/java.exe:stream", "含冒号（盘符或备用数据流）"),
            ("bin//escaped.dll", "含空段"),
            ("bin/escaped.dll.", "有段以点或空格结尾"),
        ] {
            let server = MockServer::start().await;
            let base = server.uri();
            mount_component(
                &server,
                serde_json::json!({ "bin/java.exe": file_entry(&base), path: file_entry(&base) }),
            )
            .await;
            let tmp = tempfile::tempdir().unwrap();
            let install_dir = tmp.path().join("runtime").join("17");

            let err = fast_installer(aurora_base::http::build_client().unwrap(), &base)
                .plan_for_platform(17, "windows-x64", &install_dir)
                .await
                .unwrap_err();

            assert!(
                matches!(&err, Error::UnsafeRuntimePath { path: got, reason: why } if got == path && *why == reason),
                "{path:?}: {err:?}"
            );
            assert_eq!(entries_under(tmp.path()), Vec::<PathBuf>::new(), "{path:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn links_pointing_outside_the_runtime_dir_are_rejected() {
        for target in [
            "../../../../escaped",
            "/etc/passwd",
            "C:/Windows/System32",
            "..\\..\\escaped",
            "",
        ] {
            let server = MockServer::start().await;
            let base = server.uri();
            mount_component(
                &server,
                serde_json::json!({
                    "bin/java.exe": file_entry(&base),
                    "jre.bundle/Contents/MacOS/libjli.dylib": {"type": "link", "target": target}
                }),
            )
            .await;
            let tmp = tempfile::tempdir().unwrap();

            let err = fast_installer(aurora_base::http::build_client().unwrap(), &base)
                .plan_for_platform(17, "windows-x64", &tmp.path().join("17"))
                .await
                .unwrap_err();

            assert!(
                matches!(&err, Error::UnsafeRuntimeLink { path, target: got }
                    if path == "jre.bundle/Contents/MacOS/libjli.dylib" && got == target),
                "{target:?}: {err:?}"
            );
            assert_eq!(
                entries_under(tmp.path()),
                Vec::<PathBuf>::new(),
                "{target:?}"
            );
        }
    }

    /// mac 运行时真实的链接形态：目标经 `..` 回到包内另一个目录，仍在安装目录里。
    #[test]
    fn links_staying_inside_the_runtime_dir_are_kept() {
        let files: ComponentFiles = serde_json::from_value(serde_json::json!({"files": {
            "jre.bundle/Contents/Home/bin/java": {"type": "file", "executable": true,
                "downloads": {"raw": {"sha1": "a", "size": 1, "url": "https://x/java"}}},
            "jre.bundle/Contents/MacOS/libjli.dylib": {"type": "link", "target": "../Home/lib/libjli.dylib"},
            "jre.bundle/Contents/Home/lib/jli": {"type": "link", "target": "../../.."}
        }}))
        .unwrap();
        let root = PathBuf::from("/rt");
        let plan = build_plan(
            "jre-legacy",
            JavaVersion::parse("17.0.8").unwrap(),
            &root,
            &files,
            root.join("jre.bundle/Contents/Home/bin/java"),
        )
        .unwrap();
        assert_eq!(
            plan.links,
            vec![
                RuntimeLink {
                    path: root
                        .join("jre.bundle")
                        .join("Contents")
                        .join("Home")
                        .join("lib")
                        .join("jli"),
                    target: "../../..".into(),
                },
                RuntimeLink {
                    path: root
                        .join("jre.bundle")
                        .join("Contents")
                        .join("MacOS")
                        .join("libjli.dylib"),
                    target: "../Home/lib/libjli.dylib".into(),
                },
            ]
        );
        assert!(check_link_target("jre.bundle/Contents/Home/lib/jli", "../../../..").is_ok());
        assert!(check_link_target("jre.bundle/Contents/Home/lib/jli", "../../../../..").is_err());
    }
}
