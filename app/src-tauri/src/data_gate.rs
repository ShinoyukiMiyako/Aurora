//! 启动时的数据目录关卡：数据被更新的版本用过时不打开，在窗口出现之前用系统对话框说明。
//!
//! 核对本身是 core 的 [`check_data_root`]；这里在读配置之前调它，拒绝时拼出对话框弹给用户，再让 `run()` 不建窗口
//! 直接返回。这时还没有窗口也没有前端，setup 里报错只会变成一个看不见的 panic，所以用系统消息框。消息框改不了
//! 按钮文字（是系统语言的「是」「否」），正文最后一句写成问句；点「否」直接退出。不给「仍然打开」，也不自动重置：
//! 号更低的这一版读写这份数据，可能读错、写坏更新的版本留下的东西。
//!
//! 记号文件谁都能写（数据目录可能在移动硬盘、网络盘上），里面的 `written_by` 经 [`trusted_written_by`] 认出是发过的
//! 版本号才写进对话框，否则改说「更新的落樱」；下载页地址只从编译进来的常量里选，从不取自数据。

use std::path::{Path, PathBuf};

use petalfall_base::brand::{APP_NAME, REPO_URL};
use petalfall_base::fs::DataDirResolution;
use petalfall_core::data_format::{
    check_data_root, trusted_written_by, DataRootRefusal, DATA_FORMAT,
};
use petalfall_core::release::order::Channel;
use semver::Version;

/// 关卡的结论。
#[must_use]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// 放行，启动照常往下走。
    Open,
    /// 拒绝打开，对话框已经关掉：`run()` 直接返回，不构造门面、不建窗口。
    Exit,
}

/// 读配置之前核对数据目录根下的数据格式记号，`version` 是这一版的版本号：号低时抬号写进的记号带上它，对话框的
/// 首句也写它。拒绝时弹对话框，关掉之后交回 [`Gate::Exit`]。
///
/// 数据目录定位不到时不在这里拦，交回 [`Gate::Open`]：构造门面时会以同一个错误终止启动，这是原有的行为，这里
/// 不另加一种失败的说法。
pub fn check_on_startup(version: &Version) -> Gate {
    check_with(
        petalfall_base::fs::resolve_data_dir(),
        DATA_FORMAT,
        &version.to_string(),
        ask_user,
        carry_out,
    )
}

/// [`check_on_startup`] 的实现。定位结果、本版号、弹对话框（交回用户点的是不是「是」）与「是」之后的动作都由
/// 调用方给，测试才不碰真实的数据目录、不弹真的对话框。
fn check_with(
    resolution: petalfall_base::Result<DataDirResolution>,
    own: u32,
    app_version: &str,
    ask: impl FnOnce(&Prompt) -> bool,
    follow: impl FnOnce(&FollowUp),
) -> Gate {
    let resolution = match resolution {
        Ok(resolution) => resolution,
        Err(err) => {
            tracing::warn!(
                error = %petalfall_base::error_with_causes(&err),
                "定位不到数据目录，这次不核对数据格式；构造门面时会以同一个错误终止启动"
            );
            return Gate::Open;
        }
    };
    let refusal = match tauri::async_runtime::block_on(check_data_root(
        &resolution,
        own,
        Some(app_version),
    )) {
        Ok(()) => return Gate::Open,
        Err(refusal) => refusal,
    };
    let stamp_present = match &refusal {
        DataRootRefusal::NotRecorded { path, .. } => path.is_file(),
        DataRootRefusal::TooNew { .. } | DataRootRefusal::Unreadable { .. } => true,
    };
    let prompt = refusal_prompt(&refusal, &resolution.path, app_version, stamp_present);
    let yes = ask(&prompt);
    tracing::info!(
        yes,
        follow_up = ?prompt.on_yes,
        "数据目录的数据格式不对，没有打开；拦截对话框已关掉"
    );
    if yes {
        follow(&prompt.on_yes);
    }
    Gate::Exit
}

