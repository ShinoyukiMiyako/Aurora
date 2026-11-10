//! 落盘类型的快照守卫：改了凭据库的落盘类型，却忘了判断要不要加数据格式号时，这里的测试会挂。
//!
//! 这个包写两份落盘文件（路径由上层给出），各对一份样本，样本在 `testdata/data-format/current/`：
//! - `credentials.bin`：[`AccountDatabase`] 经 `serde_json::to_vec` 序列化成紧凑 JSON，整份交给 DPAPI
//!   加密后落盘。密文外面没有任何头或信封，每次加密的字节都不同；旧版本读不读得了只取决于解密出的明文，
//!   所以比对的是加密之前的明文，样本名 `credentials.bin.json`。
//! - `offline_accounts.json`：[`OfflineAccountDb`] 经 `serde_json::to_vec_pretty` 明文落盘。文件名由
//!   petalfall-core 定，落盘类型却定义在这个包里，所以样本放在这里。
//!
//! 两份文件都没有自带的格式版本号，形状变化全靠这里的样本与数据格式号兜住，因此这里没有版本常量要登记。
//!
//! 样本把每个字段都填上非默认值，`Option` 一律填 `Some`，不管生产里这一类账户是否会留空：守的是落盘形状，
//! 不是业务规则。快照比对挂了，照失败信息里的规则判断；持久化枚举加了取值，下面对应的 match 先编译不过，
//! 补分支的同时把新取值加进旁边的全取值数组并放进样本。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use petalfall_release::data_format::DATA_FORMAT;

use crate::account::{
    Account, AccountCredentials, AccountDatabase, AccountStatus, AccountType, MicrosoftCredentials,
    SkinModel, SkinRef, YggdrasilCredentials,
};
use crate::offline_store::{OfflineAccountDb, OfflineEntry};

const CURRENT_DIR: &str = "current";

fn data_format_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("data-format")
}

/// 把序列化结果与 `current/` 下的样本逐字节比对；不一致时把判断规则与新内容一起打出来。
fn assert_matches_snapshot(disk_file: &str, sample_file: &str, serialized: &[u8]) {
    let path = data_format_dir().join(CURRENT_DIR).join(sample_file);
    let serialized = std::str::from_utf8(serialized).expect("serde_json 的输出必是 UTF-8");
    let expected = format!("{serialized}\n");
    let stored = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "读不到落盘文件 {disk_file} 的样本 {}：{err}\n按现在的类型序列化出的完整内容：\n{expected}",
            path.display()
        )
    });
    // 工作树开着 autocrlf，检出的样本是 CRLF；样本本身按 LF 生成。
    let stored = stored.replace("\r\n", "\n");
    if stored != expected {
        panic!(
            "落盘文件 {disk_file} 的形状变了：按现在的类型序列化出的内容与样本 {} 不一致。\n\
             数据格式号还是现在这个值的旧版本读到改动后写出的这个文件时，只要出现下面任一情况，就必须给数据格式号加一：\
             报错、拒绝，或把文件当作损坏改名留存、删除；读成别的意思并据此行事；\
             写坏或丢掉用户找不回来的信息（例如保存一次就把新字段里的凭据丢掉）。\
             持久化枚举新增取值属于这一类：这些枚举对未知取值没有容忍，旧版本整份读失败（凭据库会被改名留存）。\n\
             - 都不会（例如只加了带默认值、丢了也找得回的可选字段）：把下面的新内容存进上面这个样本文件。\n\
             - 会：先给数据格式号加一，把 current/ 整个复制成以旧号命名的目录冻结，再更新 current/；\
             判断规则与步骤见 docs/architecture.md 的「数据格式号」。\n\
             按现在的类型序列化出的完整内容：\n{expected}",
            path.display()
        );
    }
}

/// 账户类型的全部取值。
const ALL_ACCOUNT_TYPES: [AccountType; 3] = [
    AccountType::Microsoft,
    AccountType::Offline,
    AccountType::AuthlibInjector,
];

/// 不带通配分支：账户类型加了取值，这里编译不过。
fn account_type_tag(value: AccountType) -> &'static str {
    match value {
        AccountType::Microsoft => "microsoft",
        AccountType::Offline => "offline",
        AccountType::AuthlibInjector => "authlib_injector",
    }
}

/// 账户状态的全部取值。
const ALL_ACCOUNT_STATUSES: [AccountStatus; 2] = [AccountStatus::Ok, AccountStatus::Expired];

/// 不带通配分支：账户状态加了取值，这里编译不过。
fn account_status_tag(value: AccountStatus) -> &'static str {
    match value {
        AccountStatus::Ok => "ok",
        AccountStatus::Expired => "expired",
    }
}

/// 皮肤模型的全部取值。
const ALL_SKIN_MODELS: [SkinModel; 2] = [SkinModel::Wide, SkinModel::Slim];

