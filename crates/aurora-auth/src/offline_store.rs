//! 离线账户的持久化（明文 JSON 单文件）。
//!
//! 为什么单独一个库、而不塞进 DPAPI 加密的凭据库：离线账户没有任何凭据可保护——全部内容就是一个
//! 用户名和加入时刻，UUID 还是由用户名当场派生的公开函数值。而凭据库的 DPAPI 密钥绑当前 Windows
//! 用户，换机器、换系统账户就解不开，把无需保密的离线名单绑进去只会让它跟着一起失效；明文 JSON 则
//! 可随数据目录整包搬走，也允许用户手改。离线名本就要发进游戏聊天与多人服务器，不是秘密。
//!
//! 磁盘形态刻意不存 UUID：UUID 是 [`offline_uuid`] 对用户名的纯函数结果，存两份就会有对不上的
//! 一天；每次读盘现算，同名永远同 UUID 这条硬约束由函数本身保证。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::account::{Account, AccountCredentials, unix_millis};
use crate::credential::{read_atomic, write_atomic};
use crate::error::{AuthError, Result};
use crate::offline::{offline_account, offline_uuid};

/// 离线账户库里的一项：用户名与加入时刻（Unix 毫秒）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OfflineEntry {
    pub name: String,
    pub added_at: u64,
}

/// 离线账户库的磁盘形态：账户列表 + 当前选中的用户名。
///
/// 两个顶层字段都带 `serde(default)`：手改文件时漏写整段仍能读起来，不至于因为少一个键就让
/// 整个账户列表消失。条目内的字段是必填的，缺了就是坏数据，按损坏报错。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OfflineAccountDb {
    /// 已保存的离线账户，按加入顺序。
    #[serde(default)]
    pub accounts: Vec<OfflineEntry>,
    /// 当前选中的离线用户名；为空表示当前没有选中任何离线账户。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

/// 离线账户库：在明文 JSON 文件之上做增删改查与「当前选中」维护，任何变更立即落盘。
///
/// 增删改查一律以 32 位无连字符 UUID 为键，与 [`crate::account::AccountManager`] 对齐，
/// 让上层可以用同一个 uuid 在两个库之间寻址，不必先知道账户是哪一类。
#[derive(Debug)]
pub struct OfflineAccountStore {
    path: PathBuf,
    db: OfflineAccountDb,
}

impl OfflineAccountStore {
    /// 打开指定路径的离线账户库；文件不存在即空库（首次运行不预建文件）。
    ///
    /// 文件存在但解析不了属于真故障，直接冒泡，绝不静默当成空库——那会让用户以为账户
    /// 「凭空没了」，下一次写入又把损坏文件覆盖掉，名单再也救不回来。
    pub fn load(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        // read_atomic 只吸收原子替换窗口内的瞬时打开失败，解析失败仍原样冒泡。
        let db = match read_atomic(&path)? {
            Some(bytes) => serde_json::from_slice(&bytes).map_err(|source| {
                AuthError::OfflineStoreDeserialize {
                    path: path.clone(),
                    source,
                }
            })?,
            None => OfflineAccountDb::default(),
        };
        Ok(Self { path, db })
    }

    /// 库文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 已保存的离线用户名（按加入顺序）。
    pub fn names(&self) -> Vec<&str> {
        self.db.accounts.iter().map(|e| e.name.as_str()).collect()
    }

    /// 物化成账户列表；uuid 由用户名当场派生。
    pub fn accounts(&self) -> Vec<Account> {
        self.db.accounts.iter().map(materialize).collect()
    }

    /// 按 uuid 查找离线账户。
    pub fn find(&self, uuid: &str) -> Option<Account> {
        self.entry_of(uuid).map(materialize)
    }

    /// 当前选中的离线账户；选中项已被移出列表（手改文件所致）时视为未选中。
    pub fn current(&self) -> Option<Account> {
        let name = self.db.current.as_deref()?;
        self.db
            .accounts
            .iter()
            .find(|e| e.name == name)
            .map(materialize)
    }

