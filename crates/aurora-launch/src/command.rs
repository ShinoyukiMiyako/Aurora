//! 启动命令拼装：把版本 JSON、路径、账户、内存、Authlib-Injector 组合成完整的
//! `java <jvm 参数...> <主类> <游戏参数...>` 与工作目录。
//!
//! 这是本 crate 的门面：JVM 段（安全/编码/内存/authlib + 旧版基座与版本 jvm 参数 + 日志参数）与
//! 游戏段（新式 `arguments.game` 或旧式 `minecraftArguments`）分别拼成模板序列，再统一过一遍 `${}` 占位符
//! 替换。占位符全表（natives/library/game_directory/assets/auth_*/version_type/classpath…）在这里一次性算好。
//! 直达存档或服务器（[`QuickPlayTarget`]）按版本 JSON 有没有 Quick Play 条件块，决定是置 feature 填占位符，
//! 还是给旧版追加 `--server` / `--port`。

use std::path::PathBuf;

use aurora_version::{RuntimeContext, VersionJson, check_path_segment};
use serde::Serialize;

use crate::account::{AuthValues, AuthlibInjector, OFFLINE_ACCESS_TOKEN};
use crate::args;
use crate::classpath;
use crate::error::{LaunchError, Result};
use crate::memory::MemoryConfig;
use crate::placeholder::Placeholders;
use crate::quickplay::{
    self, FEATURE_MULTIPLAYER, FEATURE_SINGLEPLAYER, PLACEHOLDER_MULTIPLAYER,
    PLACEHOLDER_SINGLEPLAYER, QuickPlayTarget,
};

/// 一次启动所需的 `.minecraft` 布局路径。
///
/// 与 aurora-install 的落点一致：`jar_id` 是持有 `client.jar` 与 natives 的版本 id——原版即版本自身，
/// 加载器版本（已合并）则复用其原版目录，故 `jar_id` 传原版 id。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GamePaths {
    /// `.minecraft` 根目录（assets/libraries/versions 都在其下）。
    pub minecraft_dir: PathBuf,
    /// `libraries/` 根目录。
    pub libraries_dir: PathBuf,
    /// `assets/` 根目录。
    pub assets_dir: PathBuf,
    /// natives 解压目录。
    pub natives_dir: PathBuf,
    /// 客户端主 jar。
    pub client_jar: PathBuf,
}

impl GamePaths {
    /// 按标准 `.minecraft` 布局构造。`jar_id` 见结构体文档。
    pub fn standard(minecraft_dir: impl Into<PathBuf>, jar_id: &str) -> Self {
        let root = minecraft_dir.into();
        let version_dir = root.join("versions").join(jar_id);
        Self {
            libraries_dir: root.join("libraries"),
            assets_dir: root.join("assets"),
            natives_dir: version_dir.join(format!("{jar_id}-natives")),
            client_jar: version_dir.join(format!("{jar_id}.jar")),
            minecraft_dir: root,
        }
    }
}

/// 组装好的启动命令。
#[derive(Debug, Clone, Serialize)]
pub struct LaunchCommand {
    /// 要执行的程序（java 可执行文件）。
    pub program: PathBuf,
    /// 全部参数（JVM 参数 + 主类 + 游戏参数），顺序即命令行顺序。
    pub args: Vec<String>,
    /// 工作目录（隔离判定后的游戏目录）。
    pub working_dir: PathBuf,
    /// natives 解压目录，游戏进程的 PATH 里要有它，见 [`crate::process::spawn`]。
    pub natives_dir: PathBuf,
}

impl LaunchCommand {
    /// 渲染成可读命令行（含空格的参数加双引号）。用于调试、日志或导出启动脚本。
    pub fn command_line(&self) -> String {
        let mut parts = Vec::with_capacity(self.args.len() + 1);
        parts.push(quote_arg(&self.program.to_string_lossy()));
        for arg in &self.args {
            parts.push(quote_arg(arg));
        }
        parts.join(" ")
    }
}

/// 含空格或为空的参数加双引号，其余原样。
fn quote_arg(arg: &str) -> String {
    if arg.is_empty() || arg.chars().any(char::is_whitespace) {
        format!("\"{arg}\"")
    } else {
        arg.to_owned()
    }
}

/// 启动命令构造器。
pub struct CommandBuilder<'a> {
    version: &'a VersionJson,
    ctx: RuntimeContext,
    java: PathBuf,
    paths: GamePaths,
    game_dir: PathBuf,
    auth: AuthValues,
    memory: MemoryConfig,
    authlib: Option<AuthlibInjector>,
    launcher_name: String,
    launcher_version: String,
    version_name: String,
    resolution: Option<(u32, u32)>,
    fullscreen: bool,
    extra_jvm_args: Vec<String>,
    extra_game_args: Vec<String>,
    quick_play: Option<QuickPlayTarget>,
}