/// 拒绝打开时弹的对话框。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Prompt {
    /// 标题栏。
    title: &'static str,
    /// 正文：首句、说明、问句，之间各空一行。
    text: String,
    /// 点「是」之后做的事，做完退出；点「否」直接退出。
    on_yes: FollowUp,
}

/// 点「是」之后做的事。
#[derive(Debug, Clone, PartialEq, Eq)]
enum FollowUp {
    /// 用浏览器打开这个网址。
    OpenUrl(String),
    /// 在资源管理器里选中这个文件。
    Reveal(PathBuf),
    /// 用资源管理器打开这个文件夹。
    OpenFolder(PathBuf),
}

/// 三种拒绝各自的对话框。`data_root` 是数据目录（定位结果的路径），`app_version` 是这一版的版本号；`stamp_present`
/// 是记号文件此刻在不在，只决定「没能记下」那一种的「是」打开哪里：号第一次往上抬时记号多半还不存在，没法选中它。
fn refusal_prompt(
    refusal: &DataRootRefusal,
    data_root: &Path,
    app_version: &str,
    stamp_present: bool,
) -> Prompt {
    let (headline, body, question, on_yes) = match refusal {
        DataRootRefusal::TooNew { written_by, .. } => {
            let headline = format!("{APP_NAME} {app_version} 读不了这里的数据");
            let root = data_root.display();
            let kept = "为了不读错、不弄坏，这次没有打开，也没有改动这里的设置、账户和其他数据。";
            match written_by.as_deref().and_then(trusted_written_by) {
                Some(writer) => {
                    let label = channel_label(writer.channel);
                    let named = format!("{label} {}", writer.version);
                    (
                        headline,
                        format!(
                            "{root} 里的设置和账户已经被{named} 用过，这个版本读不了。{kept}装上{named} 或更新的版本，就能接着用这些数据。"
                        ),
                        format!("现在打开{label}的下载页吗？"),
                        FollowUp::OpenUrl(download_page(Some(writer.channel))),
                    )
                }
                None => (
                    headline,
                    format!(
                        "{root} 里的设置和账户已经被更新的{APP_NAME}用过，这个版本读不了。{kept}装上更新的{APP_NAME}，就能接着用这些数据。"
                    ),
                    "现在打开下载页吗？".to_owned(),
                    FollowUp::OpenUrl(download_page(None)),
                ),
            }
        }
        DataRootRefusal::Unreadable { path, reason } => (
            format!("{APP_NAME}读不懂这里的数据格式记录"),
            format!(
                "{}：{reason}。为了不读错、不弄坏这里的数据，这次没有打开，也没有改动这里的设置、账户和其他数据。这个文件多半被别的程序改过，反馈问题时带上上面的路径和原因。",
                path.display()
            ),
            "现在打开它所在的文件夹吗？".to_owned(),
            FollowUp::Reveal(path.clone()),
        ),
        DataRootRefusal::NotRecorded { path, source } => (
            format!("{APP_NAME}没能记下数据格式"),
            format!(
                "{}：{}。为了不让更早的版本读错这里的数据，这次没有打开。腾出磁盘空间或放行杀毒软件后再打开{APP_NAME}。",
                path.display(),
                petalfall_base::error_with_causes(source)
            ),
            "现在打开它所在的文件夹吗？".to_owned(),
            if stamp_present {
                FollowUp::Reveal(path.clone())
            } else {
                FollowUp::OpenFolder(data_root.to_owned())
            },
        ),
    };
    Prompt {
        title: APP_NAME,
        text: format!("{headline}\n\n{body}\n\n{question}"),
        on_yes,
    }
}

/// 通道在界面上的叫法，与前端的 `RELEASE_CHANNEL_LABEL` 一致。
fn channel_label(channel: Channel) -> &'static str {
    match channel {
        Channel::Dev => "预览版",
        Channel::Beta => "测试版",
        Channel::Stable => "正式版",
    }
}

