//! Forge 与 NeoForge 安装（安装器注入式）。
//!
//! 现代 Forge（1.13+）与 NeoForge 走同构逻辑：installer jar 内含 `install_profile.json`（声明
//! 一批处理器 JVM 调用与一张 data 占位符表）加一份 `version.json`（最终版本描述）。安装 =
//! 解出 version.json 落盘 → 下载 install_profile 与 version 声明的库 → 把 data 表按目标 side
//! 塌缩并解析 `[maven坐标]`/`/jar内路径`/`'字面量'` 三种取值 → 逐个处理器把 `{占位符}` 替换成
//! 实际值后调 java 运行 → 校验各处理器 outputs 的 sha1。旧版 Forge（install_profile 带 `install`
//! 字段而无 processors）则直接把 `versionInfo` 落盘、从 zip 解出通用 jar，不跑处理器。
//!
//! 占位符替换、data 塌缩、classpath 组装、Main-Class 解析都抽成纯函数，表驱动单测覆盖；真正的
//! java 子进程执行与库下载是集成层，本模块负责把它们按 install_profile 的语义正确编排。

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;

use aurora_download::{CancellationToken, SourcePlan};
use serde::Deserialize;
use tokio::process::{Child, Command};

use crate::context::InstallContext;
use crate::error::{Error, Result, io_err, zip_err};
use crate::net;
use crate::plan;
use aurora_version::VersionJson;

/// install_profile.json 模型（现代与 legacy 字段并存，按 `installer 是否含 install/processors` 分流）。
#[derive(Debug, Clone, Deserialize)]
struct InstallProfile {
    /// 现代：待安装版本 id（如 `1.20.1-forge-47.2.0`）。
    #[serde(default)]
    version: Option<String>,
    /// 现代：installer jar 内 version.json 的路径（如 `/version.json`）。
    #[serde(default)]
    json: Option<String>,
    /// 目标 Minecraft 版本号。
    #[serde(default)]
    minecraft: Option<String>,
    /// data 占位符表：键 -> {client, server}。
    #[serde(default)]
    data: BTreeMap<String, SidedData>,
    /// 处理器（JVM 调用）列表。
    #[serde(default)]
    processors: Vec<Processor>,
    /// 运行处理器所需的库（piston 结构）。
    #[serde(default)]
    libraries: Vec<aurora_version::Library>,
    /// legacy：安装指令块（含通用 jar 坐标与 zip 内路径）。
    #[serde(default)]
    install: Option<LegacyInstall>,
    /// legacy：直接内联的版本 JSON。
    #[serde(rename = "versionInfo", default)]
    version_info: Option<serde_json::Value>,
}

/// data 表某键的两侧取值。
#[derive(Debug, Clone, Deserialize)]
struct SidedData {
    client: String,
    server: String,
}

/// 一个处理器的定义。
#[derive(Debug, Clone, Deserialize)]
struct Processor {
    /// 适用 side；缺省表示 client/server 都跑。
    #[serde(default)]
    sides: Option<Vec<String>>,
    /// 可执行 jar 的 maven 坐标（其 Main-Class 被调用）。
    jar: String,
    /// classpath 上的 maven 坐标。
    #[serde(default)]
    classpath: Vec<String>,
    /// 命令行参数（含 `{占位符}` 与 `[坐标]`）。
    #[serde(default)]
    args: Vec<String>,
    /// 期望产物：路径占位符 -> sha1 占位符。
    #[serde(default)]
    outputs: BTreeMap<String, String>,
}

/// legacy 安装指令块。
#[derive(Debug, Clone, Deserialize)]
struct LegacyInstall {
    /// 通用 jar 的 maven 坐标。
    #[serde(default)]
    path: Option<String>,
    /// 通用 jar 在 installer zip 内的路径。
    #[serde(rename = "filePath", default)]
    file_path: Option<String>,
}

/// 一次 Forge/NeoForge 安装的结果计数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeSummary {
    /// 安装的版本 id。
    pub id: String,
    /// 下载的库文件数。
    pub libraries: usize,
    /// 实际执行的处理器数（legacy 为 0）。
    pub processors: usize,
}

/// data 表取值的三种语义。
#[derive(Debug, Clone, PartialEq, Eq)]
enum DataValue {
    /// `[maven 坐标]`：解析为库文件绝对路径。
    Coordinate(String),
    /// `/jar 内路径`：从 installer jar 解出到临时目录。
    ExtractedFile(String),
    /// `'字面量'` 或裸字面量：原样（去引号）。
    Literal(String),
}

/// 判定一个 data 取值的语义。
fn classify_data_value(raw: &str) -> DataValue {
    let bytes = raw.as_bytes();
    let len = bytes.len();
    if len >= 2 && bytes[0] == b'[' && bytes[len - 1] == b']' {
        DataValue::Coordinate(raw[1..len - 1].to_owned())
    } else if len >= 2 && bytes[0] == b'\'' && bytes[len - 1] == b'\'' {
        DataValue::Literal(raw[1..len - 1].to_owned())
    } else if raw.starts_with('/') {
        DataValue::ExtractedFile(raw.to_owned())
    } else {
        DataValue::Literal(raw.to_owned())
    }
}

/// 取 data 表某键在指定 side 的原始取值。
fn sided_value<'a>(data: &'a SidedData, side: &str) -> &'a str {
    if side == "server" {
        &data.server
    } else {
        &data.client
    }
}

