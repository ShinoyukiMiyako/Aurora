//! 落盘类型的快照守卫：改了写进实例目录的类型，却忘了判断要不要加数据格式号时，这里的测试会挂。
//!
//! 覆盖本 crate 写下的四种文件：实例设置 `settings.json`、未完成标记 `incomplete.json`、安装记录
//! `install-record.json`（三者在 `versions/<id>/.petalfall/` 下），以及存档备份清单 `index.json`（在
//! `<游戏目录>/.petalfall/backups/` 下每个存档的备份目录里）。每种文件在 `testdata/data-format/current/`
//! 下有一份同名样本：每个字段都填上（`Option` 都是 `Some`，集合不空），每个持久化枚举的每个取值都出现。
//! 一份文件只装得下某个枚举的一个取值时（设置里的卡面背景、标记里的操作类别），样本是若干份内容组成的
//! JSON 数组，每个元素都是这个文件完整的一份内容。
//!
//! 挂了怎么办：
//! - 快照比对挂了：落盘形状变了。旧版本还读得了的（例如只加了带默认值的可选字段），把失败信息里的新内容
//!   更新进 `current/`；旧版本读不了的，先把数据格式号加一、把 `current/` 冻结成旧号目录，再更新
//!   `current/`。判断规则与步骤见 docs/architecture.md 的「数据格式号」。
//! - 编译不过或取值数组的测试挂了：持久化枚举加了取值。补上 match 分支，把新取值按声明顺序加进旁边的数组，
//!   样本随之变化，再按上一条判断。
//! - 格式常量的测试挂了：自带格式版本的文件升了版本，按同一份规则判断数据格式号，再改登记值。
//! - 冻结目录的测试挂了：`testdata/data-format/` 下的号目录与数据格式号对不上。

use std::collections::BTreeSet;
use std::path::PathBuf;

use petalfall_release::data_format::DATA_FORMAT;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::isolation::IsolationOverride;
use crate::marker::{
    INSTALL_RECORD_FILE, IncompleteKind, IncompleteMarker, IncompleteOutcome, InstallSpec,
    MARKER_FILE, MarkerError,
};
use crate::settings::{
    CoverBackground, CoverImageSlot, JavaSelection, Resolution, SETTINGS_FILE, VersionSettings,
};
use crate::world_backup::{
    BACKUP_INDEX_FILE, BACKUP_INDEX_VERSION, BackupEntry, BackupIndex, BackupKind,
    write_backup_index,
};

/// `BACKUP_INDEX_VERSION` 的登记值：常量一改就与它对不上，逼改动的人同步判断数据格式号。
const REGISTERED_BACKUP_INDEX_VERSION: u32 = 1;

fn data_format_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("data-format")
}

