// Copyright (C) 2026 Shinoyuki_Miyako
// SPDX-License-Identifier: AGPL-3.0-only
// 本程序代码按 AGPL-3.0-only 授权，另附 AGPL 第 7 条的附加条款；两者见源代码根目录的 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。
// Licensed under AGPL-3.0-only with additional terms under section 7 of the AGPL; see LICENSE and LICENSE-ADDITIONAL-TERMS.md at the root of the source code.

//! petalfall-instance（L2 实例管理）
//!
//! 一个实例就是游戏目录 `versions/` 下的一个版本目录，目录名即实例 id。本 crate 向上层（petalfall-launch /
//! petalfall-core）提供：已安装版本发现、实例命名规则、实例设置与未完成标记的持久化、版本隔离判定、
//! 存档与资源包的读取、移入回收站。只碰本地文件系统，不发网络请求；版本 JSON 的域模型与加载器探测
//! 复用 [`petalfall_version`]。
//!
//! 模块划分：
//! - [`folder`]：官方启动器的游戏目录位置。
//! - [`discovery`]：`versions/` 扫描与单版本读取（含加载器探测、出错版本单列与解析缓存）。
//! - [`naming`]：实例名称规则与实例 id 的路径安全检查。
//! - [`settings`]：实例设置（介绍 / 封面 / 隔离覆盖 / 内存 / Java / JVM 参数 / 窗口）持久化。
//! - [`marker`]：安装与修复的未完成标记。
//! - [`isolation`]：版本隔离档位、版本级覆盖、已有 mods/saves 强制隔离与工作目录产出。
//! - [`content`]：存档、资源包、光影包、Mod 文件计数与目录体积。
//! - [`level`]：`level.dat` 的最小 NBT 读取。
//! - [`trash`]：移入回收站。
//! - [`world_backup`]：存档备份的打包、清单、保留策略与恢复。
//!
//! 错误统一归口到 [`Error`]，下游 `#[from]` 冒泡。

pub mod content;
#[cfg(test)]
mod data_format_snapshot;
pub mod discovery;
pub mod error;
pub mod folder;
pub mod isolation;
pub mod level;
pub mod marker;
pub mod naming;
pub mod settings;
pub mod trash;
pub mod world_backup;

pub use error::{Error, PinsViolation, Result};

/// `.minecraft` 目录名。
pub const MINECRAFT_DIR_NAME: &str = ".minecraft";
/// 版本目录名（游戏目录下存放各版本的子目录）。
pub const VERSIONS_DIR: &str = "versions";
/// 启动器在游戏/版本目录内落自身元数据（版本设置等）的子目录名，形如 `.petalfall`。
/// 常量名里的 petalfall 是内部代号，取值跟随产品 slug。
pub const PETALFALL_META_DIR: &str = concat!(".", petalfall_base::app_slug!());

pub use folder::official_minecraft_dir;

pub use discovery::{
    BrokenReason, BrokenVersion, DiscoveredVersion, VersionProbe, VersionScan, discover_version,
    discover_versions, list_version_dirs, probe_version,
};

pub use naming::{
    ILLEGAL_NAME_CHARS, MAX_NAME_UNITS, NameViolation, check_instance_name, check_name_format,
    is_safe_instance_id,
};

pub use settings::{
    COVER_IMAGE_DIR, CoverBackground, CoverImageSlot, JavaSelection, Resolution, SettingsViolation,
    VersionSettings, VersionSettingsStore, cover_image_dir,
};

pub use marker::{
    IncompleteKind, IncompleteMarker, IncompleteOutcome, InstallRecordStore, InstallSpec,
    MarkerError, MarkerStore,
};

pub use isolation::{
    IsolationFacts, IsolationOverride, IsolationPolicy, ResolvedIsolation, game_working_dir,
    has_existing_mods_or_saves, is_isolated, resolve_isolation,
};

pub use content::{
    InstanceContent, LevelInfo, PackEntry, ResourcePackEntry, ShaderPackEntry, WorldEntry,
    count_mod_files, count_worlds, dir_footprint, list_worlds, read_instance_content,
    read_render_distance,
};

pub use level::{GameMode, LevelSummary};

pub use trash::{Disposer, RecycleBin};

pub use world_backup::{
    BACKUP_INDEX_FILE, BACKUP_INDEX_VERSION, BACKUPS_DIR, BackupEntry, BackupIndex, BackupKind,
    BackupLayout, PackProgress, PackedWorld, RESTORE_SUFFIX, RetentionPolicy, WorldScope,
    commit_restore, is_backup_file_name, merge_scope_dir, pack_world, plan_prune,
    read_backup_index, remove_partial_backups, scan_backup_indices, scope_backup_indices,
    stage_restore, world_in_use, write_backup_index,
};
