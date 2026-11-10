// Copyright (C) 2026 Shinoyuki_Miyako
// SPDX-License-Identifier: AGPL-3.0-only
// 本程序代码按 AGPL-3.0-only 授权，另附 AGPL 第 7 条的附加条款；两者见源代码根目录的 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。
// Licensed under AGPL-3.0-only with additional terms under section 7 of the AGPL; see LICENSE and LICENSE-ADDITIONAL-TERMS.md at the root of the source code.

//! petalfall-release：发布规则的唯一实现。
//!
//! 「哪个版本更新」「这个版本属于哪个通道」「数据是第几号格式」「这个安装包能不能装到现有安装上」这几件事，
//! 启动器、安装引导程序和打包工具都要判断。各写一份迟早会各判各的：启动器放行的包被引导程序拦下，或者
//! 反过来。所以规则都放在这里，三处调用同一份；全是不碰磁盘、不碰系统接口的纯函数，测试随 CI 跑。
//!
//! 结构：
//! - [`order`]：版本先后、版本所属的发布通道、通道的快慢次序。
//! - [`data_format`]：数据格式号与记号文件的读法。
//! - [`handoff`]：安装引导程序交给启动器的换通道记录。
//! - [`install_policy`]：安装引导程序的判定表。

pub mod data_format;
pub mod handoff;
pub mod install_policy;
pub mod order;