/// 把生产代码写出的字节与 `current/<file_name>` 比对；不一致时把新内容整份打在信息里。
fn assert_matches_snapshot(file_name: &str, written: &[u8]) {
    let path = data_format_dir().join("current").join(file_name);
    let written = std::str::from_utf8(written)
        .unwrap_or_else(|err| panic!("{file_name} 序列化出的内容不是 UTF-8：{err}"));
    let expected = format!("{written}\n");
    // 工作树开着 autocrlf，检出的样本是 CRLF 行尾。
    let snapshot = match std::fs::read_to_string(&path) {
        Ok(text) => Some(text.replace("\r\n", "\n")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => panic!("读不了快照样本 {}：{err}", path.display()),
    };
    let difference = match &snapshot {
        Some(text) if *text == expected => return,
        Some(_) => format!("与样本 {} 不一致", path.display()),
        None => format!("样本 {} 不存在（落盘文件改了名也算）", path.display()),
    };
    panic!(
        "落盘文件 {file_name} 的形状变了：{difference}。\n\
         旧版本还读得了的（例如只加了带默认值的可选字段），把下面的新内容更新进 current/；\n\
         旧版本读不了的，先把数据格式号加一、把 current/ 冻结成旧号目录，再更新 current/。\n\
         判断规则与步骤见 docs/architecture.md 的「数据格式号」。\n\
         ----- {file_name} 新内容开始 -----\n\
         {expected}\
         ----- {file_name} 新内容结束 -----"
    );
}

/// 与 save 一致的序列化方式。
fn pretty<T: Serialize + ?Sized>(value: &T) -> Vec<u8> {
    serde_json::to_vec_pretty(value).expect("样本能序列化")
}

/// serde 为枚举声明的全部取值（落盘拼写，按声明顺序）。遇到不认识的取值时 serde 的报错会把全部取值列出来
/// （serde_core 的 `de::Error::unknown_variant`），借它拿到枚举自己的取值表，与手写的数组对照。
fn declared_variants<T: DeserializeOwned + std::fmt::Debug>(
    unknown: serde_json::Value,
) -> Vec<String> {
    let message = serde_json::from_value::<T>(unknown)
        .expect_err("空字符串不是任何取值")
        .to_string();
    let (_, listed) = message
        .split_once(", expected ")
        .unwrap_or_else(|| panic!("serde 的报错里没有取值表：{message}"));
    listed
        .split('`')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

// ---- 持久化枚举的全部取值 ----
//
// 每个 match 都不带通配分支：枚举加了取值，这里先编译不过。补分支时把新取值按声明顺序加进旁边的数组，
// 样本就会带上它，快照比对随之提醒判断数据格式号。

const COVER_BACKGROUNDS: [CoverBackground; 4] = [
    CoverBackground::Follow,
    CoverBackground::Art,
    CoverBackground::Texture,
    CoverBackground::Image,
];

fn cover_background_spelling(value: CoverBackground) -> &'static str {
    match value {
        CoverBackground::Follow => "follow",
        CoverBackground::Art => "art",
        CoverBackground::Texture => "texture",
        CoverBackground::Image => "image",
    }
}

const ISOLATION_OVERRIDES: [IsolationOverride; 3] = [
    IsolationOverride::FollowGlobal,
    IsolationOverride::Enabled,
    IsolationOverride::Disabled,
];

fn isolation_override_spelling(value: IsolationOverride) -> &'static str {
    match value {
        IsolationOverride::FollowGlobal => "follow_global",
        IsolationOverride::Enabled => "enabled",
        IsolationOverride::Disabled => "disabled",
    }
}

/// 路径用正斜杠：反斜杠的 Windows 路径在不同平台上序列化出的样子不一样。
fn java_selections() -> [JavaSelection; 2] {
    [
        JavaSelection::Auto,
        JavaSelection::Path(PathBuf::from("C:/Java/jdk-21/bin/javaw.exe")),
    ]
}

/// JavaSelection 的 serde 是手写的（路径本身就是取值），没有能对照的取值表，数组列没列全只靠这个 match
/// 在编译期把关。
fn java_selection_label(value: &JavaSelection) -> &'static str {
    match value {
        JavaSelection::Auto => "auto",
        JavaSelection::Path(_) => "path",
    }
}

fn incomplete_kinds() -> [IncompleteKind; 3] {
    [
        IncompleteKind::Install {
            spec: install_spec_sample(),
        },
        IncompleteKind::Repair,
        IncompleteKind::Modpack {
            task_id: "modpack-7".into(),
        },
    ]
}

fn incomplete_kind_spelling(value: &IncompleteKind) -> &'static str {
    match value {
        IncompleteKind::Install { .. } => "install",
        IncompleteKind::Repair => "repair",
        IncompleteKind::Modpack { .. } => "modpack",
    }
}

const INCOMPLETE_OUTCOMES: [IncompleteOutcome; 3] = [
    IncompleteOutcome::Pending,
    IncompleteOutcome::Failed,
    IncompleteOutcome::Cancelled,
];

