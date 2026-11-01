//! Forge 与 NeoForge 安装（安装器注入式）。
//!
//! 现代 Forge（1.13+）与 NeoForge 走同构逻辑：installer jar 内含 `install_profile.json`（声明
//! 一批处理器 JVM 调用与一张 data 占位符表）加一份 `version.json`（最终版本描述）。安装 =
//! 解出 version.json → 下载 install_profile 与 version 声明的库 → 把 data 表按目标 side
//! 塌缩并解析 `[maven坐标]`/`/jar内路径`/`'字面量'` 三种取值 → 逐个处理器把 `{占位符}` 替换成
//! 实际值后调 java 运行 → 校验各处理器 outputs 的 sha1 → version.json 落盘。旧版 Forge
//! （install_profile 带 `install` 字段而无 processors）则从 zip 解出通用 jar、下完库后把
//! `versionInfo` 落盘，不跑处理器。
//!
//! 版本 JSON 都是最后一步：版本列表只凭它认版本，失败或取消时这个版本就是没装上。
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

use crate::complete;
use crate::context::InstallContext;
use crate::error::{Error, ProcessorOutput, Result, io_err, zip_err};
use crate::layout::checked_segment;
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
                .checked_coordinate_path(&coord)?
                .to_string_lossy()
                .into_owned(),
            DataValue::ExtractedFile(path) => extracted
                .get(&path)
                .ok_or_else(|| Error::InstallerEntryMissing {
                    entry: path.clone(),
                })?
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
        let value = values.get(key).ok_or_else(|| Error::DataKeyMissing {
            key: key.to_owned(),
        })?;
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
            .checked_coordinate_path(coord)?
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
        let path = layout.checked_coordinate_path(coord)?;
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
    /// 传统布局：全部就绪后版本 JSON 写到 `versions/<forge 版本 id>/`，处理器读原版目录里的客户端 jar，
    /// 临时文件放在 installer 缓存目录下。
    Standalone,
    /// 按实例安装：版本 JSON 不落盘（交给调用方与原版合并后写进实例目录），处理器读实例目录里的
    /// 客户端 jar，临时文件也放在实例目录下。
    Instance(&'t str),
}

/// 同一时刻只让一个 Forge / NeoForge 安装进来。
///
/// 处理器把产物直接写进共享的 libraries（同一游戏版本的映射表、改过的客户端 jar），不经下载引擎的
/// 原子落位：两个实例同时装同一个 Forge 版本，甚至同一游戏版本的不同 Forge 版本，都会并发写同一批
/// 文件，产物校验随之失败或留下坏文件。installer 也缓存在共享位置，先装完的一方会把它删掉，另一方
/// 随后读它就失败。串行的代价只是后来的那个多等一会儿。
static FORGE_INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Forge/NeoForge 安装器。需注入 java 可执行文件路径以运行处理器。
///
/// 取消看上下文里的令牌（[`InstallContext::with_cancel`]）：触发后 `.sha1` 抓取与排队立刻停下，
/// 不再起新的处理器，正在跑的处理器子进程被结束、等它真正退出后以
/// [`aurora_download::Error::Cancelled`] 返回。下载阶段的取消由上下文里的下载池自己负责。
pub struct ForgeInstaller<'a> {
    cx: InstallContext<'a>,
    java_path: PathBuf,
    side: String,
    sources: Option<SourcePlan>,
}

impl<'a> ForgeInstaller<'a> {
    /// 用共享上下文与 java 可执行文件构造，默认安装 client 侧。
    pub fn new(cx: InstallContext<'a>, java_path: impl Into<PathBuf>) -> Self {
        Self {
            cx,
            java_path: java_path.into(),
            side: "client".to_owned(),
            sources: None,
        }
    }

    /// installer 旁的 `.sha1` 校验文件按此方案在官方与镜像之间兜底抓取。
    pub fn with_sources(mut self, sources: SourcePlan) -> Self {
        self.sources = Some(sources);
        self
    }