/// 把 data 表按 side 塌缩并解析为「键 -> 实际值字符串」。
///
/// `extracted` 是「`/jar 内路径` -> 已解出的临时文件路径」映射，由调用方先从 installer jar 解出。
fn resolve_data(
    data: &BTreeMap<String, SidedData>,
    side: &str,
    layout: &crate::layout::GameLayout,
    extracted: &BTreeMap<String, PathBuf>,
) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for (key, sided) in data {
        let raw = sided_value(sided, side);
        let value = match classify_data_value(raw) {
            DataValue::Coordinate(coord) => layout
                .library_path_for_coordinate(&coord)
                .ok_or_else(|| Error::InvalidLibraryCoordinate { name: coord })?
                .to_string_lossy()
                .into_owned(),
            DataValue::ExtractedFile(path) => extracted
                .get(&path)
                .ok_or_else(|| Error::InstallerEntryMissing { entry: path.clone() })?
                .to_string_lossy()
                .into_owned(),
            DataValue::Literal(literal) => literal,
        };
        out.insert(key.clone(), value);
    }
    Ok(out)
}

/// 把字符串里所有 `{KEY}` 占位符替换为 `values` 中的值；引用未知键即报错，不静默留空。
fn replace_placeholders(input: &str, values: &BTreeMap<String, String>) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            // 没有闭合花括号，剩余部分当字面量。
            out.push('{');
            rest = after;
            continue;
        };
        let key = &after[..close];
        let value = values
            .get(key)
            .ok_or_else(|| Error::DataKeyMissing { key: key.to_owned() })?;
        out.push_str(value);
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// 替换单个处理器参数：整体 `[坐标]` 直接解析为库路径，否则做 `{占位符}` 替换。
fn substitute_arg(
    arg: &str,
    values: &BTreeMap<String, String>,
    layout: &crate::layout::GameLayout,
) -> Result<String> {
    let bytes = arg.as_bytes();
    let len = bytes.len();
    if len >= 2 && bytes[0] == b'[' && bytes[len - 1] == b']' {
        let coord = &arg[1..len - 1];
        return Ok(layout
            .library_path_for_coordinate(coord)
            .ok_or_else(|| Error::InvalidLibraryCoordinate {
                name: coord.to_owned(),
            })?
            .to_string_lossy()
            .into_owned());
    }
    replace_placeholders(arg, values)
}

/// classpath 分隔符：Windows 用 `;`，其余用 `:`。
fn classpath_separator() -> char {
    if cfg!(windows) { ';' } else { ':' }
}

/// 组装处理器的 `-cp` 串：classpath 坐标（保序）后接可执行 jar 坐标，均解析为库绝对路径。
fn build_classpath(
    jar: &str,
    classpath: &[String],
    layout: &crate::layout::GameLayout,
) -> Result<String> {
    let mut parts = Vec::with_capacity(classpath.len() + 1);
    for coord in classpath.iter().chain(std::iter::once(&jar.to_owned())) {
        let path = layout
            .library_path_for_coordinate(coord)
            .ok_or_else(|| Error::InvalidLibraryCoordinate {
                name: coord.clone(),
            })?;
        parts.push(path.to_string_lossy().into_owned());
    }
    Ok(parts.join(&classpath_separator().to_string()))
}

/// 从 MANIFEST.MF 文本解析 Main-Class（处理 72 列续行：续行以单空格起头）。
fn parse_main_class(manifest: &str) -> Option<String> {
    let mut lines = manifest.lines();
    while let Some(line) = lines.next() {
        if let Some(value) = line.strip_prefix("Main-Class:") {
            let mut result = value.trim().to_owned();
            // 续行拼接。
            for cont in lines.by_ref() {
                if let Some(more) = cont.strip_prefix(' ') {
                    result.push_str(more.trim_end_matches(['\r', '\n']));
                } else {
                    break;
                }
            }
            if result.is_empty() {
                return None;
            }
            return Some(result);
        }
    }
    None
}

/// 判断处理器是否适用于指定 side。
fn side_applies(sides: Option<&Vec<String>>, side: &str) -> bool {
    match sides {
        None => true,
        Some(list) => list.iter().any(|s| s == side),
    }
}

/// 构造 Forge 官方 installer 的下载 URL。
pub fn forge_installer_url(mc_version: &str, forge_version: &str) -> String {
    format!(
        "https://maven.minecraftforge.net/net/minecraftforge/forge/{mc_version}-{forge_version}/forge-{mc_version}-{forge_version}-installer.jar"
    )
}

/// 构造 NeoForge 官方 installer 的下载 URL。1.20.1 的构建（47.x）沿用 Forge 坐标
/// `net.neoforged:forge:1.20.1-<版本>`，其余走 `net.neoforged:neoforge:<版本>`。
pub fn neoforge_installer_url(neoforge_version: &str) -> String {
    if neoforge_version.starts_with(crate::forge_versions::NEOFORGE_LEGACY_PREFIX) {
        return format!(
            "https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-{neoforge_version}/forge-1.20.1-{neoforge_version}-installer.jar"
        );
    }
    format!(
        "https://maven.neoforged.net/releases/net/neoforged/neoforge/{neoforge_version}/neoforge-{neoforge_version}-installer.jar"
    )
}

/// 安装产物落在哪里。
#[derive(Debug, Clone, Copy)]
enum Target<'t> {
    /// 传统布局：版本 JSON 写到 `versions/<forge 版本 id>/`，处理器读原版目录里的客户端 jar。
    Standalone,
    /// 按实例安装：版本 JSON 不落盘（交给调用方与原版合并后写进实例目录），处理器读实例目录里的
    /// 客户端 jar，临时文件也放在实例目录下。
    Instance(&'t str),
}