fn incomplete_outcome_spelling(value: IncompleteOutcome) -> &'static str {
    match value {
        IncompleteOutcome::Pending => "pending",
        IncompleteOutcome::Failed => "failed",
        IncompleteOutcome::Cancelled => "cancelled",
    }
}

const BACKUP_KINDS: [BackupKind; 2] = [BackupKind::Auto, BackupKind::Manual];

fn backup_kind_spelling(value: BackupKind) -> &'static str {
    match value {
        BackupKind::Auto => "auto",
        BackupKind::Manual => "manual",
    }
}

// ---- 样本 ----
//
// 一份文件装不下全部取值时，份数取各枚举取值数的最大值，第 i 份用每个枚举的第 i 个取值（不够就从头轮转），
// 每个取值至少出现一次。

fn settings_samples() -> Vec<VersionSettings> {
    let javas = java_selections();
    let count = COVER_BACKGROUNDS
        .len()
        .max(ISOLATION_OVERRIDES.len())
        .max(javas.len());
    // 图片文件名用生产代码的拼法生成：拼法一变，旧设置里的文件名就对不上，快照也跟着变。
    let cover_image = CoverImageSlot::Block
        .file_name("0123456789abcdef", "png")
        .expect("方块图片收 png");
    let background_image = CoverImageSlot::Background
        .file_name("fedcba9876543210", "jpg")
        .expect("背景图片收 jpg");
    (0..count)
        .map(|i| VersionSettings {
            description: Some("樱花林里的生存档".into()),
            cover: Some("cherry_planks".into()),
            cover_image: Some(cover_image.clone()),
            background: COVER_BACKGROUNDS[i % COVER_BACKGROUNDS.len()],
            background_image: Some(background_image.clone()),
            isolation: ISOLATION_OVERRIDES[i % ISOLATION_OVERRIDES.len()],
            memory_mb: Some(6144),
            java: javas[i % javas.len()].clone(),
            jvm_args: "-XX:+UseG1GC -Dfile.encoding=UTF-8".into(),
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
            fullscreen: true,
        })
        .collect()
}

fn install_spec_sample() -> InstallSpec {
    InstallSpec {
        mc_version: "1.21.1".into(),
        loader: Some("fabric".into()),
        loader_version: Some("0.16.10".into()),
        use_template: true,
    }
}

fn marker_samples() -> Vec<IncompleteMarker> {
    let kinds = incomplete_kinds();
    let count = kinds.len().max(INCOMPLETE_OUTCOMES.len());
    (0..count)
        .map(|i| IncompleteMarker {
            kind: kinds[i % kinds.len()].clone(),
            outcome: INCOMPLETE_OUTCOMES[i % INCOMPLETE_OUTCOMES.len()],
            started_at: 1_700_000_000_000 + i as u64,
            error: Some(MarkerError {
                code: "download_failed".into(),
                message: "补全本体与库 阶段有 1/3 个文件下载失败".into(),
            }),
        })
        .collect()
}

fn backup_index_sample() -> BackupIndex {
    BackupIndex {
        version: BACKUP_INDEX_VERSION,
        entries: BACKUP_KINDS
            .iter()
            .enumerate()
            .map(|(i, &kind)| {
                let created_at = 1_700_000_000_000 + i as u64;
                BackupEntry {
                    // 文件名用生产代码的拼法生成，理由同卡面图片。
                    file: kind.file_name(created_at),
                    kind,
                    created_at,
                    size_bytes: 4096 * (i as u64 + 1),
                    level_name: Some("樱花林".into()),
                }
            })
            .collect(),
    }
}

// ---- 测试 ----

#[test]
fn settings_json_matches_snapshot() {
    assert_matches_snapshot(SETTINGS_FILE, &pretty(&settings_samples()));
}

#[test]
fn incomplete_json_matches_snapshot() {
    assert_matches_snapshot(MARKER_FILE, &pretty(&marker_samples()));
}

#[test]
fn install_record_json_matches_snapshot() {
    assert_matches_snapshot(INSTALL_RECORD_FILE, &pretty(&install_spec_sample()));
}

