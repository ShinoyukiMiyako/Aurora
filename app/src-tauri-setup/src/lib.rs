// Copyright (C) 2026 Shinoyuki_Miyako
// SPDX-License-Identifier: AGPL-3.0-only
// 本程序代码按 AGPL-3.0-only 授权，另附 AGPL 第 7 条的附加条款；两者见源代码根目录的 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。
// Licensed under AGPL-3.0-only with additional terms under section 7 of the AGPL; see LICENSE and LICENSE-ADDITIONAL-TERMS.md at the root of the source code.

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
