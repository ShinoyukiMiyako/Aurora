//! version_manifest_v2 域模型。
//!
//! 对应 piston-meta.mojang.com/mc/game/version_manifest_v2.json（及 BMCLAPI 同结构镜像）。
//! 本 crate 只负责把清单解析成模型并提供查询；实际抓取、"版本数 >= 200 防截断"、latest 变化提醒
//! 等属于网络/交互层，不在此实现。v2 相较 v1 多了每条目的 sha1 与 complianceLevel。

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// 版本清单根对象。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionManifest {
    pub latest: LatestVersions,
    pub versions: Vec<ManifestVersion>,
}

impl VersionManifest {
    /// 从 JSON 字符串解析清单。
    pub fn from_json_str(s: &str) -> Result<Self> {
        serde_json::from_str(s).map_err(|source| Error::Json {
            context: "版本清单",
            source,
        })
    }

    /// 按 id 精确查找条目。
    pub fn find(&self, id: &str) -> Option<&ManifestVersion> {
        self.versions.iter().find(|v| v.id == id)
    }

    /// 取 latest.release 指向的条目。
    pub fn latest_release(&self) -> Option<&ManifestVersion> {
        self.find(&self.latest.release)
    }

    /// 取 latest.snapshot 指向的条目。
    pub fn latest_snapshot(&self) -> Option<&ManifestVersion> {
        self.find(&self.latest.snapshot)
    }
}

/// latest 区块：最新正式版与最新快照的 id。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LatestVersions {
    pub release: String,
    pub snapshot: String,
}

/// 清单中的单个版本条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestVersion {
    pub id: String,
    #[serde(rename = "type")]
    pub release_type: String,
    /// 该版本完整 JSON 的下载地址。
    pub url: String,
    pub time: String,
    #[serde(rename = "releaseTime")]
    pub release_time: String,
    /// v2 新增：版本 JSON 文件的 sha1。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(
        rename = "complianceLevel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub compliance_level: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // 结构对齐真实 version_manifest_v2.json（截取三条 + latest 区块）。
    const SAMPLE: &str = r#"{
        "latest": { "release": "1.21", "snapshot": "24w21b" },
        "versions": [
            { "id": "24w21b", "type": "snapshot",
              "url": "https://piston-meta.mojang.com/v1/packages/hash1/24w21b.json",
              "time": "2024-05-24T12:00:00+00:00", "releaseTime": "2024-05-24T11:00:00+00:00",
              "sha1": "hash1", "complianceLevel": 1 },
            { "id": "1.21", "type": "release",
              "url": "https://piston-meta.mojang.com/v1/packages/8a2338043e00aface892d86269f3eb88730e15bc/1.21.json",
              "time": "2024-06-13T08:24:03+00:00", "releaseTime": "2024-06-13T08:24:03+00:00",
              "sha1": "8a2338043e00aface892d86269f3eb88730e15bc", "complianceLevel": 1 },
            { "id": "1.12.2", "type": "release",
              "url": "https://piston-meta.mojang.com/v1/packages/hash3/1.12.2.json",
              "time": "2017-09-18T08:39:46+00:00", "releaseTime": "2017-09-18T08:39:46+00:00",
              "sha1": "hash3", "complianceLevel": 0 }
        ]
    }"#;

    #[test]
    fn parse_and_lookup() {
        let m = VersionManifest::from_json_str(SAMPLE).expect("清单应解析");
        assert_eq!(m.versions.len(), 3);
        assert_eq!(m.latest.release, "1.21");
        assert_eq!(m.latest.snapshot, "24w21b");

        let r = m.latest_release().expect("应找到 latest release");
        assert_eq!(r.release_type, "release");
        assert_eq!(
            r.url,
            "https://piston-meta.mojang.com/v1/packages/8a2338043e00aface892d86269f3eb88730e15bc/1.21.json"
        );
        assert_eq!(
            r.sha1.as_deref(),
            Some("8a2338043e00aface892d86269f3eb88730e15bc")
        );

        let s = m.latest_snapshot().expect("应找到 latest snapshot");
        assert_eq!(s.id, "24w21b");
        assert_eq!(s.compliance_level, Some(1));

        assert!(m.find("1.12.2").is_some());
        assert!(m.find("nonexistent").is_none());
    }

    #[test]
    fn v1_style_without_sha1_still_parses() {
        // v1 清单没有 sha1/complianceLevel，默认应为 None 而非报错。
        let json = r#"{
            "latest": {"release":"1.0","snapshot":"1.0"},
            "versions":[{"id":"1.0","type":"release","url":"u","time":"t","releaseTime":"t"}]
        }"#;
        let m = VersionManifest::from_json_str(json).expect("v1 清单应解析");
        let v = m.find("1.0").unwrap();
        assert!(v.sha1.is_none());
        assert!(v.compliance_level.is_none());
    }
}
