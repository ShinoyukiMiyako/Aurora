// Copyright (C) 2026 Shinoyuki_Miyako
// SPDX-License-Identifier: AGPL-3.0-only
// 本程序代码按 AGPL-3.0-only 授权，另附 AGPL 第 7 条的附加条款；两者见源代码根目录的 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。
// Licensed under AGPL-3.0-only with additional terms under section 7 of the AGPL; see LICENSE and LICENSE-ADDITIONAL-TERMS.md at the root of the source code.

//! petalfall-modpack（L2 整合包文件格式）
//!
//! 读两种平台整合包：Modrinth 的 `.mrpack`（根目录 `modrinth.index.json`）与 CurseForge 导出的
//! `.zip`（根目录 `manifest.json`），归一到 [`PackManifest`]：MC 版本、加载器、要下载的远程文件、
//! 包内自带的覆盖文件。再提供把覆盖文件安全解到实例目录的 [`extract_overrides`]。
//!
//! 反方向由 [`write_pack`] 把一份导出清单写成 `.mrpack`，写完用读包的同一套代码读回来自校验。
//!
//! 本 crate 不发网络请求、不装游戏：CurseForge 清单只给工程与文件 id，换成下载地址、把文件与加载器
//! 装进实例是上层的事。包里出现的每一条路径都先过 [`path`] 的词法校验，越出实例目录或写进
//! 启动器元数据目录的一律拒收。
//!
//! 读写 zip 是同步阻塞 IO，调用方应放进 `spawn_blocking`。

pub mod archive;
pub mod error;
pub mod manifest;
pub mod path;
pub mod writer;

pub use archive::{
    OverrideEntry, PackArchive, decode_entry_name, decompress_entry, extract_overrides, read_pack,
};
pub use error::{Error, Result};
pub use manifest::{
    CurseForgeFileRef, ModrinthFile, PackFormat, PackLoader, PackLoaderKind, PackManifest,
    RemoteFiles,
};
pub use path::{PathValidationError, SafeRelativePath, validate_relative_path};
pub use writer::{
    EXPORT_DOWNLOAD_HOSTS, ExportPack, IndexFile, OverrideFile, WriteProgress, WrittenPack,
    is_export_download_url, write_pack,
};
