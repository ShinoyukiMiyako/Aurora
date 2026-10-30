//! 离线启动编排：账户 -> 版本合并 -> Java 解析 -> 启动前检查 -> 命令拼装 -> 进程 spawn。
//!
//! 门面把 aurora-instance（版本发现/隔离）、aurora-version（继承合并）、aurora-java（探测/自动下载）、
//! aurora-launch（命令拼装/进程/启动前检查）串成一次可执行的离线启动。启动前只做轻量存在性检查
//! （启动前检查报告），深度文件补全（`ensure_complete`）由安装流程负责，不在每次启动时重跑逐文件哈希。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use aurora_auth::Account;
use aurora_instance::{IsolationOverride, discover_versions};
use aurora_java::{DetectSource, JavaInstallation, detect_all, select_for_major};
use aurora_launch::{
    AuthValues, CheckStatus, CommandBuilder, GamePaths, GameSession, LaunchCommand, LogLine,
    MemoryConfig, PreLaunchInput, precheck, resolve_game_directory, spawn,
};
use aurora_version::{RuntimeContext, VersionJson, resolve};
use tokio::sync::mpsc;

use crate::error::{CoreError, Result};
use crate::event::{CoreEvent, EventSink, emit};
use crate::facade::Aurora;

/// 离线启动的可覆盖选项（缺省取全局配置）。
#[derive(Debug, Clone, Default)]
pub struct LaunchOptions {
    /// 最大堆（MB）；缺省取配置的内存设置。
    pub max_memory_mb: Option<u32>,
    /// 最小堆（MB）；缺省取配置的内存设置。
    pub min_memory_mb: Option<u32>,
    /// 是否全屏启动。
    pub fullscreen: bool,
    /// 追加的自定义 JVM 参数（透传给 `CommandBuilder::add_jvm_args`，与版本参数去重合并）。
    pub extra_jvm_args: Vec<String>,
    /// 追加的自定义游戏参数（透传给 `CommandBuilder::add_game_args`，按键值覆盖合并）。
    pub extra_game_args: Vec<String>,
    /// 自定义窗口分辨率 `(宽, 高)`；缺省用游戏默认（None 时不置 `has_custom_resolution` 特性）。
    pub resolution: Option<(u32, u32)>,
    /// 是否以试玩（demo）模式启动。
    pub demo: bool,
}

impl Aurora {
    /// 以离线账户启动指定的已安装版本，返回运行中的游戏会话。
    ///
    /// `log_tx` 提供时逐行转发游戏进程输出（供 CLI/前端实时展示）。启动前会做轻量检查（主类、客户端
    /// jar 存在、Java 匹配、路径字符）；任一阻断项都会中止并冒泡。
    pub async fn launch_offline(
        &self,
        version_id: &str,
        player_name: &str,
        options: &LaunchOptions,
        log_tx: Option<mpsc::Sender<LogLine>>,
        events: Option<&EventSink>,
    ) -> Result<GameSession> {
        let account = self.create_offline_account(player_name, events)?;
        let auth = AuthValues::offline(&account.name, &account.uuid);
        self.launch_with_auth(version_id, &account, auth, options, log_tx, events)
            .await
    }

    /// 以已登录账户启动指定的已安装版本，返回运行中的游戏会话。
    ///
    /// 与 [`Aurora::launch_offline`] 共用同一套启动编排；差别只在鉴权值来源——这里由
    /// [`AuthValues::from_account`] 摊平账户令牌。微软账户若未缓存有效 Minecraft 令牌会直接冒泡
    /// [`aurora_launch::LaunchError::MissingAccessToken`]（同时启动前检查的账户令牌项也会阻断）。
    pub async fn launch_account(
        &self,
        version_id: &str,
        account: &Account,
        options: &LaunchOptions,
        log_tx: Option<mpsc::Sender<LogLine>>,
        events: Option<&EventSink>,
    ) -> Result<GameSession> {
        let auth = AuthValues::from_account(account)?;
        self.launch_with_auth(version_id, account, auth, options, log_tx, events)
            .await
    }

