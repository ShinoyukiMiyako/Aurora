//! 原版安装编排。
//!
//! 把「选定的原版 id」变为「本地就绪」：拉版本清单 → 下版本 JSON（sha1 校验落盘）→ 解析 →
//! 下 client.jar + 按 rules 过滤的库 + 日志配置 + assetIndex → 读 assetIndex 展开资源对象全量补全
//! → 解压 natives → 按 virtual/map_to_resources 布局物化资源。下载任务的构造在 [`crate::plan`]
//! 里（纯函数、可脱网测试），本模块只负责按序编排与两段式的资源展开。

use std::path::Path;

use aurora_version::{ManifestVersion, VersionJson, VersionManifest};

use crate::complete;
use crate::context::InstallContext;
use crate::error::{Error, Result, io_err};
use crate::net;

/// 官方版本清单地址（BMCLAPI 同结构镜像，元数据抓取不改写，按需由调用方传入镜像地址）。
pub const VERSION_MANIFEST_V2: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/// 一次原版安装的结果计数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VanillaSummary {
    /// 安装的版本 id。
    pub id: String,
    /// 下载的库文件数（含 natives 件）。
    pub libraries: usize,
    /// 补全的资源对象数。
    pub assets: usize,
    /// 解压出的 natives 文件数。
    pub natives: u32,
}

/// 原版安装器。持有共享上下文与可注入的版本清单地址（测试指向本地 mock）。
pub struct VanillaInstaller<'a> {
    cx: InstallContext<'a>,
    manifest_url: String,
}

impl<'a> VanillaInstaller<'a> {
    /// 用共享上下文构造，默认走官方版本清单。
    pub fn new(cx: InstallContext<'a>) -> Self {
        Self {
            cx,
            manifest_url: VERSION_MANIFEST_V2.to_owned(),
        }
    }

    /// 覆盖版本清单地址（测试 mock 或改用 BMCLAPI 镜像）。
    pub fn with_manifest_url(mut self, url: impl Into<String>) -> Self {
        self.manifest_url = url.into();
        self
    }

    /// 拉取并解析版本清单。
    pub async fn fetch_manifest(&self) -> Result<VersionManifest> {
        net::get_json(
            self.cx.client,
            &self.manifest_url,
            self.cx.policy,
            self.cx.cancel,
            "版本清单",
        )
        .await
    }

    /// 在版本清单里查出 `id` 的条目。清单里没有该 id 时报 [`Error::InstallerEntryMissing`]。
    pub async fn find_entry(&self, id: &str) -> Result<ManifestVersion> {
        let manifest = self.fetch_manifest().await?;
        manifest
            .find(id)
            .cloned()
            .ok_or_else(|| Error::InstallerEntryMissing {
                entry: format!("版本清单中的 {id}"),
            })
    }

    /// 按 id 安装原版（先查清单再装）。清单里没有该 id 时报 [`Error::InstallerEntryMissing`]。
    pub async fn install(&self, id: &str) -> Result<VanillaSummary> {
        let entry = self.find_entry(id).await?;
        self.install_entry(&entry).await
    }

    /// 按清单条目安装原版：下版本 JSON、落盘、解析后补全全部文件。
    pub async fn install_entry(&self, entry: &ManifestVersion) -> Result<VanillaSummary> {
        let dest = self.cx.layout.version_json(&entry.id);
        let version = self.download_version_json(entry, &dest).await?;
        self.install_files(&version).await
    }

    /// 只把版本 JSON 读进内存、不落盘：安装前查看它要求的 Java 主版本之类信息时用。
    pub async fn fetch_version_json(&self, entry: &ManifestVersion) -> Result<VersionJson> {
        net::get_json(
            self.cx.client,
            &entry.url,
            self.cx.policy,
            self.cx.cancel,
            "版本 JSON",
        )
        .await
    }

    /// 下载版本 JSON 到 `dest`（带 sha1 校验，走下载池的镜像兜底），读回并解析。
    pub async fn download_version_json(
        &self,
        entry: &ManifestVersion,
        dest: &Path,
    ) -> Result<VersionJson> {
        let mut task = aurora_download::DownloadTask::new(entry.url.clone(), dest);
        if let Some(sha1) = &entry.sha1 {
            task = task.with_sha1(sha1.clone());
        }
        self.cx.run_batch(vec![task], "版本 JSON", None).await?;

        let bytes = tokio::fs::read(dest)
            .await
            .map_err(|source| io_err(dest, source))?;
        net::parse_json(&bytes, "版本 JSON")
    }

    /// 已有解析后的原版版本 JSON（且其 JSON 文件已落盘），补全全部文件与 natives。
    ///
    /// 原版的 client jar 与 natives 都落在版本自身目录，故 target_id 即版本 id；复用
    /// [`complete::ensure_complete`] 的幂等补全逻辑。
    pub async fn install_files(&self, version: &VersionJson) -> Result<VanillaSummary> {
        let report = complete::ensure_complete(self.cx, version, &version.id).await?;
        Ok(VanillaSummary {
            id: version.id.clone(),
            libraries: report.libraries,
            assets: report.assets,
            natives: report.natives,
        })
    }
}