/// Forge/NeoForge 安装器。需注入 java 可执行文件路径以运行处理器。
pub struct ForgeInstaller<'a> {
    cx: InstallContext<'a>,
    java_path: PathBuf,
    side: String,
    sources: Option<SourcePlan>,
    cancel: Option<CancellationToken>,
}

impl<'a> ForgeInstaller<'a> {
    /// 用共享上下文与 java 可执行文件构造，默认安装 client 侧。
    pub fn new(cx: InstallContext<'a>, java_path: impl Into<PathBuf>) -> Self {
        Self {
            cx,
            java_path: java_path.into(),
            side: "client".to_owned(),
            sources: None,
            cancel: None,
        }
    }

    /// installer 旁的 `.sha1` 校验文件按此方案在官方与镜像之间兜底抓取。
    pub fn with_sources(mut self, sources: SourcePlan) -> Self {
        self.sources = Some(sources);
        self
    }

    /// 挂取消令牌：触发后不再起新的处理器，正在跑的处理器子进程被结束、等它真正退出后以
    /// [`aurora_download::Error::Cancelled`] 返回。下载阶段的取消由上下文里的下载池自己负责。
    pub fn with_cancel(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    /// 下载 installer 到缓存目录再安装，版本 JSON 写到 `versions/<forge 版本 id>/`。
    pub async fn install(&self, installer_url: &str) -> Result<ForgeSummary> {
        let installer = self.download_installer(installer_url).await?;
        let (_, summary) = self.install_from(&installer, Target::Standalone).await?;
        self.discard_installer(&installer).await;
        Ok(summary)
    }

    /// 为实例 `instance_id` 安装：处理器读实例目录里已就绪的客户端 jar；返回 installer 内嵌的
    /// 版本 JSON（带 inheritsFrom，尚未与原版合并）与安装计数，版本 JSON 由调用方合并后落盘。
    pub async fn install_for_instance(
        &self,
        installer_url: &str,
        instance_id: &str,
    ) -> Result<(VersionJson, ForgeSummary)> {
        let installer = self.download_installer(installer_url).await?;
        let outcome = self
            .install_from(&installer, Target::Instance(instance_id))
            .await?;
        self.discard_installer(&installer).await;
        Ok(outcome)
    }

    /// 从已下载的 installer jar 安装（传统布局）。
    pub async fn install_from_installer(&self, installer: &Path) -> Result<ForgeSummary> {
        Ok(self.install_from(installer, Target::Standalone).await?.1)
    }

    /// installer 下到 `<根>/.<slug>-cache/<文件名>`，带 Maven 侧 `.sha1` 校验：同一版本重试安装时
    /// 校验通过的旧文件直接复用，不再重下几十 MB。
    async fn download_installer(&self, installer_url: &str) -> Result<PathBuf> {
        let file_name = installer_url.rsplit('/').next().unwrap_or("installer.jar");
        let dest = self.installer_cache_dir().join(file_name);
        let mut task = aurora_download::DownloadTask::new(installer_url, dest.clone());
        match self.installer_sha1(installer_url).await {
            Ok(sha1) => task = task.with_sha1(sha1),
            // 拿不到校验值只影响复用：没有 sha1 时下载引擎每次都重下，安装本身照常进行。
            Err(err) => {
                tracing::warn!(url = installer_url, error = %err, "取不到 installer 的 sha1，本次不复用缓存")
            }
        }
        self.cx.run_batch(vec![task], "installer", None).await?;
        Ok(dest)
    }

    fn installer_cache_dir(&self) -> PathBuf {
        self.cx
            .layout
            .root()
            .join(concat!(".", aurora_base::app_slug!(), "-cache"))
    }

    async fn installer_sha1(&self, installer_url: &str) -> Result<String> {
        let bytes = net::get_bytes_from(
            self.cx.client,
            self.sources.as_ref(),
            &format!("{installer_url}.sha1"),
            self.cx.policy,
        )
        .await?;
        let text = String::from_utf8(bytes).map_err(|err| Error::UnsupportedInstallProfile {
            reason: format!("installer 的 .sha1 不是文本: {err}"),
        })?;
        let sha1 = text
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if sha1.len() != 40 || !sha1.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::UnsupportedInstallProfile {
                reason: format!("installer 的 .sha1 内容不是 sha1：{text}"),
            });
        }
        Ok(sha1)
    }

    /// 安装成功后删掉 installer 与空了的缓存目录。删不掉不影响安装结果，只记日志。
    async fn discard_installer(&self, installer: &Path) {
        if let Err(err) = tokio::fs::remove_file(installer).await {
            tracing::warn!(path = %installer.display(), %err, "删除已用完的 installer 失败");
            return;
        }
        // 目录里还有别的 installer（并行安装）时 remove_dir 失败，正是想要的结果。
        let _ = tokio::fs::remove_dir(self.installer_cache_dir()).await;
    }

    async fn install_from(
        &self,
        installer: &Path,
        target: Target<'_>,
    ) -> Result<(VersionJson, ForgeSummary)> {
        let profile_bytes = read_zip_entry_async(installer, "install_profile.json").await?;
        let profile: InstallProfile = net::parse_json(&profile_bytes, "install_profile.json")?;

        if profile.install.is_some() && profile.processors.is_empty() {
            self.install_legacy(installer, &profile, target).await
        } else if profile.json.is_some() {
            self.install_modern(installer, profile, target).await
        } else {
            Err(Error::UnsupportedInstallProfile {
                reason: "既无 processors/json 也无 legacy install 字段".to_owned(),
            })
        }
    }

    /// 现代安装：解出 version.json、下库、跑处理器。
    async fn install_modern(
        &self,
        installer: &Path,
        profile: InstallProfile,
        target: Target<'_>,
    ) -> Result<(VersionJson, ForgeSummary)> {
        let version_id = profile.version.clone().ok_or_else(|| {
            Error::UnsupportedInstallProfile {
                reason: "install_profile 缺 version".to_owned(),
            }
        })?;
        let minecraft = profile.minecraft.clone().ok_or_else(|| {
            Error::UnsupportedInstallProfile {
                reason: "install_profile 缺 minecraft".to_owned(),
            }
        })?;
        let json_entry = profile.json.clone().expect("已判定 json 存在");

        // 解出内联 version.json；传统布局原样落盘，按实例安装交给调用方。
        let version_bytes =
            read_zip_entry_async(installer, json_entry.trim_start_matches('/')).await?;
        let embedded: VersionJson = net::parse_json(&version_bytes, "Forge version.json")?;
        if let Target::Standalone = target {
            let json_path = self.cx.layout.version_json(&version_id);
            aurora_base::fs::atomic_write(&json_path, &version_bytes).await?;
        }

        // 下载 install_profile 与 version.json 声明的库（本地产出的通用 jar 无 url，自动跳过）。
        let mut libs = profile.libraries.clone();
        libs.extend(embedded.libraries.clone());
        let tasks = plan::tasks_for_libraries(&libs, self.cx.runtime, self.cx.layout)?;
        let libraries = self.cx.run_batch(tasks, "Forge 库", None).await?;

        // 解出 data 表里 `/jar 内路径` 型取值到独立临时目录。
        let scratch_owner = match target {
            Target::Standalone => version_id.as_str(),
            Target::Instance(id) => id,
        };
        let tmp_dir = self.cx.layout.version_dir(scratch_owner).join(concat!(
            ".",
            aurora_base::app_slug!(),
            "-forge-tmp"
        ));
        let extracted = extract_data_files(installer, &profile.data, &self.side, &tmp_dir).await?;

        // 组装占位符表：解析后的 data + 安装器注入的特殊变量。
        let minecraft_jar = match target {
            Target::Standalone => self.cx.layout.version_jar(&minecraft),
            Target::Instance(id) => self.cx.layout.version_jar(id),
        };
        let values =
            self.build_values(&profile, &minecraft, &minecraft_jar, installer, extracted)?;

        // 逐个处理器执行。
        let mut ran = 0usize;
        for processor in &profile.processors {
            if !side_applies(processor.sides.as_ref(), &self.side) {
                continue;
            }
            if self.cancel.as_ref().is_some_and(|t| t.is_cancelled()) {
                return Err(aurora_download::Error::Cancelled.into());
            }
            self.run_processor(processor, &values).await?;
            ran += 1;
        }

        // 清理临时目录（失败不影响安装结果，仅记日志）。
        if let Err(err) = tokio::fs::remove_dir_all(&tmp_dir).await {
            tracing::debug!(dir = %tmp_dir.display(), %err, "清理 Forge 安装临时目录失败");
        }

        Ok((
            embedded,
            ForgeSummary {
                id: version_id,
                libraries,
                processors: ran,
            },
        ))
    }

    /// 组装处理器占位符表。
    fn build_values(
        &self,
        profile: &InstallProfile,
        minecraft: &str,
        minecraft_jar: &Path,
        installer: &Path,
        extracted: BTreeMap<String, PathBuf>,
    ) -> Result<BTreeMap<String, String>> {
        let layout = self.cx.layout;
        let mut values = resolve_data(&profile.data, &self.side, layout, &extracted)?;
        let insert_path = |m: &mut BTreeMap<String, String>, k: &str, p: PathBuf| {
            m.insert(k.to_owned(), p.to_string_lossy().into_owned());
        };
        values.insert("SIDE".to_owned(), self.side.clone());
        values.insert("MINECRAFT_VERSION".to_owned(), minecraft.to_owned());
        insert_path(&mut values, "MINECRAFT_JAR", minecraft_jar.to_path_buf());
        insert_path(&mut values, "ROOT", layout.root().to_path_buf());
        insert_path(&mut values, "INSTALLER", installer.to_path_buf());
        insert_path(&mut values, "LIBRARY_DIR", layout.libraries_dir());
        Ok(values)
    }
    /// 执行单个处理器：读 Main-Class、组 classpath、替换参数、调 java、校验 outputs。
    async fn run_processor(
        &self,
        processor: &Processor,
        values: &BTreeMap<String, String>,
    ) -> Result<()> {
        let jar_path = self
            .cx
            .layout
            .library_path_for_coordinate(&processor.jar)
            .ok_or_else(|| Error::InvalidLibraryCoordinate {
                name: processor.jar.clone(),
            })?;
        let manifest = read_zip_entry_async(&jar_path, "META-INF/MANIFEST.MF").await?;
        let main_class = parse_main_class(&String::from_utf8_lossy(&manifest)).ok_or_else(|| {
            Error::ProcessorMainClassMissing {
                jar: processor.jar.clone(),
            }
        })?;
        let classpath = build_classpath(&processor.jar, &processor.classpath, self.cx.layout)?;
        let mut args = Vec::with_capacity(processor.args.len());
        for arg in &processor.args {
            args.push(substitute_arg(arg, values, self.cx.layout)?);
        }

        let launch_error = |source| Error::JavaLaunch {
            path: self.java_path.clone(),
            source,
        };
        let mut command = processor_command(&self.java_path);
        command
            .arg("-cp")
            .arg(&classpath)
            .arg(&main_class)
            .args(&args);
        let mut child = command.spawn().map_err(launch_error)?;
        let Some(status) = wait_or_kill(&mut child, self.cancel.as_ref())
            .await
            .map_err(launch_error)?
        else {
            tracing::info!(jar = %processor.jar, "安装被取消，处理器子进程已结束");
            return Err(aurora_download::Error::Cancelled.into());
        };
        if !status.success() {
            return Err(Error::ProcessorFailed {
                jar: processor.jar.clone(),
                status: status.code(),
            });
        }

        // 校验产物 sha1（占位符替换后）。sha1 值为空则跳过。
        for (out_path, out_sha1) in &processor.outputs {
            let path = substitute_arg(out_path, values, self.cx.layout)?;
            let sha1 = substitute_arg(out_sha1, values, self.cx.layout)?;
            if sha1.is_empty() {
                continue;
            }
            aurora_base::fs::verify_sha1(&path, &sha1).await?;
        }
        Ok(())
    }

    /// legacy 安装：versionInfo 落盘（传统布局）、解出通用 jar、下 versionInfo 里的库。
    async fn install_legacy(
        &self,
        installer: &Path,
        profile: &InstallProfile,
        target: Target<'_>,
    ) -> Result<(VersionJson, ForgeSummary)> {
        let version_info = profile.version_info.clone().ok_or_else(|| {
            Error::UnsupportedInstallProfile {
                reason: "legacy install 缺 versionInfo".to_owned(),
            }
        })?;
        let bytes = serde_json::to_vec(&version_info).map_err(|source| Error::Json {
            context: "legacy versionInfo".to_owned(),
            source,
        })?;
        let embedded: VersionJson =
            serde_json::from_value(version_info).map_err(|source| Error::Json {
                context: "legacy versionInfo".to_owned(),
                source,
            })?;
        let id = embedded.id.clone();
        if let Target::Standalone = target {
            aurora_base::fs::atomic_write(&self.cx.layout.version_json(&id), &bytes).await?;
        }

        // 从 installer zip 解出通用 jar 到其 maven 落点。
        let install = profile.install.as_ref().expect("已判定 install 存在");
        let coord = install
            .path
            .clone()
            .ok_or_else(|| Error::UnsupportedInstallProfile {
                reason: "legacy install 缺 path".to_owned(),
            })?;
        let file_path = install
            .file_path
            .clone()
            .ok_or_else(|| Error::UnsupportedInstallProfile {
                reason: "legacy install 缺 filePath".to_owned(),
            })?;
        let dest = self
            .cx
            .layout
            .library_path_for_coordinate(&coord)
            .ok_or_else(|| Error::InvalidLibraryCoordinate { name: coord })?;
        extract_zip_entry_to_async(installer, file_path.trim_start_matches('/'), &dest).await?;

        let tasks = plan::tasks_for_libraries(&embedded.libraries, self.cx.runtime, self.cx.layout)?;
        let libraries = self.cx.run_batch(tasks, "Forge 库", None).await?;

        Ok((
            embedded,
            ForgeSummary {
                id,
                libraries,
                processors: 0,
            },
        ))
    }
}

