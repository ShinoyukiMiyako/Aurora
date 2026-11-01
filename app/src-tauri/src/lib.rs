//! Petalfall 的 Tauri 外壳。
//!
//! 本文件只做装配：日志、插件、managed state、主窗口兜底、命令注册与退出收尾（[`exit`]）。命令实现按领域分在
//! [`commands`] 下；各领域共用的设施——门面锁 [`facade`]、长任务登记与取消 [`tasks`]、
//! 事件转发 [`events`]、主窗口启动期处理 [`window`]、主窗口原生拖放 [`drop`]、渲染进程故障后的
//! 自动重载 [`renderer`]——各自成模块。
//!
//! 新增命令时在 `generate_handler!` 里本领域的分块内追加，块之间以 `// -- 领域 --` 分隔；
//! 新增 managed state 同样写在 setup 里本领域的分块内。

mod commands;
mod drop;
mod events;
mod exit;
mod facade;
mod logging;
mod renderer;
mod tasks;
mod textures;
mod window;

use aurora_core::{Aurora, ServerMonitor};
use tauri::Manager;

use crate::commands::updater::{UpdaterState, UpdaterSupport};
use crate::facade::Facade;
use crate::tasks::{TaskJournal, TaskRegistry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 先装 subscriber 再做任何事：配置载入、数据目录探测这些最容易出问题的动作都在下面，
    // 晚一步初始化，恰恰是最想看的那几行日志就丢了。
    let log_path = logging::init();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        log = ?log_path,
        "{} 启动",
        aurora_base::brand::APP_NAME_EN
    );
    log_data_dir();

    let context = tauri::generate_context!();
    let updater_support = commands::updater::detect_support(
        context.config().plugins.0.get("updater"),
        cfg!(debug_assertions),
    );
    tracing::info!(?updater_support, "自更新");

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 更改游戏目录、导入本地整合包要拿磁盘绝对路径，只能走系统对话框。
        .plugin(tauri_plugin_dialog::init())
        // -- art --
        .register_asynchronous_uri_scheme_protocol(textures::SCHEME, textures::handle);
    // 插件配置里 pubkey 是必填项，缺了插件初始化就失败、整个应用起不来，所以只在支持时注册。
    if updater_support == UpdaterSupport::Supported {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .setup(move |app| {
            // 载入是异步的，而 setup 是同步闭包；用 Tauri 运行时 block_on 构造后放进 state。
            // config.json 读不出来时不终止：此刻还没有窗口，终止就是双击后什么都看不到，而且以后每次都这样。
            // 坏文件改名留存、按默认配置启动，经过记成启动提示，由前端查询后告诉用户。数据目录定位不到、
            // 坏文件改不了名这类错误仍然冒泡终止，避免带着半初始化的门面继续跑。
            let (aurora, recovery) = tauri::async_runtime::block_on(Aurora::load_recovering())?;
            let server_monitor = ServerMonitor::new(aurora.data_dir());
            app.manage(Facade::new(aurora));
            app.manage(commands::system::StartupNotices::from_recovery(recovery));
            // -- tasks --
            app.manage(TaskRegistry::default());
            app.manage(TaskJournal::default());
            // -- instances --
            app.manage(commands::instances::InstanceLocks::default());
            // -- launch --
            app.manage(commands::launch::RunningGame::default());
            // -- accounts --
            app.manage(commands::accounts::MicrosoftLoginSlot::default());
            app.manage(commands::accounts::AuthlibPendingSlot::default());
            // -- art --
            textures::setup(app);
            // -- system --
            app.manage(commands::system::FirstRunBaselineSlot::default());
            app.manage(server_monitor);
            app.manage(UpdaterState::new(updater_support));
            window::setup_main_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // -- appearance --
            commands::appearance::get_appearance,
            commands::appearance::set_appearance,
            // -- tasks --
            commands::tasks::cancel_task,
            commands::tasks::save_task_journal,
            commands::tasks::load_task_journal,
            // -- config --
            commands::config::get_config,
            commands::config::update_config,
            commands::config::set_game_directory,
            commands::config::list_game_directories,
            commands::config::discover_game_directories,
            commands::config::add_game_directory,
            commands::config::remove_game_directory,
            commands::config::inspect_game_directory,
            // -- java --
            commands::java::detect_java,
            commands::java::install_java,
            // -- accounts --
            commands::accounts::current_account,
            commands::accounts::create_offline_account,
            commands::accounts::microsoft_login,
            commands::accounts::authlib_login,
            commands::accounts::list_accounts,
            commands::accounts::set_current_account,
            commands::accounts::remove_account,
            commands::accounts::cancel_microsoft_login,
            commands::accounts::probe_auth_server,
            commands::accounts::select_authlib_profile,
            commands::accounts::refresh_account,
            // -- art --
            commands::art::art_status,
            commands::art::skin_info,
            commands::art::thumb_register,
            // -- instances --
            commands::instances::list_instances,
            commands::instances::get_instance_settings,
            commands::instances::set_instance_settings,
            commands::instances::list_instance_content,
            commands::instances::get_sidebar_pins,
            commands::instances::set_sidebar_pins,
            commands::instances::install_version,
            commands::instances::repair_instance,
            commands::instances::preview_instance_deletion,
            commands::instances::delete_instance,
            commands::instances::rename_instance,
            commands::instances::list_manifest,
            commands::instances::list_loader_versions,
            commands::instances::required_java,
            commands::instances::version_requirements,
            commands::instances::open_folder,
            // -- launch --
            commands::launch::launch_game,
            commands::launch::stop_game,
            commands::launch::play_stats,
            // -- diagnostics --
            commands::diagnostics::last_crash,
            commands::diagnostics::last_launch_log,
            commands::diagnostics::log_diagnostic,
            // -- mods --
            commands::mods::list_mods,
            commands::mods::set_mod_enabled,
            commands::mods::set_mods_enabled,
            commands::mods::remove_mod,
            commands::mods::set_mod_update_hold,
            commands::mods::check_updates,
            commands::mods::update_mod,
            commands::mods::mod_update_changelog,
            commands::mods::list_mod_versions,
            commands::mods::match_instances,
            commands::mods::installed_sources,
            commands::mods::plan_install,
            // -- history --
            commands::history::list_history,
            commands::history::rollback_checks,
            commands::history::rollback,
            // -- discover --
            commands::discover::search_resources,
            commands::discover::project_detail,
            commands::discover::install_mod,
            commands::discover::install_resource,
            // -- modpack --
            commands::modpack::preview_modpack,
            commands::modpack::summarize_platform_modpack,
            commands::modpack::install_modpack,
            // -- system --
            commands::system::memory_advice,
            commands::system::is_first_run,
            commands::system::complete_first_run,
            commands::system::startup_notices,
            commands::system::probe_network,
            commands::servers::list_pinned_servers,
            commands::servers::set_pinned_servers,
            commands::servers::list_known_servers,
            commands::servers::ping_servers,
            commands::news::list_news,
            commands::updater::updater_info,
            commands::updater::check_update,
            commands::updater::download_update,
            commands::updater::install_update,
            commands::updater::set_install_on_exit,
            // -- window --
            commands::window::restore_window_without_focus,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                exit::on_exit(app);
            }
        });
}

