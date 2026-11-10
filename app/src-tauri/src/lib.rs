// Copyright (C) 2026 Shinoyuki_Miyako
// SPDX-License-Identifier: AGPL-3.0-only
// 本程序代码按 AGPL-3.0-only 授权，另附 AGPL 第 7 条的附加条款；两者见源代码根目录的 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。
// Licensed under AGPL-3.0-only with additional terms under section 7 of the AGPL; see LICENSE and LICENSE-ADDITIONAL-TERMS.md at the root of the source code.

//! Petalfall 的 Tauri 外壳。
//!
//! 本文件只做装配：日志、插件、managed state、主窗口兜底、命令注册与退出收尾（[`exit`]）。命令实现按领域分在
//! [`commands`] 下；各领域共用的设施——门面锁 [`facade`]、长任务登记与取消 [`tasks`]、
//! 事件转发 [`events`]、主窗口启动期处理 [`window`]、主窗口记住大小与位置 [`window_state`]、主窗口原生拖放 [`drop`]、渲染进程故障后的
//! 自动重载 [`renderer`]、最小化时的页面可见性 [`page_visibility`]、同一数据目录只跑一个启动器
//! [`single_instance`]、更新插件留下的安装包目录的清扫 [`update_leftovers`]——各自成模块。
//!
//! 新增命令时在 `generate_handler!` 里本领域的分块内追加，块之间以 `// -- 领域 --` 分隔；
//! 新增 managed state 同样写在 setup 里本领域的分块内。

mod channel_handoff;
mod commands;
mod data_gate;
mod drop;
mod events;
mod exit;
mod facade;
mod gpu;
mod logging;
#[cfg(windows)]
mod page_visibility;
mod renderer;
#[cfg(windows)]
mod single_instance;
mod tasks;
mod textures;
#[cfg(windows)]
mod update_leftovers;
mod window;
mod window_state;

use petalfall_core::{Petalfall, ServerMonitor};
use tauri::Manager;

