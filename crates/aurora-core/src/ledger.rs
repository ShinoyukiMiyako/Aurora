//! 安装来源卷宗（ledger）：已装 Mod 文件与其平台身份的索引。
//!
//! 卷宗回答「`mods/` 里这个 jar 是从哪来的、属于哪个工程的哪个版本、是不是被别人当依赖带进来的」。
//! 更新检查要靠它定位工程与当前版本，依赖清理要靠它区分「用户主动装的」与「被顺带装进来的」，
//! 列表页要靠它给出来源、工程标题与平台图标。落盘位置是 `versions/<id>/<元数据目录>/ledger.json`，
//! 与版本设置同住一处，跟着版本目录走。
//!
//! 一条铁律：**磁盘是权威，卷宗只是索引**。列已装内容必须先重扫 `mods/` 目录，再拿文件名去卷宗里
//! join 补身份。卷宗有而磁盘没有的条目一律当作不存在（玩家手动删了文件是完全合法的操作），绝不能
//! 由卷宗来决定「装没装」；磁盘有而卷宗没有的（手动丢进去的 jar、别的启动器装的）也是正常态，
//! 走哈希反查补身份，反查不到就这么留着。
//!
//! 文件损坏时冒泡而不是重置为空卷宗：丢了身份等于同时丢掉更新与回滚能力，静默重置会让玩家在毫无
//! 察觉的情况下失去这两项能力，比直接报错糟糕得多。

use std::path::{Path, PathBuf};

use aurora_instance::{AURORA_META_DIR, VERSIONS_DIR};
use aurora_modplatform::Platform;
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::facade::Aurora;

/// 卷宗文件名。
const LEDGER_FILE: &str = "ledger.json";

/// 一条安装记录。`file_name` 是与磁盘 join 的键。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerEntry {
    /// 落盘的模组文件名（启用态，不含 `.disabled` 后缀）。
    pub file_name: String,
    /// 来源平台。
    pub platform: Platform,
    /// 工程标识：Modrinth 为 project_id，CurseForge 为 modId 十进制字符串。
    pub project_id: String,
    /// 版本标识：Modrinth 为版本 id，CurseForge 为 fileId 十进制字符串。
    pub version_id: String,
    /// 给人看的版本号；哈希反查补身份或早期记录里可能缺失。
    #[serde(default)]
    pub version_number: Option<String>,
    /// 工程标题（平台上的名字），列表与历史拿它称呼这个 Mod；取不到为 `None`。
    #[serde(default)]
    pub title: Option<String>,
    /// 平台给的工程图标地址；取不到为 `None`。
    #[serde(default)]
    pub icon_url: Option<String>,
    /// 下载时校验用的 SHA-1；平台没给为 `None`。
    pub sha1: Option<String>,
    /// 安装时刻 unix 秒。
    pub installed_at: i64,
    /// 作为谁的依赖被带进来的（project_id）；用户主动装的为 `None`。
    pub installed_as_dependency_of: Option<String>,
}

/// 一个实例的全部安装记录。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    /// 安装记录，按写入先后排列。
    pub entries: Vec<LedgerEntry>,
}

impl Ledger {
    /// 按磁盘文件名查条目。
    pub fn find(&self, file_name: &str) -> Option<&LedgerEntry> {
        self.entries.iter().find(|e| e.file_name == file_name)
    }

    /// 同 `file_name` 覆盖，不同则追加。
    ///
    /// 覆盖时保留原位置而不是「删了再 push」：卷宗顺序即安装先后，更新一个 Mod 不该把它挪到列表末尾。
    pub fn upsert(&mut self, entry: LedgerEntry) {
        match self
            .entries
            .iter_mut()
            .find(|e| e.file_name == entry.file_name)
        {
            Some(slot) => *slot = entry,
            None => self.entries.push(entry),
        }
    }

    /// 移除某文件名的条目并返回它；不存在返回 `None`。
    pub fn remove(&mut self, file_name: &str) -> Option<LedgerEntry> {
        let index = self.entries.iter().position(|e| e.file_name == file_name)?;
        Some(self.entries.remove(index))
    }
}