    /// 保存一个离线用户名并把它设为当前选中，返回对应账户。
    ///
    /// 用户名先过 [`offline_account`] 的硬性校验（空/引号/超长），不合法则原样冒泡且一个字节都不落盘。
    /// 同名重复添加是幂等的（列表不长第二条、加入时刻不变），但仍会把它设为当前——用户刚刚亲手
    /// 输入这个名字，紧接着的动作就是拿它开游戏。
    pub fn add(&mut self, name: &str) -> Result<Account> {
        offline_account(name)?;
        if !self.db.accounts.iter().any(|e| e.name == name) {
            self.db.accounts.push(OfflineEntry {
                name: name.to_owned(),
                added_at: unix_millis(),
            });
        }
        self.db.current = Some(name.to_owned());
        self.persist()?;
        let entry = self
            .db
            .accounts
            .iter()
            .find(|e| e.name == name)
            .expect("刚确认或加入过的条目必然在列表里");
        Ok(materialize(entry))
    }

    /// 删除离线账户；不存在则报 [`AuthError::AccountNotFound`]。
    ///
    /// 删掉的正是当前选中项时，回落到剩余的第一个（无剩余则清空选中），与
    /// [`crate::account::AccountManager::remove`] 同一套语义。
    pub fn remove(&mut self, uuid: &str) -> Result<()> {
        let Some(name) = self.entry_of(uuid).map(|e| e.name.clone()) else {
            return Err(AuthError::AccountNotFound(uuid.to_owned()));
        };
        self.db.accounts.retain(|e| e.name != name);
        if self.db.current.as_deref() == Some(name.as_str()) {
            self.db.current = self.db.accounts.first().map(|e| e.name.clone());
        }
        self.persist()
    }

    /// 切换当前选中的离线账户；目标不存在则报错。
    pub fn set_current(&mut self, uuid: &str) -> Result<()> {
        let Some(name) = self.entry_of(uuid).map(|e| e.name.clone()) else {
            return Err(AuthError::AccountNotFound(uuid.to_owned()));
        };
        self.db.current = Some(name);
        self.persist()
    }

    /// 清空「当前选中的离线账户」，供上层切到正版/外置账户时调用。已经是空的就不做多余写盘。
    pub fn clear_current(&mut self) -> Result<()> {
        if self.db.current.is_none() {
            return Ok(());
        }
        self.db.current = None;
        self.persist()
    }

    /// 按 uuid 反查条目：uuid 是用户名的纯函数值，故只能逐个现算比对。
    /// 离线账户数量是个位数量级，线性扫描无需优化。
    fn entry_of(&self, uuid: &str) -> Option<&OfflineEntry> {
        self.db
            .accounts
            .iter()
            .find(|e| offline_uuid(&e.name).simple().to_string() == uuid)
    }

    /// 整库写回。用 pretty 而非紧凑格式：这个文件的卖点之一就是可手改，可读性优先于几十字节。
    fn persist(&self) -> Result<()> {
        let bytes =
            serde_json::to_vec_pretty(&self.db).map_err(AuthError::OfflineStoreSerialize)?;
        write_atomic(&self.path, &bytes)?;
        Ok(())
    }
}

