// Copyright (C) 2026 Shinoyuki_Miyako
// SPDX-License-Identifier: AGPL-3.0-only
// 本程序代码按 AGPL-3.0-only 授权，另附 AGPL 第 7 条的附加条款；两者见源代码根目录的 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。
// Licensed under AGPL-3.0-only with additional terms under section 7 of the AGPL; see LICENSE and LICENSE-ADDITIONAL-TERMS.md at the root of the source code.

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::error::Error;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Instant;

use petalfall_setup_lib::boot::{self, Claim, DesktopUser, Notice, Webview};
use petalfall_setup_lib::cli;
use petalfall_setup_lib::commands::{self, FallenBack, SetupContext};
use petalfall_setup_lib::extract::WEBVIEW_DATA_PREFIX;
use petalfall_setup_lib::log::{self, SetupLog};
use petalfall_setup_lib::overlay;
use petalfall_setup_lib::runner::Session;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};
use tempfile::TempDir;

struct Interface {
    app: App,
    window: WebviewWindow,
    webview_data: TempDir,
}

impl Interface {
    fn start(context: &Arc<SetupContext>) -> Result<Self, Box<dyn Error>> {
        let webview_data = tempfile::Builder::new()
            .prefix(WEBVIEW_DATA_PREFIX)
            .tempdir()?;
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_opener::init())
            .manage(Arc::clone(context))
            .invoke_handler(tauri::generate_handler![
                commands::probe,
                commands::check_dir,
                commands::launcher_running,
                commands::install,
                commands::open_launcher,
                commands::open_log,
                commands::run_standard_installer,
                commands::window_ready,
            ])
            .build(tauri::generate_context!())?;
        let config = app
            .config()
            .app
            .windows
            .first()
            .ok_or("tauri.conf.json 没有配置窗口")?
            .clone();
        let page = Arc::clone(context);
        // 必须在事件循环开始前经 &App 建窗：这条路把建窗错误作为 Err 返回。经 AppHandle 建窗时错误只进日志，
        // 进程会留在后台，一个窗口也没有。
        let window = WebviewWindowBuilder::from_config(&app, &config)?
            .data_directory(webview_data.path().to_path_buf())
            .on_navigation(move |_| page.allows_navigation())
            .build()?;
        Ok(Self {
            app,
            window,
            webview_data,
        })
    }

    fn run(
        self,
        context: &SetupContext,
        instance: Arc<boot::Instance>,
        log: &Arc<SetupLog>,
    ) -> Result<ExitCode, Box<dyn Error>> {
        boot::disable_browser_accelerator_keys(&self.window, Arc::clone(log))?;
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
        // 用户改走原生向导时窗口已经关了，这里陪它到退出：句柄还钉着载荷，退出后才清得掉临时目录
        if let Err(err) = context.wait_for_wizard() {
            log.warn(format_args!("等原生向导退出失败：{err}"));
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
    // 赶在互斥那关之前记下：被转发掉的那个进程带的是什么参数，日志里也要查得到
    let parsed = cli::parse(std::env::args_os().skip(1));
    log.info(format_args!(
        "启动方式：{:?}，换通道开关：{}",
        parsed.launch, parsed.channel_switch
    ));
    if !parsed.ignored.is_empty() {
        log.warn(format_args!(
            "这些参数不起作用，已忽略：{:?}",
            parsed.ignored
        ));
    }
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

    // 开窗前就要知道载荷在、长度够：放到窗口里才报的话，用户只能看到一段错误原文
    let source = match overlay::load() {
        Ok(source) => source,
        Err(err) => {
            log.error(format_args!("安装包不完整：{err}"));
            boot::alert(&Notice::IncompletePackage);
            return Ok(ExitCode::FAILURE);
        }
    };
    let session = Session::open(source)?;
    let context = Arc::new(SetupContext::new(
        session,
        Arc::clone(&instance),
        Arc::clone(log),
        parsed.launch,
        parsed.channel_switch,
        log::local_app_data()?,
    ));

    if let Webview::Unavailable { reason } = &webview {
        log.warn(format_args!("WebView2 不可用，改走原生向导：{reason}"));
        return fall_back(&context);
    }
    match Interface::start(&context) {
        Ok(interface) => interface.run(&context, instance, log),
        Err(err) => {
            log.error(format_args!("建窗失败，改走原生向导：{err}"));
            fall_back(&context)
        }
    }
}

fn fall_back(context: &SetupContext) -> Result<ExitCode, Box<dyn Error>> {
    match context.fall_back(boot::alert)? {
        FallenBack::Ran(code) => Ok(exit_code(code)),
        // 判定不能装，什么都没装
        FallenBack::Refused => Ok(ExitCode::FAILURE),
    }
}

fn exit_code(code: i32) -> ExitCode {
    u8::try_from(code).map_or(ExitCode::FAILURE, ExitCode::from)
}