/// 用过这份数据的那一版所在通道的下载页；认不出是哪一版时是发布列表。不指向官网首页：官网的主按钮给的是测试版
/// 或正式版，数据若是预览版写的，从官网装上的包同样读不了，又被拦一次。预览版只有一份滚动更新的发布，tag 是
/// `dev-build`。
fn download_page(channel: Option<Channel>) -> String {
    let path = match channel {
        Some(Channel::Dev) => "/releases/tag/dev-build",
        Some(Channel::Stable) => "/releases/latest",
        Some(Channel::Beta) | None => "/releases",
    };
    format!("{REPO_URL}{path}")
}

/// 弹系统消息框，交回用户点的是不是「是」。没有所属窗口：这时还没有任何窗口。
#[cfg(windows)]
fn ask_user(prompt: &Prompt) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONWARNING, MB_YESNO};
    use windows_core::{HSTRING, PCWSTR};

    let text = HSTRING::from(prompt.text.as_str());
    let title = HSTRING::from(prompt.title);
    // SAFETY: 两段文字在调用期间有效
    let answer = unsafe {
        MessageBoxW(
            None,
            PCWSTR(text.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_YESNO | MB_ICONWARNING,
        )
    };
    if answer.0 == 0 {
        tracing::error!(
            error = %windows_core::Error::from_win32(),
            "拦截对话框没弹出来，按「否」直接退出"
        );
    }
    answer == IDYES
}

/// 只有 Windows 有窗口出现之前的系统消息框；别的平台把说明写到标准错误，按「否」直接退出。
#[cfg(not(windows))]
fn ask_user(prompt: &Prompt) -> bool {
    eprintln!("{}\n\n{}", prompt.title, prompt.text);
    false
}

