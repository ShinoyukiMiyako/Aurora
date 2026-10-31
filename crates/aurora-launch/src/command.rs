//! 启动命令拼装：把版本 JSON、路径、账户、内存、Authlib-Injector 组合成完整的
//! `java <jvm 参数...> <主类> <游戏参数...>` 与工作目录。
//!
//! 这是本 crate 的门面：JVM 段（安全/编码/内存/authlib + 版本 jvm 参数或旧版基座 + 日志参数）与
//! 游戏段（新式 `arguments.game` 或旧式 `minecraftArguments`）分别拼成模板序列，再统一过一遍 `${}` 占位符
//! 替换。占位符全表（natives/library/game_directory/assets/auth_*/version_type/classpath…）在这里一次性算好。

use std::path::PathBuf;

use aurora_version::{RuntimeContext, VersionJson};
use serde::Serialize;

use crate::account::{AuthValues, AuthlibInjector};
use crate::args;
use crate::classpath;
use crate::error::{LaunchError, Result};
use crate::memory::MemoryConfig;
use crate::placeholder::Placeholders;

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

    /// 拼出完整启动命令。
    pub fn build(self) -> Result<LaunchCommand> {
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
        let game_assets = if self.version.uses_legacy_assets() {
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
            .map(|client| {
                self.paths
                    .assets_dir
                    .join("log_configs")
                    .join(&client.file.id)
            });

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

        // JVM 段模板：先注入的安全/编码/内存/authlib，再叠版本 jvm 参数（或旧版基座），最后日志参数。
        let mut jvm_templates: Vec<String> = Vec::new();
        jvm_templates.extend(args::security_args());
        jvm_templates.extend(args::encoding_args());
        jvm_templates.extend(self.memory.jvm_args());
        if let Some(authlib) = &self.authlib {
            jvm_templates.extend(authlib.jvm_args());
        }
        match self
            .version
            .arguments
            .as_ref()
            .filter(|arguments| !arguments.jvm.is_empty())
        {
            Some(arguments) => {
                jvm_templates.extend(args::expand_arguments(&arguments.jvm, &self.ctx))
            }
            None => jvm_templates.extend(args::legacy_jvm_base_args()),
        }
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

        // 游戏段：优先新式 arguments.game，否则旧式 minecraftArguments。
        let game_templates: Vec<String> = if let Some(arguments) = self
            .version
            .arguments
            .as_ref()
            .filter(|arguments| !arguments.game.is_empty())
        {
            args::expand_arguments(&arguments.game, &self.ctx)
        } else if let Some(legacy) = &self.version.minecraft_arguments {
            args::split_legacy_arguments(legacy)
        } else {
            Vec::new()
        };
        let mut game_args: Vec<String> = game_templates.iter().map(|t| ph.substitute(t)).collect();
        // 旧式 minecraftArguments 不带窗口尺寸，新式参数靠 has_custom_resolution 条件块带上；
        // 游戏 1.6 起都认 --width / --height，模板里没有时补一份。
        if let Some((width, height)) = self.resolution
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
