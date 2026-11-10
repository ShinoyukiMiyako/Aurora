//! 落盘类型的快照守卫：改了写进数据目录或游戏目录的类型，却忘了判断要不要加数据格式号时，这里的测试会挂。
//!
//! 覆盖本 crate 写下的十种文件，每种在 `testdata/data-format/current/` 下有一份样本：
//! - 数据目录：全局配置 `config.json`、游玩记录 `playtime.json`、运行中游戏的记录 `running-game.json`、
//!   模板元数据 `templates/default/template.json`、移动日志 `moves/<token>.json`（文件名随每次移动变，样本叫
//!   `move-journal.json`）。
//! - 游戏目录：依赖版本记录 `.petalfall/base-versions.json`；每个实例 `versions/<id>/.petalfall/` 下的最近一次
//!   崩溃报告 `last-crash.json`、整合包信息 `modpack.json`、来源卷宗 `ledger.json`、变更历史 `history.json`。
//!
//! 离线账户文件 `offline_accounts.json` 的文件名由本 crate 定，落盘类型与序列化却在 petalfall-auth，样本登记在
//! 那边的快照守卫里，这里不重复。
//!
//! 样本把每个字段都填上非默认值（`Option` 都是 `Some`，集合不空，config.json 的保留区放一个不认识的键），每个
//! 持久化枚举的每个取值都出现：守的是落盘形状，不是业务规则。样本一律用结构体字面量写全字段，类型加了字段这里
//! 先编译不过。能走生产代码的写函数的就写进临时目录再读回比对，写盘方式一变快照也跟着变；整合包信息的写盘在
//! 导入流程中间够不着，按它的写法（pretty）直接序列化。
//!
//! 一份文件只装得下某个枚举的一个取值时（配置里的各个设置项、运行记录的账户类型、移动日志的阶段、整合包信息的
//! 格式与加载器），样本是若干份完整内容组成的 JSON 数组：每份按生产代码写出后逐行缩进两格、以逗号隔开包进方括号，
//! 与把这些内容当作数组整体 pretty 序列化的结果逐字节相同。
//!
//! 挂了怎么办：
//! - 快照比对挂了：落盘形状变了，按失败信息里的规则判断要不要加数据格式号。
//! - 编译不过或取值数组的测试挂了：持久化枚举加了取值。补上 match 分支，把新取值按声明顺序加进旁边的数组，
//!   样本随之变化，再按上一条判断。
//! - 格式常量的测试挂了：自带格式版本的文件升了版本，旧版本会拒读，按同一份规则加号，再改登记值。
//! - 冻结目录的测试挂了：`testdata/data-format/` 下的号目录与数据格式号对不上。
//!
//! 新增一种落盘文件时这里抓不到，要自己在这里加上它的样本。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use petalfall_auth::AccountType;
use petalfall_instance::{IsolationPolicy, PETALFALL_META_DIR};
use petalfall_launch::{CrashCategory, ExitCodeKind, ExitCodeNote, ProcessIdentity};
use petalfall_modpack::{PackFormat, PackLoader, PackLoaderKind};
use petalfall_modplatform::Platform;
use petalfall_release::data_format::DATA_FORMAT;
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::appearance::{AccentColor, Appearance, AppearanceMode, CoverStyle};
use crate::config::{
    AfterLaunch, CarriedOver, ConfigStore, DownloadSourcePolicy, MemorySettings, NamedDirectory,
    ParkedDirectory, PetalfallConfig, PinnedServer, UiLanguage, WorldBackupSettings,
};
use crate::crashdiag::{
    CRASH_REPORT_FILE, CRASH_REPORT_FORMAT, CrashClue, CrashReport, CrashSource, CrashSuspect,
    ScannedFile, save_crash_report,
};
use crate::facade::Petalfall;
use crate::history::{HistoryEvent, HistoryStore};
use crate::instances::record_base_versions_in;
use crate::launch::LaunchWarning;
use crate::ledger::{Ledger, LedgerEntry, LedgerStore, UpdateHold};
use crate::modpack::{InstanceModpack, MODPACK_INFO_SCHEMA};
use crate::move_journal::{MoveJournal, MoveStage};
use crate::playtime::{
    DayRecord, DirectoryBook, InstanceRecord, PLAYTIME_FILE, PLAYTIME_FORMAT, PlayBook, PlayLibrary,
};
use crate::reattach::{RECORD_FORMAT, RecordAccount, RunningRecord};
use crate::session::JavaUsed;
use crate::template::{TEMPLATE_META_FILE, TemplateMeta, fill_staging};