// ---- zip 读取/解出（同步核心 + spawn_blocking 包装）----

/// 同步读取 zip 内某条目的全部字节。条目缺失映射为 [`Error::InstallerEntryMissing`]。
fn read_zip_entry(archive: &Path, entry: &str) -> Result<Vec<u8>> {
    let file = std::fs::File::open(archive).map_err(|source| io_err(archive, source))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|source| zip_err(archive, source))?;
    let mut entry_reader = match zip.by_name(entry) {
        Ok(reader) => reader,
        Err(zip::result::ZipError::FileNotFound) => {
            return Err(Error::InstallerEntryMissing {
                entry: entry.to_owned(),
            });
        }
        Err(source) => return Err(zip_err(archive, source)),
    };
    let mut buf = Vec::with_capacity(entry_reader.size() as usize);
    entry_reader
        .read_to_end(&mut buf)
        .map_err(|source| io_err(archive, source))?;
    Ok(buf)
}

async fn read_zip_entry_async(archive: &Path, entry: &str) -> Result<Vec<u8>> {
    let archive = archive.to_path_buf();
    let entry = entry.to_owned();
    tokio::task::spawn_blocking(move || read_zip_entry(&archive, &entry))
        .await
        .map_err(|join| io_err(PathBuf::from("<zip>"), std::io::Error::other(join.to_string())))?
}