/// 卷宗文件的读写句柄。
#[derive(Debug, Clone)]
pub struct LedgerStore {
    path: PathBuf,
}

impl LedgerStore {
    /// 默认路径：`version_dir/<元数据目录>/ledger.json`（`version_dir` 即 `versions/<id>`）。
    pub fn for_version_dir(version_dir: &Path) -> Self {
        Self {
            path: version_dir.join(AURORA_META_DIR).join(LEDGER_FILE),
        }
    }

    /// 指定卷宗文件路径（测试注入）。
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 卷宗文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取卷宗；文件缺失返回空卷宗（该实例还没经本启动器装过 Mod）；存在但损坏则冒泡。
    pub async fn load(&self) -> Result<Ledger> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|source| CoreError::ConfigParse {
                path: self.path.clone(),
                source,
            }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::default()),
            Err(source) => Err(aurora_base::Error::Io {
                path: self.path.clone(),
                source,
            }
            .into()),
        }
    }

    /// 原子写入卷宗。
    pub async fn save(&self, ledger: &Ledger) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(ledger).map_err(CoreError::ConfigSerialize)?;
        aurora_base::fs::atomic_write(&self.path, &bytes).await?;
        Ok(())
    }
}

impl Aurora {
    /// 该实例的卷宗句柄：`versions/<id>/<元数据目录>/ledger.json`。
    ///
    /// 路径只由版本 id 决定，不随隔离档位漂移。卷宗记的是「这个版本装了哪些 Mod」这件版本自身的事实，
    /// 若跟着工作目录走，关掉隔离后多个版本会共用同一份卷宗、互相覆盖对方的身份。
    pub fn ledger_store(&self, version_id: &str) -> LedgerStore {
        LedgerStore::for_version_dir(&self.game_dir().join(VERSIONS_DIR).join(version_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;

    fn entry(file_name: &str, version_id: &str) -> LedgerEntry {
        LedgerEntry {
            file_name: file_name.to_owned(),
            platform: Platform::Modrinth,
            project_id: "AANobbMI".to_owned(),
            version_id: version_id.to_owned(),
            version_number: Some("0.5.3".to_owned()),
            title: Some("Sodium".to_owned()),
            icon_url: None,
            sha1: Some("aabbcc".to_owned()),
            installed_at: 1_754_000_000,
            installed_as_dependency_of: None,
        }
    }

    #[test]
    fn upsert_overwrites_same_file_name_in_place() {
        let mut ledger = Ledger::default();
        ledger.upsert(entry("sodium.jar", "v1"));
        ledger.upsert(entry("lithium.jar", "v9"));
        ledger.upsert(entry("sodium.jar", "v2"));

        // 同名覆盖：条数不变，版本被替换，且位置仍在最前（顺序即安装先后）。
        assert_eq!(ledger.entries.len(), 2);
        assert_eq!(ledger.entries[0].file_name, "sodium.jar");
        assert_eq!(ledger.entries[0].version_id, "v2");
        assert_eq!(ledger.entries[1].file_name, "lithium.jar");
        assert_eq!(ledger.entries[1].version_id, "v9");
    }

    #[test]
    fn upsert_appends_distinct_file_names() {
        let mut ledger = Ledger::default();
        ledger.upsert(entry("a.jar", "v1"));
        ledger.upsert(entry("b.jar", "v1"));
        ledger.upsert(entry("c.jar", "v1"));
        let names: Vec<&str> = ledger
            .entries
            .iter()
            .map(|e| e.file_name.as_str())
            .collect();
        assert_eq!(names, vec!["a.jar", "b.jar", "c.jar"]);
    }

    #[test]
    fn find_matches_exact_file_name_only() {
        let mut ledger = Ledger::default();
        ledger.upsert(entry("sodium.jar", "v1"));

        assert_eq!(ledger.find("sodium.jar").unwrap().version_id, "v1");
        // 禁用态文件名（带 .disabled）与前缀都不算命中：join 键是精确的磁盘文件名。
        assert!(ledger.find("sodium.jar.disabled").is_none());
        assert!(ledger.find("sodium").is_none());
        assert!(ledger.find("").is_none());
    }

    #[test]
    fn remove_returns_removed_entry_and_shrinks() {
        let mut ledger = Ledger::default();
        ledger.upsert(entry("a.jar", "v1"));
        ledger.upsert(entry("b.jar", "v2"));

        let removed = ledger.remove("b.jar").expect("应返回被删条目");
        assert_eq!(removed.file_name, "b.jar");
        assert_eq!(removed.version_id, "v2");
        assert_eq!(ledger.entries.len(), 1);
        assert_eq!(ledger.entries[0].file_name, "a.jar");

        // 再删同一条即为不存在。
        assert!(ledger.remove("b.jar").is_none());
    }

    #[tokio::test]
    async fn missing_file_loads_empty_ledger() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LedgerStore::for_version_dir(tmp.path());
        assert_eq!(
            store.path(),
            tmp.path().join(AURORA_META_DIR).join("ledger.json")
        );
        assert_eq!(store.load().await.unwrap(), Ledger::default());
    }

    #[tokio::test]
    async fn round_trip_preserves_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let store = LedgerStore::for_version_dir(tmp.path());

        let mut ledger = Ledger::default();
        ledger.upsert(entry("sodium-0.5.3.jar", "IZskiJmZ"));
        ledger.upsert(LedgerEntry {
            file_name: "fabric-api.jar".to_owned(),
            platform: Platform::CurseForge,
            project_id: "306612".to_owned(),
            version_id: "5678901".to_owned(),
            version_number: None,
            title: None,
            icon_url: Some("https://cf/fabric-api.png".to_owned()),
            sha1: None,
            installed_at: -5,
            installed_as_dependency_of: Some("AANobbMI".to_owned()),
        });
        store.save(&ledger).await.unwrap();

        let back = store.load().await.unwrap();
        assert_eq!(back, ledger);
        // 依赖来源、缺失 sha1 与早于纪元的时间都要如实回读，不能被默认值抹平。
        let dep = back.find("fabric-api.jar").unwrap();
        assert_eq!(dep.installed_as_dependency_of, Some("AANobbMI".to_owned()));
        assert_eq!(dep.sha1, None);
        assert_eq!(dep.platform, Platform::CurseForge);
        assert_eq!(dep.installed_at, -5);
    }

    #[tokio::test]
    async fn entries_written_without_display_fields_still_load() {
        // 不带 version_number / title / icon_url 的早期条目必须照常读出，三个字段为空。
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ledger.json");
        tokio::fs::write(
            &path,
            br#"{"entries":[{"file_name":"a.jar","platform":"modrinth","project_id":"p",
                "version_id":"v","sha1":null,"installed_at":1,"installed_as_dependency_of":null}]}"#,
        )
        .await
        .unwrap();
        let ledger = LedgerStore::at(&path).load().await.unwrap();
        let only = &ledger.entries[0];
        assert_eq!(only.version_id, "v");
        assert_eq!(only.version_number, None);
        assert_eq!(only.title, None);
        assert_eq!(only.icon_url, None);
    }

    #[tokio::test]
    async fn corrupt_ledger_file_bubbles_instead_of_resetting() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("ledger.json");
        tokio::fs::write(&path, b"{ \"entries\": [").await.unwrap();
        let store = LedgerStore::at(&path);

        let err = store.load().await.unwrap_err();
        match err {
            CoreError::ConfigParse { path: bad, .. } => assert_eq!(bad, path),
            other => panic!("期望解析错误，得到 {other:?}"),
        }
    }

    #[test]
    fn aurora_ledger_store_points_into_version_meta_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let mc = tmp.path().join(".minecraft");
        let aurora = Aurora::for_test(
            AuroraConfig::default(),
            tmp.path().to_path_buf(),
            mc.clone(),
        );

        assert_eq!(
            aurora.ledger_store("1.20.1-Forge_47.4.20").path(),
            mc.join("versions")
                .join("1.20.1-Forge_47.4.20")
                .join(AURORA_META_DIR)
                .join("ledger.json")
        );
    }
}