/// 自带格式版本的常量与登记值：常量一改就与登记值对不上，逼改动的人同步判断数据格式号。
const REGISTERED_FORMATS: [(&str, u32, u32); 4] = [
    ("PLAYTIME_FORMAT", PLAYTIME_FORMAT, 2),
    ("RECORD_FORMAT", RECORD_FORMAT, 1),
    ("CRASH_REPORT_FORMAT", CRASH_REPORT_FORMAT, 2),
    ("MODPACK_INFO_SCHEMA", MODPACK_INFO_SCHEMA, 1),
];

/// 样本里的路径一律用正斜杠：反斜杠的 Windows 路径在不同平台上序列化出的样子不一样。
const GAME_DIR: &str = "D:/Games/.minecraft";
const INSTANCE_ID: &str = "1.21.1-Fabric";
const INSTANCE_DIR: &str = "D:/Games/.minecraft/versions/1.21.1-Fabric";
const JAVA_PATH: &str = "C:/Java/jdk-21/bin/javaw.exe";

fn data_format_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("data-format")
}

/// 把写出的字节与 `current/<sample_file>` 比对；不一致时把判断规则与新内容整份打在信息里。
fn assert_matches_snapshot(disk_file: &str, sample_file: &str, written: &[u8]) {
    let path = data_format_dir().join("current").join(sample_file);
    let written = std::str::from_utf8(written)
        .unwrap_or_else(|err| panic!("{disk_file} 写出的内容不是 UTF-8：{err}"));
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
        "落盘文件 {disk_file} 的形状变了：{difference}。\n\
         数据格式号还是现在这个值的旧版本读到改动后写出的这个文件时，只要出现下面任一情况，就必须给数据格式号加一：\
         报错、拒绝，或把文件当作损坏改名留存、删除；读成别的意思并据此行事；写坏或丢掉用户找不回来的信息\
         （除 config.json 外，多数文件保存一次就丢掉不认识的字段）。持久化枚举新增取值、自带格式版本升版本都属于这一类，\
         只有 config.json 里登记了字段级容忍的枚举例外。\n\
         - 都不会（例如只加了带默认值、丢了也能再设一次的设置项）：把下面的新内容存进上面这个样本文件。\n\
         - 会：先给数据格式号加一，把 current/ 整个复制成以旧号命名的目录冻结，再更新 current/。\n\
         判断规则与步骤见 docs/architecture.md 的「数据格式号」。\n\
         ----- {sample_file} 新内容开始 -----\n\
         {expected}\
         ----- {sample_file} 新内容结束 -----"
    );
}

fn read_written(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|err| panic!("读不回写出的 {}：{err}", path.display()))
}

/// 把若干份完整的落盘内容拼成 JSON 数组文本：每行缩进两格、份与份之间用逗号隔开。各份都是 pretty 写法时，
/// 结果与把它们当作数组整体 pretty 序列化逐字节相同。
fn json_array(documents: &[Vec<u8>]) -> Vec<u8> {
    let parts: Vec<String> = documents
        .iter()
        .map(|document| {
            std::str::from_utf8(document)
                .expect("serde_json 的输出必是 UTF-8")
                .lines()
                .map(|line| format!("  {line}"))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect();
    format!("[\n{}\n]", parts.join(",\n")).into_bytes()
}

/// 一份文件装不下全部取值时，第 i 份用每个枚举的第 i 个取值，不够就从头轮转。
fn pick<T: Copy>(values: &[T], i: usize) -> T {
    values[i % values.len()]
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

const DOWNLOAD_SOURCE_POLICIES: [DownloadSourcePolicy; 3] = [
    DownloadSourcePolicy::Auto,
    DownloadSourcePolicy::OfficialFirst,
    DownloadSourcePolicy::MirrorFirst,
];

fn download_source_policy_spelling(value: DownloadSourcePolicy) -> &'static str {
    match value {
        DownloadSourcePolicy::Auto => "auto",
        DownloadSourcePolicy::OfficialFirst => "official_first",
        DownloadSourcePolicy::MirrorFirst => "mirror_first",
    }
}

const ISOLATION_POLICIES: [IsolationPolicy; 5] = [
    IsolationPolicy::Disabled,
    IsolationPolicy::ModLoadersOnly,
    IsolationPolicy::NonReleaseOnly,
    IsolationPolicy::ModLoadersAndNonRelease,
    IsolationPolicy::All,
];

fn isolation_policy_spelling(value: IsolationPolicy) -> &'static str {
    match value {
        IsolationPolicy::Disabled => "disabled",
        IsolationPolicy::ModLoadersOnly => "mod_loaders_only",
        IsolationPolicy::NonReleaseOnly => "non_release_only",
        IsolationPolicy::ModLoadersAndNonRelease => "mod_loaders_and_non_release",
        IsolationPolicy::All => "all",
    }
}

const APPEARANCE_MODES: [AppearanceMode; 2] = [AppearanceMode::Day, AppearanceMode::Night];

fn appearance_mode_spelling(value: AppearanceMode) -> &'static str {
    match value {
        AppearanceMode::Day => "day",
        AppearanceMode::Night => "night",
    }
}

