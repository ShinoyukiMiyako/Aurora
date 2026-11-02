//! 落樱的安装引导程序：把尾部附加的 NSIS 包解到临时目录、静默安装、事后核验，界面走 WebView2。
//!
//! 模块按职责分文件，这里只声明不装配；命令注册和窗口创建在 `main.rs`。

pub mod boot;
pub mod cli;
pub mod commands;
pub mod contract;
pub mod existing;
pub mod extract;
pub mod journal;
pub mod launcher;
pub mod log;
pub mod overlay;
pub mod runner;
pub mod target;
pub mod verify;
