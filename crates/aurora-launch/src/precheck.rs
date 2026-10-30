//! 启动前检查编排。
//!
//! 在真正 spawn 之前，把「本 crate 依赖能覆盖的检查」串成一份报告：游戏路径是否含危险字符、版本是否有
//! 主类、是否有匹配的 Java、账户令牌是否可用、客户端 jar 是否就绪。
//!
//! 深度文件完整性（逐文件 sha1 校验与缺失补全）由 `aurora_install::ensure_complete` 负责，属 L2 能力，
//! 本 crate（L3，不依赖 install）只做「客户端 jar 是否存在」这类轻量存在性检查，深度校验交由上层在启动前
//! 先行调用。

use std::path::Path;

use aurora_auth::{Account, AccountCredentials};
use aurora_java::{JavaInstallation, select_for_major};
use aurora_version::VersionJson;
use serde::{Deserialize, Serialize};

/// 旧版本 JSON 未声明 `javaVersion` 时的默认所需 Java 主版本。
const DEFAULT_JAVA_MAJOR: u32 = 8;

/// 单项检查状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    /// 通过。
    Pass,
    /// 有隐患但不阻断启动。
    Warn,
    /// 阻断启动。
    Fail,
}

/// 单项检查结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckItem {
    /// 检查项名称。
    pub name: String,
    /// 状态。
    pub status: CheckStatus,
    /// 中文说明。
    pub message: String,
}

impl CheckItem {
    fn new(name: &str, status: CheckStatus, message: impl Into<String>) -> Self {
        Self {
            name: name.to_owned(),
            status,
            message: message.into(),
        }
    }
}

/// 启动前检查报告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreLaunchReport {
    /// 各检查项。
    pub items: Vec<CheckItem>,
}

impl PreLaunchReport {
    /// 是否存在阻断项（任一 `Fail`）。
    pub fn is_blocking(&self) -> bool {
        self.items.iter().any(|item| item.status == CheckStatus::Fail)
    }

    /// 是否可以启动（无阻断项）。
    pub fn can_launch(&self) -> bool {
        !self.is_blocking()
    }
}

/// 启动前检查所需的输入。
pub struct PreLaunchInput<'a> {
    /// 游戏工作目录（隔离判定后的实际目录），用于路径字符检查。
    pub game_dir: &'a Path,
    /// 合并后的版本 JSON。
    pub version: &'a VersionJson,
    /// 本机已探测的 Java 安装。
    pub java_installations: &'a [JavaInstallation],
    /// 当前账户。
    pub account: &'a Account,
    /// 当前 Unix 秒（用于判断微软令牌是否临期，便于测试注入）。
    pub now_unix: u64,
    /// 客户端主 jar 路径（存在性检查）。
    pub client_jar: &'a Path,
}

/// 运行全部启动前检查。
pub fn run(input: &PreLaunchInput<'_>) -> PreLaunchReport {
    let required_major = input
        .version
        .java_version
        .as_ref()
        .map(|j| j.major_version)
        .unwrap_or(DEFAULT_JAVA_MAJOR);

    let items = vec![
        check_game_path(input.game_dir),
        check_main_class(input.version),
        check_java(required_major, input.java_installations),
        check_account(input.account, input.now_unix),
        check_client_jar(input.client_jar),
    ];
    PreLaunchReport { items }
}

/// 检查游戏路径是否含可能引发崩溃的字符（非 ASCII、`!`）。
pub fn check_game_path(game_dir: &Path) -> CheckItem {
    const NAME: &str = "游戏路径";
    match risky_path_char(game_dir) {
        Some(ch) => CheckItem::new(
            NAME,
            CheckStatus::Warn,
            format!("路径含字符 '{ch}'，在部分非 UTF-8 环境下可能导致 Forge/natives 加载异常，建议换到纯英文路径"),
        ),
        None => CheckItem::new(NAME, CheckStatus::Pass, "路径字符正常"),
    }
}

/// 检查版本是否有启动主类。
pub fn check_main_class(version: &VersionJson) -> CheckItem {
    const NAME: &str = "启动主类";
    match &version.main_class {
        Some(main) => CheckItem::new(NAME, CheckStatus::Pass, format!("主类 {main}")),
        None => CheckItem::new(
            NAME,
            CheckStatus::Fail,
            "版本 JSON 缺少 mainClass，无法确定启动入口（可能是纯补丁 JSON 未正确合并）",
        ),
    }
}

/// 检查是否有匹配所需主版本的 Java。
pub fn check_java(required_major: u32, installations: &[JavaInstallation]) -> CheckItem {
    const NAME: &str = "Java 匹配";
    match select_for_major(installations, required_major) {
        Some(java) => CheckItem::new(
            NAME,
            CheckStatus::Pass,
            format!(
                "已选用 Java {} ({}位) {}",
                java.version.major,
                if java.is_64bit { 64 } else { 32 },
                java.path.display()
            ),
        ),
        None => CheckItem::new(
            NAME,
            CheckStatus::Fail,
            format!(
                "未找到 Java {required_major}，请安装或让{}自动下载对应运行时",
                aurora_base::brand::APP_NAME
            ),
        ),
    }
}