/// 把 zip 内某条目解出到目标路径（原子写）。
async fn extract_zip_entry_to_async(archive: &Path, entry: &str, dest: &Path) -> Result<()> {
    let bytes = read_zip_entry_async(archive, entry).await?;
    aurora_base::fs::atomic_write(dest, &bytes).await?;
    Ok(())
}

/// 把 data 表里 `/jar 内路径` 型取值从 installer 解出到 `tmp_dir`，返回「原始取值 -> 临时路径」映射。
async fn extract_data_files(
    installer: &Path,
    data: &BTreeMap<String, SidedData>,
    side: &str,
    tmp_dir: &Path,
) -> Result<BTreeMap<String, PathBuf>> {
    let mut out = BTreeMap::new();
    for (index, sided) in data.values().enumerate() {
        let raw = sided_value(sided, side);
        if let DataValue::ExtractedFile(path) = classify_data_value(raw) {
            if out.contains_key(&path) {
                continue;
            }
            // 用 zip 内条目的文件名 + 序号避免重名碰撞。
            let file_name = path.rsplit('/').next().unwrap_or("data.bin");
            let dest = tmp_dir.join(format!("{index}-{file_name}"));
            extract_zip_entry_to_async(installer, path.trim_start_matches('/'), &dest).await?;
            out.insert(path, dest);
        }
    }
    Ok(out)
}