    /// 启动编排主体：版本发现/合并 -> Java 解析 -> 隔离目录 -> 启动前检查 -> 命令拼装 -> spawn。
    ///
    /// `account` 供启动前检查读取账户类型与令牌有效期；`auth` 是已摊平、直接注入命令占位符的鉴权值。
    /// 二者由离线/在线两条入口分别构造后传入，令本函数与「账户身份从何而来」解耦。
    async fn launch_with_auth(
        &self,
        version_id: &str,
        account: &Account,
        auth: AuthValues,
        options: &LaunchOptions,
        log_tx: Option<mpsc::Sender<LogLine>>,
        events: Option<&EventSink>,
    ) -> Result<GameSession> {
        // 版本发现 + 继承合并。
        let scan = discover_versions(self.game_dir()).await?;
        let mut provider: HashMap<String, VersionJson> = HashMap::new();
        for version in &scan.versions {
            provider.insert(version.id.clone(), version.json.clone());
        }
        let target = scan
            .versions
            .iter()
            .find(|v| v.id == version_id)
            .ok_or_else(|| CoreError::VersionNotInstalled {
                id: version_id.to_owned(),
            })?;
        let merged = resolve(&target.json, &provider)?;
        // 客户端 jar 与 natives 落在继承链根（原版）版本目录；离线原版即自身。
        let base_id = resolve_base_id(&provider, version_id);

        // Java 解析（本地匹配优先，缺失且允许时自动下载），产出探测列表供启动前检查复用。
        let required_major = merged
            .java_version
            .as_ref()
            .map(|j| j.major_version)
            .unwrap_or(8);
        let (installations, java_path) = self.prepare_java(required_major, events).await?;

        // 版本隔离判定，产出工作目录。
        let resolved = resolve_game_directory(
            self.game_dir(),
            version_id,
            self.config().isolation_policy,
            IsolationOverride::FollowGlobal,
            target.has_mod_loader(),
            target.is_release(),
        )
        .await?;
        let working_dir = resolved.working_dir.clone();
        tokio::fs::create_dir_all(&working_dir)
            .await
            .map_err(|source| aurora_base::Error::Io {
                path: working_dir.clone(),
                source,
            })?;

        let paths = GamePaths::standard(self.game_dir(), &base_id);

        // 启动前检查。
        let report = precheck::run(&PreLaunchInput {
            game_dir: &working_dir,
            version: &merged,
            java_installations: &installations,
            account,
            now_unix: now_unix(),
            client_jar: &paths.client_jar,
        });
        for item in &report.items {
            if item.status == CheckStatus::Warn {
                emit(events, CoreEvent::warning(format!("{}：{}", item.name, item.message)));
            }
        }
        if report.is_blocking() {
            let failures = report
                .items
                .iter()
                .filter(|i| i.status == CheckStatus::Fail)
                .map(|i| format!("{}：{}", i.name, i.message))
                .collect::<Vec<_>>()
                .join("；");
            return Err(CoreError::PrecheckFailed(failures));
        }

        let memory = self.memory_config(options);
        let command = assemble_command(
            &merged,
            &java_path,
            paths,
            &working_dir,
            auth,
            version_id,
            self.runtime().clone(),
            memory,
            options,
        )?;
        emit(
            events,
            CoreEvent::stage(format!(
                "启动命令已就绪：Java {} 主类 {}",
                java_path.display(),
                merged.main_class.as_deref().unwrap_or("<未知>")
            )),
        );

        let session = spawn(&command, log_tx)?;
        emit(
            events,
            CoreEvent::stage(format!(
                "游戏进程已启动（工作目录 {}{}）",
                working_dir.display(),
                if resolved.isolated { "，已隔离" } else { "" }
            )),
        );
        Ok(session)
    }

    /// 解析可用 Java：本地探测并按主版本匹配，缺失且允许时自动下载 Mojang 运行时。
    ///
    /// 返回 `(探测/托管的 Java 列表, 选中的 java 可执行文件路径)`；列表含选中的 Java，供启动前检查复用。
    pub(crate) async fn prepare_java(
        &self,
        required_major: u32,
        events: Option<&EventSink>,
    ) -> Result<(Vec<JavaInstallation>, PathBuf)> {
        let mut installations = tokio::task::spawn_blocking(detect_all).await?;
        if let Some(java) = select_for_major(&installations, required_major) {
            let path = java.path.clone();
            emit(
                events,
                CoreEvent::stage(format!("使用本地 Java {required_major}：{}", path.display())),
            );
            return Ok((installations, path));
        }

        if !self.config().auto_download_java {
            return Err(CoreError::NoJava {
                major: required_major,
            });
        }

        emit(
            events,
            CoreEvent::stage(format!("本地未找到 Java {required_major}，开始下载 Mojang 运行时")),
        );
        let installer = self.java_installer(self.java_runtime_url());
        let install_dir = self
            .data_dir()
            .join("runtime")
            .join(required_major.to_string());
        let runtime = installer.install(required_major, &install_dir).await?;
        let exe = runtime.java_executable.clone();
        // 探测刚下载的运行时，纳入列表让启动前检查的 Java 项通过。
        let probed =
            tokio::task::spawn_blocking(move || aurora_java::probe(&exe, DetectSource::Managed))
                .await??;
        let path = probed.path.clone();
        installations.push(probed);
        emit(
            events,
            CoreEvent::stage(format!("Java {required_major} 运行时安装完成：{}", path.display())),
        );
        Ok((installations, path))
    }