/// 不带通配分支：皮肤模型加了取值，这里编译不过。
fn skin_model_tag(value: SkinModel) -> &'static str {
    match value {
        SkinModel::Wide => "wide",
        SkinModel::Slim => "slim",
    }
}

/// 凭据种类（`kind` 标签）的全部取值。
const ALL_CREDENTIAL_KINDS: [&str; 3] = ["microsoft", "offline", "authlib_injector"];

/// 不带通配分支：凭据种类加了取值，这里编译不过。
fn credentials_kind(value: &AccountCredentials) -> &'static str {
    match value {
        AccountCredentials::Microsoft(_) => "microsoft",
        AccountCredentials::Offline => "offline",
        AccountCredentials::AuthlibInjector(_) => "authlib_injector",
    }
}

/// `credentials.bin` 解密后的明文样本：三种凭据各一条，每个字段都填满。
fn credentials_sample() -> AccountDatabase {
    let microsoft = AccountCredentials::Microsoft(MicrosoftCredentials {
        refresh_token: "sample-refresh-token".to_owned(),
        minecraft_token: Some("sample-minecraft-token".to_owned()),
        minecraft_expires_at: Some(1_767_312_000),
    });
    let offline = AccountCredentials::Offline;
    let authlib_injector = AccountCredentials::AuthlibInjector(YggdrasilCredentials {
        api_root: "https://auth.example.invalid/api/yggdrasil/".to_owned(),
        access_token: "sample-access-token".to_owned(),
        client_token: "sample-client-token".to_owned(),
        username: Some("player@example.invalid".to_owned()),
    });
    AccountDatabase {
        accounts: vec![
            Account {
                uuid: "0f1e2d3c4b5a69788796a5b4c3d2e1f0".to_owned(),
                name: "MicrosoftSample".to_owned(),
                account_type: microsoft.account_type(),
                credentials: microsoft,
                added_at: 1_767_225_600_000,
                status: AccountStatus::Ok,
                last_verified_at: Some(1_767_229_200_000),
                auth_server: Some("Microsoft Sample".to_owned()),
                skin: Some(SkinRef {
                    url: "https://textures.example.invalid/texture/slim0001".to_owned(),
                    model: SkinModel::Slim,
                }),
                xuid: Some("2535400000000001".to_owned()),
            },
            Account {
                uuid: "11111111222233334444555555555555".to_owned(),
                name: "OfflineSample".to_owned(),
                account_type: offline.account_type(),
                credentials: offline,
                added_at: 1_767_232_800_000,
                status: AccountStatus::Ok,
                last_verified_at: Some(1_767_236_400_000),
                auth_server: Some("Offline Sample".to_owned()),
                skin: Some(SkinRef {
                    url: "https://textures.example.invalid/texture/wide0002".to_owned(),
                    model: SkinModel::Wide,
                }),
                xuid: Some("2535400000000002".to_owned()),
            },
            Account {
                uuid: "aaaabbbbccccddddeeeeffff00001111".to_owned(),
                name: "AuthlibSample".to_owned(),
                account_type: authlib_injector.account_type(),
                credentials: authlib_injector,
                added_at: 1_767_240_000_000,
                status: AccountStatus::Expired,
                last_verified_at: Some(1_767_243_600_000),
                auth_server: Some("Example Auth".to_owned()),
                skin: Some(SkinRef {
                    url: "https://textures.example.invalid/texture/wide0003".to_owned(),
                    model: SkinModel::Wide,
                }),
                xuid: Some("2535400000000003".to_owned()),
            },
        ],
        current: Some("0f1e2d3c4b5a69788796a5b4c3d2e1f0".to_owned()),
    }
}

/// `offline_accounts.json` 的样本：两条离线账户与当前选中项。
fn offline_accounts_sample() -> OfflineAccountDb {
    OfflineAccountDb {
        accounts: vec![
            OfflineEntry {
                name: "Steve".to_owned(),
                added_at: 1_767_225_600_000,
            },
            OfflineEntry {
                name: "Alex".to_owned(),
                added_at: 1_767_232_800_000,
            },
        ],
        current: Some("Alex".to_owned()),
    }
}

#[test]
fn credentials_plaintext_matches_snapshot() {
    // 与 AccountManager 落盘前的序列化一致：紧凑 JSON，随后才交给 DPAPI。
    let serialized = serde_json::to_vec(&credentials_sample()).expect("凭据库样本序列化");
    assert_matches_snapshot("credentials.bin", "credentials.bin.json", &serialized);
}

#[test]
fn offline_accounts_file_matches_snapshot() {
    // 与 OfflineAccountStore 落盘一致：pretty 明文。
    let serialized =
        serde_json::to_vec_pretty(&offline_accounts_sample()).expect("离线账户库样本序列化");
    assert_matches_snapshot(
        "offline_accounts.json",
        "offline_accounts.json",
        &serialized,
    );
}