/// 数据目录在日志装好之前就定位了（日志文件就落在里面），走了哪条路、为什么、花了多久在这里补记。
fn log_data_dir() {
    match aurora_base::fs::resolve_data_dir() {
        Ok(resolved) => tracing::info!(
            path = ?resolved.path,
            portable = resolved.portable,
            fallback_reason = ?resolved.fallback_reason,
            elapsed_ms = resolved.elapsed.as_millis() as u64,
            "数据目录"
        ),
        // 这里只记录；随后的 Aurora::load 会以同一个错误终止启动。
        Err(err) => tracing::error!(error = %err, "定位数据目录失败"),
    }
}

#[cfg(test)]
mod tests {
    use aurora_base::brand::{APP_NAME, APP_NAME_EN, APP_SLUG};

    // tauri.conf.json、index.html 与前端 TS 无法引用 Rust 常量，产品名只能各写一份，
    // 由这条测试钉住它们与 aurora-base 的 brand 模块一致。identifier 发布后即成兼容契约，单独写死。
    #[test]
    fn product_name_is_consistent_across_config_html_and_frontend() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json 应是合法 JSON");
        assert_eq!(conf["productName"], APP_NAME_EN);
        assert_eq!(conf["mainBinaryName"], APP_NAME_EN);
        assert_eq!(conf["app"]["windows"][0]["title"], APP_NAME_EN);
        assert_eq!(conf["identifier"], "org.petalfall.launcher");

        let title = format!("<title>{APP_NAME_EN}</title>");
        assert!(
            include_str!("../../index.html").contains(&title),
            "index.html 缺少 {title}"
        );

        let app_info = include_str!("../../src/lib/app-info.ts");
        for (name, value) in [
            ("APP_NAME", APP_NAME),
            ("APP_NAME_EN", APP_NAME_EN),
            ("APP_SLUG", APP_SLUG),
        ] {
            let decl = format!("export const {name} = \"{value}\";");
            assert!(app_info.contains(&decl), "app-info.ts 缺少 {decl}");
        }
    }

    // 许可证只在根 Cargo.toml 的 [workspace.package] 写一次；关于页显示的 APP_LICENSE 引用不到
    // Cargo 元数据，由这条测试钉住两边相同，也拦住新加的 crate 忘了继承、各写各的。
    #[test]
    fn license_is_declared_once_for_the_workspace_and_matches_frontend() {
        let license = env!("CARGO_PKG_LICENSE");
        assert_eq!(license, "AGPL-3.0-only");
        let decl = format!("export const APP_LICENSE = \"{license}\";");
        assert!(
            include_str!("../../src/lib/app-info.ts").contains(&decl),
            "app-info.ts 缺少 {decl}"
        );

        let shell_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let crates_dir = shell_dir.join("../../crates");
        let mut manifests = vec![shell_dir.join("Cargo.toml")];
        for entry in std::fs::read_dir(&crates_dir).expect("读 crates 目录") {
            let manifest = entry.expect("读 crates 目录项").path().join("Cargo.toml");
            if manifest.is_file() {
                manifests.push(manifest);
            }
        }
        assert!(
            manifests.len() > 1,
            "{} 下没找到 crate",
            crates_dir.display()
        );
        for manifest in manifests {
            let text = std::fs::read_to_string(&manifest).expect("读 Cargo.toml");
            assert!(
                text.lines()
                    .any(|line| line.trim() == "license.workspace = true"),
                "{} 没有继承 workspace 的 license",
                manifest.display()
            );
        }
    }
}
