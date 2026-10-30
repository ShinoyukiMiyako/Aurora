//! Petalfall 调试 CLI：端到端冒烟的载体。
//!
//! 子命令覆盖 architecture.md 约定的验收路径：列版本清单 / 安装（原版 + Fabric/Quilt）/ 微软登录与
//! 账户状态 / 离线启动 / 资源搜索。所有业务逻辑在 aurora-core，本层只做参数解析、tracing subscriber
//! 初始化与人类可读输出。库内只发 tracing 事件，subscriber 在此配置并写到 stderr，与 stdout 的
//! 人类可读输出分离。

use std::path::PathBuf;
use std::process::ExitCode;

use aurora_core::{
    Aurora, CoreEvent, EventSink, LaunchOptions, LoaderChoice, LogLine, LogStream, ModLoader,
    SearchQuery, analyze, detect_crash,
};
use clap::{Parser, Subcommand, ValueEnum};
use tokio::sync::mpsc;

/// Petalfall 调试命令行。命令名 `aurora` 与日志过滤目标绑定 crate 名，属内部代号，不随产品名改。
#[derive(Debug, Parser)]
#[command(name = "aurora", version, about = concat!(aurora_base::app_name_en!(), " 调试 CLI"))]
struct Cli {
    /// 游戏目录（.minecraft），覆盖配置默认值。
    #[arg(long, global = true)]
    game_dir: Option<PathBuf>,
    /// 微软登录 client_id，覆盖配置与环境变量。
    #[arg(long, global = true)]
    client_id: Option<String>,
    /// 输出更详细的日志（等价于 RUST_LOG=aurora=debug）。
    #[arg(long, short, global = true)]
    verbose: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// 版本清单与本地版本。
    Versions {
        #[command(subcommand)]
        action: VersionsAction,
    },
    /// 安装版本（原版，可选叠加 Fabric/Quilt 加载器）。
    Install {
        /// 版本 id，如 1.21.1。
        id: String,
        /// 附加安装的 Mod 加载器。
        #[arg(long, value_enum)]
        loader: Option<LoaderArg>,
        /// 加载器版本，缺省取推荐版。
        #[arg(long)]
        loader_version: Option<String>,
    },
    /// 账户（微软登录 / 状态）。
    Auth {
        #[command(subcommand)]
        action: AuthAction,
    },
    /// 以离线账户启动已安装的版本。
    Launch {
        /// 要启动的版本 id。
        version: String,
        /// 离线角色名。
        #[arg(long)]
        offline: String,
        /// 最大堆（MB），覆盖配置默认。
        #[arg(long)]
        max_memory: Option<u32>,
        /// 全屏启动。
        #[arg(long)]
        fullscreen: bool,
    },
    /// 搜索 Mod / 资源（Modrinth + CurseForge）。
    Search {
        /// 关键词。
        query: String,
        /// 目标加载器过滤。
        #[arg(long, value_enum)]
        loader: Option<LoaderArg>,
        /// 目标游戏版本过滤。
        #[arg(long)]
        game_version: Option<String>,
        /// 返回条数。
        #[arg(long, default_value_t = 10)]
        limit: u32,
    },
}

#[derive(Debug, Subcommand)]
enum VersionsAction {
    /// 列出远端可安装版本（版本清单）。
    List {
        /// 一并列出快照版。
        #[arg(long)]
        snapshots: bool,
        /// 最多列出条数。
        #[arg(long, default_value_t = 30)]
        limit: usize,
    },
    /// 列出本地已安装版本。
    Installed,
}

#[derive(Debug, Subcommand)]
enum AuthAction {
    /// 微软设备码登录。
    Login,
    /// 显示已登录账户与当前账户。
    Status,
}

/// 命令行加载器选项。安装仅支持 Fabric/Quilt；搜索支持全部。
#[derive(Debug, Clone, Copy, ValueEnum)]
enum LoaderArg {
    Fabric,
    Quilt,
    Forge,
    Neoforge,
}

impl LoaderArg {
    fn to_mod_loader(self) -> ModLoader {
        match self {
            LoaderArg::Fabric => ModLoader::Fabric,
            LoaderArg::Quilt => ModLoader::Quilt,
            LoaderArg::Forge => ModLoader::Forge,
            LoaderArg::Neoforge => ModLoader::NeoForge,
        }
    }

    /// 转成安装用的加载器选择；Forge/NeoForge 暂不支持从本命令安装。
    fn to_install_choice(self) -> Option<LoaderChoice> {
        match self {
            LoaderArg::Fabric => Some(LoaderChoice::Fabric),
            LoaderArg::Quilt => Some(LoaderChoice::Quilt),
            LoaderArg::Forge | LoaderArg::Neoforge => None,
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    init_tracing(cli.verbose);

    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("错误：{err}");
            let mut source = std::error::Error::source(&err);
            while let Some(cause) = source {
                eprintln!("  originated from: {cause}");
                source = cause.source();
            }
            ExitCode::FAILURE
        }
    }
}