const ACCENT_COLORS: [AccentColor; 3] = [
    AccentColor::Sakura,
    AccentColor::Amethyst,
    AccentColor::Moss,
];

fn accent_color_spelling(value: AccentColor) -> &'static str {
    match value {
        AccentColor::Sakura => "sakura",
        AccentColor::Amethyst => "amethyst",
        AccentColor::Moss => "moss",
    }
}

const COVER_STYLES: [CoverStyle; 2] = [CoverStyle::Art, CoverStyle::Texture];

fn cover_style_spelling(value: CoverStyle) -> &'static str {
    match value {
        CoverStyle::Art => "art",
        CoverStyle::Texture => "texture",
    }
}

const AFTER_LAUNCHES: [AfterLaunch; 3] =
    [AfterLaunch::Keep, AfterLaunch::Minimize, AfterLaunch::Close];

fn after_launch_spelling(value: AfterLaunch) -> &'static str {
    match value {
        AfterLaunch::Keep => "keep",
        AfterLaunch::Minimize => "minimize",
        AfterLaunch::Close => "close",
    }
}

const UI_LANGUAGES: [UiLanguage; 2] = [UiLanguage::ZhCn, UiLanguage::EnUs];

fn ui_language_spelling(value: UiLanguage) -> &'static str {
    match value {
        UiLanguage::ZhCn => "zh-CN",
        UiLanguage::EnUs => "en-US",
    }
}

const ACCOUNT_TYPES: [AccountType; 3] = [
    AccountType::Microsoft,
    AccountType::Offline,
    AccountType::AuthlibInjector,
];

fn account_type_spelling(value: AccountType) -> &'static str {
    match value {
        AccountType::Microsoft => "microsoft",
        AccountType::Offline => "offline",
        AccountType::AuthlibInjector => "authlib_injector",
    }
}

const LAUNCH_WARNINGS: [LaunchWarning; 8] = [
    LaunchWarning::GamePath,
    LaunchWarning::InstanceName,
    LaunchWarning::OnedriveFolder,
    LaunchWarning::IcloudFolder,
    LaunchWarning::LongPlayerName,
    LaunchWarning::JvmMemoryUnit,
    LaunchWarning::JvmMinOverMax,
    LaunchWarning::JvmMaxTooLow,
];

fn launch_warning_spelling(value: LaunchWarning) -> &'static str {
    match value {
        LaunchWarning::GamePath => "game_path",
        LaunchWarning::InstanceName => "instance_name",
        LaunchWarning::OnedriveFolder => "onedrive_folder",
        LaunchWarning::IcloudFolder => "icloud_folder",
        LaunchWarning::LongPlayerName => "long_player_name",
        LaunchWarning::JvmMemoryUnit => "jvm_memory_unit",
        LaunchWarning::JvmMinOverMax => "jvm_min_over_max",
        LaunchWarning::JvmMaxTooLow => "jvm_max_too_low",
    }
}

const CRASH_CATEGORIES: [CrashCategory; 17] = [
    CrashCategory::ManualDebugCrash,
    CrashCategory::JavaVersionMismatch,
    CrashCategory::OutOfMemory,
    CrashCategory::JvmArgsInvalid,
    CrashCategory::MissingLanguageProvider,
    CrashCategory::GameVersionMismatch,
    CrashCategory::DependencyVersionMismatch,
    CrashCategory::MissingDependency,
    CrashCategory::OptifineIncompatible,
    CrashCategory::MixinFailure,
    CrashCategory::DuplicateMod,
    CrashCategory::NativeLibraryMissing,
    CrashCategory::IntelGraphicsDriver,
    CrashCategory::GraphicsDriver,
    CrashCategory::CorruptedJar,
    CrashCategory::LoopbackUnavailable,
    CrashCategory::NativeCrash,
];

fn crash_category_spelling(value: CrashCategory) -> &'static str {
    match value {
        CrashCategory::ManualDebugCrash => "manual_debug_crash",
        CrashCategory::JavaVersionMismatch => "java_version_mismatch",
        CrashCategory::OutOfMemory => "out_of_memory",
        CrashCategory::JvmArgsInvalid => "jvm_args_invalid",
        CrashCategory::MissingLanguageProvider => "missing_language_provider",
        CrashCategory::GameVersionMismatch => "game_version_mismatch",
        CrashCategory::DependencyVersionMismatch => "dependency_version_mismatch",
        CrashCategory::MissingDependency => "missing_dependency",
        CrashCategory::OptifineIncompatible => "optifine_incompatible",
        CrashCategory::MixinFailure => "mixin_failure",
        CrashCategory::DuplicateMod => "duplicate_mod",
        CrashCategory::NativeLibraryMissing => "native_library_missing",
        CrashCategory::IntelGraphicsDriver => "intel_graphics_driver",
        CrashCategory::GraphicsDriver => "graphics_driver",
        CrashCategory::CorruptedJar => "corrupted_jar",
        CrashCategory::LoopbackUnavailable => "loopback_unavailable",
        CrashCategory::NativeCrash => "native_crash",
    }
}

