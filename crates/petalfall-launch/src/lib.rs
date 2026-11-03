// Copyright (C) 2026 Shinoyuki_Miyako
// SPDX-License-Identifier: AGPL-3.0-only
// 本程序代码按 AGPL-3.0-only 授权，另附 AGPL 第 7 条的附加条款；两者见源代码根目录的 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。
// Licensed under AGPL-3.0-only with additional terms under section 7 of the AGPL; see LICENSE and LICENSE-ADDITIONAL-TERMS.md at the root of the source code.

//! petalfall-launch（L3 启动链路）
//!
//! 把「账户 + 已合并版本 JSON + Java + 路径」拼装成一条可执行的启动命令并驱动游戏进程。本 crate 只做拼装与
//! 进程编排，不发网络请求、不下载文件（补全交给 petalfall-install，探测交给 petalfall-java，登录交给 petalfall-auth）。
//!
//! 模块划分：
//! - [`placeholder`]：`${}` 占位符替换引擎（ArgumentReplace）。
//! - [`classpath`]：按合并后 libraries 顺序拼 classpath，客户端主 jar 垫最后。
//! - [`memory`]：本机内存探测、自动分配与推荐值，产出 `-Xmx`/`-Xms`。
//! - [`args`]：安全/编码防御参数、旧版 JVM 基座、新式条件参数展开、ignoreList 补齐、参数分割与去重/覆盖合并。
//! - [`account`]：账户鉴权值摊平与 Authlib-Injector javaagent 拼装。
//! - [`command`]：门面构造器 [`command::CommandBuilder`] -> [`command::LaunchCommand`]。
//! - [`process`]：进程 spawn、输出捕获与批量转发、结束游戏、退出报告、崩溃触发判定。
//! - [`logfile`]：每次启动的会话日志（写入、滚动保留、读尾部）。
//! - `log4j_xml`：把游戏 stdout 上的 log4j XML 事件还原成普通日志行。
//! - [`crash`]：崩溃基础检测规则表与结构化诊断。
//! - [`precheck`]：启动前的轻量判断（所需 Java 主版本、路径与同步盘提醒、角色名长度、JVM 内存参数）。
//! - [`quickplay`]：直达存档与服务器（Quick Play 与旧版 `--server` / `--port`）的支持判定。
//! - [`redact`]：遮掉文字里的访问令牌，游戏输出、会话日志与崩溃诊断共用。
//! - [`workspace`]：游戏工作目录（版本隔离）解析。
//!
//! 错误统一归口到 [`LaunchError`]，下游可 `#[from] petalfall_launch::LaunchError` 冒泡。

pub mod account;
pub mod args;
pub mod classpath;
pub mod command;
pub mod crash;
pub mod error;
mod log4j_xml;
pub mod logfile;
pub mod memory;
pub mod placeholder;
pub mod precheck;
pub mod process;
pub mod quickplay;
pub mod redact;
pub mod workspace;

pub use account::{AuthValues, AuthlibInjector, OFFLINE_ACCESS_TOKEN};
pub use args::{dedup_jvm_args, ensure_client_jar_ignored, merge_game_args, split_args};
pub use classpath::{classpath_entries, classpath_separator, classpath_string};
pub use command::{CommandBuilder, GamePaths, LaunchCommand};
pub use crash::{
    CrashCategory, CrashDiagnosis, ExitCodeKind, ExitCodeNote, analyze, analyze_lines,
    exit_code_clue, explain_exit_code, extract_mod_ids, has_crash_marker, jvm_exception_clue,
    suspected_mods,
};
pub use error::{LaunchError, Result};
pub use logfile::{
    LauncherLevel, LogEntry, LogSource, LogTail, SessionClock, SessionEnded, SessionLog,
    SessionOutcome, game_line_level, read_log_tail, session_log_path, unix_millis,
};
pub use memory::{
    DISTANT_HORIZONS_MOD_ID, LimitReason, LoaderClass, MemoryAdvice, MemoryConfig, MemoryEstimate,
    MemoryLimit, MemoryProfile, NeedFactor, SystemMemory, estimate_memory, estimate_need,
    memory_limit, probe_system_memory,
};
pub use placeholder::Placeholders;
pub use precheck::{
    DEFAULT_JAVA_MAJOR, JvmMemoryIssue, MIN_MAX_HEAP_MB, ONEDRIVE_ENV_VARS, PLAYER_NAME_MAX_UNITS,
    PathWarning, SyncProvider, SyncRoot, effective_max_heap_mb, jvm_memory_issue, long_player_name,
    non_ascii_path_at_risk, path_char_outside_code_page, path_warnings, required_java_major,
    sync_folder, sync_roots_from_env,
};
pub use process::{
    ExitReport, GameSession, KillSwitch, LogBatchSink, LogLine, LogStream, SessionEnd,
    SessionFailure, detect_crash, spawn,
};
pub use quickplay::{
    FEATURE_MULTIPLAYER, FEATURE_SINGLEPLAYER, QuickPlayMode, QuickPlaySupport, QuickPlayTarget,
    legacy_server_args, quick_play_lost_char, quick_play_support,
};
pub use redact::{REDACTED, redact_access_tokens};
pub use workspace::resolve_game_directory;
