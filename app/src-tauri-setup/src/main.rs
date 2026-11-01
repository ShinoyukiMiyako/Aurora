// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("tauri.conf.json 没有配置窗口")?;
            // 配置里 create 为 false：窗口要等启动检查过了才建，这里直接建出来并显示
            tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
                .visible(true)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("安装引导程序运行失败");
}