const CRASH_SOURCES: [CrashSource; 4] = [
    CrashSource::SessionLog,
    CrashSource::CrashReport,
    CrashSource::HsErr,
    CrashSource::ExitCode,
];

fn crash_source_spelling(value: CrashSource) -> &'static str {
    match value {
        CrashSource::SessionLog => "session_log",
        CrashSource::CrashReport => "crash_report",
        CrashSource::HsErr => "hs_err",
        CrashSource::ExitCode => "exit_code",
    }
}

const MOVE_STAGES: [MoveStage; 4] = [
    MoveStage::Copying,
    MoveStage::Committing,
    MoveStage::Committed,
    MoveStage::Settled,
];

fn move_stage_spelling(value: MoveStage) -> &'static str {
    match value {
        MoveStage::Copying => "copying",
        MoveStage::Committing => "committing",
        MoveStage::Committed => "committed",
        MoveStage::Settled => "settled",
    }
}

const PACK_FORMATS: [PackFormat; 2] = [PackFormat::Modrinth, PackFormat::CurseForge];

fn pack_format_spelling(value: PackFormat) -> &'static str {
    match value {
        PackFormat::Modrinth => "modrinth",
        PackFormat::CurseForge => "curseforge",
    }
}

/// 卷宗与整合包信息里的来源平台。卷宗对未知平台没有容忍，旧版本读到新取值整份失败。
const PLATFORMS: [Platform; 2] = [Platform::Modrinth, Platform::CurseForge];

fn platform_spelling(value: Platform) -> &'static str {
    match value {
        Platform::Modrinth => "modrinth",
        Platform::CurseForge => "curseforge",
    }
}

const PACK_LOADER_KINDS: [PackLoaderKind; 4] = [
    PackLoaderKind::Fabric,
    PackLoaderKind::Quilt,
    PackLoaderKind::Forge,
    PackLoaderKind::NeoForge,
];

fn pack_loader_kind_spelling(value: PackLoaderKind) -> &'static str {
    match value {
        PackLoaderKind::Fabric => "fabric",
        PackLoaderKind::Quilt => "quilt",
        PackLoaderKind::Forge => "forge",
        PackLoaderKind::NeoForge => "neoforge",
    }
}

fn update_holds() -> [UpdateHold; 2] {
    [
        UpdateHold::Ignored,
        UpdateHold::Pinned {
            version_id: "mc1.21.1-0.6.0".into(),
        },
    ]
}

fn update_hold_spelling(value: &UpdateHold) -> &'static str {
    match value {
        UpdateHold::Ignored => "ignored",
        UpdateHold::Pinned { .. } => "pinned",
    }
}

fn history_events() -> [HistoryEvent; 4] {
    [
        HistoryEvent::Install {
            id: "1767225600-001".into(),
            at: 1_767_225_600,
            files: vec![
                "sodium-fabric-0.5.13.jar".into(),
                "fabric-api-0.110.0.jar".into(),
            ],
        },
        HistoryEvent::Update {
            id: "1767229200-001".into(),
            at: 1_767_229_200,
            file_name: "sodium-fabric-0.6.0.jar".into(),
            old_file: "sodium-fabric-0.5.13.jar".into(),
            backup_file: Some("sodium-fabric-0.5.13.jar.1.old".into()),
            from_version: "mc1.21.1-0.5.13".into(),
            to_version: "mc1.21.1-0.6.0".into(),
            title: Some("Sodium".into()),
            from_version_number: Some("0.5.13".into()),
            to_version_number: Some("0.6.0".into()),
        },
        HistoryEvent::Rollback {
            id: "1767232800-001".into(),
            at: 1_767_232_800,
            reverted_event: "1767229200-001".into(),
        },
        HistoryEvent::Remove {
            id: "1767236400-001".into(),
            at: 1_767_236_400,
            files: vec!["fabric-api-0.110.0.jar.disabled".into()],
        },
    ]
}

fn history_event_spelling(value: &HistoryEvent) -> &'static str {
    match value {
        HistoryEvent::Install { .. } => "install",
        HistoryEvent::Update { .. } => "update",
        HistoryEvent::Rollback { .. } => "rollback",
        HistoryEvent::Remove { .. } => "remove",
    }
}