/// 配置 tracing subscriber：默认按 verbose 选级别，可被 RUST_LOG 覆盖，日志写 stderr。
fn init_tracing(verbose: bool) {
    let default = if verbose {
        "aurora=debug,info"
    } else {
        "warn,aurora=info"
    };
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

async fn run(cli: Cli) -> aurora_core::Result<()> {
    let mut aurora = Aurora::load().await?;
    if let Some(game_dir) = &cli.game_dir {
        aurora.set_game_dir(game_dir.clone());
    }
    if let Some(client_id) = &cli.client_id {
        aurora.set_client_id(client_id.clone());
    }

    match cli.command {
        Command::Versions { action } => versions(&aurora, action).await,
        Command::Install {
            id,
            loader,
            loader_version,
        } => install(&aurora, &id, loader, loader_version.as_deref()).await,
        Command::Auth { action } => auth(&aurora, action).await,
        Command::Launch {
            version,
            offline,
            max_memory,
            fullscreen,
        } => launch(&aurora, &version, &offline, max_memory, fullscreen).await,
        Command::Search {
            query,
            loader,
            game_version,
            limit,
        } => search(&aurora, &query, loader, game_version.as_deref(), limit).await,
    }
}

async fn versions(aurora: &Aurora, action: VersionsAction) -> aurora_core::Result<()> {
    match action {
        VersionsAction::List { snapshots, limit } => {
            let manifest = aurora.list_manifest().await?;
            println!("最新正式版：{}", manifest.latest.release);
            println!("最新快照：{}", manifest.latest.snapshot);
            println!("{:-<52}", "");
            let mut shown = 0usize;
            for v in &manifest.versions {
                if !snapshots && v.release_type != "release" {
                    continue;
                }
                println!("{:<24} {:<10} {}", v.id, v.release_type, v.release_time);
                shown += 1;
                if shown >= limit {
                    break;
                }
            }
            println!("（共列出 {shown} 个版本）");
        }
        VersionsAction::Installed => {
            let scan = aurora.list_installed().await?;
            if scan.versions.is_empty() && scan.broken.is_empty() {
                println!("当前游戏目录未发现已安装版本：{}", aurora.game_dir().display());
                return Ok(());
            }
            for v in &scan.versions {
                let loaders = if v.loaders.is_empty() {
                    "原版".to_owned()
                } else {
                    v.loaders
                        .iter()
                        .map(|l| match &l.version {
                            Some(ver) => format!("{} {}", l.kind.as_str(), ver),
                            None => l.kind.as_str().to_owned(),
                        })
                        .collect::<Vec<_>>()
                        .join(" + ")
                };
                let kind = if v.is_release() { "release" } else { "非正式版" };
                println!("{:<28} [{kind}] {loaders}", v.id);
            }
            for b in &scan.broken {
                println!("[损坏] {} : {:?}", b.id, b.reason);
            }
        }
    }
    Ok(())
}

async fn install(
    aurora: &Aurora,
    id: &str,
    loader: Option<LoaderArg>,
    loader_version: Option<&str>,
) -> aurora_core::Result<()> {
    let choice = match loader {
        Some(arg) => match arg.to_install_choice() {
            Some(choice) => Some(choice),
            None => {
                eprintln!("暂不支持通过本命令安装 Forge/NeoForge，请选择 Fabric 或 Quilt");
                return Ok(());
            }
        },
        None => None,
    };

    let (sink, printer) = spawn_event_printer();
    let outcome = aurora.install(id, choice, loader_version, Some(&sink)).await;
    drop(sink);
    let _ = printer.await;
    let outcome = outcome?;

    println!("安装完成。");
    println!(
        "  原版 {}：库 {} / 资源 {} / natives {}",
        outcome.vanilla.id, outcome.vanilla.libraries, outcome.vanilla.assets, outcome.vanilla.natives
    );
    if let Some(loader) = outcome.loader {
        println!(
            "  加载器 {}：loader {}，新增库 {}",
            loader.id, loader.loader_version, loader.libraries
        );
    }
    Ok(())
}

async fn auth(aurora: &Aurora, action: AuthAction) -> aurora_core::Result<()> {
    match action {
        AuthAction::Login => auth_login(aurora).await,
        AuthAction::Status => auth_status(aurora),
    }
}

#[cfg(windows)]
async fn auth_login(aurora: &Aurora) -> aurora_core::Result<()> {
    let account = aurora
        .microsoft_login(|device| {
            println!("请在浏览器打开：{}", device.verification_uri);
            println!("并输入代码：{}", device.user_code);
            if !device.message.is_empty() {
                println!("{}", device.message);
            }
            println!("等待授权中……");
        })
        .await?;
    println!("登录成功：{} ({})", account.name, account.uuid);
    Ok(())
}

#[cfg(not(windows))]
async fn auth_login(_aurora: &Aurora) -> aurora_core::Result<()> {
    eprintln!("微软登录（凭据加密）仅支持 Windows。");
    Ok(())
}

#[cfg(windows)]
fn auth_status(aurora: &Aurora) -> aurora_core::Result<()> {
    let accounts = aurora.accounts()?;
    let current = aurora.current_account()?;
    if accounts.is_empty() {
        println!("尚无已登录账户。");
        return Ok(());
    }
    let current_uuid = current.as_ref().map(|c| c.uuid.as_str());
    for account in &accounts {
        let mark = if Some(account.uuid.as_str()) == current_uuid {
            "*"
        } else {
            " "
        };
        println!(
            "{mark} {:<18} {} 类型={:?}",
            account.name, account.uuid, account.account_type
        );
    }
    Ok(())
}

#[cfg(not(windows))]
fn auth_status(_aurora: &Aurora) -> aurora_core::Result<()> {
    eprintln!("账户存储（凭据加密）仅支持 Windows。");
    Ok(())
}

async fn launch(
    aurora: &Aurora,
    version: &str,
    offline: &str,
    max_memory: Option<u32>,
    fullscreen: bool,
) -> aurora_core::Result<()> {
    let options = LaunchOptions {
        max_memory_mb: max_memory,
        min_memory_mb: None,
        fullscreen,
        ..Default::default()
    };

    let (sink, printer) = spawn_event_printer();
    let (log_tx, mut log_rx) = mpsc::channel::<LogLine>(256);
    let log_printer = tokio::spawn(async move {
        while let Some(line) = log_rx.recv().await {
            match line.stream {
                LogStream::Stderr => eprintln!("{}", line.text),
                LogStream::Stdout => println!("{}", line.text),
            }
        }
    });

    let session = aurora
        .launch_offline(version, offline, &options, Some(log_tx), Some(&sink))
        .await;
    drop(sink);
    let _ = printer.await;
    let session = session?;

    println!("游戏已启动（pid {:?}），等待退出……", session.id());
    let report = session.wait().await?;
    let _ = log_printer.await;

    println!("游戏退出，退出码 {:?}", report.code);
    if detect_crash(&report) {
        println!("检测到崩溃，诊断如下：");
        let diagnoses = analyze(&report.recent_lines.join("\n"));
        if diagnoses.is_empty() {
            println!("  未匹配到已知崩溃规则，请查看上方日志。");
        }
        for d in diagnoses {
            println!("  - [{:?}] {}", d.category, d.summary);
            println!("    建议：{}", d.advice);
        }
    }
    Ok(())
}

async fn search(
    aurora: &Aurora,
    query: &str,
    loader: Option<LoaderArg>,
    game_version: Option<&str>,
    limit: u32,
) -> aurora_core::Result<()> {
    let mut search = SearchQuery::new(query).with_paging(limit, 0);
    if let Some(loader) = loader {
        search = search.with_loader(loader.to_mod_loader());
    }
    if let Some(game_version) = game_version {
        search = search.with_game_version(game_version);
    }

    let result = aurora.search(&search).await?;
    for err in &result.errors {
        eprintln!("[{}] 搜索失败：{}", err.platform.display_name(), err.error);
    }
    if result.hits.is_empty() {
        println!("未找到匹配结果。");
        return Ok(());
    }
    for hit in &result.hits {
        println!(
            "{} [{}] 下载 {}",
            hit.title,
            hit.platform.display_name(),
            hit.downloads
        );
        let desc = truncate(&hit.description, 78);
        if !desc.is_empty() {
            println!("    {desc}");
        }
    }
    Ok(())
}

/// 起一个后台任务把门面事件打印到控制台，返回 `(发送端, 打印任务句柄)`。
///
/// 调用方在操作结束后 `drop` 发送端并 `await` 句柄，确保事件全部落地后再打印最终结果。
fn spawn_event_printer() -> (EventSink, tokio::task::JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<CoreEvent>();
    let handle = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CoreEvent::Stage(message) => println!("[进度] {message}"),
                CoreEvent::Warning(message) => eprintln!("[告警] {message}"),
                CoreEvent::Download(progress) => {
                    eprintln!(
                        "[下载] {}/{} 文件，{} KiB，{} KiB/s",
                        progress.finished,
                        progress.total,
                        progress.bytes / 1024,
                        progress.speed / 1024
                    );
                }
            }
        }
    });
    (tx, handle)
}

/// 按字符（而非字节）截断，避免切断多字节字符；超出时追加省略号。
fn truncate(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_owned();
    }
    let mut out: String = trimmed.chars().take(max_chars).collect();
    out.push('…');
    out
}