#[test]
fn credentials_sample_covers_every_persisted_enum_value() {
    // 先确认每个标签就是该取值落盘时的拼写，且全取值数组里没有重复：样本覆盖了这些标签，
    // 才等于覆盖了每一种会写进文件的取值。
    for value in ALL_ACCOUNT_TYPES {
        assert_eq!(
            serde_json::to_value(value).expect("账户类型序列化"),
            serde_json::Value::String(account_type_tag(value).to_owned())
        );
    }
    for value in ALL_ACCOUNT_STATUSES {
        assert_eq!(
            serde_json::to_value(value).expect("账户状态序列化"),
            serde_json::Value::String(account_status_tag(value).to_owned())
        );
    }
    for value in ALL_SKIN_MODELS {
        assert_eq!(
            serde_json::to_value(value).expect("皮肤模型序列化"),
            serde_json::Value::String(skin_model_tag(value).to_owned())
        );
    }
    let all_types: BTreeSet<&str> = ALL_ACCOUNT_TYPES
        .into_iter()
        .map(account_type_tag)
        .collect();
    let all_statuses: BTreeSet<&str> = ALL_ACCOUNT_STATUSES
        .into_iter()
        .map(account_status_tag)
        .collect();
    let all_models: BTreeSet<&str> = ALL_SKIN_MODELS.into_iter().map(skin_model_tag).collect();
    let all_kinds: BTreeSet<&str> = ALL_CREDENTIAL_KINDS.into_iter().collect();
    assert_eq!(
        all_types.len(),
        ALL_ACCOUNT_TYPES.len(),
        "账户类型全取值数组有重复"
    );
    assert_eq!(
        all_statuses.len(),
        ALL_ACCOUNT_STATUSES.len(),
        "账户状态全取值数组有重复"
    );
    assert_eq!(
        all_models.len(),
        ALL_SKIN_MODELS.len(),
        "皮肤模型全取值数组有重复"
    );
    assert_eq!(
        all_kinds.len(),
        ALL_CREDENTIAL_KINDS.len(),
        "凭据种类全取值数组有重复"
    );

    let sample = credentials_sample();
    let mut types = BTreeSet::new();
    let mut statuses = BTreeSet::new();
    let mut models = BTreeSet::new();
    let mut kinds = BTreeSet::new();
    for account in &sample.accounts {
        types.insert(account_type_tag(account.account_type));
        statuses.insert(account_status_tag(account.status));
        let skin = account.skin.as_ref().expect("样本的每条账户都带皮肤");
        models.insert(skin_model_tag(skin.model));
        let kind = credentials_kind(&account.credentials);
        let written = serde_json::to_value(&account.credentials).expect("凭据序列化");
        assert_eq!(
            written["kind"],
            serde_json::Value::String(kind.to_owned()),
            "凭据种类的标签与落盘拼写不一致"
        );
        kinds.insert(kind);
    }
    assert_eq!(types, all_types, "凭据库样本没有覆盖账户类型的全部取值");
    assert_eq!(
        statuses, all_statuses,
        "凭据库样本没有覆盖账户状态的全部取值"
    );
    assert_eq!(models, all_models, "凭据库样本没有覆盖皮肤模型的全部取值");
    assert_eq!(kinds, all_kinds, "凭据库样本没有覆盖凭据种类的全部取值");
}

#[test]
fn frozen_snapshot_dirs_are_exactly_the_older_data_formats() {
    let root = data_format_dir();
    let entries = std::fs::read_dir(&root)
        .unwrap_or_else(|err| panic!("读不到快照目录 {}：{err}", root.display()));
    let mut actual = BTreeSet::new();
    for entry in entries {
        let entry = entry.unwrap_or_else(|err| panic!("列 {} 失败：{err}", root.display()));
        let file_type = entry
            .file_type()
            .unwrap_or_else(|err| panic!("读 {} 的类型失败：{err}", entry.path().display()));
        if !file_type.is_dir() {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .unwrap_or_else(|name| panic!("快照目录名不是 UTF-8：{name:?}"));
        if name != CURRENT_DIR {
            actual.insert(name);
        }
    }
    let expected: BTreeSet<String> = (1..DATA_FORMAT).map(|n| n.to_string()).collect();
    assert_eq!(
        actual,
        expected,
        "{} 下除 current 外的冻结目录必须恰好是 1 到 DATA_FORMAT - 1（现在 DATA_FORMAT = {DATA_FORMAT}）：\
         加数据格式号时把 current/ 复制成以旧号命名的目录冻结，号不能变小也不能跳号。期望 {expected:?}，实际 {actual:?}",
        root.display()
    );
}