// ---- 样本 ----

fn config_samples() -> Vec<PetalfallConfig> {
    let count = [
        DOWNLOAD_SOURCE_POLICIES.len(),
        ISOLATION_POLICIES.len(),
        APPEARANCE_MODES.len(),
        ACCENT_COLORS.len(),
        COVER_STYLES.len(),
        AFTER_LAUNCHES.len(),
        UI_LANGUAGES.len(),
    ]
    .into_iter()
    .max()
    .expect("取值数组不空");
    let mut unrecognized = serde_json::Map::new();
    unrecognized.insert(
        "future_setting".into(),
        json!({ "enabled": true, "level": 3 }),
    );
    (0..count)
        .map(|i| PetalfallConfig {
            download_source: pick(&DOWNLOAD_SOURCE_POLICIES, i),
            version_list_source: pick(&DOWNLOAD_SOURCE_POLICIES, i + 1),
            download_concurrency: 32,
            memory: MemorySettings {
                max_mb: 6144,
                min_mb: Some(1024),
                auto: false,
            },
            isolation_policy: pick(&ISOLATION_POLICIES, i),
            msa_client_id: Some("11111111-2222-3333-4444-555555555555".into()),
            game_directory: Some(PathBuf::from(GAME_DIR)),
            selected_version: Some(INSTANCE_ID.into()),
            cache_directory: Some(PathBuf::from("D:/PetalfallCache")),
            auto_download_java: false,
            appearance: Appearance {
                mode: pick(&APPEARANCE_MODES, i),
                accent: pick(&ACCENT_COLORS, i),
                petals: false,
                panorama: true,
                reduce_motion: true,
                cover_background: pick(&COVER_STYLES, i),
            },
            sidebar_pins: vec![INSTANCE_ID.into(), "樱花生存".into()],
            after_launch: pick(&AFTER_LAUNCHES, i),
            check_updates: false,
            default_java: Some(PathBuf::from(JAVA_PATH)),
            pinned_servers: vec![PinnedServer {
                name: "樱花服务器".into(),
                address: "mc.example.invalid:25565".into(),
                instance: Some(INSTANCE_ID.into()),
            }],
            extra_game_directories: vec![NamedDirectory {
                name: "PCL2".into(),
                path: PathBuf::from("E:/PCL2/.minecraft"),
            }],
            parked_directories: vec![ParkedDirectory {
                path: PathBuf::from("F:/Old/.minecraft"),
                sidebar_pins: vec!["1.20.1-Forge".into()],
                selected_version: Some("1.20.1-Forge".into()),
            }],
            first_run_completed: true,
            skipped_update_version: Some("1.0.0-beta.3".into()),
            notified_update_version: Some("1.0.0-beta.4".into()),
            update_channel: Some(json!("beta")),
            seen_update_versions: Some(json!({
                "beta": {
                    "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IGJldGE=",
                    "version": "1.0.0-beta.4"
                },
                "dev": {
                    "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IGRldg==",
                    "version": "1.0.0-dev.41"
                }
            })),
            language: pick(&UI_LANGUAGES, i),
            extra_java_paths: vec![PathBuf::from("C:/Java/jdk-17/bin/java.exe")],
            prefer_dedicated_gpu: true,
            skip_accessibility_onboarding: false,
            new_instance_template: false,
            world_backup: WorldBackupSettings {
                auto: false,
                keep_per_world: 8,
                max_total_gb: 50,
            },
            unrecognized: unrecognized.clone(),
            // 不参与序列化：只由 ConfigStore 读入时收下各段不认识的键、落盘时写回，填不进样本。
            carried_over: CarriedOver::default(),
        })
        .collect()
}

fn playtime_sample() -> PlayLibrary {
    PlayLibrary {
        directories: vec![DirectoryBook {
            game_dir: PathBuf::from(GAME_DIR),
            book: PlayBook {
                instances: BTreeMap::from([(
                    INSTANCE_ID.to_owned(),
                    InstanceRecord {
                        total_ms: 7_200_000,
                        last_played_at: 1_767_229_200_000,
                    },
                )]),
                days: BTreeMap::from([(
                    "2026-01-01".to_owned(),
                    DayRecord {
                        instances: BTreeMap::from([(INSTANCE_ID.to_owned(), 3_600_000)]),
                    },
                )]),
            },
        }],
    }
}

fn java_used_sample() -> JavaUsed {
    JavaUsed {
        major: 21,
        path: JAVA_PATH.into(),
        is_64bit: true,
    }
}