    /// 等到轮到自己安装（见 [`FORGE_INSTALL`]）；等待期间照样响应取消。
    async fn exclusive(&self) -> Result<tokio::sync::MutexGuard<'static, ()>> {
        let Some(token) = self.cx.cancel else {
            return Ok(FORGE_INSTALL.lock().await);
        };
        tokio::select! {
            guard = FORGE_INSTALL.lock() => Ok(guard),
            () = token.cancelled() => Err(aurora_download::Error::Cancelled.into()),
        }
    }

    /// 下载 installer 到缓存目录再安装，版本 JSON 写到 `versions/<forge 版本 id>/`。
    pub async fn install(&self, installer_url: &str) -> Result<ForgeSummary> {
        let _turn = self.exclusive().await?;
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
        let _turn = self.exclusive().await?;
        let installer = self.download_installer(installer_url).await?;
        let outcome = self
            .install_from(&installer, Target::Instance(instance_id))
            .await?;
        self.discard_installer(&installer).await;
        Ok(outcome)
    }

    /// 从已下载的 installer jar 安装（传统布局）。
    pub async fn install_from_installer(&self, installer: &Path) -> Result<ForgeSummary> {
        let _turn = self.exclusive().await?;
        Ok(self.install_from(installer, Target::Standalone).await?.1)
    }

    /// installer 下到 `<根>/.<slug>-cache/<文件名>`，带 Maven 侧 `.sha1` 校验：同一版本重试安装时
    /// 校验通过的旧文件直接复用，不再重下几十 MB。
    async fn download_installer(&self, installer_url: &str) -> Result<PathBuf> {
        let file_name = installer_url.rsplit('/').next().unwrap_or("installer.jar");
        // 地址由加载器版本号拼出，版本号来自远端版本列表或导入的整合包，原样成了文件名：Windows 上
        // 反斜杠也是分隔符，带 `..` 时会落到缓存目录之外。
        checked_segment(file_name, || "Forge 安装器的缓存文件名".to_owned())?;
        let dest = self.installer_cache_dir().join(file_name);
        let mut task = aurora_download::DownloadTask::new(installer_url, dest.clone());
        match self.installer_sha1(installer_url).await {
            Ok(sha1) => task = task.with_sha1(sha1),
            Err(err) if err.is_cancelled() => return Err(err),
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
        net::get_decoded_from(
            self.cx.client,
            self.sources.as_ref(),
            &format!("{installer_url}.sha1"),
            self.cx.policy,
            self.cx.cancel,
            "installer 的 sha1",
            parse_sha1_file,
        )
        .await
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

    /// 现代安装：解出 version.json、下库、跑处理器，全部成功后版本 JSON 才落盘（传统布局）。
    async fn install_modern(
        &self,
        installer: &Path,
        profile: InstallProfile,
        target: Target<'_>,
    ) -> Result<(VersionJson, ForgeSummary)> {
        let version_id =
            profile
                .version
                .clone()
                .ok_or_else(|| Error::UnsupportedInstallProfile {
                    reason: "install_profile 缺 version".to_owned(),
                })?;
        let minecraft =
            profile
                .minecraft
                .clone()
                .ok_or_else(|| Error::UnsupportedInstallProfile {
                    reason: "install_profile 缺 minecraft".to_owned(),
                })?;
        let json_entry = profile.json.clone().expect("已判定 json 存在");
        // 两个 id 都来自远端 installer，随后原样拼进 versions/<id>/ 下的路径。
        checked_segment(&version_id, || "Forge install_profile 的版本 id".to_owned())?;
        checked_segment(&minecraft, || "Forge install_profile 的游戏版本".to_owned())?;

        // 解出内联 version.json。
        let version_bytes =
            read_zip_entry_async(installer, json_entry.trim_start_matches('/')).await?;
        let embedded: VersionJson = net::parse_json(&version_bytes, "Forge version.json")?;

        // 下载 install_profile 与 version.json 声明的库。下载地址留空的是 installer 自带的
        // （放在 `maven/` 下），从 installer 解出，不进下载批次：空地址交给下载引擎只会整批失败。
        let mut libs = profile.libraries.clone();
        libs.extend(embedded.libraries.clone());
        let (bundled, remote): (Vec<_>, Vec<_>) = libs.into_iter().partition(is_bundled);
        extract_bundled_libraries(installer, &bundled, self.cx.layout).await?;
        let tasks = complete::skip_present_unverifiable(plan::tasks_for_libraries(
            &remote,
            self.cx.runtime,
            self.cx.layout,
        )?)
        .await?;
        let libraries = self.cx.run_batch(tasks, "Forge 库", None).await?;

        // 解出 data 表里 `/jar 内路径` 型取值到独立临时目录。传统布局不放进版本目录：它在版本 JSON
        // 就位之前不该出现，安装的 future 被整个丢弃时临时目录也来不及清，会在版本列表里留下一行。
        let scratch_parent = match target {
            Target::Standalone => self.installer_cache_dir(),
            Target::Instance(id) => self.cx.layout.version_dir(id),
        };
        let tmp_dir = scratch_parent.join(concat!(".", aurora_base::app_slug!(), "-forge-tmp"));
        let minecraft_jar = match target {
            Target::Standalone => self.cx.layout.version_jar(&minecraft),
            Target::Instance(id) => self.cx.layout.version_jar(id),
        };
        let ran = self
            .run_processors(installer, &profile, &minecraft, &minecraft_jar, &tmp_dir)
            .await;

        // 成败都清：解出的补丁包有几 MB，重试时会重新解出。清不掉不影响安装结果，仅记日志。
        if let Err(err) = tokio::fs::remove_dir_all(&tmp_dir).await {
            tracing::debug!(dir = %tmp_dir.display(), %err, "清理 Forge 安装临时目录失败");
        }
        let processors = ran?;

        // 传统布局原样落盘，按实例安装交给调用方。
        if let Target::Standalone = target {
            let json_path = self.cx.layout.version_json(&version_id);
            aurora_base::fs::atomic_write(&json_path, &version_bytes).await?;
        }

        Ok((
            embedded,
            ForgeSummary {
                id: version_id,
                libraries,
                processors,
            },
        ))
    }

    /// 把 data 表里的文件解到 `tmp_dir`，组好占位符表，逐个处理器执行；返回实际执行的处理器数，产物都已
    /// 就绪而跳过的不计。
    async fn run_processors(
        &self,
        installer: &Path,
        profile: &InstallProfile,
        minecraft: &str,
        minecraft_jar: &Path,
        tmp_dir: &Path,
    ) -> Result<usize> {
        let extracted = extract_data_files(installer, &profile.data, &self.side, tmp_dir).await?;

        // 组装占位符表：解析后的 data + 安装器注入的特殊变量。
        let values = self.build_values(profile, minecraft, minecraft_jar, installer, extracted)?;

        let mut ran = 0usize;
        for processor in &profile.processors {
            if !side_applies(processor.sides.as_ref(), &self.side) {
                continue;
            }
            if self.cx.cancel.is_some_and(CancellationToken::is_cancelled) {
                return Err(aurora_download::Error::Cancelled.into());
            }
            if self.run_processor(processor, &values).await? {
                ran += 1;
            }
        }
        Ok(ran)
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
    /// 执行单个处理器：产物都已就绪时跳过（返回 `false`），否则读 Main-Class、组 classpath、替换参数、
    /// 调 java、校验 outputs（返回 `true`）。
    async fn run_processor(
        &self,
        processor: &Processor,
        values: &BTreeMap<String, String>,
    ) -> Result<bool> {
        let outputs = resolve_outputs(processor, values, self.cx.layout)?;
        if outputs_ready(&processor.jar, &outputs).await? {
            tracing::info!(jar = %processor.jar, "处理器的产物都已就绪且校验通过，跳过");
            return Ok(false);
        }

        let jar_path = self.cx.layout.checked_coordinate_path(&processor.jar)?;
        let manifest = read_zip_entry_async(&jar_path, "META-INF/MANIFEST.MF").await?;
        let main_class =
            parse_main_class(&String::from_utf8_lossy(&manifest)).ok_or_else(|| {
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
        let capture = OutputCapture::start(&mut child);
        let status = match wait_or_kill(&mut child, self.cx.cancel).await {
            Ok(Some(status)) => status,
            Ok(None) => {
                // 取消有时限，不等剩下的输出读完。
                capture.abandon();
                tracing::info!(jar = %processor.jar, "安装被取消，处理器子进程已结束");
                return Err(aurora_download::Error::Cancelled.into());
            }
            Err(source) => {
                capture.abandon();
                return Err(launch_error(source));
            }
        };
        let output = capture.finish().await;
        if !status.success() {
            tracing::warn!(
                jar = %processor.jar,
                status = ?status.code(),
                output = %output,
                "处理器执行失败"
            );
            let touched = outputs
                .iter()
                .map(|(path, _)| path.clone())
                .chain(library_files_in(&args, self.cx.layout))
                .collect();
            if let Some(path) = first_held_open(touched).await {
                return Err(Error::ProcessorOutputLocked {
                    jar: processor.jar.clone(),
                    path,
                    output: Some(output),
                });
            }
            return Err(Error::ProcessorFailed {
                jar: processor.jar.clone(),
                status: status.code(),
                output,
            });
        }
        tracing::debug!(
            jar = %processor.jar,
            lines = output.lines.len() + output.dropped,
            "处理器执行完成"
        );

        // 校验产物 sha1（占位符替换后）。sha1 值为空则跳过。
        for (path, sha1) in &outputs {
            if sha1.is_empty() {
                continue;
            }
            aurora_base::fs::verify_sha1(path, sha1).await?;
        }
        Ok(true)
    }

    /// legacy 安装：解出通用 jar、下 versionInfo 里的库，全部成功后 versionInfo 才落盘（传统布局）。
    async fn install_legacy(
        &self,
        installer: &Path,
        profile: &InstallProfile,
        target: Target<'_>,
    ) -> Result<(VersionJson, ForgeSummary)> {
        let version_info =
            profile
                .version_info
                .clone()
                .ok_or_else(|| Error::UnsupportedInstallProfile {
                    reason: "legacy install 缺 versionInfo".to_owned(),
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
        checked_segment(&id, || "Forge versionInfo 的版本 id".to_owned())?;

        // 从 installer zip 解出通用 jar 到其 maven 落点。
        let install = profile.install.as_ref().expect("已判定 install 存在");
        let coord = install
            .path
            .clone()
            .ok_or_else(|| Error::UnsupportedInstallProfile {
                reason: "legacy install 缺 path".to_owned(),
            })?;
        let file_path =
            install
                .file_path
                .clone()
                .ok_or_else(|| Error::UnsupportedInstallProfile {
                    reason: "legacy install 缺 filePath".to_owned(),
                })?;
        let dest = self.cx.layout.checked_coordinate_path(&coord)?;
        extract_universal_jar(installer, file_path.trim_start_matches('/'), &dest).await?;

        // versionInfo 里的 Forge 库条目只有坐标和仓库地址，仓库里那个坐标并没有文件（只有
        // `-universal.jar`）；它就是刚解出的通用 jar，在盘上即算就绪。
        let tasks = complete::skip_present_unverifiable(plan::tasks_for_libraries(
            &embedded.libraries,
            self.cx.runtime,
            self.cx.layout,
        )?)
        .await?;
        let libraries = self.cx.run_batch(tasks, "Forge 库", None).await?;

        if let Target::Standalone = target {
            aurora_base::fs::atomic_write(&self.cx.layout.version_json(&id), &bytes).await?;
        }

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
        .map_err(|join| {
            io_err(
                PathBuf::from("<zip>"),
                std::io::Error::other(join.to_string()),
            )
        })?
}

/// 把 zip 内某条目解出到目标路径（原子写）。
async fn extract_zip_entry_to_async(archive: &Path, entry: &str, dest: &Path) -> Result<()> {
    let bytes = read_zip_entry_async(archive, entry).await?;
    aurora_base::fs::atomic_write(dest, &bytes).await?;
    Ok(())
}

/// 把旧版通用 jar 解到库目录。同一 Forge 版本的游戏正在运行时 JVM 占着这份 jar，替换它会失败；
/// 失败之后查一次占用，把笼统的 IO 失败换成能照着做的提示，没被占用就原样报出。
async fn extract_universal_jar(installer: &Path, entry: &str, dest: &Path) -> Result<()> {
    let bytes = read_zip_entry_async(installer, entry).await?;
    let Err(source) = aurora_base::fs::atomic_write(dest, &bytes).await else {
        return Ok(());
    };
    match first_held_open(vec![dest.to_path_buf()]).await {
        Some(path) => Err(Error::LibraryFileLocked { path, source }),
        None => Err(source.into()),
    }
}

/// 解析 Maven 旁的 `.sha1` 文件：取第一段，必须是 40 位十六进制。
fn parse_sha1_file(bytes: Vec<u8>) -> Result<String> {
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

/// 库条目声明了下载件、地址却留空：这类库由 installer 自带。
fn is_bundled(lib: &aurora_version::Library) -> bool {
    lib.downloads
        .as_ref()
        .and_then(|d| d.artifact.as_ref())
        .is_some_and(|artifact| artifact.url.is_empty())
}

/// 把 installer 自带的库从 `maven/<路径>` 解到库目录，按条目声明的 sha1 校验。
///
/// 盘上已有且 sha1 对得上的不再重写：同一 Forge 版本的另一个实例可能正在运行，Windows 上覆盖
/// 一个被占用的 jar 会失败。
///
/// 地址留空的库不一定在 installer 里：1.20.4 起 version.json 把处理器才生成的 `:client` jar 也列了
/// 进来。这里只解 installer 里有的，其余留给处理器（官方 installer 也是这样处理），处理器没生成出来
/// 时由补全报 [`Error::LoaderLibraryMissing`]。
async fn extract_bundled_libraries(
    installer: &Path,
    libraries: &[aurora_version::Library],
    layout: &crate::layout::GameLayout,
) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    for lib in libraries {
        let artifact = lib
            .downloads
            .as_ref()
            .and_then(|d| d.artifact.as_ref())
            .expect("is_bundled 已保证带下载件");
        // 路径与 sha1 来自同一份远端 installer，sha1 拦不住越界路径，落盘前逐段校验。
        let rel = match &artifact.path {
            Some(path) => path.clone(),
            None => crate::layout::coordinate_path(&lib.name)?,
        };
        if !seen.insert(rel.clone()) {
            continue;
        }
        let dest = layout.checked_library_path(&lib.name, &rel)?;
        if file_matches_sha1(&dest, &artifact.sha1).await? {
            continue;
        }
        let bytes = match read_zip_entry_async(installer, &format!("maven/{rel}")).await {
            Ok(bytes) => bytes,
            Err(Error::InstallerEntryMissing { .. }) => continue,
            Err(err) => return Err(err),
        };
        if !artifact.sha1.is_empty() {
            let mut hasher = aurora_base::fs::Sha1Hasher::new();
            hasher.update(&bytes);
            hasher.verify(&artifact.sha1)?;
        }
        aurora_base::fs::atomic_write(&dest, &bytes).await?;
    }
    Ok(())
}

/// 落点上是否已经是 sha1 对得上的文件。没有 sha1 可比时一律算不上（自带库重新解出、处理器重跑）。
async fn file_matches_sha1(dest: &Path, sha1: &str) -> Result<bool> {
    if sha1.is_empty() {
        return Ok(false);
    }
    match aurora_base::fs::verify_sha1(dest, sha1).await {
        Ok(()) => Ok(true),
        Err(aurora_base::Error::HashMismatch { .. }) => Ok(false),
        Err(aurora_base::Error::Io { source, .. })
            if source.kind() == std::io::ErrorKind::NotFound =>
        {
            Ok(false)
        }
        Err(err) => Err(err.into()),
    }
}

/// 把 data 表里 `/jar 内路径` 型取值从 installer 解出到 `tmp_dir`，返回「原始取值 -> 临时路径」映射。
async fn extract_data_files(
    installer: &Path,
    data: &BTreeMap<String, SidedData>,
    side: &str,
    tmp_dir: &Path,
) -> Result<BTreeMap<String, PathBuf>> {
    let mut out = BTreeMap::new();
    for (index, (key, sided)) in data.iter().enumerate() {
        let raw = sided_value(sided, side);
        if let DataValue::ExtractedFile(path) = classify_data_value(raw) {
            if out.contains_key(&path) {
                continue;
            }
            // 用 zip 内条目的文件名 + 序号避免重名碰撞。
            let file_name = path.rsplit('/').next().unwrap_or("data.bin");
            // 文件名出自远端 installer，Windows 上反斜杠也是分隔符，`..` 能藏在里面走出临时目录。
            aurora_version::check_path_segment(file_name).map_err(|problem| Error::UnsafePath {
                entry: format!("Forge 安装器的数据项 {key}"),
                path: path.clone(),
                problem,
            })?;
            let dest = tmp_dir.join(format!("{index}-{file_name}"));
            extract_zip_entry_to_async(installer, path.trim_start_matches('/'), &dest).await?;
            out.insert(path, dest);
        }
    }
    Ok(out)
}

// ---- 处理器产物：缓存命中、占用探测 ----

/// 展开处理器声明的产物，得到「落点 -> 期望 sha1」。求值规则照官方 installer：键整体是 `[坐标]` 时
/// 取该坐标的库路径，否则做 `{占位符}` 替换；值做 `{占位符}` 替换。
fn resolve_outputs(
    processor: &Processor,
    values: &BTreeMap<String, String>,
    layout: &crate::layout::GameLayout,
) -> Result<Vec<(PathBuf, String)>> {
    processor
        .outputs
        .iter()
        .map(|(path, sha1)| {
            Ok((
                PathBuf::from(substitute_arg(path, values, layout)?),
                replace_placeholders(sha1, values)?,
            ))
        })
        .collect()
}

/// 处理器能否跳过：照官方 installer 的缓存规则，声明了产物、且每一项都在盘上并与期望 sha1 吻合。
///
/// 有一项缺失或对不上就要重跑。对不上的旧文件先删掉（官方也这样做），删之前确认它没被别的进程
/// 占着：另一个实例正用同一个加载器版本运行时，游戏的 JVM 打开着这些 jar。没写期望 sha1 的产物无从
/// 校验，算作未就绪，旧文件留给处理器覆盖。
async fn outputs_ready(jar: &str, outputs: &[(PathBuf, String)]) -> Result<bool> {
    if outputs.is_empty() {
        return Ok(false);
    }
    let mut ready = true;
    for (path, sha1) in outputs {
        if sha1.is_empty() {
            ready = false;
            continue;
        }
        if file_matches_sha1(path, sha1).await? {
            continue;
        }
        ready = false;
        discard_stale_output(jar, path).await?;
    }
    Ok(ready)
}

/// 删掉 sha1 对不上的旧产物；它正被别的进程占着时报 [`Error::ProcessorOutputLocked`]。
async fn discard_stale_output(jar: &str, path: &Path) -> Result<()> {
    let probe = path.to_path_buf();
    let held = tokio::task::spawn_blocking(move || aurora_base::fs::held_open(&probe))
        .await
        .map_err(|join| io_err(path, std::io::Error::other(join.to_string())))?
        .map_err(|source| io_err(path, source))?;
    if held {
        return Err(Error::ProcessorOutputLocked {
            jar: jar.to_owned(),
            path: path.to_path_buf(),
            output: None,
        });
    }
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(io_err(path, source)),
    }
}

/// 参数里指向库目录下的那些路径：处理器失败后据此找出是不是撞上了被占用的文件。
fn library_files_in(args: &[String], layout: &crate::layout::GameLayout) -> Vec<PathBuf> {
    let libraries = layout.libraries_dir();
    args.iter()
        .map(PathBuf::from)
        .filter(|path| path.starts_with(&libraries))
        .collect()
}

/// 第一个正被别的进程占着的现有文件。只用于给已经发生的失败找原因：探测本身出错时记一笔日志、
/// 当它没被占用，原来的失败照原样报出，不被探测的错误顶替。
async fn first_held_open(paths: Vec<PathBuf>) -> Option<PathBuf> {
    let probed = tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .filter(|path| path.is_file())
            .find(|path| match aurora_base::fs::held_open(path) {
                Ok(held) => held,
                Err(err) => {
                    tracing::warn!(path = %path.display(), %err, "探测处理器用到的文件是否被占用失败");
                    false
                }
            })
    })
    .await;
    match probed {
        Ok(found) => found,
        Err(join) => match join.try_into_panic() {
            Ok(payload) => std::panic::resume_unwind(payload),
            Err(join) => {
                tracing::warn!(error = %join, "探测文件占用的任务被中止");
                None
            }
        },
    }
}

// ---- 处理器子进程 ----

/// 处理器输出只留最后这么多行：binarypatcher、重命名工具一跑能打出上万行，失败时有用的是末尾的异常。
const OUTPUT_TAIL_LINES: usize = 200;

/// 单行输出留下的上限。末尾缓冲只限行数：处理器把一大段内容打在一行里、甚至一直不换行时，这一行会
/// 涨到把内存吃光。16 KiB 放得下带整条 classpath 的命令行和最长的异常信息，200 行也才 3.2 MB。
const OUTPUT_LINE_MAX_BYTES: usize = 16 * 1024;

/// 子进程退出后等读取任务读完剩余输出的时限。处理器若把管道句柄传给了还活着的孙进程，管道不会
/// 关闭、读取任务会一直等下去；限时后放弃剩下的输出，不让安装卡在这里。
const OUTPUT_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// 收集处理器的 stdout 与 stderr：各起一个读取任务，按到达顺序合进同一份末尾缓冲。管道必须一直有人
/// 读，否则输出多的处理器写满管道缓冲后会卡住不动。
struct OutputCapture {
    tail: std::sync::Arc<std::sync::Mutex<OutputTail>>,
    readers: Vec<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
struct OutputTail {
    lines: std::collections::VecDeque<String>,
    dropped: usize,
}

impl OutputCapture {
    fn start(child: &mut Child) -> Self {
        let tail = std::sync::Arc::new(std::sync::Mutex::new(OutputTail::default()));
        let mut readers = Vec::with_capacity(2);
        if let Some(stdout) = child.stdout.take() {
            readers.push(tokio::spawn(collect_lines(stdout, tail.clone())));
        }
        if let Some(stderr) = child.stderr.take() {
            readers.push(tokio::spawn(collect_lines(stderr, tail.clone())));
        }
        Self { tail, readers }
    }

    /// 不要输出了：结束读取任务。
    fn abandon(self) {
        for reader in self.readers {
            reader.abort();
        }
    }

    /// 等读取任务读完（限时见 [`OUTPUT_DRAIN_GRACE`]），交出收集到的输出。
    async fn finish(self) -> ProcessorOutput {
        for mut reader in self.readers {
            match tokio::time::timeout(OUTPUT_DRAIN_GRACE, &mut reader).await {
                Ok(Ok(())) => {}
                Ok(Err(join)) => match join.try_into_panic() {
                    Ok(payload) => std::panic::resume_unwind(payload),
                    Err(join) => push_line(
                        &self.tail,
                        format!("（读取处理器输出的任务被中止：{join}）"),
                    ),
                },
                Err(_) => {
                    reader.abort();
                    push_line(
                        &self.tail,
                        "（处理器已退出，管道仍被占着，后面的输出没有读完）".to_owned(),
                    );
                }
            }
        }
        let tail = self
            .tail
            .lock()
            .expect("输出缓冲的锁只在追加一行时短暂持有");
        ProcessorOutput {
            lines: tail.lines.iter().cloned().collect(),
            dropped: tail.dropped,
        }
    }
}

async fn collect_lines(
    stream: impl tokio::io::AsyncRead + Unpin,
    tail: std::sync::Arc<std::sync::Mutex<OutputTail>>,
) {
    use tokio::io::AsyncBufReadExt;

    let mut reader = tokio::io::BufReader::new(stream);
    let mut line = PendingLine::default();
    loop {
        let chunk = match reader.fill_buf().await {
            Ok(chunk) => chunk,
            Err(err) => {
                line.flush_partial(&tail);
                push_line(&tail, format!("（读取处理器输出中断：{err}）"));
                return;
            }
        };
        if chunk.is_empty() {
            line.flush_partial(&tail);
            return;
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let body = &chunk[..newline.unwrap_or(chunk.len())];
        line.append(body);
        let consumed = body.len() + usize::from(newline.is_some());
        reader.consume(consumed);
        if newline.is_some() {
            line.flush(&tail);
        }
    }
}

/// 正在收的一行：只留开头 [`OUTPUT_LINE_MAX_BYTES`]，超出的只计数。
#[derive(Default)]
struct PendingLine {
    kept: Vec<u8>,
    cut: usize,
}

impl PendingLine {
    fn append(&mut self, bytes: &[u8]) {
        let room = OUTPUT_LINE_MAX_BYTES - self.kept.len();
        let taken = bytes.len().min(room);
        self.kept.extend_from_slice(&bytes[..taken]);
        self.cut += bytes.len() - taken;
    }

    /// 这一行收完了，交给末尾缓冲。
    fn flush(&mut self, tail: &std::sync::Mutex<OutputTail>) {
        let decoded = decode_output(&self.kept);
        let text = decoded.trim_end_matches('\r');
        push_line(
            tail,
            match self.cut {
                0 => text.to_owned(),
                cut => format!("{text}（这一行太长，略去后面 {cut} 字节）"),
            },
        );
        self.kept.clear();
        self.cut = 0;
    }

    /// 输出到头了：没有换行符结尾的最后半行也要交上去，什么都没收到时不多出一个空行。
    fn flush_partial(&mut self, tail: &std::sync::Mutex<OutputTail>) {
        if !self.kept.is_empty() {
            self.flush(tail);
        }
    }
}

/// 解码处理器的一行输出，只用于展示与排查。
///
/// JVM 往管道写时用 `native.encoding`，也就是系统 ANSI 代码页（简体中文系统上是 GBK），与
/// `file.encoding` 无关。不先试 UTF-8：GBK 的「目录」恰好是合法 UTF-8。
#[cfg(windows)]
fn decode_output(bytes: &[u8]) -> String {
    decode_code_page(bytes, windows_sys::Win32::Globalization::CP_ACP)
}

#[cfg(not(windows))]
fn decode_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// 按代码页解码；非法字节由系统换成替换字符，不让一行读不出就丢掉整段输出。系统不认这个代码页时
/// 退回按 UTF-8 有损解码并记日志：处理器的失败才是要报的错，不能被解码的问题顶替。
#[cfg(windows)]
fn decode_code_page(bytes: &[u8], code_page: u32) -> String {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;

    if bytes.is_empty() {
        return String::new();
    }
    let fall_back = || {
        let err = std::io::Error::last_os_error();
        tracing::warn!(code_page, %err, "按代码页解码处理器输出失败，改按 UTF-8 解码");
        String::from_utf8_lossy(bytes).into_owned()
    };
    let input_len = i32::try_from(bytes.len()).expect("处理器输出的单行长度有上限");
    // SAFETY: 输入指针与长度出自同一切片；输出缓冲传空指针与 0，只询问需要的 UTF-16 长度。
    let needed = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            input_len,
            std::ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        return fall_back();
    }
    let mut wide = vec![0u16; needed as usize];
    // SAFETY: 输入同上；输出缓冲是刚按 needed 分配的 wide，长度如实告知。
    let written = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            input_len,
            wide.as_mut_ptr(),
            needed,
        )
    };
    if written <= 0 {
        return fall_back();
    }
    wide.truncate(written as usize);
    String::from_utf16_lossy(&wide)
}

fn push_line(tail: &std::sync::Mutex<OutputTail>, line: String) {
    let mut tail = tail.lock().expect("输出缓冲的锁只在追加一行时短暂持有");
    if tail.lines.len() == OUTPUT_TAIL_LINES {
        tail.lines.pop_front();
        tail.dropped += 1;
    }
    tail.lines.push_back(line);
}

/// 处理器子进程的命令骨架（参数由调用方补上）。
///
/// 丢弃即结束：取消宽限期满时安装的 future 会被整个丢弃，子进程不跟着结束的话，java 会在实例锁
/// 已经放开之后继续往共享的 libraries 目录写产物，和紧接着的重试互相踩。不弹控制台：java.exe 是
/// 控制台程序，从没有控制台的启动器里起它，Windows 会给每个处理器开一个黑框，玩家顺手关掉就等于
/// 杀掉处理器。stdout 与 stderr 接成管道，由 [`OutputCapture`] 收集。
fn processor_command(java_path: &Path) -> Command {
    let mut command = Command::new(java_path);
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
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
        extracted.insert(
            "/data/client.lzma".to_string(),
            PathBuf::from("/tmp/0-client.lzma"),
        );
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
        let got = substitute_arg(
            "[de.oceanlabs.mcp:mcp_config:1.20.1@zip]",
            &values,
            &layout(),
        )
        .unwrap();
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

    /// 处理器参数、data 表与 classpath 里的坐标有能走出库目录的段时，与下载计划一样报路径越界
    /// （命令层 install_unsafe_path），不混进「坐标非法」；缺段的坐标仍报坐标非法。
    #[test]
    fn processor_coordinates_escaping_the_libraries_dir_report_unsafe_path() {
        let l = layout();
        let values = BTreeMap::new();
        let escaping = "evil:..:1";
        let is_unsafe = |result: Result<String>| match result {
            Err(Error::UnsafePath { entry, problem, .. }) => {
                assert_eq!(entry, format!("库 {escaping}"));
                assert_eq!(problem, aurora_version::UnsafePath::DotSegment);
            }
            other => panic!("应报路径越界，实际：{other:?}"),
        };
        is_unsafe(substitute_arg(&format!("[{escaping}]"), &values, &l));
        is_unsafe(build_classpath(escaping, &[], &l));
        is_unsafe(build_classpath("a.b:main:3", &[escaping.to_owned()], &l));
        let data = BTreeMap::from([(
            "MAPPINGS".to_owned(),
            SidedData {
                client: format!("[{escaping}]"),
                server: String::new(),
            },
        )]);
        is_unsafe(
            resolve_data(&data, "client", &l, &BTreeMap::new())
                .map(|values| values["MAPPINGS"].clone()),
        );

        assert!(matches!(
            substitute_arg("[only:two]", &values, &l),
            Err(Error::InvalidLibraryCoordinate { name }) if name == "only:two"
        ));
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
        extracted.insert(
            "/data/client.lzma".to_string(),
            PathBuf::from("/tmp/0-client.lzma"),
        );
        let mut values = resolve_data(&profile.data, "client", &layout(), &extracted).unwrap();
        values.insert(
            "MINECRAFT_JAR".to_string(),
            "/mc/versions/1.20.1/1.20.1.jar".to_string(),
        );

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

    /// 第一个源的 `.sha1` 是错误页：换下一个源取到校验值，缓存里的 installer 照样复用，不重下。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_garbled_sha1_page_moves_on_to_the_next_source() {
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
            .and(path("/garbled"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>维护中</html>"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/clean"))
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
            .with_sources(crate::net::tests::plan_between(
                &server, "/garbled", "/clean",
            ))
            .install_for_instance(&format!("{}/forge-installer.jar", server.uri()), "x")
            .await
            .unwrap();
    }

    /// 另一个 Forge 安装正在进行时，新的安装原地等着、不碰共享的 installer 缓存与库；前一个结束后
    /// 它照常装完。等待中取消立刻以已取消返回。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_second_install_waits_for_the_running_one_and_can_be_cancelled_meanwhile() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let installer = legacy_installer_bytes();
        Mock::given(method("GET"))
            .and(path("/forge-installer.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(installer.clone()))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/forge-installer.jar.sha1"))
            .respond_with(ResponseTemplate::new(200).set_body_string(sha1_hex(&installer)))
            .mount(&server)
            .await;
        let url = format!("{}/forge-installer.jar", server.uri());
        let f = fixture();

        let running = FORGE_INSTALL.lock().await;
        let token = CancellationToken::new();
        let cancelled = {
            let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy)
                .with_cancel(Some(&token));
            let forge = ForgeInstaller::new(cx, "java");
            let attempt = forge.install_for_instance(&url, "排队的");
            tokio::pin!(attempt);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(200), &mut attempt)
                    .await
                    .is_err(),
                "前一个安装没结束时不该开始"
            );
            token.cancel();
            attempt.await.unwrap_err()
        };
        assert!(
            matches!(
                cancelled,
                Error::Download(aurora_download::Error::Cancelled)
            ),
            "实际：{cancelled:?}"
        );
        assert!(server.received_requests().await.unwrap().is_empty());

        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
        let forge = ForgeInstaller::new(cx, "java");
        let waiting = forge.install_for_instance(&url, "后来的");
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), &mut waiting)
                .await
                .is_err()
        );
        drop(running);
        let (_, summary) = waiting.await.unwrap();
        assert_eq!(summary.id, "1.12.2-forge-14.23.5.2860");
        assert!(!server.received_requests().await.unwrap().is_empty());
    }

    /// 按给定条目造一个 installer zip，写到 `dir/installer.jar`。
    fn write_installer(dir: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        use std::io::Write;
        let path = dir.join("installer.jar");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(*name, opts).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
        path
    }

    /// 1.13 到 1.16.5 的 installer（以及重新打包过的 1.12.2 推荐版）把 Forge 自己的 jar 放在
    /// installer 的 `maven/` 下，库条目的下载地址留空：这些库从 installer 里解出来，不去下载。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn libraries_with_an_empty_url_are_extracted_from_the_installer() {
        let universal: &[u8] = b"forge-universal-bytes";
        let shim: &[u8] = b"forge-shim";
        let universal_path =
            "net/minecraftforge/forge/1.16.5-36.2.39/forge-1.16.5-36.2.39-universal.jar";
        let shim_path = "net/minecraftforge/forge/1.16.5-36.2.39/forge-1.16.5-36.2.39.jar";
        let profile = serde_json::json!({
            "spec": 0,
            "version": "1.16.5-forge-36.2.39",
            "minecraft": "1.16.5",
            "json": "/version.json",
            "data": {},
            "processors": [],
            "libraries": [{
                "name": "net.minecraftforge:forge:1.16.5-36.2.39:universal",
                "downloads": {"artifact": {
                    "path": universal_path, "url": "",
                    "sha1": sha1_hex(universal), "size": universal.len()
                }}
            }]
        });
        let version = serde_json::json!({
            "id": "1.16.5-forge-36.2.39",
            "inheritsFrom": "1.16.5",
            "mainClass": "cpw.mods.modlauncher.Launcher",
            "libraries": [{
                "name": "net.minecraftforge:forge:1.16.5-36.2.39",
                "downloads": {"artifact": {
                    "path": shim_path, "url": "",
                    "sha1": sha1_hex(shim), "size": shim.len()
                }}
            }]
        });
        let f = fixture();
        let installer = write_installer(
            &f.root,
            &[
                ("install_profile.json", profile.to_string().as_bytes()),
                ("version.json", version.to_string().as_bytes()),
                (&format!("maven/{universal_path}"), universal),
                (&format!("maven/{shim_path}"), shim),
            ],
        );

        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
        let summary = ForgeInstaller::new(cx, "java")
            .install_from_installer(&installer)
            .await
            .unwrap();

        assert_eq!(summary.id, "1.16.5-forge-36.2.39");
        assert_eq!(summary.libraries, 0, "没有需要下载的库");
        assert_eq!(
            std::fs::read(f.layout.library_path(universal_path)).unwrap(),
            universal
        );
        assert_eq!(
            std::fs::read(f.layout.library_path(shim_path)).unwrap(),
            shim
        );
    }

    /// 1.20.4 起 version.json 把补丁后的 `:client` jar 也列成地址留空的库，installer 的 `maven/` 下
    /// 却没有它：它要等处理器生成。解库这一步不能因此报条目缺失，那样这些版本一次都装不上；
    /// 处理器没生成出来时由随后的补全报加载器自带库缺失。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_library_left_for_the_processors_is_not_required_in_the_installer() {
        let patched: &[u8] = b"patched-client";
        let patched_path =
            "net/minecraftforge/forge/1.21.1-52.0.30/forge-1.21.1-52.0.30-client.jar";
        let library = serde_json::json!({
            "name": "net.minecraftforge:forge:1.21.1-52.0.30:client",
            "downloads": {"artifact": {
                "path": patched_path, "url": "",
                "sha1": sha1_hex(patched), "size": patched.len()
            }}
        });
        let profile = serde_json::json!({
            "spec": 1,
            "version": "1.21.1-forge-52.0.30",
            "minecraft": "1.21.1",
            "json": "/version.json",
            "data": {},
            "processors": [],
            "libraries": []
        });
        let version = serde_json::json!({
            "id": "1.21.1-forge-52.0.30",
            "inheritsFrom": "1.21.1",
            "mainClass": "net.minecraftforge.bootstrap.ForgeBootstrap",
            "libraries": [library]
        });
        let f = fixture();
        let installer = write_installer(
            &f.root,
            &[
                ("install_profile.json", profile.to_string().as_bytes()),
                ("version.json", version.to_string().as_bytes()),
            ],
        );

        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
        let summary = ForgeInstaller::new(cx, "java")
            .install_from_installer(&installer)
            .await
            .unwrap();

        assert_eq!(summary.id, "1.21.1-forge-52.0.30");
        assert_eq!(summary.libraries, 0, "这个库没有地址，不进下载批次");
        assert!(
            !f.layout.library_path(patched_path).exists(),
            "它只能由处理器生成，解库这一步什么都不写"
        );
    }

    /// installer 自带库的路径与 sha1 出自同一份远端文件，sha1 拦不住越界：直给的路径或由坐标算出的
    /// 路径能走出库目录时报路径越界，库目录外什么都不写。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bundled_libraries_escaping_the_libraries_dir_are_rejected() {
        let payload: &[u8] = b"escaped-bytes";
        let cases = [
            (
                serde_json::json!({
                    "name": "net.minecraftforge:forge:1.16.5-36.2.39",
                    "downloads": {"artifact": {
                        "path": "../escaped.jar", "url": "",
                        "sha1": sha1_hex(payload), "size": payload.len()
                    }}
                }),
                "maven/../escaped.jar",
            ),
            (
                serde_json::json!({
                    "name": "evil:x:1/../../../escaped",
                    "downloads": {"artifact": {
                        "url": "", "sha1": sha1_hex(payload), "size": payload.len()
                    }}
                }),
                "maven/evil/x/1/../../../escaped/x-1/../../../escaped.jar",
            ),
        ];
        for (library, entry) in cases {
            let profile = serde_json::json!({
                "spec": 0,
                "version": "1.16.5-forge-36.2.39",
                "minecraft": "1.16.5",
                "json": "/version.json",
                "data": {},
                "processors": [],
                "libraries": [library]
            });
            let version = serde_json::json!({
                "id": "1.16.5-forge-36.2.39", "inheritsFrom": "1.16.5", "libraries": []
            });
            let f = fixture();
            let installer = write_installer(
                &f.root,
                &[
                    ("install_profile.json", profile.to_string().as_bytes()),
                    ("version.json", version.to_string().as_bytes()),
                    (entry, payload),
                ],
            );

            let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
            let err = ForgeInstaller::new(cx, "java")
                .install_from_installer(&installer)
                .await
                .unwrap_err();

            assert!(
                matches!(err, Error::UnsafePath { .. }),
                "{entry}：实际 {err:?}"
            );
            assert!(
                !f.root.join("escaped.jar").exists(),
                "{entry}：库目录外不该写出文件"
            );
            assert!(
                !f.layout.libraries_dir().exists(),
                "{entry}：库目录里也不该有东西"
            );
        }
    }

    /// install_profile 与 versionInfo 里的版本 id、游戏版本原样拼进 versions/<id>/：能走出版本目录的
    /// 一律报路径越界，什么都不写。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remote_version_ids_escaping_the_versions_dir_are_rejected() {
        let modern = |version: &str, minecraft: &str| {
            let profile = serde_json::json!({
                "spec": 0, "version": version, "minecraft": minecraft, "json": "/version.json",
                "data": {}, "processors": [], "libraries": []
            });
            let embedded =
                serde_json::json!({ "id": version, "inheritsFrom": minecraft, "libraries": [] });
            vec![
                (
                    "install_profile.json".to_owned(),
                    profile.to_string().into_bytes(),
                ),
                ("version.json".to_owned(), embedded.to_string().into_bytes()),
            ]
        };
        let legacy = |id: &str| {
            let profile = serde_json::json!({
                "install": {
                    "path": "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10",
                    "filePath": "forge-universal.jar",
                    "minecraft": "1.7.10",
                    "target": id
                },
                "versionInfo": { "id": id, "inheritsFrom": "1.7.10", "libraries": [] }
            });
            vec![
                (
                    "install_profile.json".to_owned(),
                    profile.to_string().into_bytes(),
                ),
                ("forge-universal.jar".to_owned(), b"universal".to_vec()),
            ]
        };
        let cases = [
            (r"..\escaped", modern(r"..\escaped", "1.16.5")),
            ("../escaped", modern("../escaped", "1.16.5")),
            ("../escaped", modern("1.16.5-forge-36.2.39", "../escaped")),
            ("../escaped", legacy("../escaped")),
        ];
        for (bad, entries) in cases {
            let f = fixture();
            let named: Vec<(&str, &[u8])> = entries
                .iter()
                .map(|(n, b)| (n.as_str(), b.as_slice()))
                .collect();
            let installer = write_installer(&f.root, &named);
            let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
            let err = ForgeInstaller::new(cx, "java")
                .install_from_installer(&installer)
                .await
                .unwrap_err();

            assert!(
                matches!(&err, Error::UnsafePath { path, .. } if path == bad),
                "{bad}：实际 {err:?}"
            );
            assert!(
                !f.root.join("escaped.json").exists(),
                "{bad}：版本目录外不该写出文件"
            );
            assert!(
                !f.root.join("versions").exists(),
                "{bad}：versions 下也不该有东西"
            );
            assert!(!f.layout.libraries_dir().exists(), "{bad}：不该解出任何库");
        }
    }

    /// data 表里 `/jar 内路径` 的文件名原样拼进临时目录：Windows 上反斜杠也是分隔符，`..` 能藏在
    /// 文件名里走出临时目录。这种取值报路径越界，临时目录外什么都不写。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn data_files_escaping_the_scratch_dir_are_rejected() {
        let data_path = r"/data/..\..\..\..\..\escaped.lzma";
        let profile = serde_json::json!({
            "spec": 0, "version": "1.16.5-forge-36.2.39", "minecraft": "1.16.5",
            "json": "/version.json",
            "data": {"BINPATCH": {"client": data_path, "server": data_path}},
            "processors": [], "libraries": []
        });
        let version = serde_json::json!({
            "id": "1.16.5-forge-36.2.39", "inheritsFrom": "1.16.5", "libraries": []
        });
        let f = fixture();
        let installer = write_installer(
            &f.root,
            &[
                ("install_profile.json", profile.to_string().as_bytes()),
                ("version.json", version.to_string().as_bytes()),
                (data_path.trim_start_matches('/'), b"escaped-bytes"),
            ],
        );

        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
        let err = ForgeInstaller::new(cx, "java")
            .install_from_installer(&installer)
            .await
            .unwrap_err();

        assert!(
            matches!(
                &err,
                Error::UnsafePath { entry, path, problem: aurora_version::UnsafePath::Backslash }
                    if entry == "Forge 安装器的数据项 BINPATCH" && path == data_path
            ),
            "实际：{err:?}"
        );
        // 校验漏掉时，第一个 `..` 抵掉加了序号前缀的那一段，其余四个把文件从 versions/<id>/ 下的
        // 临时目录送回游戏目录根下。
        assert!(!f.root.join("escaped.lzma").exists());
        assert!(!f.root.join("versions").join("escaped.lzma").exists());
    }

    /// installer 地址由加载器版本号拼出，版本号可以来自导入的整合包：最后一段原样当缓存文件名，Windows 上
    /// 反斜杠也是分隔符，`..` 藏在里面能把下到的文件写到缓存目录之外。这种地址报路径越界，不发请求。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn installer_file_names_escaping_the_cache_dir_are_rejected() {
        use wiremock::matchers::any;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"installer".to_vec()))
            .expect(0)
            .mount(&server)
            .await;
        let file_name = r"forge-1.20.1-..\..\..\escaped-installer.jar";
        let f = fixture();
        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);

        let err = ForgeInstaller::new(cx, "java")
            .install(&format!("{}/{file_name}", server.uri()))
            .await
            .unwrap_err();

        assert!(
            matches!(
                &err,
                Error::UnsafePath { entry, path, problem: aurora_version::UnsafePath::Backslash }
                    if entry == "Forge 安装器的缓存文件名" && path == file_name
            ),
            "实际：{err:?}"
        );
        assert!(!f.root.join("escaped-installer.jar").exists());
        assert!(
            !f.root
                .parent()
                .unwrap()
                .join("escaped-installer.jar")
                .exists()
        );
    }

    /// installer 里那份 jar 与库条目声明的 sha1 对不上：照实报错，不把坏文件留在库目录里。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_embedded_library_with_a_wrong_sha1_is_rejected() {
        let path = "net/minecraftforge/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860.jar";
        let profile = serde_json::json!({
            "version": "1.12.2-forge-14.23.5.2860",
            "minecraft": "1.12.2",
            "json": "/version.json",
            "processors": [],
            "libraries": [{
                "name": "net.minecraftforge:forge:1.12.2-14.23.5.2860",
                "downloads": {"artifact": {
                    "path": path, "url": "", "sha1": "0".repeat(40), "size": 4
                }}
            }]
        });
        let version = serde_json::json!({
            "id": "1.12.2-forge-14.23.5.2860", "inheritsFrom": "1.12.2", "libraries": []
        });
        let f = fixture();
        let installer = write_installer(
            &f.root,
            &[
                ("install_profile.json", profile.to_string().as_bytes()),
                ("version.json", version.to_string().as_bytes()),
                (&format!("maven/{path}"), b"evil"),
            ],
        );

        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
        let err = ForgeInstaller::new(cx, "java")
            .install_from_installer(&installer)
            .await
            .unwrap_err();

        assert!(
            matches!(err, Error::Base(aurora_base::Error::HashMismatch { .. })),
            "实际：{err:?}"
        );
        assert!(!f.layout.library_path(path).exists());
    }

    /// 1.7.10 到 1.12.2 早期构建的 installer：Forge 库条目带着 Maven 仓库地址，那里却只有
    /// `-universal.jar`，照坐标去拉是 404；通用 jar 已经从 installer 里解到这个落点，不该再下载。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn legacy_forge_library_is_not_fetched_over_the_extracted_universal_jar() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404))
            .expect(0)
            .mount(&server)
            .await;
        let profile = serde_json::json!({
            "install": {
                "path": "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10",
                "filePath": "forge-1.7.10-10.13.4.1614-1.7.10-universal.jar"
            },
            "versionInfo": {
                "id": "1.7.10-Forge10.13.4.1614-1.7.10",
                "inheritsFrom": "1.7.10",
                "mainClass": "net.minecraft.launchwrapper.Launch",
                "libraries": [{
                    "name": "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10",
                    "url": format!("{}/", server.uri())
                }]
            }
        });
        let f = fixture();
        let installer = write_installer(
            &f.root,
            &[
                ("install_profile.json", profile.to_string().as_bytes()),
                (
                    "forge-1.7.10-10.13.4.1614-1.7.10-universal.jar",
                    b"universal",
                ),
            ],
        );

        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
        ForgeInstaller::new(cx, "java")
            .install_from_installer(&installer)
            .await
            .unwrap();

        let universal = f
            .layout
            .library_path_for_coordinate("net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10")
            .unwrap();
        assert_eq!(std::fs::read(universal).unwrap(), b"universal");
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

    // ---- 处理器：缓存命中、输出收集、占用 ----

    const OUT_A: &str = "test:out:1:a";
    const OUT_B: &str = "test:out:1:b";
    const PROCESSOR_JAR: &str = "test:proc:1";

    /// 造一个只有一个处理器的现代 installer：产物 A 用 `{占位符}` 键、产物 B 用 `[坐标]` 键，两种
    /// 写法都是官方 installer 认的；期望 sha1 走 data 表里的 `'字面量'`。`args` 原样交给处理器。
    fn processor_installer(
        f: &Fixture,
        sha_a: &str,
        sha_b: &str,
        args: serde_json::Value,
        with_outputs: bool,
    ) -> PathBuf {
        let sided = |value: String| serde_json::json!({ "client": value, "server": value });
        let outputs = if with_outputs {
            serde_json::json!({ "{OUT_A}": "{OUT_A_SHA}", format!("[{OUT_B}]"): "{OUT_B_SHA}" })
        } else {
            serde_json::json!({})
        };
        let profile = serde_json::json!({
            "version": "1.20.1-forge-47.2.0",
            "minecraft": "1.20.1",
            "json": "/version.json",
            "data": {
                "OUT_A": sided(format!("[{OUT_A}]")),
                "OUT_A_SHA": sided(format!("'{sha_a}'")),
                "OUT_B_SHA": sided(format!("'{sha_b}'")),
            },
            "processors": [{
                "sides": ["client"],
                "jar": PROCESSOR_JAR,
                "classpath": [],
                "args": args,
                "outputs": outputs,
            }],
            "libraries": []
        });
        let version = serde_json::json!({
            "id": "1.20.1-forge-47.2.0", "inheritsFrom": "1.20.1", "libraries": []
        });
        write_installer(
            &f.root,
            &[
                ("install_profile.json", profile.to_string().as_bytes()),
                ("version.json", version.to_string().as_bytes()),
            ],
        )
    }

    fn library(f: &Fixture, coordinate: &str) -> PathBuf {
        f.layout.library_path_for_coordinate(coordinate).unwrap()
    }

    fn put(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    /// 处理器 jar 本身：只要 MANIFEST.MF 里有 Main-Class，真正执行的是注入的 java。
    fn put_processor_jar(f: &Fixture) {
        use std::io::Write;
        let path = library(f, PROCESSOR_JAR);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file("META-INF/MANIFEST.MF", opts).unwrap();
        writer
            .write_all(b"Manifest-Version: 1.0\r\nMain-Class: test.Processor\r\n\r\n")
            .unwrap();
        writer.finish().unwrap();
    }

    /// 代替 java 的脚本：往 stdout、stderr 各打一行，再以 `code` 退出。
    fn fake_java(dir: &Path, stdout: &str, stderr: &str, code: u8) -> PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join("fake-java.cmd");
            std::fs::write(
                &path,
                // 重定向写在前面：`echo x 1>&2` 会把 x 后面的空格也输出。
                format!("@echo off\r\necho {stdout}\r\n1>&2 echo {stderr}\r\nexit /b {code}\r\n"),
            )
            .unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("fake-java");
            std::fs::write(
                &path,
                format!("#!/bin/sh\necho '{stdout}'\necho '{stderr}' 1>&2\nexit {code}\n"),
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    /// 代替 java 的脚本：写下 `started` 后一直跑，代替正在干活、不观察取消令牌的处理器。
    ///
    /// 不能靠子命令拖时间：结束的只是脚本本身，还活着的子命令占着管道，Windows 上读管道在阻塞线程
    /// 里，测试运行时收尾时要等它退出。
    fn hanging_java(dir: &Path, started: &Path) -> PathBuf {
        let started = started.display();
        #[cfg(windows)]
        {
            let path = dir.join("hanging-java.cmd");
            std::fs::write(
                &path,
                format!("@echo off\r\necho up> \"{started}\"\r\n:spin\r\ngoto spin\r\n"),
            )
            .unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("hanging-java");
            std::fs::write(
                &path,
                format!("#!/bin/sh\necho up > '{started}'\nexec sleep 30\n"),
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    async fn install_with(f: &Fixture, java: &Path, installer: &Path) -> Result<ForgeSummary> {
        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
        ForgeInstaller::new(cx, java)
            .install_from_installer(installer)
            .await
    }

    /// 声明的产物都在盘上且 sha1 吻合：处理器整个跳过，不读处理器 jar、不起 java，也不计入执行数。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_processor_whose_outputs_are_all_present_and_valid_is_skipped() {
        let f = fixture();
        let (a, b) = (b"slim-jar".as_slice(), b"extra-jar".as_slice());
        put(&library(&f, OUT_A), a);
        put(&library(&f, OUT_B), b);
        let installer = processor_installer(
            &f,
            &sha1_hex(a),
            &sha1_hex(b),
            serde_json::json!(["--output", "{OUT_A}"]),
            true,
        );

        // 处理器 jar 不在、java 也不存在：只要真去执行就会失败。
        let summary = install_with(&f, &f.root.join("no-such-java.exe"), &installer)
            .await
            .unwrap();

        assert_eq!(summary.processors, 0);
        assert_eq!(std::fs::read(library(&f, OUT_A)).unwrap(), a);
        assert_eq!(std::fs::read(library(&f, OUT_B)).unwrap(), b);
    }

    /// 只有部分产物就绪时照常执行处理器：缺一个、或有一个对不上，都不能跳过。对不上的旧文件先删掉，
    /// 已就绪的那一个不动。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_processor_with_only_some_outputs_ready_is_run() {
        let f = fixture();
        put_processor_jar(&f);
        let (a, b) = (b"slim-jar".as_slice(), b"extra-jar".as_slice());
        let installer = processor_installer(
            &f,
            &sha1_hex(a),
            &sha1_hex(b),
            serde_json::json!(["--output", "{OUT_A}"]),
            true,
        );
        let java = f.root.join("no-such-java.exe");

        // A 就绪，B 缺失。
        put(&library(&f, OUT_A), a);
        let err = install_with(&f, &java, &installer).await.unwrap_err();
        assert!(
            matches!(err, Error::JavaLaunch { .. }),
            "应真的去起 java：{err:?}"
        );
        assert_eq!(std::fs::read(library(&f, OUT_A)).unwrap(), a);

        // A 就绪，B 是上次留下的坏文件。
        put(&library(&f, OUT_B), b"stale");
        let err = install_with(&f, &java, &installer).await.unwrap_err();
        assert!(
            matches!(err, Error::JavaLaunch { .. }),
            "应真的去起 java：{err:?}"
        );
        assert_eq!(std::fs::read(library(&f, OUT_A)).unwrap(), a);
        assert!(!library(&f, OUT_B).exists(), "对不上的旧产物应在重跑前删掉");
    }

    /// 从 installer 解出的补丁包有几 MB，只给处理器读：处理器失败时也要清掉，不留在版本目录里。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_scratch_dir_is_removed_when_a_processor_fails() {
        let f = fixture();
        put_processor_jar(&f);
        let profile = serde_json::json!({
            "version": "1.20.1-forge-47.2.0",
            "minecraft": "1.20.1",
            "json": "/version.json",
            "data": {"BINPATCH": {"client": "/data/client.lzma", "server": "/data/server.lzma"}},
            "processors": [{"jar": PROCESSOR_JAR, "classpath": [], "args": ["{BINPATCH}"]}],
            "libraries": []
        });
        let version = serde_json::json!({
            "id": "1.20.1-forge-47.2.0", "inheritsFrom": "1.20.1", "libraries": []
        });
        let installer = write_installer(
            &f.root,
            &[
                ("install_profile.json", profile.to_string().as_bytes()),
                ("version.json", version.to_string().as_bytes()),
                ("data/client.lzma", b"patches"),
            ],
        );
        let java = fake_java(&f.root, "out", "err", 3);

        let err = install_with(&f, &java, &installer).await.unwrap_err();

        assert!(
            matches!(err, Error::ProcessorFailed { .. }),
            "实际：{err:?}"
        );
        let scratch = f
            .root
            .join(concat!(".", aurora_base::app_slug!(), "-cache"))
            .join(concat!(".", aurora_base::app_slug!(), "-forge-tmp"));
        assert!(!scratch.exists(), "临时目录应被清掉：{}", scratch.display());
    }

    /// 处理器失败时这个 Forge 版本就是没装上：不留版本 JSON，版本目录也不出现。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failing_processor_leaves_no_version_behind() {
        let f = fixture();
        put_processor_jar(&f);
        let installer = processor_installer(
            &f,
            "",
            "",
            serde_json::json!(["--output", "{OUT_A}"]),
            false,
        );
        let java = fake_java(&f.root, "out", "err", 3);

        let err = install_with(&f, &java, &installer).await.unwrap_err();

        assert!(
            matches!(err, Error::ProcessorFailed { .. }),
            "实际：{err:?}"
        );
        assert!(!f.layout.version_dir("1.20.1-forge-47.2.0").exists());
    }

    /// 取消时正在跑的处理器被结束，同样不留版本 JSON 与版本目录。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_a_running_processor_leaves_no_version_behind() {
        let f = fixture();
        put_processor_jar(&f);
        let installer = processor_installer(
            &f,
            "",
            "",
            serde_json::json!(["--output", "{OUT_A}"]),
            false,
        );
        let started = f.root.join("processor-started");
        let java = hanging_java(&f.root, &started);
        let token = CancellationToken::new();
        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy)
            .with_cancel(Some(&token));
        let forge = ForgeInstaller::new(cx, &java);
        let attempt = forge.install_from_installer(&installer);
        tokio::pin!(attempt);

        let processor_started = async {
            while !started.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        };
        tokio::select! {
            outcome = &mut attempt => panic!("处理器还在跑，安装不该结束：{outcome:?}"),
            () = processor_started => {}
        }
        token.cancel();
        let err = attempt.await.unwrap_err();

        assert!(err.is_cancelled(), "实际：{err:?}");
        assert!(!f.layout.version_dir("1.20.1-forge-47.2.0").exists());
    }

    const DEPENDENCY: &str = "org.example:dep:1";
    const DEPENDENCY_PATH: &str = "/org/example/dep/1/dep-1.jar";

    /// 现代 installer：version.json 声明了一个要从 `repository` 下载的库。返回 installer 与版本 id。
    fn modern_installer_needing(f: &Fixture, repository: &str) -> (PathBuf, &'static str) {
        let id = "1.16.5-forge-36.2.39";
        let profile = serde_json::json!({
            "spec": 0, "version": id, "minecraft": "1.16.5", "json": "/version.json",
            "data": {}, "processors": [], "libraries": []
        });
        let version = serde_json::json!({
            "id": id, "inheritsFrom": "1.16.5",
            "libraries": [{ "name": DEPENDENCY, "url": repository }]
        });
        let installer = write_installer(
            &f.root,
            &[
                ("install_profile.json", profile.to_string().as_bytes()),
                ("version.json", version.to_string().as_bytes()),
            ],
        );
        (installer, id)
    }

    /// 旧版 installer：versionInfo 声明了一个要从 `repository` 下载的库。返回 installer 与版本 id。
    fn legacy_installer_needing(f: &Fixture, repository: &str) -> (PathBuf, &'static str) {
        let id = "1.7.10-Forge10.13.4.1614-1.7.10";
        let profile = serde_json::json!({
            "install": {
                "path": "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10",
                "filePath": "forge-universal.jar"
            },
            "versionInfo": {
                "id": id, "inheritsFrom": "1.7.10",
                "libraries": [{ "name": DEPENDENCY, "url": repository }]
            }
        });
        let installer = write_installer(
            &f.root,
            &[
                ("install_profile.json", profile.to_string().as_bytes()),
                ("forge-universal.jar", b"universal"),
            ],
        );
        (installer, id)
    }

    /// 现代与旧版两条路：库下不下来时不留版本 JSON，版本目录也不出现。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_library_download_leaves_no_version_behind() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(DEPENDENCY_PATH))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let repository = format!("{}/", server.uri());

        for build in [modern_installer_needing, legacy_installer_needing] {
            let f = fixture();
            let (installer, id) = build(&f, &repository);

            let err = install_with(&f, Path::new("java"), &installer)
                .await
                .unwrap_err();

            assert!(
                matches!(err, Error::BatchIncomplete { .. }),
                "{id}：{err:?}"
            );
            assert!(!f.layout.version_dir(id).exists(), "{id}");
        }
    }

    /// 现代与旧版两条路：取消发生在下库的途中，同样不留版本 JSON 与版本目录。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_the_library_download_leaves_no_version_behind() {
        use std::time::Duration;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        for build in [modern_installer_needing, legacy_installer_needing] {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(path(DEPENDENCY_PATH))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_bytes(b"dep".to_vec())
                        .set_delay(Duration::from_secs(30)),
                )
                .mount(&server)
                .await;
            let f = fixture();
            let (installer, id) = build(&f, &format!("{}/", server.uri()));
            let token = CancellationToken::new();
            let pool = aurora_download::DownloadPool::new(
                aurora_download::Downloader::with_defaults(f.client.clone()),
                2,
            )
            .with_cancel(token.clone());
            let cx = InstallContext::new(&f.client, &pool, &f.layout, &f.runtime, &f.policy)
                .with_cancel(Some(&token));
            let forge = ForgeInstaller::new(cx, "java");
            let attempt = forge.install_from_installer(&installer);
            tokio::pin!(attempt);

            let library_requested = async {
                while server.received_requests().await.unwrap().is_empty() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            };
            tokio::select! {
                outcome = &mut attempt => panic!("{id}：库还没回来，安装不该结束：{outcome:?}"),
                () = library_requested => {}
            }
            token.cancel();
            let err = attempt.await.unwrap_err();

            assert!(err.is_cancelled(), "{id}：{err:?}");
            assert!(!f.layout.version_dir(id).exists(), "{id}");
        }
    }

    /// 全部就绪后版本 JSON 才落位：现代走 installer 里那份的原始字节（保留未建模字段），旧版走内联的
    /// versionInfo；版本目录里只有它。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_finished_install_lands_the_version_json_last() {
        let id = "1.16.5-forge-36.2.39";
        let profile = serde_json::json!({
            "spec": 0, "version": id, "minecraft": "1.16.5", "json": "/version.json",
            "data": {"BINPATCH": {"client": "/data/client.lzma", "server": "/data/server.lzma"}},
            "processors": [], "libraries": []
        });
        let version = format!(
            "{{\n  \"id\": \"{id}\",\n  \"inheritsFrom\": \"1.16.5\",\n  \"notModelled\": true\n}}"
        );
        let f = fixture();
        let installer = write_installer(
            &f.root,
            &[
                ("install_profile.json", profile.to_string().as_bytes()),
                ("version.json", version.as_bytes()),
                ("data/client.lzma", b"patches"),
            ],
        );
        install_with(&f, Path::new("java"), &installer)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(f.layout.version_json(id)).unwrap(),
            version.as_bytes()
        );
        let entries: Vec<String> = std::fs::read_dir(f.layout.version_dir(id))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![format!("{id}.json")]);

        let f = fixture();
        let (installer, id) = legacy_installer_needing(&f, "http://unused.invalid/");
        put(&library(&f, DEPENDENCY), b"dep");
        install_with(&f, Path::new("java"), &installer)
            .await
            .unwrap();
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(f.layout.version_json(id)).unwrap()).unwrap();
        assert_eq!(on_disk["id"], id);
        assert_eq!(on_disk["inheritsFrom"], "1.7.10");
    }

    /// 没有声明产物的处理器没有可比的东西，每次都执行（官方 installer 同样如此）。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_processor_without_declared_outputs_always_runs() {
        let f = fixture();
        put_processor_jar(&f);
        put(&library(&f, OUT_A), b"slim-jar");
        let installer = processor_installer(
            &f,
            &sha1_hex(b"slim-jar"),
            "",
            serde_json::json!(["--output", "{OUT_A}"]),
            false,
        );
        let err = install_with(&f, &f.root.join("no-such-java.exe"), &installer)
            .await
            .unwrap_err();
        assert!(matches!(err, Error::JavaLaunch { .. }), "实际：{err:?}");
    }

    /// 处理器失败：退出码与它自己的 stdout、stderr 一起交回，输出挂在原因链上。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failing_processor_reports_its_output_on_the_cause_chain() {
        let f = fixture();
        put_processor_jar(&f);
        let installer = processor_installer(
            &f,
            "",
            "",
            serde_json::json!(["--output", "{OUT_A}"]),
            false,
        );
        let java = fake_java(
            &f.root,
            "Splitting: client.jar",
            "java.lang.IllegalStateException: bad patch",
            3,
        );

        let err = install_with(&f, &java, &installer).await.unwrap_err();

        let Error::ProcessorFailed {
            jar,
            status,
            output,
        } = &err
        else {
            panic!("应为 ProcessorFailed，实际 {err:?}");
        };
        assert_eq!(jar, PROCESSOR_JAR);
        assert_eq!(*status, Some(3));
        assert_eq!(output.dropped, 0);
        let mut lines = output.lines.clone();
        lines.sort();
        assert_eq!(
            lines,
            vec![
                "Splitting: client.jar".to_owned(),
                "java.lang.IllegalStateException: bad patch".to_owned(),
            ]
        );
        let chain: Vec<String> =
            std::iter::successors(std::error::Error::source(&err), |e| e.source())
                .map(|e| e.to_string())
                .collect();
        assert!(
            chain
                .iter()
                .any(|c| c.contains("java.lang.IllegalStateException: bad patch")),
            "{chain:?}"
        );
    }

    const OUTPUT_LINE_CAP: usize = 16 * 1024;

    fn cut_line(kept: &str, cut: usize) -> String {
        format!("{kept}（这一行太长，略去后面 {cut} 字节）")
    }

    /// 单行超过上限时只留开头并标明略去多少；下一行不受影响。正好到上限的不算超。
    #[tokio::test]
    async fn a_line_over_the_cap_is_cut_and_marked() {
        let kept = "x".repeat(OUTPUT_LINE_CAP);
        for (over, expected) in [
            (0, kept.clone()),
            (1, cut_line(&kept, 1)),
            (5000, cut_line(&kept, 5000)),
            (3 * OUTPUT_LINE_CAP, cut_line(&kept, 3 * OUTPUT_LINE_CAP)),
        ] {
            let mut stream = vec![b'x'; OUTPUT_LINE_CAP + over];
            stream.extend_from_slice(b"\nnext line\n");
            let tail = collected();

            collect_lines(stream.as_slice(), tail.clone()).await;

            assert_eq!(lines_of(&tail), vec![expected, "next line".to_owned()]);
        }
    }

    /// 一直不换行的输出（比如把二进制打到了 stdout）读到结束：缓冲不跟着涨，只留上限内的开头。
    #[tokio::test]
    async fn output_that_never_ends_a_line_stays_within_the_cap() {
        let stream = vec![b'y'; 64 * OUTPUT_LINE_CAP];
        let tail = collected();

        collect_lines(stream.as_slice(), tail.clone()).await;

        assert_eq!(
            lines_of(&tail),
            vec![cut_line(&"y".repeat(OUTPUT_LINE_CAP), 63 * OUTPUT_LINE_CAP)]
        );
    }

    /// 换行符落在哪一段读取里都一样：随机长度的行连成一串读出来，逐行与预期一致。
    #[tokio::test]
    async fn lines_of_random_lengths_read_back_one_by_one() {
        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        let mut stream = Vec::new();
        let mut expected = Vec::new();
        for _ in 0..OUTPUT_TAIL_LINES {
            let len = rng.usize(0..2 * OUTPUT_LINE_CAP);
            let ending: &[u8] = if rng.bool() { b"\n" } else { b"\r\n" };
            stream.extend(std::iter::repeat_n(b'z', len));
            stream.extend_from_slice(ending);
            // 换行符之前的字节都算这一行的长度，CR 也在内。
            let body = len + ending.len() - 1;
            expected.push(if body <= OUTPUT_LINE_CAP {
                "z".repeat(len)
            } else {
                cut_line(&"z".repeat(OUTPUT_LINE_CAP), body - OUTPUT_LINE_CAP)
            });
        }
        let tail = collected();

        collect_lines(stream.as_slice(), tail.clone()).await;

        assert_eq!(lines_of(&tail), expected, "seed {seed}");
    }

    /// 普通输出照旧：去掉行尾的 CRLF，空行留着，最后一行没有换行符也不丢。
    #[tokio::test]
    async fn ordinary_lines_come_through_unchanged() {
        let tail = collected();

        collect_lines(b"first\r\n\nlast".as_slice(), tail.clone()).await;

        assert_eq!(lines_of(&tail), vec!["first", "", "last"]);
    }

    /// 读到一半管道出错：已经读到的半行不丢，后面跟上中断的原因。
    #[tokio::test]
    async fn a_read_error_keeps_the_partial_line() {
        struct BreaksAfter(Option<&'static [u8]>);

        impl tokio::io::AsyncRead for BreaksAfter {
            fn poll_read(
                mut self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
                buf: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                std::task::Poll::Ready(match self.0.take() {
                    Some(bytes) => {
                        buf.put_slice(bytes);
                        Ok(())
                    }
                    None => Err(std::io::Error::other("管道断了")),
                })
            }
        }

        let tail = collected();

        collect_lines(BreaksAfter(Some(b"partial")), tail.clone()).await;

        assert_eq!(
            lines_of(&tail),
            vec!["partial", "（读取处理器输出中断：管道断了）"]
        );
    }

    /// 输出只留末尾：超出的行从最早的丢起并计数。
    #[test]
    fn processor_output_keeps_only_the_tail() {
        let tail = std::sync::Mutex::new(OutputTail::default());
        for n in 0..OUTPUT_TAIL_LINES + 5 {
            push_line(&tail, format!("line {n}"));
        }
        let tail = tail.into_inner().unwrap();
        assert_eq!(tail.dropped, 5);
        assert_eq!(tail.lines.len(), OUTPUT_TAIL_LINES);
        assert_eq!(tail.lines.front().map(String::as_str), Some("line 5"));
        assert_eq!(
            tail.lines.back().map(String::as_str),
            Some(format!("line {}", OUTPUT_TAIL_LINES + 4).as_str())
        );

        let shown = ProcessorOutput {
            lines: vec!["a".into(), "b".into()],
            dropped: 3,
        };
        assert_eq!(shown.to_string(), "处理器输出（略去前 3 行）：\na\nb");
        assert_eq!(ProcessorOutput::default().to_string(), "处理器没有任何输出");
    }

    fn collected() -> std::sync::Arc<std::sync::Mutex<OutputTail>> {
        std::sync::Arc::new(std::sync::Mutex::new(OutputTail::default()))
    }

    fn lines_of(tail: &std::sync::Mutex<OutputTail>) -> Vec<String> {
        let tail = tail.lock().unwrap();
        tail.lines.iter().cloned().collect()
    }

    /// 「游戏目录」的 GBK 字节。按 UTF-8 解码时前半截全成替换符，后半截的「目录」恰好是合法 UTF-8，
    /// 会变成「Ŀ¼」，所以不能先试 UTF-8 再退回代码页。
    #[cfg(windows)]
    const GBK_GAME_DIR: &[u8] = b"\xD3\xCE\xCF\xB7\xC4\xBF\xC2\xBC";

    /// 经管道读到的字节按系统代码页解码：JVM 往管道写时用的就是它（`native.encoding`）。
    #[cfg(windows)]
    #[tokio::test]
    async fn processor_output_is_read_in_the_system_code_page() {
        use windows_sys::Win32::Globalization::GetACP;

        let stream = [b"C:\\", GBK_GAME_DIR, b"\\.minecraft\r\n"].concat();
        let tail = collected();

        collect_lines(stream.as_slice(), tail.clone()).await;

        // SAFETY: GetACP 没有参数，只读进程的代码页设置。
        let expected = match unsafe { GetACP() } {
            936 => r"C:\游戏目录\.minecraft".to_owned(),
            other => decode_code_page(&stream[..stream.len() - 2], other),
        };
        assert_eq!(lines_of(&tail), vec![expected]);
    }

    /// 代码页由参数决定，不依赖这台机器的系统设置：GBK 与系统启用 UTF-8 时的 65001 都解得对，空串不算
    /// 失败（空输入调系统函数会报参数错误），行尾残缺的多字节序列不让整行读不出来。
    #[cfg(windows)]
    #[test]
    fn decode_code_page_reads_the_bytes_of_that_code_page() {
        assert_eq!(decode_code_page(GBK_GAME_DIR, 936), "游戏目录");
        assert_eq!(decode_code_page("游戏目录".as_bytes(), 65001), "游戏目录");
        assert_eq!(decode_code_page(b"", 936), "");
        assert_eq!(decode_code_page(b"plain ascii", 936), "plain ascii");
        let cut = decode_code_page(&GBK_GAME_DIR[..3], 936);
        assert!(cut.starts_with('游'), "{cut:?}");
    }

    /// 系统不认的代码页：输出只用于排查，退回按 UTF-8 有损解码，不让这一行消失。
    #[cfg(windows)]
    #[test]
    fn an_unknown_code_page_falls_back_to_lossy_utf8() {
        assert_eq!(decode_code_page(b"Exception: boom", 1), "Exception: boom");
    }

    /// JVM 读 jar 的打开方式：放行读写共享、不放行删除共享。另一个实例的游戏就这样占着库里的 jar。
    #[cfg(windows)]
    fn hold_like_a_running_game(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(path)
            .unwrap()
    }

    /// 要重跑的处理器有一个对不上的旧产物，而它正被运行中的游戏占着：动手前就报占用，不报笼统的
    /// IO 失败，也不去起 java。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stale_output_held_by_a_running_game_is_reported_as_locked() {
        let f = fixture();
        put_processor_jar(&f);
        let (a, b) = (b"slim-jar".as_slice(), b"extra-jar".as_slice());
        put(&library(&f, OUT_A), b"older-slim-jar");
        put(&library(&f, OUT_B), b);
        let installer = processor_installer(
            &f,
            &sha1_hex(a),
            &sha1_hex(b),
            serde_json::json!(["--output", "{OUT_A}"]),
            true,
        );
        let _game = hold_like_a_running_game(&library(&f, OUT_A));

        let err = install_with(&f, &f.root.join("no-such-java.exe"), &installer)
            .await
            .unwrap_err();

        match &err {
            Error::ProcessorOutputLocked { jar, path, output } => {
                assert_eq!(jar, PROCESSOR_JAR);
                assert_eq!(path, &library(&f, OUT_A));
                assert!(output.is_none(), "还没起处理器，不该有输出");
            }
            other => panic!("应为 ProcessorOutputLocked，实际 {other:?}"),
        }
        assert!(!aurora_base::retry::RetryableError::is_retryable(&err));
        assert!(err.to_string().contains("正被别的程序占用"), "{err}");
        assert_eq!(
            std::fs::read(library(&f, OUT_A)).unwrap(),
            b"older-slim-jar"
        );
    }

    /// 没声明产物的处理器（如 binarypatcher）写库里一个被占着的 jar 而失败：报占用并带上处理器输出。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_processor_failing_on_a_held_library_file_is_reported_as_locked() {
        let f = fixture();
        put_processor_jar(&f);
        put(&library(&f, OUT_A), b"patched-client");
        let installer = processor_installer(
            &f,
            "",
            "",
            serde_json::json!(["--output", "{OUT_A}"]),
            false,
        );
        let java = fake_java(
            &f.root,
            "Patching client",
            "java.nio.file.FileSystemException: being used by another process",
            1,
        );
        let _game = hold_like_a_running_game(&library(&f, OUT_A));

        let err = install_with(&f, &java, &installer).await.unwrap_err();

        match &err {
            Error::ProcessorOutputLocked { path, output, .. } => {
                assert_eq!(path, &library(&f, OUT_A));
                let output = output.as_ref().expect("处理器跑过，应带着它的输出");
                assert!(
                    output
                        .lines
                        .iter()
                        .any(|line| line.contains("FileSystemException")),
                    "{output:?}"
                );
            }
            other => panic!("应为 ProcessorOutputLocked，实际 {other:?}"),
        }
    }

    /// 同一个失败的处理器，没有文件被占着时照常报 ProcessorFailed：占用的判定不会张冠李戴。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_processor_failure_without_a_held_file_is_not_reported_as_locked() {
        let f = fixture();
        put_processor_jar(&f);
        put(&library(&f, OUT_A), b"patched-client");
        let installer = processor_installer(
            &f,
            "",
            "",
            serde_json::json!(["--output", "{OUT_A}"]),
            false,
        );
        let java = fake_java(&f.root, "Patching client", "OutOfMemoryError", 1);

        let err = install_with(&f, &java, &installer).await.unwrap_err();

        assert!(
            matches!(
                err,
                Error::ProcessorFailed {
                    status: Some(1),
                    ..
                }
            ),
            "实际：{err:?}"
        );
    }

    const LEGACY_UNIVERSAL: &str = "net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10";

    /// 旧版安装要把通用 jar 解到库目录，而同一 Forge 版本的游戏正占着它：报占用并指认文件，不报笼统的
    /// IO 失败，原来的系统错误留在原因链上；旧 jar 不动，版本也不算装上。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_universal_jar_held_by_a_running_game_is_reported_as_locked() {
        let f = fixture();
        let (installer, id) = legacy_installer_needing(&f, "http://unused.invalid/");
        let universal = library(&f, LEGACY_UNIVERSAL);
        put(&universal, b"older-universal");
        let _game = hold_like_a_running_game(&universal);

        let err = install_with(&f, Path::new("java"), &installer)
            .await
            .unwrap_err();

        match &err {
            Error::LibraryFileLocked { path, source } => {
                assert_eq!(path, &universal);
                assert!(
                    matches!(source, aurora_base::Error::Io { path, .. } if *path == universal),
                    "{source:?}"
                );
            }
            other => panic!("应为 LibraryFileLocked，实际 {other:?}"),
        }
        assert!(!aurora_base::retry::RetryableError::is_retryable(&err));
        let shown = err.to_string();
        assert!(shown.contains(&universal.display().to_string()), "{shown}");
        assert!(shown.contains("正被别的程序占用"), "{shown}");
        assert_eq!(std::fs::read(&universal).unwrap(), b"older-universal");
        assert!(!f.layout.version_dir(id).exists());
    }

    /// 写不进去的原因不是占用（落点是个目录）：不张冠李戴，照原样报 IO 失败。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_universal_jar_failing_for_another_reason_keeps_its_own_error() {
        let f = fixture();
        let (installer, _) = legacy_installer_needing(&f, "http://unused.invalid/");
        let universal = library(&f, LEGACY_UNIVERSAL);
        std::fs::create_dir_all(&universal).unwrap();

        let err = install_with(&f, Path::new("java"), &installer)
            .await
            .unwrap_err();

        assert!(
            matches!(&err, Error::Base(aurora_base::Error::Io { path, .. }) if *path == universal),
            "实际：{err:?}"
        );
    }

    /// installer 的 `.sha1` 迟迟不回时取消：不等它，立即以已取消返回，不当成「拿不到校验值」接着下 installer。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_while_fetching_the_installer_sha1_stops_the_install() {
        use std::time::{Duration, Instant};
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/forge-installer.jar.sha1"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string("0".repeat(40))
                    .set_delay(Duration::from_secs(10)),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/forge-installer.jar"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(legacy_installer_bytes()))
            .expect(0)
            .mount(&server)
            .await;
        let f = fixture();
        let token = CancellationToken::new();
        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy)
            .with_cancel(Some(&token));
        let forge = ForgeInstaller::new(cx, "java");
        let url = format!("{}/forge-installer.jar", server.uri());
        let attempt = forge.install_for_instance(&url, "x");
        tokio::pin!(attempt);

        // 等 `.sha1` 请求真正落到服务器（排队等别的 Forge 安装的时间不算）再取消。
        let sha1_requested = async {
            while server.received_requests().await.unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        tokio::select! {
            _ = &mut attempt => panic!(".sha1 还没回来，安装不该结束"),
            () = sha1_requested => {}
        }
        let cancelled_at = Instant::now();
        token.cancel();
        let err = attempt.await.unwrap_err();

        assert!(err.is_cancelled(), "实际：{err:?}");
        // .sha1 要 10 秒才回话，以它为界。
        assert!(
            cancelled_at.elapsed() < Duration::from_secs(10),
            "实际等了 {:?}",
            cancelled_at.elapsed()
        );
    }

    /// installer 的缓存文件名取自地址的最后一段，地址里的加载器版本号来自远端版本列表或整合包清单。
    /// 带反斜杠的版本号在 Windows 上会把落点带出缓存目录：报路径越界，不发请求、不写文件。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_installer_file_name_escaping_the_cache_dir_is_rejected() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(legacy_installer_bytes()))
            .expect(0)
            .mount(&server)
            .await;
        let f = fixture();
        let cx = InstallContext::new(&f.client, &f.pool, &f.layout, &f.runtime, &f.policy);
        let file_name = r"forge-1.20.1-47.2.0\..\..\escaped-installer.jar";
        let url = format!("{}/{file_name}", server.uri());

        let err = ForgeInstaller::new(cx, "java")
            .install_for_instance(&url, "x")
            .await
            .unwrap_err();

        match err {
            Error::UnsafePath {
                entry,
                path,
                problem,
            } => {
                assert_eq!(entry, "Forge 安装器的缓存文件名");
                assert_eq!(path, file_name);
                assert_eq!(problem, aurora_version::UnsafePath::Backslash);
            }
            other => panic!("应报路径越界，实际：{other:?}"),
        }
        assert!(!f.root.join("escaped-installer.jar").exists());
        assert!(
            !f.root
                .join(concat!(".", aurora_base::app_slug!(), "-cache"))
                .exists()
        );
    }
}