/// 做「是」之后的事。做不成只记日志：反正接着就退出，用户还能照对话框上写的路径与网址自己去找。
fn carry_out(follow_up: &FollowUp) {
    let done = match follow_up {
        FollowUp::OpenUrl(url) => tauri_plugin_opener::open_url(url, None::<&str>),
        FollowUp::Reveal(path) => tauri_plugin_opener::reveal_item_in_dir(path),
        FollowUp::OpenFolder(path) => tauri_plugin_opener::open_path(path, None::<&str>),
    };
    if let Err(err) = done {
        tracing::error!(?follow_up, error = %err, "没能打开拦截对话框里说的地方");
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::io;
    use std::time::Duration;

    use petalfall_core::data_format::STAMP_FILE;

    use super::*;

    const APP_VERSION: &str = "1.0.0-beta.5";

    fn root() -> PathBuf {
        PathBuf::from(r"D:\Petalfall")
    }

    fn too_new(written_by: Option<&str>) -> DataRootRefusal {
        DataRootRefusal::TooNew {
            path: root().join(STAMP_FILE),
            found: 3,
            supported: 2,
            written_by: written_by.map(str::to_owned),
        }
    }

    /// 数据比这一版新、认不出是哪一版写的时候的全文。
    fn newer_petalfall_text(root: &Path) -> String {
        format!(
            "{APP_NAME} {APP_VERSION} 读不了这里的数据\n\n{} 里的设置和账户已经被更新的{APP_NAME}用过，这个版本读不了。为了不读错、不弄坏，这次没有打开，也没有改动这里的设置、账户和其他数据。装上更新的{APP_NAME}，就能接着用这些数据。\n\n现在打开下载页吗？",
            root.display()
        )
    }

    // ---- 对话框文案 ----

    #[test]
    fn a_newer_root_with_a_trusted_writer_names_its_channel_version_and_download_page() {
        // 预览版这一条整段逐字写出，其余通道只换通道名、版本号与下载页。
        assert_eq!(
            refusal_prompt(&too_new(Some("1.1.0-dev.57")), &root(), APP_VERSION, true),
            Prompt {
                title: APP_NAME,
                text: format!(
                    "{APP_NAME} 1.0.0-beta.5 读不了这里的数据\n\nD:\\Petalfall 里的设置和账户已经被预览版 1.1.0-dev.57 用过，这个版本读不了。为了不读错、不弄坏，这次没有打开，也没有改动这里的设置、账户和其他数据。装上预览版 1.1.0-dev.57 或更新的版本，就能接着用这些数据。\n\n现在打开预览版的下载页吗？"
                ),
                on_yes: FollowUp::OpenUrl(format!("{REPO_URL}/releases/tag/dev-build")),
            }
        );

        for (written_by, label, page) in [
            ("1.2.0-beta.3", "测试版", "/releases"),
            ("1.0.0", "正式版", "/releases/latest"),
            ("10.20.30-dev.0", "预览版", "/releases/tag/dev-build"),
        ] {
            assert_eq!(
                refusal_prompt(&too_new(Some(written_by)), &root(), APP_VERSION, true),
                Prompt {
                    title: APP_NAME,
                    text: format!(
                        "{APP_NAME} {APP_VERSION} 读不了这里的数据\n\nD:\\Petalfall 里的设置和账户已经被{label} {written_by} 用过，这个版本读不了。为了不读错、不弄坏，这次没有打开，也没有改动这里的设置、账户和其他数据。装上{label} {written_by} 或更新的版本，就能接着用这些数据。\n\n现在打开{label}的下载页吗？"
                    ),
                    on_yes: FollowUp::OpenUrl(format!("{REPO_URL}{page}")),
                },
                "{written_by}"
            );
        }
    }

    /// 没有 `written_by`，或它不是发过的版本号的样子：说「更新的落樱」，下载页是发布列表，原文一个字都不进对话框。
    #[test]
    fn a_newer_root_without_a_trusted_writer_says_a_newer_petalfall_and_shows_no_raw_text() {
        let too_long = format!("1.0.0-dev.{}", "1".repeat(40));
        let untrusted = [
            too_long.as_str(),
            "1.1.0-dev.57+sha.5114f85",
            "https://evil.example/1.1.0",
            "1.1.0-dev.57 https://evil.example",
            "1.1.0-dev.57\u{1b}[2J",
            "1.1.0\r\n正式版 9.9.9",
            "\u{7}1.1.0",
            "1.01.0",
            "1.1.0-rc.1",
            "1.1.0-dev-1",
            "",
        ];
        let expected = Prompt {
            title: APP_NAME,
            text: newer_petalfall_text(&root()),
            on_yes: FollowUp::OpenUrl(format!("{REPO_URL}/releases")),
        };

        assert_eq!(
            refusal_prompt(&too_new(None), &root(), APP_VERSION, true),
            expected
        );
        for raw in untrusted {
            let prompt = refusal_prompt(&too_new(Some(raw)), &root(), APP_VERSION, true);
            assert_eq!(prompt, expected, "{raw:?}");
            if !raw.is_empty() {
                assert!(!prompt.text.contains(raw), "{raw:?}");
            }
        }
        assert!(!expected.text.contains("evil"));
    }

    #[test]
    fn an_unreadable_stamp_shows_its_path_and_reason_and_offers_to_reveal_it() {
        let stamp = root().join(STAMP_FILE);
        let refusal = DataRootRefusal::Unreadable {
            path: stamp.clone(),
            reason: "不是 JSON：expected value at line 1 column 1".to_owned(),
        };

        assert_eq!(
            refusal_prompt(&refusal, &root(), APP_VERSION, true),
            Prompt {
                title: APP_NAME,
                text: format!(
                    "{APP_NAME}读不懂这里的数据格式记录\n\n{}：不是 JSON：expected value at line 1 column 1。为了不读错、不弄坏这里的数据，这次没有打开，也没有改动这里的设置、账户和其他数据。这个文件多半被别的程序改过，反馈问题时带上上面的路径和原因。\n\n现在打开它所在的文件夹吗？",
                    stamp.display()
                ),
                on_yes: FollowUp::Reveal(stamp),
            }
        );
    }

    /// 记号还不存在时打开数据目录，已经存在时在资源管理器里选中它；原因带上整条错误链。
    #[test]
    fn a_stamp_that_could_not_be_recorded_shows_its_path_and_reason() {
        let stamp = root().join(STAMP_FILE);
        let temp = root().join(".data-format.json.0123456789abcdef.tmp");
        let refusal = || DataRootRefusal::NotRecorded {
            path: stamp.clone(),
            source: petalfall_base::Error::Io {
                path: temp.clone(),
                source: io::Error::other("磁盘已满"),
            },
        };
        let text = format!(
            "{APP_NAME}没能记下数据格式\n\n{}：文件 IO 失败: {}：磁盘已满。为了不让更早的版本读错这里的数据，这次没有打开。腾出磁盘空间或放行杀毒软件后再打开{APP_NAME}。\n\n现在打开它所在的文件夹吗？",
            stamp.display(),
            temp.display()
        );

        assert_eq!(
            refusal_prompt(&refusal(), &root(), APP_VERSION, false),
            Prompt {
                title: APP_NAME,
                text: text.clone(),
                on_yes: FollowUp::OpenFolder(root()),
            }
        );
        assert_eq!(
            refusal_prompt(&refusal(), &root(), APP_VERSION, true),
            Prompt {
                title: APP_NAME,
                text,
                on_yes: FollowUp::Reveal(stamp.clone()),
            }
        );
    }

    /// 前端的 `RELEASE_CHANNEL_LABEL` 写在 TS 里，引用不到这边的常量，逐项对照。只比三个通道：前端那张表按版本号认通道，
    /// 预发布标识是 dev 的叫 preview（见 app/scripts/build-info.mjs）。
    #[test]
    fn channel_labels_match_the_frontend_release_channel_labels() {
        let flows = include_str!("../../src/copy/flows.ts").replace("\r\n", "\n");
        let (_, table) = flows
            .split_once("export const RELEASE_CHANNEL_LABEL")
            .expect("flows.ts 里没有 RELEASE_CHANNEL_LABEL");
        let (table, _) = table
            .split_once("};")
            .expect("RELEASE_CHANNEL_LABEL 没有收尾");
        let labels: BTreeMap<&str, &str> = table
            .lines()
            .filter_map(|line| {
                let (key, value) = line.trim().split_once(": ")?;
                Some((key, value.strip_prefix('"')?.strip_suffix("\",")?))
            })
            .collect();

        for (key, channel) in [
            ("preview", Channel::Dev),
            ("beta", Channel::Beta),
            ("stable", Channel::Stable),
        ] {
            assert_eq!(
                labels.get(key).copied(),
                Some(channel_label(channel)),
                "{key}：{labels:?}"
            );
        }
    }

    // ---- 关卡 ----

    fn resolution(root: &Path, write_failure: Option<&str>) -> DataDirResolution {
        DataDirResolution {
            path: root.to_owned(),
            portable: true,
            fallback_reason: None,
            write_failure: write_failure.map(str::to_owned),
            elapsed: Duration::ZERO,
        }
    }

    /// 关卡跑完的结论、弹过的对话框与「是」之后做过的事。
    struct Run {
        gate: Gate,
        asked: Vec<Prompt>,
        followed: Vec<FollowUp>,
    }

    /// 跑一次关卡，对话框上点 `yes`。
    fn run(resolution: petalfall_base::Result<DataDirResolution>, own: u32, yes: bool) -> Run {
        let asked = RefCell::new(Vec::new());
        let followed = RefCell::new(Vec::new());
        let gate = check_with(
            resolution,
            own,
            APP_VERSION,
            |prompt| {
                asked.borrow_mut().push(prompt.clone());
                yes
            },
            |follow_up| followed.borrow_mut().push(follow_up.clone()),
        );
        Run {
            gate,
            asked: asked.into_inner(),
            followed: followed.into_inner(),
        }
    }

    /// 目录下全部条目（相对路径）与文件字节，文件夹记 `None`。前后各拍一次，比出有没有改动、多出或少了文件。
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let relative = path.strip_prefix(root).unwrap().to_owned();
                if path.is_dir() {
                    out.insert(relative, None);
                    walk(root, &path, out);
                } else {
                    out.insert(relative, Some(std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    const CONFIG: &[u8] =
        br#"{"first_run_completed":true,"game_directory":"D:\\Games\\.minecraft"}"#;

    /// 有一份配置与给定记号的数据目录。
    fn data_root_with(stamp: Option<&str>) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("config.json"), CONFIG).unwrap();
        if let Some(stamp) = stamp {
            std::fs::write(tmp.path().join(STAMP_FILE), stamp).unwrap();
        }
        tmp
    }

    /// 拦下时只弹一次对话框，配置原样不动、不产生改名留存的坏配置或任何别的文件；点「否」什么都不打开，点「是」
    /// 打开写数据的那个通道的下载页。
    #[test]
    fn a_newer_data_root_exits_after_one_dialog_without_touching_any_file() {
        for (yes, followed) in [
            (false, vec![]),
            (
                true,
                vec![FollowUp::OpenUrl(format!(
                    "{REPO_URL}/releases/tag/dev-build"
                ))],
            ),
        ] {
            let tmp = data_root_with(Some(r#"{"data_format":3,"written_by":"1.1.0-dev.57"}"#));
            let before = snapshot(tmp.path());

            let run = run(Ok(resolution(tmp.path(), None)), 2, yes);

            assert_eq!(run.gate, Gate::Exit);
            assert_eq!(run.asked.len(), 1, "点「是」：{yes}");
            assert_eq!(run.asked[0].title, APP_NAME);
            assert!(
                run.asked[0].text.starts_with(&format!(
                    "{APP_NAME} {APP_VERSION} 读不了这里的数据\n\n{} 里的设置和账户已经被预览版 1.1.0-dev.57 用过",
                    tmp.path().display()
                )),
                "{}",
                run.asked[0].text
            );
            assert_eq!(run.followed, followed, "点「是」：{yes}");
            assert_eq!(
                std::fs::read(tmp.path().join("config.json")).unwrap(),
                CONFIG
            );
            assert_eq!(snapshot(tmp.path()), before, "点「是」：{yes}");
        }
    }

    #[test]
    fn an_unreadable_data_root_stamp_exits_after_one_dialog_without_touching_any_file() {
        let tmp = data_root_with(Some(r#"{"data_format":"3"}"#));
        let stamp = tmp.path().join(STAMP_FILE);
        let before = snapshot(tmp.path());

        let run = run(Ok(resolution(tmp.path(), None)), 2, true);

        assert_eq!(run.gate, Gate::Exit);
        assert_eq!(run.asked.len(), 1);
        assert!(
            run.asked[0].text.starts_with(&format!(
                "{APP_NAME}读不懂这里的数据格式记录\n\n{}：data_format 是字符串，不是整数。",
                stamp.display()
            )),
            "{}",
            run.asked[0].text
        );
        assert_eq!(run.followed, vec![FollowUp::Reveal(stamp)]);
        assert_eq!(snapshot(tmp.path()), before);
    }

    /// 号要往上抬、数据目录也说写得进去，记号却写不成：拦下，「是」打开数据目录（记号还不存在）。这里数据目录的
    /// 位置被一个文件占着：Windows 上隔着文件读记号报找不到路径，记号按缺失算，才走得到写这一步。
    #[cfg(windows)]
    #[test]
    fn a_stamp_that_cannot_be_written_exits_after_one_dialog_and_offers_the_data_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("Petalfall");
        std::fs::write(&root, b"").unwrap();
        let before = snapshot(tmp.path());

        let run = run(Ok(resolution(&root, None)), 2, true);

        assert_eq!(run.gate, Gate::Exit);
        assert_eq!(run.asked.len(), 1);
        assert!(
            run.asked[0].text.starts_with(&format!(
                "{APP_NAME}没能记下数据格式\n\n{}：",
                root.join(STAMP_FILE).display()
            )),
            "{}",
            run.asked[0].text
        );
        assert_eq!(run.followed, vec![FollowUp::OpenFolder(root)]);
        assert_eq!(snapshot(tmp.path()), before);
    }

    /// 号不高于这一版时放行、不弹对话框；号低时把记号抬上去，写进的 `written_by` 是这一版的版本号。
    #[test]
    fn a_data_root_at_or_below_this_format_opens_without_a_dialog() {
        for (own, stamp, written) in [
            (1, None, None),
            (
                2,
                Some(r#"{"data_format":2}"#),
                Some(r#"{"data_format":2}"#),
            ),
            (
                2,
                None,
                Some(r#"{"data_format":2,"written_by":"1.0.0-beta.5"}"#),
            ),
            (
                3,
                Some(r#"{"data_format":2,"written_by":"1.0.0-beta.2"}"#),
                Some(r#"{"data_format":3,"written_by":"1.0.0-beta.5"}"#),
            ),
        ] {
            let tmp = data_root_with(stamp);
            let case = format!("本版 {own}，记号 {stamp:?}");

            let run = run(Ok(resolution(tmp.path(), None)), own, true);

            assert_eq!(run.gate, Gate::Open, "{case}");
            assert!(run.asked.is_empty(), "{case}");
            assert!(run.followed.is_empty(), "{case}");
            assert_eq!(
                std::fs::read_to_string(tmp.path().join(STAMP_FILE))
                    .ok()
                    .as_deref(),
                written,
                "{case}"
            );
            let names: Vec<PathBuf> = snapshot(tmp.path()).into_keys().collect();
            let mut expected = vec![PathBuf::from("config.json")];
            if written.is_some() {
                expected.push(PathBuf::from(STAMP_FILE));
            }
            assert_eq!(names, expected, "{case}");
            assert_eq!(
                std::fs::read(tmp.path().join("config.json")).unwrap(),
                CONFIG
            );
        }
    }

    /// 数据目录整个写不进去：号低也不抬，照常放行，不弹对话框。
    #[test]
    fn an_unwritable_data_root_opens_without_raising_the_stamp() {
        for stamp in [None, Some(r#"{"data_format":1}"#)] {
            let tmp = data_root_with(stamp);
            let before = snapshot(tmp.path());

            let run = run(
                Ok(resolution(tmp.path(), Some("拒绝访问。 (os error 5)"))),
                2,
                true,
            );

            assert_eq!(run.gate, Gate::Open, "{stamp:?}");
            assert!(run.asked.is_empty(), "{stamp:?}");
            assert_eq!(snapshot(tmp.path()), before, "{stamp:?}");
        }
    }

    /// 数据目录定位不到时不在这里拦：构造门面时会以同一个错误终止启动。
    #[test]
    fn a_data_root_that_cannot_be_located_is_left_to_the_facade() {
        let run = run(Err(petalfall_base::Error::MissingLocalAppData), 2, true);

        assert_eq!(run.gate, Gate::Open);
        assert!(run.asked.is_empty());
        assert!(run.followed.is_empty());
    }

    /// 关卡在 `run()` 里的位置单测里走不到（要真的启动），钉住源码：等上一个实例退出之后才核对，同一数据目录上不会
    /// 有两个进程同时抬号；判定自更新、构造门面读配置都排在它后面；拦下时 `run()` 直接返回。
    #[test]
    fn run_checks_the_data_root_after_the_single_instance_wait_and_before_detect_support() {
        let (source, _) = include_str!("lib.rs")
            .split_once("#[cfg(test)]")
            .expect("lib.rs 里应有测试模块");
        let source = source.replace("\r\n", "\n");
        let at = |needle: &str| {
            source
                .find(needle)
                .unwrap_or_else(|| panic!("lib.rs 里找不到 {needle}"))
        };
        let gate = "    if data_gate::check_on_startup(&context.package_info().version) == data_gate::Gate::Exit {\n        return;\n    }\n";

        assert_eq!(source.matches("data_gate::check_on_startup(").count(), 1);
        let claim = at("single_instance::claim()");
        let waited = at("single_instance::Instance::waited_for_exit");
        let checked = at(gate);
        let detect = at("commands::updater::detect_support(");
        let load = at("Petalfall::load_recovering()");
        assert!(
            claim < waited && waited < checked,
            "关卡要在等上一个实例退出之后"
        );
        assert!(
            checked < detect && detect < load,
            "关卡要在判定自更新与读配置之前"
        );
    }
}