fn running_record_samples() -> Vec<RunningRecord> {
    ACCOUNT_TYPES
        .iter()
        .map(|&account_type| RunningRecord {
            format: RECORD_FORMAT,
            process: ProcessIdentity {
                pid: 4242,
                created: 133_000_000_000_000_000,
                exe: PathBuf::from(JAVA_PATH),
            },
            instance_id: INSTANCE_ID.into(),
            game_dir: PathBuf::from(GAME_DIR),
            version_dir: PathBuf::from(INSTANCE_DIR),
            working_dir: PathBuf::from(INSTANCE_DIR),
            session_started_at: 1_767_225_600_000,
            running_since: 1_767_225_601_000,
            backup_since: 1_767_225_600_500,
            session_log: Some(PathBuf::from(
                "D:/Games/.minecraft/versions/1.21.1-Fabric/.petalfall/logs/latest.log",
            )),
            java: java_used_sample(),
            max_memory_mb: 6144,
            warnings: LAUNCH_WARNINGS.to_vec(),
            offline: true,
            account: RecordAccount {
                uuid: "0123456789abcdef0123456789abcdef".into(),
                name: "Steve".into(),
                account_type,
            },
        })
        .collect()
}

fn crash_report_sample() -> CrashReport {
    CrashReport {
        at: Some(1_767_229_200_000),
        exit_code: Some(1),
        session_started_at: Some(1_767_225_600_000),
        // 存盘时清掉：读报告时现找。填上值，存盘不再清它时快照就看得见。
        log_path: Some(
            "D:/Games/.minecraft/versions/1.21.1-Fabric/.petalfall/logs/latest.log".into(),
        ),
        diagnoses: CRASH_CATEGORIES
            .iter()
            .enumerate()
            .map(|(i, &category)| CrashClue {
                category,
                summary: "樱花林里的线索".into(),
                advice: "先停用最近装的 Mod 再试".into(),
                detail: Some("sodium".into()),
                matched: format!("[main/ERROR]: {}", crash_category_spelling(category)),
                line: 100 + i as u64,
                context: vec!["[main/INFO]: 前两行".into(), "[main/INFO]: 前一行".into()],
                source: pick(&CRASH_SOURCES, i),
            })
            .collect(),
        suspects: vec![CrashSuspect {
            mod_id: "sodium".into(),
            file_name: Some("sodium-fabric-0.6.0.jar".into()),
        }],
        java: Some(java_used_sample()),
        max_memory_mb: Some(6144),
        warnings: LAUNCH_WARNINGS.to_vec(),
        // 存盘时清掉：读报告时按退出码现算。
        exit_code_note: Some(ExitCodeNote {
            code: 1,
            hex: "0x00000001".into(),
            kind: ExitCodeKind::GenericFailure,
            summary: "进程报错退出".into(),
        }),
        // 会话日志一项存盘时去掉；另两项写成相对实例目录的路径，存盘时原样保留。
        scanned_files: vec![
            ScannedFile {
                kind: CrashSource::SessionLog,
                path: "D:/Games/.minecraft/versions/1.21.1-Fabric/.petalfall/logs/latest.log"
                    .into(),
            },
            ScannedFile {
                kind: CrashSource::CrashReport,
                path: "crash-reports/crash-2026-01-01_10.00.00-client.txt".into(),
            },
            ScannedFile {
                kind: CrashSource::HsErr,
                path: "hs_err_pid4242.log".into(),
            },
        ],
    }
}

fn template_meta_sample() -> TemplateMeta {
    TemplateMeta {
        source_instance: Some(INSTANCE_ID.into()),
        saved_at: Some(1_767_225_600_000),
    }
}

const MOVE_TOKEN: &str = "1767225600000-0";

fn move_journal_samples() -> Vec<MoveJournal> {
    MOVE_STAGES
        .iter()
        .map(|&stage| MoveJournal {
            token: MOVE_TOKEN.into(),
            id: INSTANCE_ID.into(),
            source_game_dir: PathBuf::from(GAME_DIR),
            target_game_dir: PathBuf::from("E:/Games/.minecraft"),
            same_volume: false,
            stage,
            staging_dir: Some(PathBuf::from(
                "E:/Games/.minecraft/.petalfall/moving/1767225600000-0",
            )),
            old_dir: PathBuf::from("D:/Games/.minecraft/.petalfall/moving/1767225600000-0"),
            backups_staged: true,
            bases: vec!["1.21.1".into(), "fabric-loader-0.16.10-1.21.1".into()],
            records_moved: true,
            config_done: true,
            started_at: 1_767_225_600_000,
        })
        .collect()
}

fn base_version_ids() -> Vec<String> {
    vec!["1.21.1".into(), "fabric-loader-0.16.10-1.21.1".into()]
}

