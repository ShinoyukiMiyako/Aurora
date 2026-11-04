//! 离线账户：用户名合法性校验与稳定离线 UUID。
//!
//! 离线 UUID 与原版 `UUID.nameUUIDFromBytes("OfflinePlayer:" + name)` 完全一致：
//! 取 `md5("OfflinePlayer:"+name)` 的 16 字节，置版本号 3、IETF 变体位。同名恒得同一 UUID，
//! 保证离线世界中玩家身份稳定、与官方启动器互通。

use md5::{Digest, Md5};

use crate::account::{Account, AccountCredentials};
use crate::error::{AuthError, Result};

/// 1.20.3+ 起客户端强制的用户名长度上限。
const MAX_USERNAME_LEN: usize = 16;

/// 用户名校验结果：硬性不合法直接 `Err`，软性问题以 `warnings` 返回供 UI 提示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsernameCheck {
    /// 非阻断性提示（如含非标准字符）。
    pub warnings: Vec<String>,
}

/// 校验离线用户名。
///
/// 硬性规则（返回 `Err`）：非空、不含双引号、长度不超过 16。
/// 软性规则（进入 `warnings`）：含 `[A-Za-z0-9_]` 以外的字符时提示“可能无法进入 1.18+ 世界”。
pub fn validate_username(name: &str) -> Result<UsernameCheck> {
    if name.is_empty() {
        return Err(AuthError::InvalidUsername("用户名不能为空".into()));
    }
    if name.contains('"') {
        return Err(AuthError::InvalidUsername("用户名不能包含双引号".into()));
    }
    // 按字符计数（而非字节），避免多字节字符被误判长度。
    if name.chars().count() > MAX_USERNAME_LEN {
        return Err(AuthError::InvalidUsername(format!(
            "用户名不能超过 {MAX_USERNAME_LEN} 个字符（1.20.3 及以上版本限制）"
        )));
    }

    let mut warnings = Vec::new();
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        warnings.push("用户名包含非标准字符，可能无法进入 1.18+ 世界".into());
    }
    Ok(UsernameCheck { warnings })
}

/// 生成与原版一致的离线 UUID。
///
/// `Builder::from_md5_bytes` 恰好等价于 Java `UUID.nameUUIDFromBytes`：对给定 16 字节
/// 置版本 3 与 RFC4122 变体位，不额外拼接命名空间前缀。
pub fn offline_uuid(name: &str) -> uuid::Uuid {
    let digest = Md5::digest(format!("OfflinePlayer:{name}").as_bytes());
    let bytes: [u8; 16] = digest.into();
    uuid::Builder::from_md5_bytes(bytes).into_uuid()
}

/// 构造离线账户。用户名先过硬性校验（软性 warning 由调用方另行获取），uuid 用无连字符形式。
pub fn offline_account(name: &str) -> Result<Account> {
    validate_username(name)?;
    let uuid = offline_uuid(name).simple().to_string();
    Ok(Account::new(uuid, name, AccountCredentials::Offline))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 原版算法（md5("OfflinePlayer:"+name) 置版本 3）的独立参照值，由 Python hashlib 计算得出，
    // 与 Java UUID.nameUUIDFromBytes 一致；用于锁死“与原版一致”这一硬约束。
    #[test]
    fn offline_uuid_matches_vanilla_vectors() {
        let cases = [
            ("Steve", "5627dd98e6be3c21b8a8e92344183641"),
            ("Notch", "b50ad385829d3141a2167e7d7539ba7f"),
            ("jeb_", "a762f5604fce3236812ab80efff0b62b"),
            ("Dev", "380df991f603344ca090369bad2a924a"),
        ];
        for (name, expected) in cases {
            assert_eq!(
                offline_uuid(name).simple().to_string(),
                expected,
                "离线 UUID 与原版参照值不一致: {name}"
            );
        }
    }

    #[test]
    fn offline_uuid_has_version_3_and_rfc_variant() {
        // nameUUIDFromBytes 语义：版本号 3、变体 RFC4122。
        let u = offline_uuid("Steve");
        assert_eq!(u.get_version_num(), 3);
        assert_eq!(u.get_variant(), uuid::Variant::RFC4122);
    }

    #[test]
    fn same_name_is_stable_different_name_differs() {
        assert_eq!(offline_uuid("Alice"), offline_uuid("Alice"));
        assert_ne!(offline_uuid("Alice"), offline_uuid("Bob"));
    }

    #[test]
    fn empty_and_quoted_names_are_rejected() {
        assert!(matches!(
            validate_username(""),
            Err(AuthError::InvalidUsername(_))
        ));
        assert!(matches!(
            validate_username("bad\"name"),
            Err(AuthError::InvalidUsername(_))
        ));
    }

    #[test]
    fn overlong_name_is_rejected_at_17_chars() {
        // 恰好 16 合法，17 触发上限。
        assert!(validate_username("abcdefghijklmnop").is_ok()); // 16 个字符
        let err = validate_username("abcdefghijklmnopq").unwrap_err(); // 17 个字符
        assert!(matches!(err, AuthError::InvalidUsername(msg) if msg.contains("16")));
    }

    #[test]
    fn standard_name_has_no_warnings() {
        let check = validate_username("Steve_123").unwrap();
        assert!(check.warnings.is_empty());
    }

    #[test]
    fn nonstandard_chars_yield_warning_but_pass() {
        let check = validate_username("玩家-1").unwrap();
        assert_eq!(check.warnings.len(), 1);
        assert!(check.warnings[0].contains("1.18+"));
    }

    #[test]
    fn offline_account_carries_stable_uuid_and_type() {
        let account = offline_account("Steve").unwrap();
        assert_eq!(account.uuid, "5627dd98e6be3c21b8a8e92344183641");
        assert_eq!(account.name, "Steve");
        assert_eq!(account.account_type, crate::account::AccountType::Offline);
    }
}