use crate::commands::updater::{UpdaterState, UpdaterSupport};
use crate::facade::Facade;
use crate::tasks::{TaskJournal, TaskRegistry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 排在日志之前：每次启动都开一份新日志、清掉最旧的，连点几下图标就把正在用的那份挤掉了。
    #[cfg(windows)]
    let claimed = match single_instance::claim() {
        // 叫不到窗口又迟迟不退出的那个进程多半卡住了，这里也退出：不和它同时用一份数据。此时还没有日志，
        // 每次启动开一份新日志，为这次什么都没做的启动开一份会挤掉一份有用的。
        Ok(single_instance::Claim::Forwarded | single_instance::Claim::Unanswered) => return,
        Ok(single_instance::Claim::First(instance)) => Ok(instance),
        Err(err) => Err(err),
    };

    // 先装 subscriber 再做任何事：配置载入、数据目录探测这些最容易出问题的动作都在下面，
    // 晚一步初始化，恰恰是最想看的那几行日志就丢了。
    let log_path = logging::init();
    log_panics();
    // 版本号以 tauri.conf.json 为准：dev 包只改它，Cargo.toml 里的版本和实际发出去的包对不上。
    let context = tauri::generate_context!();
    tracing::info!(
        version = %context.package_info().version,
        log = ?log_path,
        "{} 启动",
        petalfall_base::brand::APP_NAME_EN
    );
    log_data_dir();

    // 占位失败不拦启动：拦下来就是双击后什么都没有，而这只是少了一层防重复打开，错误记进日志。
    #[cfg(windows)]
    let instance = claimed
        .inspect_err(|err| {
            tracing::error!(error = %err, "同一数据目录的占位失败，这次启动不防重复打开");
        })
        .ok();
    #[cfg(windows)]
    if let Some(waited) = instance
        .as_ref()
        .and_then(single_instance::Instance::waited_for_exit)
    {
        tracing::info!(
            waited_ms = waited.as_millis() as u64,
            "同一数据目录上的上一个落樱正在退出，等它退出后才接手"
        );
    }

    let updater_support = commands::updater::detect_support(
        context.config().plugins.0.get("updater"),
        cfg!(debug_assertions),
        context.package_info().version.pre.as_str(),
    );
    tracing::info!(?updater_support, "自更新");

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 更改游戏目录、导入本地整合包、选导出存档的位置要拿磁盘绝对路径，只能走系统对话框。
        .plugin(tauri_plugin_dialog::init())
        // -- art --
        .register_asynchronous_uri_scheme_protocol(textures::SCHEME, textures::handle);
    // 插件配置里 pubkey 是必填项，缺了插件初始化就失败、整个应用起不来，所以只在支持时注册。
    // 支持还要求打开 requireSignedVersion、不打开 allowDowngrades，否则防不住伪造清单诱导降级；
    // 版本号认不出通道时不知道去哪取清单，同样不注册。见 detect_support。
    if updater_support == UpdaterSupport::Supported {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .setup(move |app| {
            // 载入是异步的，而 setup 是同步闭包；用 Tauri 运行时 block_on 构造后放进 state。
            // config.json 读不出来时不终止：此刻还没有窗口，终止就是双击后什么都看不到，而且以后每次都这样。
            // 坏文件改名留存、按默认配置启动，经过记成启动提示，由前端查询后告诉用户。数据目录定位不到、
            // 坏文件改不了名这类错误仍然冒泡终止，避免带着半初始化的门面继续跑。
            let (petalfall, recovery) =
                tauri::async_runtime::block_on(Petalfall::load_recovering())?;
            let petalfall = petalfall.with_app_version(&app.package_info().version.to_string())?;
            let server_monitor = ServerMonitor::new(petalfall.data_dir());
            let data_dir = petalfall.data_dir().to_path_buf();
            app.manage(Facade::new(petalfall));
            app.manage(
                commands::system::StartupNotices::from_recovery(recovery)
                    .with_data_dir(&petalfall_base::fs::resolve_data_dir()?),
            );
            // -- tasks --
            app.manage(TaskRegistry::default());
            app.manage(TaskJournal::default());
            // -- instances --
            app.manage(commands::instances::InstanceLocks::default());
            app.manage(commands::art::ArtDownloadSlot::default());
            app.manage(commands::instances::ExportedFiles::default());
            // 上次在提交前后被打断的移动：回滚或补完，配置里的引用跟着改。
            commands::instances::recover_moves_in_background(app.handle());
            // -- launch --
            app.manage(commands::launch::RunningGame::default());
            // 门面与实例占用表都已就位；前端加载要几百毫秒，接回赶在它之前占住占用槽。
            commands::launch::reattach_in_background(app.handle());
            // -- accounts --
            app.manage(commands::accounts::MicrosoftLoginSlot::default());
            app.manage(commands::accounts::AuthlibPendingSlot::default());
            commands::accounts::renew_ahead_in_background(app.handle());
            // -- art --
            textures::setup(app);
            // -- system --
            app.manage(commands::system::FirstRunBaselineSlot::default());
            app.manage(server_monitor);
            app.manage(UpdaterState::new(updater_support));
            // 只有装了插件的构建才会留下这些目录；开发构建不碰，本机正式安装的更新包轮不到它来删
            #[cfg(windows)]
            if updater_support == UpdaterSupport::Supported {
                update_leftovers::sweep_in_background(app.package_info().name.clone());
            }
            // -- window --
            // 排在兜底显示之前：显示时要按这里记下的状态决定是否最大化
            app.manage(window_state::install(app, &data_dir)?);
            window::setup_main_window(app)?;
            #[cfg(windows)]
            if let Some(instance) = instance {
                // 退出时要拉起安装程序的，先用它打发走在等的后来者（见 `install_on_exit`）。
                app.manage(instance.answer());
                window::front_on_second_launch(app, instance)?;
            }
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
            commands::tasks::discard_export_leftovers,
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
            commands::java::add_java_path,
            commands::java::remove_java_path,
            commands::java::gpu_adapters,
            commands::java::switch_to_dedicated_gpu,
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
            commands::art::art_blocks,
            commands::art::art_download,
            commands::art::skin_info,
            commands::art::thumb_register,
            // -- instances --
            commands::instances::list_instances,
            commands::instances::get_instance_settings,
            commands::instances::set_instance_settings,
            commands::instances::import_cover_image,
            commands::instances::list_instance_content,
            commands::instances::get_sidebar_pins,
            commands::instances::set_sidebar_pins,
            commands::instances::install_version,
            commands::instances::repair_instance,
            commands::instances::preview_instance_deletion,
            commands::instances::delete_instance,
            commands::instances::rename_instance,
            commands::instances::preview_instance_move,
            commands::instances::move_instance,
            commands::instances::list_manifest,
            commands::instances::list_loader_versions,
            commands::instances::required_java,
            commands::instances::version_requirements,
            commands::instances::open_folder,
            commands::instances::reveal_in_folder,
            commands::instances::template_info,
            commands::instances::save_instance_as_template,
            commands::instances::clear_template,
            commands::instances::backup_world,
            commands::instances::list_world_backups,
            commands::instances::restore_world_backup,
            commands::instances::delete_world_backup,
            commands::instances::export_world,
            // -- launch --
            commands::launch::launch_game,
            commands::launch::stop_game,
            commands::launch::running_game,
            commands::launch::play_stats,
            // -- diagnostics --
            commands::diagnostics::last_crash,
            commands::diagnostics::last_launch_log,
            commands::diagnostics::log_diagnostic,
            // -- mods --
            commands::mods::list_mods,
            commands::mods::set_mod_enabled,
            commands::mods::set_mods_enabled,
            commands::mods::add_local_mods,
            commands::mods::remove_mod,
            commands::mods::set_mod_update_hold,
            commands::mods::check_updates,
            commands::mods::update_mod,
            commands::mods::mod_update_changelog,
            commands::mods::list_mod_versions,
            commands::mods::match_instances,
            commands::mods::installed_sources,
            commands::mods::plan_install,
            commands::mods::starter_mods,
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
            commands::modpack::claim_blocked_files,
            commands::modpack::downloads_folder,
            commands::modpack::preview_modpack_export,
            commands::modpack::export_modpack,
            // -- system --
            commands::system::memory_advice,
            commands::system::is_first_run,
            commands::system::complete_first_run,
            commands::system::startup_notices,
            commands::system::probe_network,
            commands::servers::list_pinned_servers,
            commands::servers::set_pinned_servers,
            commands::servers::set_pinned_server_instance,
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
            commands::window::reveal_main_window,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                exit::on_exit(app);
            }
        });
}