    /// 由启动选项与全局配置算出内存配置。
    fn memory_config(&self, options: &LaunchOptions) -> MemoryConfig {
        let max = options.max_memory_mb.unwrap_or(self.config().memory.max_mb);
        let mut config = MemoryConfig::fixed(max);
        if let Some(min) = options.min_memory_mb.or(self.config().memory.min_mb) {
            config = config.with_min(min);
        }
        config
    }
}

/// 沿 `inheritsFrom` 链找到继承根版本 id（持有客户端 jar / natives 的版本）。
///
/// 原版无 `inheritsFrom`，返回自身；加载器版本返回其原版 id。带环保护（异常数据不至死循环）。
fn resolve_base_id(provider: &HashMap<String, VersionJson>, root_id: &str) -> String {
    let mut current = root_id.to_owned();
    let mut seen = std::collections::HashSet::new();
    while seen.insert(current.clone()) {
        match provider.get(&current).and_then(|v| v.inherits_from.clone()) {
            Some(parent) => current = parent,
            None => break,
        }
    }
    current
}

/// 用合并后的版本 JSON、路径与已摊平的鉴权值拼出可执行的启动命令。
///
/// 启动选项里的分辨率/试玩/自定义 JVM 与游戏参数在此透传进 [`CommandBuilder`]；分辨率仅在显式提供时
/// 才置 `has_custom_resolution` 特性，避免无谓地触发条件参数。
#[allow(clippy::too_many_arguments)]
fn assemble_command(
    merged: &VersionJson,
    java: &Path,
    paths: GamePaths,
    working_dir: &Path,
    auth: AuthValues,
    version_name: &str,
    runtime: RuntimeContext,
    memory: MemoryConfig,
    options: &LaunchOptions,
) -> Result<LaunchCommand> {
    let mut builder = CommandBuilder::new(merged, runtime, java, paths, working_dir, auth)
        .with_memory(memory)
        .with_version_name(version_name)
        .demo(options.demo)
        .fullscreen(options.fullscreen)
        .add_jvm_args(options.extra_jvm_args.iter().cloned())
        .add_game_args(options.extra_game_args.iter().cloned());
    if let Some((width, height)) = options.resolution {
        builder = builder.with_resolution(width, height);
    }
    let command = builder.build()?;
    Ok(command)
}

