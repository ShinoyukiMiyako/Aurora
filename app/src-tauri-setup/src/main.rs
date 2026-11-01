// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::error::Error;
use std::fs::File;
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Instant;

use aurora_setup_lib::boot::{self, Claim, DesktopUser, Instance, Notice, Webview, WizardError};
use aurora_setup_lib::log::{self, SetupLog};
use tauri::{App, WebviewWindow, WebviewWindowBuilder};
use tempfile::TempDir;

/// 默认的 WebView2 数据目录会永远留在 `%LOCALAPPDATA%`：引导程序没有卸载流程。
const WEBVIEW_DATA_PREFIX: &str = "petalfall-setup-webview-";

struct Interface {
    app: App,
    window: WebviewWindow,
    webview_data: TempDir,
}

impl Interface {
    fn start(instance: &Arc<Instance>, log: &Arc<SetupLog>) -> Result<Self, Box<dyn Error>> {
        let webview_data = tempfile::Builder::new()
            .prefix(WEBVIEW_DATA_PREFIX)
            .tempdir()?;
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init())
            .manage(Arc::clone(instance))
            .manage(Arc::clone(log))
            .invoke_handler(tauri::generate_handler![])
            .build(tauri::generate_context!())?;
        let config = app
            .config()
            .app
            .windows
            .first()
            .ok_or("tauri.conf.json 没有配置窗口")?
            .clone();
        // 必须在事件循环开始前经 &App 建窗：这条路把建窗错误作为 Err 返回。经 AppHandle 建窗时错误只进日志，
        // 进程会留在后台，一个窗口也没有。
        let window = WebviewWindowBuilder::from_config(&app, &config)?
            .data_directory(webview_data.path().to_path_buf())
            .build()?;
        Ok(Self {
            app,
            window,
            webview_data,
        })
    }

    fn run(self, instance: Arc<Instance>, log: &Arc<SetupLog>) -> Result<ExitCode, Box<dyn Error>> {
        boot::focus_on_request(instance, self.window.clone(), Arc::clone(log))?;
        boot::guard_visibility(self.window, Arc::clone(log))?;
        let code = self.app.run_return(|_, _| {});
        let started = Instant::now();
        match boot::remove_webview_data(&self.webview_data.keep()) {
            Ok(()) => log.info(format_args!(
                "WebView2 数据目录已清理，用了 {} 毫秒",
                started.elapsed().as_millis()
            )),
            Err(err) => log.warn(format_args!("清理 WebView2 数据目录失败：{err}")),
        }
        Ok(exit_code(code))
    }
}

fn main() -> ExitCode {
    // 排在一切之前：探测只读，不写盘，也不创建用户数据目录。结果要等过了互斥和账户两关才动用，
    // 否则双击两下会开出两个向导，别的账户提权时向导会装到那个账户下。
    let webview = Webview::judge(tauri::webview_version());
    let log = match log::default_root().and_then(|root| SetupLog::open(&root)) {
        Ok(log) => Arc::new(log),
        Err(err) => {
            boot::alert(&Notice::StartFailed(format!("打不开日志：{err}")));
            return ExitCode::FAILURE;
        }
    };
    run(webview, &log).unwrap_or_else(|err| {
        log.error(&err);
        boot::alert(&Notice::StartFailed(err.to_string()));
        ExitCode::FAILURE
    })
}

fn run(webview: Webview, log: &Arc<SetupLog>) -> Result<ExitCode, Box<dyn Error>> {
    log.info(format_args!("启动，WebView2：{webview:?}"));
    let instance = match boot::claim()? {
        Claim::First(instance) => Arc::new(instance),
        Claim::Forwarded => {
            log.info("已有实例在运行，这个进程退出");
            return Ok(ExitCode::SUCCESS);
        }
    };
    match boot::desktop_user()? {
        DesktopUser::Same => {}
        DesktopUser::Other => {
            log.warn("令牌用户和桌面用户不同，拒绝继续");
            boot::alert(&Notice::ForeignUser);
            return Ok(ExitCode::FAILURE);
        }
        DesktopUser::Unknown(reason) => log.warn(format_args!("比不出桌面用户：{reason}")),
    }

    let exe = std::env::current_exe()?;
    if let Err(err) = boot::check_package(&mut File::open(&exe)?, cfg!(debug_assertions)) {
        log.error(format_args!("安装包不完整：{err}"));
        boot::alert(&Notice::IncompletePackage);
        return Ok(ExitCode::FAILURE);
    }

    if let Webview::Unavailable { reason } = &webview {
        log.warn(format_args!("WebView2 不可用，改走原生向导：{reason}"));
        return fall_back(&exe, log);
    }
    match Interface::start(&instance, log) {
        Ok(interface) => interface.run(instance, log),
        Err(err) => {
            log.error(format_args!("建窗失败，改走原生向导：{err}"));
            fall_back(&exe, log)
        }
    }
}

fn fall_back(exe: &Path, log: &SetupLog) -> Result<ExitCode, Box<dyn Error>> {
    match boot::run_wizard(exe, log) {
        Ok(status) => {
            log.info(format_args!("原生向导已退出：{status}"));
            Ok(status.code().map_or(ExitCode::FAILURE, exit_code))
        }
        Err(WizardError::Package(detail)) => {
            log.error(format_args!("安装包损坏：{detail}"));
            boot::alert(&Notice::IncompletePackage);
            Ok(ExitCode::FAILURE)
        }
        Err(err @ WizardError::Io(_)) => Err(err.into()),
    }
}

fn exit_code(code: i32) -> ExitCode {
    u8::try_from(code).map_or(ExitCode::FAILURE, ExitCode::from)
}