/// 把 panic 的现场写进会话日志，再交给原来的钩子。
///
/// GUI 子系统没有控制台，默认钩子写的 stderr 谁也看不见。Tauri 把 setup 返回的错误（配置读不了、数据目录
/// 定位不到）转成 panic，那时窗口还没出来，双击之后什么都没有，日志里也没有一行原因；命令里的 panic 让那次
/// 调用永远等不到返回，同样无迹可查。
fn log_panics() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|at| format!("{}:{}:{}", at.file(), at.line(), at.column()));
        // panic_any 抛出的非字符串负载读不出内容，如实写明是哪种情况。
        let payload = info.payload_as_str().unwrap_or("panic 负载不是字符串");
        tracing::error!(
            payload = %payload,
            location,
            thread = std::thread::current().name(),
            backtrace = %std::backtrace::Backtrace::force_capture(),
            "进程 panic"
        );
        previous(info);
    }));
}

/// 数据目录在日志装好之前就定位了（日志文件就落在里面），走了哪条路、为什么、花了多久在这里补记。
fn log_data_dir() {
    match petalfall_base::fs::resolve_data_dir() {
        Ok(resolved) => tracing::info!(
            path = ?resolved.path,
            portable = resolved.portable,
            fallback_reason = ?resolved.fallback_reason,
            write_failure = ?resolved.write_failure,
            elapsed_ms = resolved.elapsed.as_millis() as u64,
            "数据目录"
        ),
        // 这里只记录；随后的 Petalfall::load 会以同一个错误终止启动。
        Err(err) => tracing::error!(error = %err, "定位数据目录失败"),
    }
}

#[cfg(test)]
mod tests {
    use petalfall_base::brand::{APP_NAME, APP_NAME_EN, APP_SLUG};

    pub(crate) use log_capture::Captured;