/// 检查账户令牌是否可用。
pub fn check_account(account: &Account, now_unix: u64) -> CheckItem {
    const NAME: &str = "账户令牌";
    match &account.credentials {
        AccountCredentials::Microsoft(creds) => {
            if creds.minecraft_token_valid_at(now_unix) {
                CheckItem::new(NAME, CheckStatus::Pass, "微软账户令牌有效")
            } else {
                CheckItem::new(
                    NAME,
                    CheckStatus::Fail,
                    "微软账户令牌缺失或已临期，请先刷新登录",
                )
            }
        }
        AccountCredentials::Offline => CheckItem::new(NAME, CheckStatus::Pass, "离线账户无需令牌"),
        AccountCredentials::AuthlibInjector(_) => {
            CheckItem::new(NAME, CheckStatus::Pass, "第三方账户令牌就绪")
        }
    }
}

/// 检查客户端主 jar 是否存在（轻量存在性检查；深度校验由 aurora-install 负责）。
pub fn check_client_jar(client_jar: &Path) -> CheckItem {
    const NAME: &str = "客户端文件";
    if client_jar.is_file() {
        CheckItem::new(NAME, CheckStatus::Pass, "客户端 jar 就绪")
    } else {
        CheckItem::new(
            NAME,
            CheckStatus::Fail,
            format!("客户端 jar 缺失：{}，请先补全该版本", client_jar.display()),
        )
    }
}

/// 找出路径里第一个危险字符（非 ASCII 或 `!`）。
fn risky_path_char(path: &Path) -> Option<char> {
    path.to_string_lossy()
        .chars()
        .find(|c| !c.is_ascii() || *c == '!')
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_auth::MicrosoftCredentials;
    use aurora_java::{DetectSource, JavaVersion};
    use std::path::PathBuf;

    fn java(major: &str, is_64bit: bool) -> JavaInstallation {
        JavaInstallation {
            path: PathBuf::from(format!("C:/java{major}/bin/java.exe")),
            version: JavaVersion::parse(major).unwrap(),
            is_64bit,
            vendor: "OpenJDK".to_owned(),
            source: DetectSource::CommonDir,
        }
    }

    fn version_with_java(major: u32) -> VersionJson {
        VersionJson::from_json_str(&format!(
            r#"{{"id":"1.21","mainClass":"net.minecraft.client.main.Main","javaVersion":{{"majorVersion":{major}}}}}"#
        ))
        .unwrap()
    }

    #[test]
    fn game_path_warns_on_non_ascii_and_bang() {
        assert_eq!(
            check_game_path(Path::new(r"D:\我的世界")).status,
            CheckStatus::Warn
        );
        assert_eq!(
            check_game_path(Path::new(r"D:\games!\mc")).status,
            CheckStatus::Warn
        );
        assert_eq!(
            check_game_path(Path::new(r"D:\games\mc")).status,
            CheckStatus::Pass
        );
    }

    #[test]
    fn main_class_absence_is_blocking() {
        let ok = VersionJson::from_json_str(r#"{"id":"x","mainClass":"M"}"#).unwrap();
        assert_eq!(check_main_class(&ok).status, CheckStatus::Pass);
        let missing = VersionJson::from_json_str(r#"{"id":"x"}"#).unwrap();
        assert_eq!(check_main_class(&missing).status, CheckStatus::Fail);
    }

    #[test]
    fn java_match_picks_and_fails_when_absent() {
        let installs = vec![java("17.0.1", true), java("8.0.402", true)];
        assert_eq!(check_java(17, &installs).status, CheckStatus::Pass);
        // 需要 Java 21 但没有 -> 阻断。
        assert_eq!(check_java(21, &installs).status, CheckStatus::Fail);
    }

    #[test]
    fn account_token_checks_per_type() {
        let offline = Account::new("u", "Steve", AccountCredentials::Offline);
        assert_eq!(check_account(&offline, 0).status, CheckStatus::Pass);

        let expired = Account::new(
            "u",
            "Alex",
            AccountCredentials::Microsoft(MicrosoftCredentials {
                refresh_token: "r".into(),
                minecraft_token: Some("mc".into()),
                minecraft_expires_at: Some(1_000),
            }),
        );
        // now=1000 已到期（含 60s 边际），阻断。
        assert_eq!(check_account(&expired, 1_000).status, CheckStatus::Fail);
        // now=800 尚有效。
        assert_eq!(check_account(&expired, 800).status, CheckStatus::Pass);
    }

    #[test]
    fn client_jar_existence() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("1.21.jar");
        assert_eq!(check_client_jar(&jar).status, CheckStatus::Fail);
        std::fs::write(&jar, b"stub").unwrap();
        assert_eq!(check_client_jar(&jar).status, CheckStatus::Pass);
    }

    #[test]
    fn full_report_blocks_on_missing_java() {
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("1.21.jar");
        std::fs::write(&jar, b"stub").unwrap();
        let version = version_with_java(21);
        let account = Account::new("u", "Steve", AccountCredentials::Offline);
        // 只有 Java 8，缺 Java 21。
        let installs = vec![java("8.0.402", true)];
        let report = run(&PreLaunchInput {
            game_dir: dir.path(),
            version: &version,
            java_installations: &installs,
            account: &account,
            now_unix: 0,
            client_jar: &jar,
        });
        assert!(report.is_blocking());
        assert!(!report.can_launch());
        // Java 项应为 Fail，其余为 Pass。
        let java_item = report.items.iter().find(|i| i.name == "Java 匹配").unwrap();
        assert_eq!(java_item.status, CheckStatus::Fail);
    }
}