/// 直达目标落到命令行上的方式。
enum QuickPlayPlan {
    /// 置上 feature，让版本 JSON 的条件块生效，占位符填目标。
    Feature {
        feature: &'static str,
        placeholder: &'static str,
        value: String,
    },
    /// 版本没有 Quick Play 块：追加旧版的 `--server <host> --port <port>`。
    LegacyServer { host: String, port: u16 },
}

impl<'a> CommandBuilder<'a> {
    /// 用必需输入构造：合并后的版本 JSON、运行环境、java 可执行文件、路径布局、游戏工作目录、鉴权值，
    /// 以及写进 `${launcher_version}` 的启动器版本号。
    ///
    /// 启动器版本号由调用方传入应用自身的版本：游戏与服务器统计启动器分布时读的是它，取本 crate 的
    /// 版本号就会永远报一个与发布版脱钩的数。默认最大堆 2048MB、启动器名取英文产品名、版本名取版本 id。
    pub fn new(
        version: &'a VersionJson,
        ctx: RuntimeContext,
        java: impl Into<PathBuf>,
        paths: GamePaths,
        game_dir: impl Into<PathBuf>,
        auth: AuthValues,
        launcher_version: impl Into<String>,
    ) -> Self {
        Self {
            version,
            ctx,
            java: java.into(),
            paths,
            game_dir: game_dir.into(),
            auth,
            memory: MemoryConfig::fixed(2048),
            authlib: None,
            launcher_name: aurora_base::brand::APP_NAME_EN.to_owned(),
            launcher_version: launcher_version.into(),
            version_name: version.id.clone(),
            resolution: None,
            fullscreen: false,
            extra_jvm_args: Vec::new(),
            extra_game_args: Vec::new(),
            quick_play: None,
        }
    }

    /// 设置内存配置。
    pub fn with_memory(mut self, memory: MemoryConfig) -> Self {
        self.memory = memory;
        self
    }

    /// 启用 Authlib-Injector 注入。
    pub fn with_authlib(mut self, authlib: AuthlibInjector) -> Self {
        self.authlib = Some(authlib);
        self
    }

    /// 覆盖 `${version_name}`（默认为版本 id）。
    pub fn with_version_name(mut self, name: impl Into<String>) -> Self {
        self.version_name = name.into();
        self
    }

    /// 设置自定义分辨率（同时置 `has_custom_resolution` 特性，让相关条件参数生效）。
    pub fn with_resolution(mut self, width: u32, height: u32) -> Self {
        self.resolution = Some((width, height));
        self.ctx = self.ctx.with_feature("has_custom_resolution", true);
        self
    }

    /// 以试玩模式启动（置 `is_demo_user` 特性，让 `--demo` 条件参数生效）。
    pub fn demo(mut self, enabled: bool) -> Self {
        self.ctx = self.ctx.with_feature("is_demo_user", enabled);
        self
    }

    /// 全屏启动（追加 `--fullscreen`）。
    pub fn fullscreen(mut self, enabled: bool) -> Self {
        self.fullscreen = enabled;
        self
    }

    /// 追加自定义 JVM 参数（与版本参数去重合并）。
    pub fn add_jvm_args(mut self, args: impl IntoIterator<Item = String>) -> Self {
        self.extra_jvm_args.extend(args);
        self
    }

    /// 追加自定义游戏参数（按键值覆盖合并）。
    pub fn add_game_args(mut self, args: impl IntoIterator<Item = String>) -> Self {
        self.extra_game_args.extend(args);
        self
    }

    /// 启动后直接进入存档或加入服务器。版本不支持这种方式时 [`CommandBuilder::build`] 报
    /// [`LaunchError::QuickPlayUnsupported`]。
    pub fn with_quick_play(mut self, target: QuickPlayTarget) -> Self {
        self.quick_play = Some(target);
        self
    }

    /// 定出直达目标怎样落到命令行上。有 Quick Play 块的版本只走 Quick Play：同一版本删掉了 `--server`。
    fn plan_quick_play(&self) -> Result<Option<QuickPlayPlan>> {
        let Some(target) = &self.quick_play else {
            return Ok(None);
        };
        let mode = target.mode();
        if !quickplay::quick_play_support(self.version).supports(mode) {
            return Err(LaunchError::QuickPlayUnsupported {
                version: self.version.id.clone(),
                mode,
            });
        }
        let plan = match target {
            QuickPlayTarget::Singleplayer { world_dir_name } => QuickPlayPlan::Feature {
                feature: FEATURE_SINGLEPLAYER,
                placeholder: PLACEHOLDER_SINGLEPLAYER,
                value: world_dir_name.clone(),
            },
            QuickPlayTarget::Multiplayer {
                address,
                host,
                port,
            } => {
                if quickplay::has_feature_block(self.version, FEATURE_MULTIPLAYER) {
                    // 原文照传、不补端口：没写端口时由游戏按它自己多人列表的规则解析（含 SRV）。
                    QuickPlayPlan::Feature {
                        feature: FEATURE_MULTIPLAYER,
                        placeholder: PLACEHOLDER_MULTIPLAYER,
                        value: address.clone(),
                    }
                } else {
                    QuickPlayPlan::LegacyServer {
                        host: host.clone(),
                        port: *port,
                    }
                }
            }
        };
        Ok(Some(plan))
    }