/// 处理器子进程的命令骨架（参数由调用方补上）。
///
/// 丢弃即结束：取消宽限期满时安装的 future 会被整个丢弃，子进程不跟着结束的话，java 会在实例锁
/// 已经放开之后继续往共享的 libraries 目录写产物，和紧接着的重试互相踩。不弹控制台：java.exe 是
/// 控制台程序，从没有控制台的启动器里起它，Windows 会给每个处理器开一个黑框，玩家顺手关掉就等于
/// 杀掉处理器。
fn processor_command(java_path: &Path) -> Command {
    let mut command = Command::new(java_path);
    command.kill_on_drop(true);
    configure_no_window(&mut command);
    command
}

#[cfg(windows)]
fn configure_no_window(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_no_window(_command: &mut Command) {}

/// 等子进程退出并返回退出状态；取消令牌先触发时结束它，等它真正退出后返回 `None`。
///
/// 只发结束信号就返回是不够的：调用方随后会释放实例锁，那一刻处理器必须已经不在了。
async fn wait_or_kill(
    child: &mut Child,
    cancel: Option<&CancellationToken>,
) -> std::io::Result<Option<ExitStatus>> {
    let Some(token) = cancel else {
        return child.wait().await.map(Some);
    };
    tokio::select! {
        status = child.wait() => status.map(Some),
        () = token.cancelled() => {
            child.kill().await?;
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::GameLayout;

    fn layout() -> GameLayout {
        GameLayout::new(PathBuf::from("/mc"))
    }

    #[test]
    fn classify_covers_three_forms() {
        assert_eq!(
            classify_data_value("[net.minecraft:client:1.20.1:mappings@txt]"),
            DataValue::Coordinate("net.minecraft:client:1.20.1:mappings@txt".into())
        );
        assert_eq!(
            classify_data_value("'1.20.1-20230612'"),
            DataValue::Literal("1.20.1-20230612".into())
        );
        assert_eq!(
            classify_data_value("/data/client.lzma"),
            DataValue::ExtractedFile("/data/client.lzma".into())
        );
        assert_eq!(
            classify_data_value("client"),
            DataValue::Literal("client".into())
        );
    }

    #[test]
    fn resolve_data_collapses_to_client_side() {
        let mut data = BTreeMap::new();
        data.insert(
            "MOJMAPS".to_string(),
            SidedData {
                client: "[net.minecraft:client:1.20.1:mappings@txt]".into(),
                server: "[net.minecraft:server:1.20.1:mappings@txt]".into(),
            },
        );
        data.insert(
            "MCP_VERSION".to_string(),
            SidedData {
                client: "'20230612.114412'".into(),
                server: "'20230612.114412'".into(),
            },
        );
        let mut extracted = BTreeMap::new();
        extracted.insert("/data/client.lzma".to_string(), PathBuf::from("/tmp/0-client.lzma"));
        data.insert(
            "BINPATCH".to_string(),
            SidedData {
                client: "/data/client.lzma".into(),
                server: "/data/server.lzma".into(),
            },
        );

        let resolved = resolve_data(&data, "client", &layout(), &extracted).unwrap();
        // 坐标解析成客户端 mappings 的库路径。
        let expected_mojmaps = layout()
            .library_path_for_coordinate("net.minecraft:client:1.20.1:mappings@txt")
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(resolved["MOJMAPS"], expected_mojmaps);
        assert_eq!(resolved["MCP_VERSION"], "20230612.114412");
        assert_eq!(resolved["BINPATCH"], "/tmp/0-client.lzma");
    }

    #[test]
    fn replace_placeholders_substitutes_and_errors_on_unknown() {
        let mut values = BTreeMap::new();
        values.insert("ROOT".to_string(), "/mc".to_string());
        values.insert("SIDE".to_string(), "client".to_string());
        assert_eq!(
            replace_placeholders("{ROOT}/config-{SIDE}.txt", &values).unwrap(),
            "/mc/config-client.txt"
        );
        let err = replace_placeholders("{NOPE}", &values).unwrap_err();
        assert!(matches!(err, Error::DataKeyMissing { key } if key == "NOPE"));
    }

    #[test]
    fn substitute_arg_resolves_bracket_coordinate() {
        let values = BTreeMap::new();
        let got = substitute_arg("[de.oceanlabs.mcp:mcp_config:1.20.1@zip]", &values, &layout()).unwrap();
        let expected = layout()
            .library_path_for_coordinate("de.oceanlabs.mcp:mcp_config:1.20.1@zip")
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(got, expected);
    }

    #[test]
    fn build_classpath_orders_classpath_then_jar() {
        let cp = vec!["a.b:one:1".to_string(), "a.b:two:2".to_string()];
        let got = build_classpath("a.b:main:3", &cp, &layout()).unwrap();
        let sep = classpath_separator().to_string();
        let p = |c: &str| {
            layout()
                .library_path_for_coordinate(c)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        let expected = [p("a.b:one:1"), p("a.b:two:2"), p("a.b:main:3")].join(&sep);
        assert_eq!(got, expected);
    }

    #[test]
    fn parse_main_class_handles_plain_and_continuation() {
        let manifest = "Manifest-Version: 1.0\r\nMain-Class: net.minecraftforge.installertools.ConsoleTool\r\n\r\n";
        assert_eq!(
            parse_main_class(manifest).as_deref(),
            Some("net.minecraftforge.installertools.ConsoleTool")
        );
        // 72 列续行：值被折成两行。
        let wrapped = "Main-Class: com.example.verylongpackage.name.that.wraps.Over\n Seventy\n";
        assert_eq!(
            parse_main_class(wrapped).as_deref(),
            Some("com.example.verylongpackage.name.that.wraps.OverSeventy")
        );
        assert!(parse_main_class("Manifest-Version: 1.0\n").is_none());
    }

    #[test]
    fn side_applies_default_and_filtered() {
        assert!(side_applies(None, "client"));
        assert!(side_applies(Some(&vec!["client".into()]), "client"));
        assert!(!side_applies(Some(&vec!["server".into()]), "client"));
    }

    #[test]
    fn installer_url_builders() {
        assert_eq!(
            forge_installer_url("1.20.1", "47.2.0"),
            "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar"
        );
        assert_eq!(
            neoforge_installer_url("21.0.167"),
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.0.167/neoforge-21.0.167-installer.jar"
        );
        assert_eq!(
            neoforge_installer_url("47.1.106"),
            "https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar"
        );
    }

    #[test]
    fn parse_representative_install_profile() {
        // 精简自真实 1.20.1 Forge install_profile.json 的关键结构。
        let json = r#"{
            "spec": 1,
            "profile": "forge",
            "version": "1.20.1-forge-47.2.0",
            "minecraft": "1.20.1",
            "json": "/version.json",
            "path": "net.minecraftforge:forge:1.20.1-47.2.0",
            "data": {
                "BINPATCH": {"client": "/data/client.lzma", "server": "/data/server.lzma"},
                "MOJMAPS": {"client": "[net.minecraft:client:1.20.1:mappings@txt]", "server": "[net.minecraft:server:1.20.1:mappings@txt]"}
            },
            "processors": [
                {
                    "sides": ["client"],
                    "jar": "net.minecraftforge:installertools:1.3.0",
                    "classpath": ["net.minecraftforge:installertools:1.3.0", "net.sf.jopt-simple:jopt-simple:5.0.4"],
                    "args": ["--task", "MCP_DATA", "--input", "[de.oceanlabs.mcp:mcp_config:1.20.1@zip]", "--output", "{MOJMAPS}"],
                    "outputs": {}
                },
                {
                    "jar": "net.minecraftforge:jarsplitter:1.1.4",
                    "args": ["--input", "{MINECRAFT_JAR}", "--output", "{BINPATCH}"]
                }
            ],
            "libraries": [
                {"name": "net.minecraftforge:installertools:1.3.0",
                 "downloads": {"artifact": {"path": "net/minecraftforge/installertools/1.3.0/installertools-1.3.0.jar", "sha1": "aa", "size": 10, "url": "https://maven.minecraftforge.net/x.jar"}}}
            ]
        }"#;
        let profile: InstallProfile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.version.as_deref(), Some("1.20.1-forge-47.2.0"));
        assert_eq!(profile.minecraft.as_deref(), Some("1.20.1"));
        assert_eq!(profile.processors.len(), 2);
        assert_eq!(profile.libraries.len(), 1);
        // 第一个处理器限定 client，第二个无 sides（两侧都跑）。
        assert!(side_applies(profile.processors[0].sides.as_ref(), "client"));
        assert!(side_applies(profile.processors[1].sides.as_ref(), "server"));

        // 端到端组一遍 client 侧的第一个处理器 args（不含真正 java 执行）。
        let mut extracted = BTreeMap::new();
        extracted.insert("/data/client.lzma".to_string(), PathBuf::from("/tmp/0-client.lzma"));
        let mut values = resolve_data(&profile.data, "client", &layout(), &extracted).unwrap();
        values.insert("MINECRAFT_JAR".to_string(), "/mc/versions/1.20.1/1.20.1.jar".to_string());

        let p0 = &profile.processors[0];
        let args: Vec<String> = p0
            .args
            .iter()
            .map(|a| substitute_arg(a, &values, &layout()).unwrap())
            .collect();
        let mojmaps_path = layout()
            .library_path_for_coordinate("net.minecraft:client:1.20.1:mappings@txt")
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mcp_input = layout()
            .library_path_for_coordinate("de.oceanlabs.mcp:mcp_config:1.20.1@zip")
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            args,
            vec![
                "--task".to_string(),
                "MCP_DATA".to_string(),
                "--input".to_string(),
                mcp_input,
                "--output".to_string(),
                mojmaps_path,
            ]
        );
    }

    /// 造一个 legacy 风格的 installer：install_profile 声明通用 jar 坐标与 zip 内路径，
    /// versionInfo 内联版本 JSON（inheritsFrom 原版）。无处理器，不需要 java。
    fn legacy_installer_bytes() -> Vec<u8> {
        use std::io::Write;
        let profile = serde_json::json!({
            "install": {
                "path": "net.minecraftforge:forge:1.12.2-14.23.5.2860",
                "filePath": "/forge-universal.jar"
            },
            "versionInfo": {
                "id": "1.12.2-forge-14.23.5.2860",
                "inheritsFrom": "1.12.2",
                "mainClass": "net.minecraft.launchwrapper.Launch",
                "libraries": [{ "name": "net.minecraftforge:forge:1.12.2-14.23.5.2860" }]
            }
        });
        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            writer.start_file("install_profile.json", opts).unwrap();
            writer
                .write_all(serde_json::to_string(&profile).unwrap().as_bytes())
                .unwrap();
            writer.start_file("forge-universal.jar", opts).unwrap();
            writer.write_all(b"universal-jar").unwrap();
            writer.finish().unwrap();
        }
        buf
    }

    fn sha1_hex(bytes: &[u8]) -> String {
        use sha1::{Digest, Sha1};
        base16ct::lower::encode_string(&Sha1::digest(bytes))
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        client: reqwest::Client,
        pool: aurora_download::DownloadPool,
        layout: GameLayout,
        runtime: aurora_version::RuntimeContext,
        policy: aurora_base::retry::RetryPolicy,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let client = aurora_base::http::build_client().unwrap();
        let pool = aurora_download::DownloadPool::new(
            aurora_download::Downloader::with_defaults(client.clone()),
            2,
        );
        Fixture {
            layout: GameLayout::new(&root),
            root,
            _dir: dir,
            client,
            pool,
            runtime: aurora_version::RuntimeContext::new(
                aurora_version::OsName::Windows,
                "x86_64",
                64,
            ),
            policy: aurora_base::retry::RetryPolicy {
                max_attempts: 1,
                initial_delay: std::time::Duration::from_millis(1),
                max_delay: std::time::Duration::from_millis(1),
                multiplier: 1.0,
                jitter: false,
            },
        }
    }

    /// 按实例安装：installer 内嵌的版本 JSON 原样交回、不写 versions/<forge id>/；通用 jar 解到库目录；
    /// 安装成功后 installer 与空的缓存目录被清掉。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn install_for_instance_returns_embedded_json_and_discards_installer() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let installer = legacy_installer_bytes();
        Mock::given(method("GET"))
            .and(path("/forge-installer.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(installer.clone()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/forge-installer.jar.sha1"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                "{}
",
                sha1_hex(&installer)
            )))
            .mount(&server)
            .await;

        let f = fixture();
        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
        let (embedded, summary) = ForgeInstaller::new(cx, "java")
            .install_for_instance(&format!("{}/forge-installer.jar", server.uri()), "周末生存")
            .await
            .unwrap();

        assert_eq!(embedded.inherits_from.as_deref(), Some("1.12.2"));
        assert_eq!(summary.id, "1.12.2-forge-14.23.5.2860");
        assert_eq!(summary.processors, 0);
        assert!(
            !f.layout.version_dir("1.12.2-forge-14.23.5.2860").exists(),
            "按实例安装不应另建 forge 版本目录"
        );
        let universal = f
            .layout
            .library_path_for_coordinate("net.minecraftforge:forge:1.12.2-14.23.5.2860")
            .unwrap();
        assert_eq!(std::fs::read(universal).unwrap(), b"universal-jar");
        assert!(
            !f.root
                .join(concat!(".", aurora_base::app_slug!(), "-cache"))
                .exists(),
            "用完的 installer 与空缓存目录应被清掉"
        );
    }

    /// 上次安装失败后留在缓存里的 installer 与 Maven 侧 sha1 一致：直接复用，不再下载。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cached_installer_matching_maven_sha1_is_reused() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let installer = legacy_installer_bytes();
        Mock::given(method("GET"))
            .and(path("/forge-installer.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(installer.clone()))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/forge-installer.jar.sha1"))
            .respond_with(ResponseTemplate::new(200).set_body_string(sha1_hex(&installer)))
            .expect(1)
            .mount(&server)
            .await;

        let f = fixture();
        let cache = f
            .root
            .join(concat!(".", aurora_base::app_slug!(), "-cache"));
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("forge-installer.jar"), &installer).unwrap();

        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
        ForgeInstaller::new(cx, "java")
            .install_for_instance(&format!("{}/forge-installer.jar", server.uri()), "x")
            .await
            .unwrap();
    }

    /// 一个三十秒左右才自己退出的子进程，代替不观察取消令牌、一跑好几秒的处理器。
    fn long_running() -> Command {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("ping");
            command.args(["-n", "30", "127.0.0.1"]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sleep");
            command.arg("30");
            command
        };
        command
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        command
    }

    fn exits_with(code: u8) -> Command {
        #[cfg(windows)]
        let mut command = Command::new("cmd");
        #[cfg(windows)]
        command.args(["/C", &format!("exit {code}")]);
        #[cfg(not(windows))]
        let mut command = Command::new("sh");
        #[cfg(not(windows))]
        command.args(["-c", &format!("exit {code}")]);
        command
    }

    #[test]
    fn processor_command_is_killed_when_its_handle_is_dropped() {
        assert!(processor_command(Path::new("java")).get_kill_on_drop());
    }

    /// 取消时正在跑的处理器被结束，而且返回那一刻它已经退出了（调用方紧接着就要释放实例锁）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_kills_the_running_processor_before_returning() {
        let mut child = long_running().spawn().unwrap();
        let token = CancellationToken::new();
        let trigger = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            trigger.cancel();
        });
        let started = std::time::Instant::now();

        let status = wait_or_kill(&mut child, Some(&token)).await.unwrap();

        assert_eq!(status, None);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "应在取消后立刻结束，实际等了 {:?}",
            started.elapsed()
        );
        assert!(
            child.try_wait().unwrap().is_some(),
            "返回时子进程必须已经退出"
        );
    }

    /// 没有取消时照常等处理器跑完，退出码原样交回；不挂令牌也一样。
    #[tokio::test]
    async fn a_finished_processor_reports_its_exit_code() {
        let token = CancellationToken::new();
        let mut child = exits_with(3).spawn().unwrap();
        let status = wait_or_kill(&mut child, Some(&token))
            .await
            .unwrap()
            .expect("没有取消，应拿到退出状态");
        assert_eq!(status.code(), Some(3));

        let mut child = exits_with(0).spawn().unwrap();
        let status = wait_or_kill(&mut child, None).await.unwrap().unwrap();
        assert!(status.success());
    }
}