/// 当前 Unix 秒（时钟异常时退化为 0，令令牌视为过期，属安全兜底）。
fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(json: &str) -> VersionJson {
        VersionJson::from_json_str(json).unwrap()
    }

    #[test]
    fn base_id_walks_inheritance_chain() {
        let mut provider = HashMap::new();
        provider.insert(
            "1.21".to_owned(),
            version(r#"{"id":"1.21","type":"release","mainClass":"m"}"#),
        );
        provider.insert(
            "fabric-loader-0.15.11-1.21".to_owned(),
            version(
                r#"{"id":"fabric-loader-0.15.11-1.21","inheritsFrom":"1.21","mainClass":"knot"}"#,
            ),
        );

        // 加载器版本 -> 原版根。
        assert_eq!(
            resolve_base_id(&provider, "fabric-loader-0.15.11-1.21"),
            "1.21"
        );
        // 原版 -> 自身。
        assert_eq!(resolve_base_id(&provider, "1.21"), "1.21");
        // 未知 id -> 原样返回。
        assert_eq!(resolve_base_id(&provider, "ghost"), "ghost");
    }

    #[test]
    fn base_id_survives_cyclic_data() {
        let mut provider = HashMap::new();
        provider.insert(
            "a".to_owned(),
            version(r#"{"id":"a","inheritsFrom":"b","mainClass":"m"}"#),
        );
        provider.insert(
            "b".to_owned(),
            version(r#"{"id":"b","inheritsFrom":"a","mainClass":"m"}"#),
        );
        // 环不应死循环；返回环上某个 id（不 panic 即可）。
        let base = resolve_base_id(&provider, "a");
        assert!(base == "a" || base == "b");
    }

    #[test]
    fn assemble_offline_command_injects_auth_memory_and_main_class() {
        let merged = version(
            r#"{"id":"1.21","type":"release","mainClass":"net.minecraft.client.main.Main",
                "minecraftArguments":"--username ${auth_player_name} --uuid ${auth_uuid} --accessToken ${auth_access_token}"}"#,
        );
        let runtime = RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64);
        let paths = GamePaths::standard(PathBuf::from("D:/mc/.minecraft"), "1.21");
        let command = assemble_command(
            &merged,
            Path::new("C:/java/bin/java.exe"),
            paths,
            Path::new("D:/mc/.minecraft"),
            AuthValues::offline("Steve", "5627dd98e6be3c21b8a8e92344183641"),
            "1.21",
            runtime,
            MemoryConfig::fixed(3072).with_min(512),
            &LaunchOptions::default(),
        )
        .unwrap();

        assert_eq!(command.program, PathBuf::from("C:/java/bin/java.exe"));
        assert_eq!(command.working_dir, PathBuf::from("D:/mc/.minecraft"));
        // 内存参数（-Xms 在前、-Xmx 在后）。
        assert!(command.args.iter().any(|a| a == "-Xms512m"));
        assert!(command.args.iter().any(|a| a == "-Xmx3072m"));
        // 主类。
        assert!(command.args.iter().any(|a| a == "net.minecraft.client.main.Main"));
        // 离线鉴权值经占位符替换进入游戏参数。
        let joined = command.args.join(" ");
        assert!(joined.contains("--username Steve"));
        assert!(joined.contains("--uuid 5627dd98e6be3c21b8a8e92344183641"));
        // 离线访问令牌占位常量 "0"。
        assert!(joined.contains("--accessToken 0"));
    }

    #[test]
    fn assemble_command_from_account_injects_account_identity() {
        use aurora_auth::{AccountCredentials, MicrosoftCredentials};

        // 已登录微软账户（缓存了 Minecraft 令牌）经 from_account 摊平后走同一命令拼装路径。
        let account = Account::new(
            "5627dd98e6be3c21b8a8e92344183641",
            "Alex",
            AccountCredentials::Microsoft(MicrosoftCredentials {
                refresh_token: "refresh".into(),
                minecraft_token: Some("mc-live-token".into()),
                minecraft_expires_at: Some(9_999_999_999),
            }),
        );
        let auth = AuthValues::from_account(&account).unwrap();

        let merged = version(
            r#"{"id":"1.21","type":"release","mainClass":"net.minecraft.client.main.Main",
                "minecraftArguments":"--username ${auth_player_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type}"}"#,
        );
        let runtime = RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64);
        let paths = GamePaths::standard(PathBuf::from("D:/mc/.minecraft"), "1.21");
        let command = assemble_command(
            &merged,
            Path::new("C:/java/bin/java.exe"),
            paths,
            Path::new("D:/mc/.minecraft"),
            auth,
            "1.21",
            runtime,
            MemoryConfig::fixed(2048),
            &LaunchOptions::default(),
        )
        .unwrap();

        let joined = command.args.join(" ");
        // 账户身份（名/uuid）与真实访问令牌注入游戏参数，且用户类型为 msa。
        assert!(joined.contains("--username Alex"));
        assert!(joined.contains("--uuid 5627dd98e6be3c21b8a8e92344183641"));
        assert!(joined.contains("--accessToken mc-live-token"));
        assert!(joined.contains("--userType msa"));
    }

    #[test]
    fn launch_options_reach_command_args() {
        // 新式 arguments.game：含分辨率与试玩两个条件参数，验证 with_resolution/demo 特性开关生效。
        let merged = version(
            r#"{"id":"1.21","type":"release","mainClass":"net.minecraft.client.main.Main",
                "arguments":{"jvm":[],"game":[
                    "--username","${auth_player_name}",
                    {"rules":[{"action":"allow","features":{"has_custom_resolution":true}}],
                     "value":["--width","${resolution_width}","--height","${resolution_height}"]},
                    {"rules":[{"action":"allow","features":{"is_demo_user":true}}],"value":"--demo"}
                ]}}"#,
        );
        let runtime = RuntimeContext::new(aurora_version::OsName::Windows, "x86_64", 64);
        let paths = GamePaths::standard(PathBuf::from("D:/mc/.minecraft"), "1.21");
        let options = LaunchOptions {
            extra_jvm_args: vec!["-XX:+UseStringDeduplication".to_owned()],
            extra_game_args: vec!["--server".to_owned(), "mc.example.net".to_owned()],
            resolution: Some((1280, 720)),
            demo: true,
            ..LaunchOptions::default()
        };
        let command = assemble_command(
            &merged,
            Path::new("C:/java/bin/java.exe"),
            paths,
            Path::new("D:/mc/.minecraft"),
            AuthValues::offline("Steve", "uuid0"),
            "1.21",
            runtime,
            MemoryConfig::fixed(2048),
            &options,
        )
        .unwrap();

        let joined = command.args.join(" ");
        // 自定义 JVM 参数原样进入。
        assert!(command.args.iter().any(|a| a == "-XX:+UseStringDeduplication"));
        // 自定义游戏参数（新键）追加进入。
        assert!(joined.contains("--server mc.example.net"));
        // 分辨率经条件参数与占位符替换进入。
        assert!(joined.contains("--width 1280"));
        assert!(joined.contains("--height 720"));
        // 试玩模式条件参数生效。
        assert!(command.args.iter().any(|a| a == "--demo"));
    }
}