    /// 拼出完整启动命令。
    pub fn build(mut self) -> Result<LaunchCommand> {
        // feature 要在展开条件参数之前置上，否则 Quick Play 块不会进入模板序列。
        let quick_play = self.plan_quick_play()?;
        if let Some(QuickPlayPlan::Feature { feature, .. }) = &quick_play {
            self.ctx = self.ctx.with_feature(*feature, true);
        }
        let separator = classpath::classpath_separator(self.ctx.os_name);
        let entries = classpath::classpath_entries(
            self.version,
            &self.ctx,
            &self.paths.libraries_dir,
            &self.paths.client_jar,
        )?;
        let classpath = classpath::classpath_string(&entries, separator);

        let index_id = self
            .version
            .asset_index
            .as_ref()
            .map(|a| a.id.clone())
            .or_else(|| self.version.assets.clone())
            .unwrap_or_default();
        let game_assets = if self.version.maps_assets_to_resources() {
            self.game_dir.join("resources").display().to_string()
        } else if self.version.uses_legacy_assets() {
            self.paths
                .assets_dir
                .join("virtual")
                .join(&index_id)
                .display()
                .to_string()
        } else {
            self.paths.assets_dir.display().to_string()
        };
        let version_type = self
            .version
            .release_type
            .clone()
            .unwrap_or_else(|| "release".to_owned());
        let log_config = self
            .version
            .logging
            .as_ref()
            .and_then(|l| l.client.as_ref())
            .map(|client| -> Result<PathBuf> {
                // 判据与补全时的下载计划一致，免得日志参数指到 log_configs 之外另一个文件。
                check_path_segment(&client.file.id).map_err(|problem| LaunchError::UnsafePath {
                    entry: "日志配置".to_owned(),
                    path: client.file.id.clone(),
                    problem,
                })?;
                Ok(self
                    .paths
                    .assets_dir
                    .join("log_configs")
                    .join(&client.file.id))
            })
            .transpose()?;

        let mut ph = Placeholders::new();
        ph.insert(
            "natives_directory",
            self.paths.natives_dir.display().to_string(),
        );
        ph.insert(
            "library_directory",
            self.paths.libraries_dir.display().to_string(),
        );
        ph.insert("classpath_separator", separator.to_string());
        ph.insert("game_directory", self.game_dir.display().to_string());
        ph.insert("assets_root", self.paths.assets_dir.display().to_string());
        ph.insert("assets_index_name", index_id.as_str());
        ph.insert("game_assets", game_assets);
        ph.insert("version_name", self.version_name.as_str());
        ph.insert("version_type", version_type);
        ph.insert("auth_player_name", self.auth.player_name.as_str());
        ph.insert("auth_uuid", self.auth.uuid.as_str());
        ph.insert("auth_access_token", self.auth.access_token.as_str());
        ph.insert(
            "auth_session",
            format!("token:{}:{}", self.auth.access_token, self.auth.uuid),
        );
        ph.insert("auth_xuid", self.auth.xuid.as_str());
        ph.insert("clientid", self.auth.client_id.as_str());
        ph.insert("user_type", self.auth.user_type.as_str());
        ph.insert("user_properties", self.auth.user_properties.as_str());
        ph.insert("launcher_name", self.launcher_name.as_str());
        ph.insert("launcher_version", self.launcher_version.as_str());
        ph.insert("classpath", classpath.as_str());
        if let Some(path) = &log_config {
            ph.insert("path", path.display().to_string());
        }
        if let Some((width, height)) = self.resolution {
            ph.insert("resolution_width", width.to_string());
            ph.insert("resolution_height", height.to_string());
        }
        if let Some(QuickPlayPlan::Feature {
            placeholder, value, ..
        }) = &quick_play
        {
            ph.insert(*placeholder, value.as_str());
        }

        // JVM 段模板：先注入的安全/编码/内存/authlib，再叠旧版基座（版本 jvm 参数没带 classpath 时）与版本
        // jvm 参数，最后日志参数。
        let mut jvm_templates: Vec<String> = Vec::new();
        jvm_templates.extend(args::security_args());
        jvm_templates.extend(args::encoding_args());
        jvm_templates.extend(self.memory.jvm_args());
        if let Some(authlib) = &self.authlib {
            jvm_templates.extend(authlib.jvm_args());
        }
        if self.auth.access_token == OFFLINE_ACCESS_TOKEN {
            jvm_templates.extend(args::offline_api_args(self.version));
        }
        let version_jvm = self
            .version
            .arguments
            .as_ref()
            .map(|arguments| args::expand_arguments(&arguments.jvm, &self.ctx))
            .unwrap_or_default();
        // 不能按 arguments.jvm 是否为空判断：Legacy Fabric 这类加载器继承 minecraftArguments 的旧版，
        // arguments.jvm 里只有它自己的 -D，classpath 与 natives 路径仍要靠基座。基座排在前面，
        // 与新式版本合并后「原版参数在前、加载器参数在后」的顺序一致。
        if !version_jvm
            .iter()
            .any(|template| template.contains("${classpath}"))
        {
            jvm_templates.extend(args::legacy_jvm_platform_args(&self.ctx));
            jvm_templates.extend(args::legacy_jvm_base_args());
        }
        jvm_templates.extend(version_jvm);
        if let Some(client) = self
            .version
            .logging
            .as_ref()
            .and_then(|l| l.client.as_ref())
        {
            jvm_templates.push(client.argument.clone());
        }

        let mut jvm_args: Vec<String> = jvm_templates.iter().map(|t| ph.substitute(t)).collect();
        if !self.extra_jvm_args.is_empty() {
            jvm_args.extend(self.extra_jvm_args.clone());
        }
        // 放在合并自定义 JVM 参数之后：玩家若自带一条 -DignoreList，同样要按真实 jar 名补齐。
        if let Some(name) = self.paths.client_jar.file_name().and_then(|n| n.to_str()) {
            args::ensure_client_jar_ignored(&mut jvm_args, name);
        }
        let jvm_args = args::dedup_jvm_args(jvm_args);

        let main_class =
            self.version
                .main_class
                .clone()
                .ok_or_else(|| LaunchError::MissingMainClass {
                    version: self.version.id.clone(),
                })?;

        // 游戏段：优先新式 arguments.game，否则旧式 minecraftArguments。加载器继承旧版时新式这段可能只有
        // 自己的 tweak，基础参数还在旧式那段：没带 --username 就把旧式拼在前面，与合并时祖先在前的顺序一致。
        let structured = self
            .version
            .arguments
            .as_ref()
            .filter(|arguments| !arguments.game.is_empty())
            .map(|arguments| args::expand_arguments(&arguments.game, &self.ctx));
        let legacy = self
            .version
            .minecraft_arguments
            .as_deref()
            .map(args::split_legacy_arguments);
        let game_templates: Vec<String> = match (structured, legacy) {
            (Some(structured), Some(mut legacy))
                if !structured.iter().any(|arg| arg == "--username") =>
            {
                legacy.extend(structured);
                legacy
            }
            (Some(structured), _) => structured,
            (None, Some(legacy)) => legacy,
            (None, None) => Vec::new(),
        };
        let mut game_args: Vec<String> = game_templates.iter().map(|t| ph.substitute(t)).collect();
        // 旧式 minecraftArguments 不带窗口尺寸，新式参数靠 has_custom_resolution 条件块带上，
        // 模板里没有时补一份。
        if let Some((width, height)) = self.resolution
            && self.version.accepts_window_size_args()
            && !game_args
                .iter()
                .any(|arg| arg == "--width" || arg == "--height")
        {
            game_args.extend([
                "--width".to_owned(),
                width.to_string(),
                "--height".to_owned(),
                height.to_string(),
            ]);
        }
        // 放在自定义游戏参数合并之前：玩家自己写的 --server / --port 照常覆盖这里的值。端口总是显式写出，
        // 不依赖旧版游戏自己的缺省值。
        if let Some(QuickPlayPlan::LegacyServer { host, port }) = quick_play {
            game_args.extend([
                "--server".to_owned(),
                host,
                "--port".to_owned(),
                port.to_string(),
            ]);
        }
        if self.fullscreen {
            game_args.push("--fullscreen".to_owned());
        }
        if !self.extra_game_args.is_empty() {
            game_args = args::merge_game_args(game_args, self.extra_game_args.clone());
        }

        let mut argv = Vec::with_capacity(jvm_args.len() + 1 + game_args.len());
        argv.extend(jvm_args);
        argv.push(main_class);
        argv.extend(game_args);

        Ok(LaunchCommand {
            program: self.java,
            args: argv,
            working_dir: self.game_dir,
            natives_dir: self.paths.natives_dir,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_paths_follow_minecraft_layout() {
        let paths = GamePaths::standard(PathBuf::from("D:/mc/.minecraft"), "1.21");
        assert_eq!(
            paths.libraries_dir,
            PathBuf::from("D:/mc/.minecraft/libraries")
        );
        assert_eq!(paths.assets_dir, PathBuf::from("D:/mc/.minecraft/assets"));
        assert_eq!(
            paths.client_jar,
            PathBuf::from("D:/mc/.minecraft/versions/1.21/1.21.jar")
        );
        assert_eq!(
            paths.natives_dir,
            PathBuf::from("D:/mc/.minecraft/versions/1.21/1.21-natives")
        );
    }

    #[test]
    fn command_line_quotes_spaced_and_empty_args() {
        let command = LaunchCommand {
            program: PathBuf::from("C:/Program Files/Java/bin/java.exe"),
            args: vec![
                "-Xmx2048m".to_owned(),
                "--userProperties".to_owned(),
                "{}".to_owned(),
                "".to_owned(),
            ],
            working_dir: PathBuf::from("D:/mc"),
            natives_dir: PathBuf::from("D:/mc/natives"),
        };
        let line = command.command_line();
        assert!(line.starts_with("\"C:/Program Files/Java/bin/java.exe\""));
        assert!(line.contains(" -Xmx2048m "));
        // 空参数渲染成一对引号。
        assert!(line.ends_with(" \"\""));
    }

    fn build_with_resolution(json: &str, resolution: Option<(u32, u32)>) -> Vec<String> {
        let version = VersionJson::from_json_str(json).unwrap();
        let ctx = RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64);
        let paths = GamePaths::standard(PathBuf::from("/mc"), &version.id);
        let mut builder = CommandBuilder::new(
            &version,
            ctx,
            "java.exe",
            paths,
            "/mc",
            AuthValues::offline("Steve", "uuid"),
            "1.0.0",
        );
        if let Some((width, height)) = resolution {
            builder = builder.with_resolution(width, height);
        }
        builder.build().unwrap().args
    }

    fn value_after<'a>(args: &'a [String], key: &str) -> Vec<&'a str> {
        args.windows(2)
            .filter(|pair| pair[0] == key)
            .map(|pair| pair[1].as_str())
            .collect()
    }