#[tokio::test]
async fn backup_index_json_matches_snapshot() {
    // 清单由 write_backup_index 里的一个局部结构写出，不是直接序列化 BackupIndex；走真正的写函数，
    // 那个结构变了这里才看得见。
    let dir = tempfile::tempdir().expect("建临时目录");
    write_backup_index(dir.path(), &backup_index_sample())
        .await
        .expect("写备份清单");
    let written = std::fs::read(dir.path().join(BACKUP_INDEX_FILE)).expect("读回备份清单");
    assert_matches_snapshot(BACKUP_INDEX_FILE, &written);
}

#[test]
fn persisted_enum_arrays_cover_every_variant() {
    fn check(enum_name: &str, listed: Vec<&str>, declared: Vec<String>) {
        assert_eq!(
            listed, declared,
            "{enum_name} 的取值数组与枚举声明的取值对不上：加了取值就补上 match 分支、按声明顺序加进数组，\
             样本随之变化，再按快照比对的提示判断数据格式号"
        );
    }
    check(
        "CoverBackground",
        COVER_BACKGROUNDS.map(cover_background_spelling).to_vec(),
        declared_variants::<CoverBackground>(json!("")),
    );
    check(
        "IsolationOverride",
        ISOLATION_OVERRIDES
            .map(isolation_override_spelling)
            .to_vec(),
        declared_variants::<IsolationOverride>(json!("")),
    );
    check(
        "IncompleteKind",
        incomplete_kinds()
            .iter()
            .map(incomplete_kind_spelling)
            .collect(),
        declared_variants::<IncompleteKind>(json!({ "kind": "" })),
    );
    check(
        "IncompleteOutcome",
        INCOMPLETE_OUTCOMES
            .map(incomplete_outcome_spelling)
            .to_vec(),
        declared_variants::<IncompleteOutcome>(json!("")),
    );
    check(
        "BackupKind",
        BACKUP_KINDS.map(backup_kind_spelling).to_vec(),
        declared_variants::<BackupKind>(json!("")),
    );
    assert_eq!(
        java_selections()
            .iter()
            .map(java_selection_label)
            .collect::<Vec<_>>(),
        ["auto", "path"],
        "JavaSelection 的取值数组应当每种取值各一份"
    );
}

#[test]
fn backup_index_version_matches_registered_value() {
    assert_eq!(
        BACKUP_INDEX_VERSION, REGISTERED_BACKUP_INDEX_VERSION,
        "BACKUP_INDEX_VERSION 变了：自带格式版本的文件升版本，按 docs/architecture.md 的「数据格式号」\
         判断数据格式号要不要加一，处理完再把这里的登记值改成新值"
    );
}

#[test]
fn frozen_snapshot_dirs_match_data_format() {
    let root = data_format_dir();
    let mut frozen = BTreeSet::new();
    for entry in std::fs::read_dir(&root)
        .unwrap_or_else(|err| panic!("读不了快照目录 {}：{err}", root.display()))
    {
        let entry = entry.unwrap_or_else(|err| panic!("读不了快照目录 {}：{err}", root.display()));
        let is_dir = entry
            .file_type()
            .unwrap_or_else(|err| panic!("读不了 {} 的类型：{err}", entry.path().display()))
            .is_dir();
        if !is_dir {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .unwrap_or_else(|raw| panic!("快照目录名不是合法的 Unicode：{raw:?}"));
        if name != "current" {
            frozen.insert(name);
        }
    }
    let expected: BTreeSet<String> = (1..DATA_FORMAT).map(|n| n.to_string()).collect();
    assert_eq!(
        frozen,
        expected,
        "{} 下除 current 之外的冻结快照目录应恰好是 1 到 DATA_FORMAT - 1（DATA_FORMAT = {DATA_FORMAT}）：\
         加号时把 current/ 复制成旧号目录，号不能跳也不能少",
        root.display()
    );
}