    // 单独一个模块：字段只在这里可见，tests 里别的测试（包括本文件的）也只能经 new 构造，绕不过闸门。
    mod log_capture {
        use std::sync::{Arc, Mutex, OnceLock};

        /// 收集日志输出的写入端。字段私有，构造只有 [`Captured::new`] 一条路，好让每个收日志的测试都先过闸门；
        /// 收到的内容经 [`Captured::text`] 读、经 [`Captured::clear`] 清。
        #[derive(Clone)]
        pub(crate) struct Captured(Arc<Mutex<Vec<u8>>>);

        impl Captured {
            /// tracing-core 0.1.36 只登记了一个调度器时，别的线程头一次走到某个日志点，按它自己线程上的默认调度器
            /// （什么都不收）算兴趣，再全局缓存成「不启用」，测试装的订阅者就收不到那条日志。并行的测试里别人先走到
            /// 同一个日志点，断言就时挂时不挂；只跑一个模块时更容易撞上。所以先常驻登记一个级别上限为 OFF 的调度器：
            /// 它和测试的订阅者之间全局级别一直是 OFF，别的线程走不到登记日志点；订阅者登记时调度器已有两个，
            /// 「只有一个」的标志先关掉、再抬级别，之后谁头一次走到日志点，都按所有存活的调度器算兴趣。
            /// 上限不能用 NoSubscriber：它不报上限，按 TRACE 算，登记那一刻起别的线程就能按自己线程的默认调度器登记日志点。
            pub(crate) fn new() -> Self {
                use tracing_subscriber::layer::SubscriberExt as _;
                static GATE: OnceLock<tracing::Dispatch> = OnceLock::new();
                GATE.get_or_init(|| {
                    tracing::Dispatch::new(
                        tracing_subscriber::registry()
                            .with(tracing_subscriber::filter::LevelFilter::OFF),
                    )
                });
                Self(Arc::default())
            }

            pub(crate) fn text(&self) -> String {
                String::from_utf8(self.0.lock().expect("收日志的锁已中毒").clone())
                    .expect("fmt 层写进来的是格式化好的整段文本，应是 UTF-8")
            }

            pub(crate) fn clear(&self) {
                self.0.lock().expect("收日志的锁已中毒").clear();
            }
        }

        impl std::io::Write for Captured {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
    }

    /// panic 的负载与位置进了日志，之后照常交给原来的钩子、照常展开。setup 失败就是这样一个 panic：
    /// 没有这一条，日志停在「数据目录」那行，看不出启动为什么失败。
    #[test]
    fn panics_are_written_to_the_session_log() {
        super::log_panics();
        let captured = Captured::new();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let line = line!() + 3;
        let unwound = tracing::subscriber::with_default(subscriber, || {
            std::panic::catch_unwind(|| {
                panic!("Failed to setup app: 读取配置文件 C:\\Data\\config.json 失败")
            })
        });
        assert!(unwound.is_err(), "钩子不该吞掉 panic");
        let log = captured.text();
        assert!(log.contains("ERROR"), "{log}");
        assert!(log.contains("进程 panic"), "{log}");
        assert!(
            log.contains("Failed to setup app: 读取配置文件 C:\\Data\\config.json 失败"),
            "{log}"
        );
        assert!(log.contains(&format!("lib.rs:{line}:")), "{log}");
    }

    // tauri.conf.json、index.html 与前端 TS 无法引用 Rust 常量，产品名只能各写一份，
    // 由这条测试钉住它们与 petalfall-base 的 brand 模块一致。identifier 和 publisher 发布后即成兼容契约，
    // 单独写死：publisher 还决定 NSIS 记安装目录的注册表键，引导程序按它去读。
    #[test]
    fn product_name_is_consistent_across_config_html_and_frontend() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json 应是合法 JSON");
        assert_eq!(conf["productName"], APP_NAME_EN);
        assert_eq!(conf["mainBinaryName"], APP_NAME_EN);
        assert_eq!(conf["app"]["windows"][0]["title"], APP_NAME_EN);
        assert_eq!(conf["identifier"], "org.petalfall.launcher");
        assert_eq!(conf["bundle"]["publisher"], "Shinoyuki_Miyako");

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