    /// `--assetsDir` 指到 `${game_assets}`：launchwrapper 从这里读窗口图标，得和资源实际铺开的位置一致。
    fn game_assets_of(json: &str, game_dir: &str) -> String {
        let version = VersionJson::from_json_str(json).unwrap();
        let ctx = RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64);
        let paths = GamePaths::standard(PathBuf::from("/mc"), &version.id);
        let args = CommandBuilder::new(
            &version,
            ctx,
            "java.exe",
            paths,
            game_dir,
            AuthValues::offline("Steve", "uuid"),
            "1.0.0",
        )
        .build()
        .unwrap()
        .args;
        value_after(&args, "--assetsDir")[0].to_owned()
    }

    /// pre-1.6 的资源铺在工作目录的 resources 下（隔离实例就是实例自己的目录），assets/virtual 下没有它。
    #[test]
    fn pre_1_6_assets_dir_is_the_resources_folder_of_the_working_dir() {
        let json = r#"{"id":"b1.7.3","mainClass":"net.minecraft.launchwrapper.Launch","assets":"pre-1.6",
            "minecraftArguments":"${auth_player_name} --gameDir ${game_directory} --assetsDir ${game_assets}"}"#;
        assert_eq!(
            game_assets_of(json, "/mc/versions/b1.7.3"),
            PathBuf::from("/mc/versions/b1.7.3")
                .join("resources")
                .display()
                .to_string()
        );
    }

    #[test]
    fn legacy_index_assets_dir_stays_under_virtual() {
        let json = r#"{"id":"1.6.4","mainClass":"net.minecraft.client.main.Main","assets":"legacy",
            "minecraftArguments":"--username ${auth_player_name} --assetsDir ${game_assets}"}"#;
        assert_eq!(
            game_assets_of(json, "/mc"),
            PathBuf::from("/mc")
                .join("assets")
                .join("virtual")
                .join("legacy")
                .display()
                .to_string()
        );
    }

    fn jvm_args_for(authlib: &str, auth: AuthValues) -> Vec<String> {
        let json = format!(
            r#"{{"id":"1.16.5","mainClass":"net.minecraft.client.main.Main",
                "libraries":[{{"name":"com.mojang:authlib:{authlib}"}}],
                "arguments":{{"game":["--username","${{auth_player_name}}"],"jvm":["-cp","${{classpath}}"]}}}}"#
        );
        let version = VersionJson::from_json_str(&json).unwrap();
        let ctx = RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64);
        let paths = GamePaths::standard(PathBuf::from("/mc"), &version.id);
        CommandBuilder::new(&version, ctx, "java.exe", paths, "/mc", auth, "1.0.0")
            .build()
            .unwrap()
            .args
    }

    fn redirects_api(args: &[String]) -> bool {
        [
            "-Dminecraft.api.auth.host=https://invalid.invalid",
            "-Dminecraft.api.account.host=https://invalid.invalid",
            "-Dminecraft.api.session.host=https://invalid.invalid",
            "-Dminecraft.api.services.host=https://invalid.invalid",
        ]
        .iter()
        .all(|arg| args.iter().any(|a| a == arg))
    }

    /// 1.16.4、1.16.5 带的 authlib 2.1 拿离线占位令牌问权限接口被拒后，多人游戏整个不可用；接口连不上时它才
    /// 按离线处理。指到解析不了的地址，离线账户才进得了局域网和第三方服务器。
    #[test]
    fn offline_account_on_authlib_2_1_redirects_the_api_hosts() {
        let args = jvm_args_for("2.1.28", AuthValues::offline("Steve", "uuid"));
        assert!(redirects_api(&args), "{args:?}");
    }

    #[test]
    fn other_authlib_versions_keep_the_real_api_hosts() {
        for authlib in ["1.5.25", "2.3.31", "6.0.54"] {
            let args = jvm_args_for(authlib, AuthValues::offline("Steve", "uuid"));
            assert!(
                !args.iter().any(|a| a.starts_with("-Dminecraft.api.")),
                "{authlib}: {args:?}"
            );
        }
    }

    /// 带真实令牌的账户要连官方接口：正版校验、皮肤与 Realms 都靠它。
    #[test]
    fn real_token_keeps_the_real_api_hosts_on_authlib_2_1() {
        let auth = AuthValues {
            access_token: "real-token".to_owned(),
            user_type: "msa".to_owned(),
            ..AuthValues::offline("Steve", "uuid")
        };
        let args = jvm_args_for("2.1.28", auth);
        assert!(
            !args.iter().any(|a| a.starts_with("-Dminecraft.api.")),
            "{args:?}"
        );
    }

    /// 1.12.2 及更早的 minecraftArguments 不带窗口尺寸参数，游戏本身认 `--width` / `--height`：
    /// 设了分辨率就要补上，否则实例设置里的窗口大小对这些版本不生效。
    #[test]
    fn legacy_arguments_get_the_custom_resolution_appended() {
        let legacy = r#"{"id":"1.12.2","mainClass":"net.minecraft.client.main.Main",
            "minecraftArguments":"--username ${auth_player_name} --version ${version_name}"}"#;
        let args = build_with_resolution(legacy, Some((1920, 1080)));
        assert_eq!(value_after(&args, "--width"), vec!["1920"]);
        assert_eq!(value_after(&args, "--height"), vec!["1080"]);
        assert_eq!(args.last().map(String::as_str), Some("1080"));

        // 没设分辨率：不凭空加尺寸参数，交给游戏自己的默认窗口。
        let args = build_with_resolution(legacy, None);
        assert!(!args.iter().any(|a| a == "--width" || a == "--height"));
    }

    /// 13w25a 之前的 Main 不认窗口尺寸选项，遇到未知选项直接退出，默认分辨率也会让这些快照起不来。
    /// 13w24b 的模板和 1.6 已经一样，只能按发布时间分。
    #[test]
    fn versions_before_13w25a_never_get_the_resolution_appended() {
        for (id, released) in [
            ("13w16a", "2013-04-21T12:49:30+00:00"),
            ("13w24b", "2013-06-14T12:19:13+00:00"),
        ] {
            let json = serde_json::json!({
                "id": id, "mainClass": "net.minecraft.client.main.Main",
                "releaseTime": released,
                "minecraftArguments": "--username ${auth_player_name}",
            })
            .to_string();
            let args = build_with_resolution(&json, Some((1280, 720)));
            assert!(
                !args.iter().any(|a| a == "--width" || a == "--height"),
                "{id}: {args:?}"
            );
        }
    }

    #[test]
    fn resolution_is_appended_from_13w25a_on() {
        let json = serde_json::json!({
            "id": "13w25a", "mainClass": "net.minecraft.client.main.Main",
            "releaseTime": "2013-06-17T14:08:06+00:00",
            "minecraftArguments": "--username ${auth_player_name}",
        })
        .to_string();
        let args = build_with_resolution(&json, Some((1280, 720)));
        assert_eq!(value_after(&args, "--width"), vec!["1280"]);
        assert_eq!(value_after(&args, "--height"), vec!["720"]);
    }

    /// 新式参数自带 has_custom_resolution 条件块：只出现一份，不重复追加。
    #[test]
    fn modern_arguments_carry_the_resolution_exactly_once() {
        let modern = r#"{"id":"1.21","mainClass":"net.minecraft.client.main.Main",
            "arguments":{"game":["--username","${auth_player_name}",
                {"rules":[{"action":"allow","features":{"has_custom_resolution":true}}],
                 "value":["--width","${resolution_width}","--height","${resolution_height}"]}],
             "jvm":["-cp","${classpath}"]}}"#;
        let args = build_with_resolution(modern, Some((854, 480)));
        assert_eq!(value_after(&args, "--width"), vec!["854"]);
        assert_eq!(value_after(&args, "--height"), vec!["480"]);
    }

    /// 旧版又设分辨率又直达服务器：窗口尺寸与 `--server` / `--port` 都走追加，谁也不能挤掉谁。
    #[test]
    fn legacy_arguments_keep_the_resolution_alongside_the_quick_play_server() {
        let version = VersionJson::from_json_str(
            r#"{"id":"1.12.2","mainClass":"net.minecraft.client.main.Main",
            "minecraftArguments":"--username ${auth_player_name} --version ${version_name}"}"#,
        )
        .unwrap();
        let ctx = RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64);
        let paths = GamePaths::standard(PathBuf::from("/mc"), &version.id);
        let args = CommandBuilder::new(
            &version,
            ctx,
            "java.exe",
            paths,
            "/mc",
            AuthValues::offline("Steve", "uuid"),
            "1.0.0",
        )
        .with_resolution(1920, 1080)
        .with_quick_play(QuickPlayTarget::Multiplayer {
            address: "play.example.com:25566".to_owned(),
            host: "play.example.com".to_owned(),
            port: 25566,
        })
        .build()
        .unwrap()
        .args;
        assert_eq!(value_after(&args, "--width"), vec!["1920"]);
        assert_eq!(value_after(&args, "--height"), vec!["1080"]);
        assert_eq!(value_after(&args, "--server"), vec!["play.example.com"]);
        assert_eq!(value_after(&args, "--port"), vec!["25566"]);
    }

    /// 判据看展开后的模板：条件块没命中时 classpath 并没有进命令行，`${classpath_separator}` 也不是 classpath。
    #[test]
    fn legacy_base_is_added_whenever_the_expanded_jvm_args_have_no_classpath() {
        for jvm in [
            r#""-Dloader.own=1""#,
            r#"{"rules":[{"action":"allow","os":{"name":"linux"}}],"value":["-cp","${classpath}"]},"-Dloader.own=1""#,
            r#""-p","${library_directory}/a.jar${classpath_separator}${library_directory}/b.jar""#,
        ] {
            let json = format!(
                r#"{{"id":"1.12.2","mainClass":"m",
                "minecraftArguments":"--username ${{auth_player_name}}",
                "arguments":{{"jvm":[{jvm}]}}}}"#
            );
            let args = build_with_resolution(&json, None);
            let classpaths = value_after(&args, "-cp");
            assert_eq!(classpaths.len(), 1, "{jvm}：{args:?}");
            assert!(classpaths[0].ends_with("1.12.2.jar"), "{jvm}：{args:?}");
            assert!(
                args.iter().any(|a| a.starts_with("-Djava.library.path=")),
                "{jvm}：{args:?}"
            );
        }
    }

    /// 模板自带 classpath 就是完整的 jvm 参数，不管是不是写成 `-cp`：再补一份基座只会多出第二条 classpath。
    #[test]
    fn jvm_args_that_carry_the_classpath_get_no_legacy_base() {
        for (jvm, cp_flags) in [
            (r#""-cp","${classpath}""#, 1),
            (r#""-Djava.class.path=${classpath}""#, 0),
            (
                r#"{"rules":[{"action":"allow","os":{"name":"windows"}}],"value":["-cp","${classpath}"]}"#,
                1,
            ),
        ] {
            let json = format!(
                r#"{{"id":"1.12.2","mainClass":"m",
                "minecraftArguments":"--username ${{auth_player_name}}",
                "arguments":{{"jvm":[{jvm}]}}}}"#
            );
            let args = build_with_resolution(&json, None);
            assert!(
                !args.iter().any(|a| a.starts_with("-Djava.library.path=")
                    || a.starts_with("-Dminecraft.launcher.brand=")
                    || a.starts_with("-XX:HeapDumpPath=")),
                "{jvm}：{args:?}"
            );
            assert_eq!(value_after(&args, "-cp").len(), cp_flags, "{jvm}：{args:?}");
        }
    }

    /// 加载器继承旧版时 `arguments.game` 可能只有自己的 tweak，`--username` 这些基础参数还在旧式那一段：
    /// 不能丢，旧式在前，与新式参数合并时祖先在前的顺序一致。
    #[test]
    fn game_args_without_the_base_keep_the_legacy_ones_in_front() {
        let json = r#"{"id":"1.12.2","mainClass":"m",
            "minecraftArguments":"--username ${auth_player_name} --version ${version_name}",
            "arguments":{"game":["--tweakClass","x.Tweaker"]}}"#;
        let args = build_with_resolution(json, None);
        let at = |flag: &str| args.iter().position(|a| a == flag);
        assert!(at("--username").unwrap() < at("--tweakClass").unwrap(), "{args:?}");
        assert_eq!(value_after(&args, "--version"), ["1.12.2"]);
    }

    /// `arguments.game` 自带基础参数就是完整的一段：再拼旧式会重复，joptsimple 读单值选项时报错退出。
    #[test]
    fn complete_game_args_leave_the_legacy_ones_out() {
        let json = r#"{"id":"1.12.2","mainClass":"m",
            "minecraftArguments":"--username ${auth_player_name} --legacyOnly x",
            "arguments":{"game":["--username","${auth_player_name}","--version","${version_name}"]}}"#;
        let args = build_with_resolution(json, None);
        assert_eq!(value_after(&args, "--username").len(), 1, "{args:?}");
        assert!(!args.iter().any(|a| a == "--legacyOnly"), "{args:?}");
    }

    /// 官方版本 JSON 里真实出现过的日志配置名都能通过校验，`-Dlog4j.configurationFile` 指向 log_configs 下的
    /// 这个文件；拼接路径时段里的空格、中文不受影响。
    #[test]
    fn real_log_config_names_reach_the_jvm_argument() {
        for id in ["client-1.7.xml", "client-1.12.xml", "client-1.21.2.xml"] {
            let json = serde_json::json!({
                "id": "1.21", "mainClass": "net.minecraft.client.main.Main",
                "logging": {"client": {
                    "argument": "-Dlog4j.configurationFile=${path}",
                    "file": {"id": id, "sha1": "a", "size": 1, "url": "u"},
                    "type": "log4j2-xml"
                }}
            });
            let version = VersionJson::from_json_str(&json.to_string()).unwrap();
            let ctx = RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64);
            let root = PathBuf::from("/我的 世界/.minecraft");
            let paths = GamePaths::standard(root.clone(), "1.21");
            let args = CommandBuilder::new(
                &version,
                ctx,
                "java.exe",
                paths,
                &root,
                AuthValues::offline("Steve", "uuid"),
                "1.0.0",
            )
            .build()
            .unwrap()
            .args;
            let expected = format!(
                "-Dlog4j.configurationFile={}",
                root.join("assets").join("log_configs").join(id).display()
            );
            assert!(args.contains(&expected), "{id}：{args:?}");
        }
    }

    /// 日志配置名原样当作 `assets/log_configs/` 下的文件名：不是单个安全路径段时报路径越界，
    /// 与补全时的下载计划同一判据，不把 `-Dlog4j.configurationFile` 指到目录外的文件。
    #[test]
    fn build_rejects_a_log_config_name_escaping_log_configs() {
        for (id, problem) in [
            (r"..\..\evil.xml", aurora_version::UnsafePath::Backslash),
            ("../evil.xml", aurora_version::UnsafePath::Separator),
            ("..", aurora_version::UnsafePath::DotSegment),
        ] {
            let json = serde_json::json!({
                "id": "1.21", "mainClass": "net.minecraft.client.main.Main",
                "logging": {"client": {
                    "argument": "-Dlog4j.configurationFile=${path}",
                    "file": {"id": id, "sha1": "a", "size": 1, "url": "u"},
                    "type": "log4j2-xml"
                }}
            });
            let version = VersionJson::from_json_str(&json.to_string()).unwrap();
            let ctx = RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64);
            let paths = GamePaths::standard(PathBuf::from("/mc"), "1.21");
            let err = CommandBuilder::new(
                &version,
                ctx,
                "java.exe",
                paths,
                "/mc",
                AuthValues::offline("Steve", "uuid"),
                "1.0.0",
            )
            .build()
            .unwrap_err();
            assert!(
                matches!(
                    &err,
                    LaunchError::UnsafePath { entry, path, problem: got }
                        if entry == "日志配置" && path == id && *got == problem
                ),
                "{id}：{err:?}"
            );
        }
    }

    #[test]
    fn build_errors_when_main_class_missing() {
        let version = VersionJson::from_json_str(r#"{"id":"x"}"#).unwrap();
        let ctx = RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64);
        let paths = GamePaths::standard(PathBuf::from("/mc"), "x");
        let err = CommandBuilder::new(
            &version,
            ctx,
            "java.exe",
            paths,
            "/mc",
            AuthValues::offline("Steve", "uuid"),
            "1.0.0",
        )
        .build()
        .unwrap_err();
        assert!(matches!(err, LaunchError::MissingMainClass { version } if version == "x"));
    }
}