/// 由条目组装离线账户（uuid 现算）。此处不再校验用户名：列表里的名字要么是 [`OfflineAccountStore::add`]
/// 校验过的，要么是用户手改进文件的——后者也应如实列出来，让用户看得见自己写了什么。
fn materialize(entry: &OfflineEntry) -> Account {
    Account {
        added_at: entry.added_at,
        ..Account::new(
            offline_uuid(&entry.name).simple().to_string(),
            entry.name.as_str(),
            AccountCredentials::Offline,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::{AccountStatus, AccountType};

    /// Steve 的原版离线 UUID（与 offline.rs 的参照向量同源），用于锁死跨进程 UUID 稳定性。
    const STEVE_UUID: &str = "5627dd98e6be3c21b8a8e92344183641";

    fn store_at(dir: &tempfile::TempDir) -> OfflineAccountStore {
        OfflineAccountStore::load(dir.path().join("offline_accounts.json")).unwrap()
    }

    #[test]
    fn missing_file_loads_as_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_at(&dir);
        assert!(store.names().is_empty());
        assert!(store.current().is_none());
        // 只读不该凭空建文件。
        assert!(!store.path().exists());
    }

    #[test]
    fn added_accounts_survive_reload_with_selection_and_added_at() {
        let dir = tempfile::tempdir().unwrap();
        let (steve_added, alex_added) = {
            let mut store = store_at(&dir);
            let steve = store.add("Steve").unwrap();
            let alex = store.add("Alex").unwrap();
            store.set_current(STEVE_UUID).unwrap();
            (steve.added_at, alex.added_at)
        };

        // 换一个 store 句柄从同一文件重载＝重启启动器。
        let reloaded = store_at(&dir);
        assert_eq!(reloaded.names(), ["Steve", "Alex"]);
        let current = reloaded.current().unwrap();
        assert_eq!(current.name, "Steve");
        assert_eq!(current.uuid, STEVE_UUID);
        assert_eq!(current.added_at, steve_added);
        assert_eq!(current.status, AccountStatus::Ok);
        assert_eq!(current.last_verified_at, None);
        assert_eq!(reloaded.accounts()[1].added_at, alex_added);
        assert_eq!(reloaded.accounts()[1].account_type, AccountType::Offline);
    }

    #[test]
    fn file_is_plaintext_json_readable_by_anything() {
        // 存放形态本身就是需求的一部分（可迁移、可手改），故对文件内容直接断言。
        let dir = tempfile::tempdir().unwrap();
        let mut store = store_at(&dir);
        let steve = store.add("Steve").unwrap();

        let text = std::fs::read_to_string(store.path()).unwrap();
        let parsed: OfflineAccountDb = serde_json::from_str(&text).unwrap();
        assert_eq!(
            parsed.accounts,
            vec![OfflineEntry {
                name: "Steve".to_owned(),
                added_at: steve.added_at
            }]
        );
        assert_eq!(parsed.current.as_deref(), Some("Steve"));
        // 不存 UUID，也不存任何体型字段。
        assert!(!text.contains(STEVE_UUID));
        assert!(!text.contains("model"));
    }

    #[test]
    fn same_name_always_derives_the_same_uuid() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store_at(&dir);
        let first = store.add("Steve").unwrap();
        // 删掉再加回来，UUID 必须一模一样，否则同一个存档里的玩家数据会对不上。
        store.remove(&first.uuid).unwrap();
        let again = store.add("Steve").unwrap();
        assert_eq!(again.uuid, first.uuid);
        assert_eq!(again.uuid, STEVE_UUID);
        // 重载后现算的 uuid 同样稳定。
        assert_eq!(store_at(&dir).accounts()[0].uuid, STEVE_UUID);
    }

    #[test]
    fn adding_same_name_twice_does_not_duplicate_or_reset_added_at() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store_at(&dir);
        let first = store.add("Steve").unwrap();
        store.add("Alex").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let again = store.add("Steve").unwrap();

        assert_eq!(store.names(), ["Steve", "Alex"]);
        assert_eq!(again.added_at, first.added_at);
        // 重复添加仍把它选为当前。
        assert_eq!(store.current().unwrap().name, "Steve");
    }

    #[test]
    fn removed_account_is_gone_after_reload() {
        let dir = tempfile::tempdir().unwrap();
        let alex_uuid = {
            let mut store = store_at(&dir);
            store.add("Steve").unwrap();
            let alex = store.add("Alex").unwrap();
            store.remove(&alex.uuid).unwrap();
            alex.uuid
        };

        let reloaded = store_at(&dir);
        assert_eq!(reloaded.names(), ["Steve"]);
        assert!(reloaded.find(&alex_uuid).is_none());
        assert!(reloaded.accounts().iter().all(|a| a.name != "Alex"));
    }

    #[test]
    fn removing_current_falls_back_to_first_remaining() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store_at(&dir);
        store.add("Steve").unwrap();
        store.add("Alex").unwrap();
        let herobrine = store.add("Herobrine").unwrap();
        assert_eq!(store.current().unwrap().name, "Herobrine");

        store.remove(&herobrine.uuid).unwrap();
        assert_eq!(store.current().unwrap().name, "Steve");
        // 回落结果也要落盘，不能只活在内存里。
        assert_eq!(store_at(&dir).current().unwrap().name, "Steve");
    }

    #[test]
    fn removing_the_last_account_clears_selection() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store_at(&dir);
        let steve = store.add("Steve").unwrap();
        store.remove(&steve.uuid).unwrap();

        assert!(store.names().is_empty());
        assert!(store.current().is_none());
        assert!(store_at(&dir).current().is_none());
    }

    #[test]
    fn removing_a_non_current_account_keeps_the_selection() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store_at(&dir);
        let steve = store.add("Steve").unwrap();
        store.add("Alex").unwrap();
        assert_eq!(store.current().unwrap().name, "Alex");

        store.remove(&steve.uuid).unwrap();
        assert_eq!(store.current().unwrap().name, "Alex");
    }

    #[test]
    fn remove_and_set_current_reject_unknown_uuid() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store_at(&dir);
        store.add("Steve").unwrap();

        let err = store
            .remove("ffffffffffffffffffffffffffffffff")
            .unwrap_err();
        assert!(
            matches!(err, AuthError::AccountNotFound(id) if id == "ffffffffffffffffffffffffffffffff")
        );
        let err = store
            .set_current("00000000000000000000000000000000")
            .unwrap_err();
        assert!(matches!(err, AuthError::AccountNotFound(_)));
        // 失败不该动到既有数据。
        assert_eq!(store.names(), ["Steve"]);
    }

    #[test]
    fn clear_current_persists_and_keeps_the_list() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store_at(&dir);
        store.add("Steve").unwrap();
        store.clear_current().unwrap();

        let reloaded = store_at(&dir);
        assert!(reloaded.current().is_none());
        assert_eq!(reloaded.names(), ["Steve"]);
    }

    #[test]
    fn invalid_username_is_rejected_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = store_at(&dir);

        assert!(matches!(store.add(""), Err(AuthError::InvalidUsername(_))));
        assert!(matches!(
            store.add("abcdefghijklmnopq"),
            Err(AuthError::InvalidUsername(_))
        ));
        assert!(store.names().is_empty());
        assert!(!store.path().exists());
    }

    #[test]
    fn dangling_selection_is_reported_as_no_selection() {
        // 手改文件把 current 指到一个不在列表里的名字：不该凭空造出一个账户来。
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("offline_accounts.json");
        std::fs::write(
            &path,
            br#"{"accounts":[{"name":"Steve","added_at":5}],"current":"Ghost"}"#,
        )
        .unwrap();

        let store = OfflineAccountStore::load(&path).unwrap();
        assert!(store.current().is_none());
        assert_eq!(store.names(), ["Steve"]);
        assert_eq!(store.accounts()[0].added_at, 5);
    }

    #[test]
    fn corrupt_file_errors_loudly_instead_of_resetting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("offline_accounts.json");
        std::fs::write(&path, b"{ this is not json").unwrap();

        let err = OfflineAccountStore::load(&path).unwrap_err();
        assert!(matches!(err, AuthError::OfflineStoreDeserialize { path: p, .. } if p == path));
        // 损坏的原文件必须原封不动留着，供用户自己救回名单。
        assert_eq!(std::fs::read(&path).unwrap(), b"{ this is not json");

        // 条目缺加入时刻同样算损坏。
        std::fs::write(&path, br#"{"accounts":[{"name":"Steve"}]}"#).unwrap();
        assert!(matches!(
            OfflineAccountStore::load(&path),
            Err(AuthError::OfflineStoreDeserialize { .. })
        ));
    }
}