fn modpack_samples() -> Vec<InstanceModpack> {
    let count = PACK_FORMATS
        .len()
        .max(PLATFORMS.len())
        .max(PACK_LOADER_KINDS.len());
    (0..count)
        .map(|i| InstanceModpack {
            schema: MODPACK_INFO_SCHEMA,
            format: pick(&PACK_FORMATS, i),
            platform: Some(pick(&PLATFORMS, i)),
            project_id: Some("Sakura01".into()),
            version_id: Some("Ver12345".into()),
            name: "樱花整合包".into(),
            version: Some("1.2.0".into()),
            minecraft: "1.21.1".into(),
            loader: Some(PackLoader {
                kind: pick(&PACK_LOADER_KINDS, i),
                version: "0.16.10".into(),
            }),
            remote_files: 120,
            override_files: 35,
            installed_at: 1_767_225_600,
            recommended_ram_mb: Some(6144),
        })
        .collect()
}

fn ledger_sample() -> Ledger {
    let holds = update_holds();
    let count = PLATFORMS.len().max(holds.len());
    Ledger {
        entries: (0..count)
            .map(|i| LedgerEntry {
                file_name: format!("mod-{i}.jar"),
                platform: pick(&PLATFORMS, i),
                project_id: format!("project-{i}"),
                version_id: format!("version-{i}"),
                version_number: Some("0.6.0".into()),
                title: Some("Sodium".into()),
                icon_url: Some("https://cdn.example.invalid/icon.png".into()),
                sha1: Some("da39a3ee5e6b4b0d3255bfef95601890afd80709".into()),
                installed_at: 1_767_225_600,
                installed_as_dependency_of: Some("parent-project".into()),
                update_hold: Some(holds[i % holds.len()].clone()),
            })
            .collect(),
    }
}

// ---- 测试 ----

#[tokio::test]
async fn config_json_matches_snapshot() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = ConfigStore::at(dir.path().join("config.json"));
    let mut documents = Vec::new();
    for config in config_samples() {
        store.save(&config).await.expect("写配置");
        documents.push(read_written(store.path()));
    }
    assert_matches_snapshot("config.json", "config.json", &json_array(&documents));
}

#[tokio::test]
async fn playtime_json_matches_snapshot() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let path = dir.path().join(PLAYTIME_FILE);
    crate::playtime::save(&path, playtime_sample())
        .await
        .expect("写游玩记录");
    assert_matches_snapshot(PLAYTIME_FILE, PLAYTIME_FILE, &read_written(&path));
}

#[tokio::test]
async fn running_game_json_matches_snapshot() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let petalfall = Petalfall::for_test(
        PetalfallConfig::default(),
        dir.path().to_path_buf(),
        dir.path().to_path_buf(),
    );
    let mut documents = Vec::new();
    for record in running_record_samples() {
        petalfall
            .save_running_record(&record)
            .await
            .expect("写运行记录");
        documents.push(read_written(&petalfall.running_record_path()));
    }
    assert_matches_snapshot(
        "running-game.json",
        "running-game.json",
        &json_array(&documents),
    );
}

#[tokio::test]
async fn last_crash_json_matches_snapshot() {
    let dir = tempfile::tempdir().expect("建临时目录");
    save_crash_report(dir.path(), &crash_report_sample())
        .await
        .expect("写崩溃报告");
    let written = read_written(&dir.path().join(PETALFALL_META_DIR).join(CRASH_REPORT_FILE));
    assert_matches_snapshot(CRASH_REPORT_FILE, CRASH_REPORT_FILE, &written);
}

#[tokio::test]
async fn template_json_matches_snapshot() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let staging = dir.path().join("staging");
    // 白名单文件一个都不给，暂存目录里只写元数据。
    fill_staging(
        dir.path(),
        &staging,
        dir.path(),
        &[],
        &template_meta_sample(),
    )
    .await
    .expect("写模板元数据");
    let written = read_written(&staging.join(TEMPLATE_META_FILE));
    assert_matches_snapshot(TEMPLATE_META_FILE, TEMPLATE_META_FILE, &written);
}

#[tokio::test]
async fn move_journal_matches_snapshot() {
    let dir = tempfile::tempdir().expect("建临时目录");
    // 日志的位置也是落盘形状的一部分：挪了位置旧版本就找不到它，这里读不回来同样会挂。
    let path = dir.path().join("moves").join(format!("{MOVE_TOKEN}.json"));
    let mut documents = Vec::new();
    for journal in move_journal_samples() {
        crate::move_journal::write(dir.path(), &journal)
            .await
            .expect("写移动日志");
        documents.push(read_written(&path));
    }
    assert_matches_snapshot(
        "moves/<token>.json",
        "move-journal.json",
        &json_array(&documents),
    );
}

