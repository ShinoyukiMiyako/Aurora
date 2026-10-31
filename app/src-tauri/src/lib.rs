//! Petalfall 的 Tauri 外壳。
//!
//! 本文件只做装配：日志、插件、managed state、主窗口兜底与命令注册。命令实现按领域分在
//! [`commands`] 下；各领域共用的设施——门面锁 [`facade`]、长任务登记与取消 [`tasks`]、
//! 事件转发 [`events`]、主窗口启动期处理 [`window`]——各自成模块。
//!
//! 新增命令时在 `generate_handler!` 里本领域的分块内追加，块之间以 `// -- 领域 --` 分隔；
//! 新增 managed state 同样写在 setup 里本领域的分块内。

mod commands;
mod events;
mod facade;
mod logging;
mod tasks;
mod textures;
mod window;

use aurora_core::Aurora;
use tauri::Manager;

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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 更改游戏目录、导入本地整合包要拿磁盘绝对路径，只能走系统对话框。
        .plugin(tauri_plugin_dialog::init())
        // 自更新装完后重启进程。
        .plugin(tauri_plugin_process::init())
        // -- art --
        .register_asynchronous_uri_scheme_protocol(textures::SCHEME, textures::handle)
        .setup(|app| {
            // Aurora::load() 是异步，而 setup 是同步闭包；用 Tauri 运行时 block_on 构造后放进 state。
            // 构造失败（配置损坏等）直接冒泡终止启动，避免带着半初始化的门面继续跑。
            let aurora = tauri::async_runtime::block_on(Aurora::load())?;
            app.manage(Facade::new(aurora));
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
            commands::instances::open_folder,
            // -- launch --
            commands::launch::launch_game,
            commands::launch::stop_game,
            commands::launch::play_stats,
            // -- diagnostics --
            commands::diagnostics::last_crash,
            commands::diagnostics::diagnose_crash,
            commands::diagnostics::last_launch_log,
            commands::diagnostics::log_diagnostic,
            // -- mods --
            commands::mods::list_mods,
            commands::mods::set_mod_enabled,
            // -- discover --
            commands::discover::search_resources,
            commands::discover::install_mod,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
}