#[tokio::test]
async fn base_versions_json_matches_snapshot() {
    let dir = tempfile::tempdir().expect("建临时目录");
    record_base_versions_in(dir.path(), &base_version_ids())
        .await
        .expect("写依赖版本记录");
    let written = read_written(
        &dir.path()
            .join(PETALFALL_META_DIR)
            .join("base-versions.json"),
    );
    assert_matches_snapshot("base-versions.json", "base-versions.json", &written);
}

#[test]
fn modpack_json_matches_snapshot() {
    let documents: Vec<Vec<u8>> = modpack_samples()
        .iter()
        .map(|info| serde_json::to_vec_pretty(info).expect("样本能序列化"))
        .collect();
    assert_matches_snapshot("modpack.json", "modpack.json", &json_array(&documents));
}

#[tokio::test]
async fn ledger_json_matches_snapshot() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = LedgerStore::for_version_dir(dir.path());
    store.save(&ledger_sample()).await.expect("写卷宗");
    assert_matches_snapshot("ledger.json", "ledger.json", &read_written(store.path()));
}

#[tokio::test]
async fn history_json_matches_snapshot() {
    let dir = tempfile::tempdir().expect("建临时目录");
    let store = HistoryStore::for_version_dir(dir.path());
    for event in history_events() {
        store.append(event).await.expect("追加历史事件");
    }
    assert_matches_snapshot("history.json", "history.json", &read_written(store.path()));
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
        "DownloadSourcePolicy",
        DOWNLOAD_SOURCE_POLICIES
            .map(download_source_policy_spelling)
            .to_vec(),
        declared_variants::<DownloadSourcePolicy>(json!("")),
    );
    check(
        "IsolationPolicy",
        ISOLATION_POLICIES.map(isolation_policy_spelling).to_vec(),
        declared_variants::<IsolationPolicy>(json!("")),
    );
    check(
        "AppearanceMode",
        APPEARANCE_MODES.map(appearance_mode_spelling).to_vec(),
        declared_variants::<AppearanceMode>(json!("")),
    );
    check(
        "AccentColor",
        ACCENT_COLORS.map(accent_color_spelling).to_vec(),
        declared_variants::<AccentColor>(json!("")),
    );
    check(
        "CoverStyle",
        COVER_STYLES.map(cover_style_spelling).to_vec(),
        declared_variants::<CoverStyle>(json!("")),
    );
    check(
        "AfterLaunch",
        AFTER_LAUNCHES.map(after_launch_spelling).to_vec(),
        declared_variants::<AfterLaunch>(json!("")),
    );
    check(
        "UiLanguage",
        UI_LANGUAGES.map(ui_language_spelling).to_vec(),
        declared_variants::<UiLanguage>(json!("")),
    );
    check(
        "AccountType",
        ACCOUNT_TYPES.map(account_type_spelling).to_vec(),
        declared_variants::<AccountType>(json!("")),
    );
    check(
        "LaunchWarning",
        LAUNCH_WARNINGS.map(launch_warning_spelling).to_vec(),
        declared_variants::<LaunchWarning>(json!("")),
    );
    check(
        "CrashCategory",
        CRASH_CATEGORIES.map(crash_category_spelling).to_vec(),
        declared_variants::<CrashCategory>(json!("")),
    );
    check(
        "CrashSource",
        CRASH_SOURCES.map(crash_source_spelling).to_vec(),
        declared_variants::<CrashSource>(json!("")),
    );
    check(
        "MoveStage",
        MOVE_STAGES.map(move_stage_spelling).to_vec(),
        declared_variants::<MoveStage>(json!("")),
    );
    check(
        "PackFormat",
        PACK_FORMATS.map(pack_format_spelling).to_vec(),
        declared_variants::<PackFormat>(json!("")),
    );
    check(
        "Platform",
        PLATFORMS.map(platform_spelling).to_vec(),
        declared_variants::<Platform>(json!("")),
    );
    check(
        "PackLoaderKind",
        PACK_LOADER_KINDS.map(pack_loader_kind_spelling).to_vec(),
        declared_variants::<PackLoaderKind>(json!("")),
    );
    check(
        "UpdateHold",
        update_holds().iter().map(update_hold_spelling).collect(),
        declared_variants::<UpdateHold>(json!({ "kind": "" })),
    );
    check(
        "HistoryEvent",
        history_events()
            .iter()
            .map(history_event_spelling)
            .collect(),
        declared_variants::<HistoryEvent>(json!({ "kind": "" })),
    );
}

#[test]
fn format_constants_match_registered_values() {
    for (name, actual, registered) in REGISTERED_FORMATS {
        assert_eq!(
            actual, registered,
            "{name} 变了：自带格式版本的文件升版本，旧版本会拒读或改名留存，按 docs/architecture.md 的\
             「数据格式号」给数据格式号加一、冻结快照，处理完再把这里的登记值改成新值"
        );
    }
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
