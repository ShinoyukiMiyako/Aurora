//! 安装前读数据格式记号：这台电脑上的数据要是被更新的版本用过，手里这个安装包就不能装。
//!
//! 难的是数据在哪。启动器选数据根的规则在 `petalfall-base` 的 `fs::choose_data_root`：exe 所在目录（也就是
//! 登记的安装目录）写得进就用它；写不进但里面有读得进来的 config.json，仍用它；否则落到
//! `%LOCALAPPDATA%\Petalfall`。引导程序不依赖 `petalfall-base`，这里照同一套规则另写一份，两边必须一起改，
//! 否则引导程序看的不是启动器要打开的那份数据。
//!
//! 引导程序与启动器以同一个 Windows 用户运行，在同一个目录上探针的结论一般相同；提权运行时可能不同，那种少见
//! 情形由启动器启动时那一关兜底。启动器会落到 `%LOCALAPPDATA%\Petalfall` 的那种情形下两处都读、取较大的号：
//! 一次探针失败证明不了数据不在登记目录，找不准时宁可多看一处。首装还没有登记目录，装好后数据根就是选定的
//! 目标目录，只读它。
//!
//! 引导程序从不写记号，号低于安装包认得的号与相等一样放行。游戏目录不在这里读，由启动器用到时把关。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use petalfall_release::data_format::{
    STAMP_FILE, StampFile, StampRead, StampVerdict, judge_stamp, merge_roots, parse_stamp,
};
use petalfall_release::install_policy;

use crate::contract::DataBlock;
use crate::existing::CONFIG_FILE;
use crate::target::{APP_FOLDER, probe_write};

/// 数据关的结论，连同为它读过哪些根。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataGate {
    /// 读过的数据根，按读的顺序。
    pub roots: Vec<PathBuf>,
    /// 定下结论的那个记号文件：有读不懂的就是第一个读不懂的，否则是号最大的（号相同取靠前的）。
    pub stamp: PathBuf,
    /// 那个记号与安装包认得的号比出的结论。`Raise` 与 `Pass` 一样放行。
    pub verdict: StampVerdict,
    /// 被拦时交给界面的详情，放行时为 `None`。
    pub block: Option<DataBlock>,
    /// 为什么连 `%LOCALAPPDATA%\Petalfall` 也读了：探针失败的原文，config.json 读不进来时连同它的原因。
    /// 只读一个根时为 `None`。
    pub fallback_reason: Option<String>,
}

/// 已有安装（含程序文件残缺）时的数据关。`registered` 是登记的安装目录，`local_app_data` 是
/// `%LOCALAPPDATA%`，`supported` 是安装包认得的号（生产传 `DATA_FORMAT`）。
///
/// 探针与选目录时的写入探针是同一个：在登记目录里建一个随机名的目录、写一个文件，再全删掉。
pub fn inspect_installed(registered: &Path, local_app_data: &Path, supported: u32) -> DataGate {
    inspect_installed_with(registered, local_app_data, supported, probe_write)
}

/// 首装时的数据关：只读最终目标目录 `target`，也就是目录校验给出的 `normalized`（含追加的产品名子目录）。
pub fn inspect_target(target: &Path, supported: u32) -> DataGate {
    judge_roots(vec![target.to_path_buf()], supported, None)
}

fn inspect_installed_with(
    registered: &Path,
    local_app_data: &Path,
    supported: u32,
    probe: impl FnOnce(&Path) -> io::Result<()>,
) -> DataGate {
    let registered = registered.to_path_buf();
    // 启动器在探针失败、目录里又有配置时会再探几次，但不论成败都留在这个目录，所以这里探一次就够
    let failure = match probe(&registered) {
        Ok(()) => return judge_roots(vec![registered], supported, None),
        Err(failure) => failure,
    };
    let reason = format!("{} 不可写：{failure}", registered.display());
    let reason = match has_readable_config(&registered) {
        Ok(true) => return judge_roots(vec![registered], supported, None),
        Ok(false) => reason,
        Err(err) => format!("{reason}；{CONFIG_FILE} 读不进来：{err}"),
    };
    let fallback = local_app_data.join(APP_FOLDER);
    judge_roots(vec![registered, fallback], supported, Some(reason))
}

fn judge_roots(roots: Vec<PathBuf>, supported: u32, fallback_reason: Option<String>) -> DataGate {
    let reads = roots.iter().map(|root| {
        let stamp = root.join(STAMP_FILE);
        let read = read_stamp(&stamp);
        (stamp, read)
    });
    let (stamp, read) = merge_roots(reads).expect("至少有一个数据根");
    let verdict = judge_stamp(&read, supported);
    let block = install_policy::DataBlock::from_verdict(&verdict).map(|block| {
        DataBlock::from_policy(block, stamp.to_string_lossy().into_owned(), supported)
    });
    DataGate {
        roots,
        stamp,
        verdict,
        block,
        fallback_reason,
    }
}

/// 文件不存在、所在的目录不存在都算没有记号：数据根还没建出来，自然没被号更高的版本碰过。
fn read_stamp(stamp: &Path) -> StampRead {
    match fs::read(stamp) {
        Ok(bytes) => parse_stamp(StampFile::Contents(&bytes)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => parse_stamp(StampFile::Missing),
        Err(err) => parse_stamp(StampFile::ReadFailed(err.to_string())),
    }
}

/// 与启动器的 `has_readable_config` 同一判据：文件不在是 `false`，读不出来或不是合法 JSON 报错。
/// 报错与 `false` 在这里结论相同：启动器都会落到 `%LOCALAPPDATA%\Petalfall`。
fn has_readable_config(dir: &Path) -> io::Result<bool> {
    let bytes = match fs::read(dir.join(CONFIG_FILE)) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    serde_json::from_slice::<serde_json::Value>(&bytes)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use petalfall_release::data_format::{DATA_FORMAT, stamp_contents};

    use super::*;
    use crate::contract::{Channel, DataProblem};

    /// 缺 `data_format` 的记号：读不懂，原因是固定的一句话。
    const NO_NUMBER: &str = r#"{"written_by":"1.0.0"}"#;

    /// 一台假电脑：登记的安装目录与 `%LOCALAPPDATA%` 都落在同一个临时目录里，回落的数据根还没建出来。
    struct Machine {
        _temp: tempfile::TempDir,
        registered: PathBuf,
        local_app_data: PathBuf,
    }

    impl Machine {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let registered = temp.path().join("Games").join("Petalfall");
            let local_app_data = temp.path().join("LocalAppData");
            fs::create_dir_all(&registered).unwrap();
            fs::create_dir_all(&local_app_data).unwrap();
            Self {
                _temp: temp,
                registered,
                local_app_data,
            }
        }

        /// 启动器写不进 exe 旁边时用的数据根，名字照启动器写死，不取引导程序的常量。
        fn fallback(&self) -> PathBuf {
            self.local_app_data.join("Petalfall")
        }

        fn inspect(&self, supported: u32, probe: impl FnOnce(&Path) -> io::Result<()>) -> DataGate {
            inspect_installed_with(&self.registered, &self.local_app_data, supported, probe)
        }
    }

    /// 固定种子的 xorshift64，失败时能原样重现。
    struct Seeded(u64);

    impl Seeded {
        fn below(&mut self, bound: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % bound
        }
    }

    fn put(root: &Path, name: &str, contents: &str) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join(name), contents).unwrap();
    }

    fn put_stamp(root: &Path, data_format: u32, written_by: Option<&str>) {
        put(root, STAMP_FILE, &stamp_contents(data_format, written_by));
    }

    fn stamp_of(root: &Path) -> PathBuf {
        root.join(STAMP_FILE)
    }

    fn text(path: &Path) -> String {
        path.to_str().unwrap().to_owned()
    }

    fn denied(_: &Path) -> io::Result<()> {
        Err(io::Error::from_raw_os_error(5))
    }

    fn denied_reason(dir: &Path) -> String {
        format!(
            "{} 不可写：{}",
            dir.display(),
            io::Error::from_raw_os_error(5)
        )
    }

    fn too_new(
        path: &Path,
        recorded: u32,
        supported: u32,
        by: Option<(&str, Channel)>,
    ) -> DataBlock {
        DataBlock {
            problem: DataProblem::TooNew,
            path: text(path),
            recorded: Some(recorded),
            supported,
            reason: None,
            written_by: by.map(|(version, _)| version.to_owned()),
            written_by_channel: by.map(|(_, channel)| channel),
        }
    }

    fn unreadable(path: &Path, supported: u32, reason: &str) -> DataBlock {
        DataBlock {
            problem: DataProblem::Unreadable,
            path: text(path),
            recorded: None,
            supported,
            reason: Some(reason.to_owned()),
            written_by: None,
            written_by_channel: None,
        }
    }

    #[test]
    fn a_writable_registered_dir_is_the_only_root_read() {
        let machine = Machine::new();
        put_stamp(&machine.registered, 3, Some("1.2.0-dev.4"));
        // 回落的根里放一份读不懂的记号：读了它，结论就会变成读不懂
        put(&machine.fallback(), STAMP_FILE, NO_NUMBER);
        let probed = RefCell::new(Vec::new());

        let gate = machine.inspect(2, |dir| {
            probed.borrow_mut().push(dir.to_owned());
            Ok(())
        });

        assert_eq!(probed.into_inner(), vec![machine.registered.clone()]);
        assert_eq!(gate.roots, vec![machine.registered.clone()]);
        assert_eq!(gate.stamp, stamp_of(&machine.registered));
        assert_eq!(
            gate.verdict,
            StampVerdict::TooNew {
                found: 3,
                written_by: Some("1.2.0-dev.4".to_owned()),
            }
        );
        assert_eq!(
            gate.block,
            Some(too_new(
                &stamp_of(&machine.registered),
                3,
                2,
                Some(("1.2.0-dev.4", Channel::Dev))
            ))
        );
        assert_eq!(gate.fallback_reason, None);
    }

    #[test]
    fn an_unwritable_registered_dir_with_a_readable_config_is_the_only_root_read() {
        // 启动器只要求是合法 JSON，不管是不是对象
        for config in ["{}", r#"{"update_channel":"beta"}"#, "[]", "null"] {
            let machine = Machine::new();
            put(&machine.registered, CONFIG_FILE, config);
            put(&machine.fallback(), STAMP_FILE, NO_NUMBER);

            let gate = machine.inspect(1, denied);

            assert_eq!(gate.roots, vec![machine.registered.clone()], "{config}");
            assert_eq!(gate.stamp, stamp_of(&machine.registered), "{config}");
            assert_eq!(gate.verdict, StampVerdict::Pass, "{config}");
            assert_eq!(gate.block, None, "{config}");
            assert_eq!(gate.fallback_reason, None, "{config}");
        }
    }

    #[test]
    fn an_unwritable_registered_dir_without_config_reads_both_and_takes_the_larger() {
        // (登记目录的号, 回落的根的号)：较大的在哪一处都取它，written_by 也跟着它
        for (in_registered, in_fallback) in [(2, 4), (4, 2)] {
            let machine = Machine::new();
            put_stamp(&machine.registered, in_registered, Some("1.0.0-beta.2"));
            put_stamp(&machine.fallback(), in_fallback, Some("1.1.0"));

            let gate = machine.inspect(3, denied);

            let (decisive, by) = if in_registered > in_fallback {
                (machine.registered.clone(), ("1.0.0-beta.2", Channel::Beta))
            } else {
                (machine.fallback(), ("1.1.0", Channel::Stable))
            };
            assert_eq!(
                gate.roots,
                vec![machine.registered.clone(), machine.fallback()]
            );
            assert_eq!(gate.stamp, stamp_of(&decisive));
            assert_eq!(
                gate.block,
                Some(too_new(&stamp_of(&decisive), 4, 3, Some(by)))
            );
            assert_eq!(
                gate.fallback_reason,
                Some(denied_reason(&machine.registered))
            );
        }
    }

    #[test]
    fn both_roots_read_pass_when_neither_is_above_the_package() {
        let machine = Machine::new();
        put_stamp(&machine.registered, 2, None);

        let gate = machine.inspect(2, denied);

        assert_eq!(
            gate.roots,
            vec![machine.registered.clone(), machine.fallback()]
        );
        assert_eq!(gate.stamp, stamp_of(&machine.registered));
        assert_eq!(gate.verdict, StampVerdict::Pass);
        assert_eq!(gate.block, None);
    }

    #[test]
    fn a_config_the_launcher_cannot_read_does_not_keep_the_registered_dir() {
        let not_json = Machine::new();
        put(&not_json.registered, CONFIG_FILE, "{");
        put_stamp(&not_json.fallback(), 2, None);

        let gate = not_json.inspect(1, denied);

        assert_eq!(
            gate.roots,
            vec![not_json.registered.clone(), not_json.fallback()]
        );
        assert_eq!(
            gate.block,
            Some(too_new(&stamp_of(&not_json.fallback()), 2, 1, None))
        );
        let parse_error = serde_json::from_slice::<serde_json::Value>(b"{").unwrap_err();
        assert_eq!(
            gate.fallback_reason,
            Some(format!(
                "{}；config.json 读不进来：{}",
                denied_reason(&not_json.registered),
                io::Error::from(parse_error)
            ))
        );

        // 同名的是个目录：读不出来，与启动器一样当作没有配置
        let a_folder = Machine::new();
        fs::create_dir(a_folder.registered.join(CONFIG_FILE)).unwrap();

        let gate = a_folder.inspect(1, denied);

        assert_eq!(
            gate.roots,
            vec![a_folder.registered.clone(), a_folder.fallback()]
        );
        assert_eq!(
            gate.fallback_reason,
            Some(format!(
                "{}；config.json 读不进来：{}",
                denied_reason(&a_folder.registered),
                io::Error::from_raw_os_error(5)
            ))
        );
    }

    #[test]
    fn an_unreadable_stamp_in_either_root_blocks() {
        // 读不懂的在登记目录：回落的根号再大也不看
        let machine = Machine::new();
        put(&machine.registered, STAMP_FILE, NO_NUMBER);
        put_stamp(&machine.fallback(), 9, Some("2.0.0"));

        let gate = machine.inspect(3, denied);

        assert_eq!(gate.stamp, stamp_of(&machine.registered));
        assert_eq!(
            gate.verdict,
            StampVerdict::Unreadable {
                reason: "缺 data_format".to_owned()
            }
        );
        assert_eq!(
            gate.block,
            Some(unreadable(
                &stamp_of(&machine.registered),
                3,
                "缺 data_format"
            ))
        );

        // 读不懂的在回落的根：登记目录读得懂也拦
        let machine = Machine::new();
        put_stamp(&machine.registered, 1, None);
        put(&machine.fallback(), STAMP_FILE, "[1]");

        let gate = machine.inspect(3, denied);

        assert_eq!(gate.stamp, stamp_of(&machine.fallback()));
        assert_eq!(
            gate.block,
            Some(unreadable(
                &stamp_of(&machine.fallback()),
                3,
                "不是 JSON 对象，而是数组"
            ))
        );
    }

    #[test]
    fn a_stamp_that_cannot_be_read_off_the_disk_blocks_with_the_system_error() {
        let machine = Machine::new();
        fs::create_dir(stamp_of(&machine.registered)).unwrap();

        let gate = machine.inspect(DATA_FORMAT, |_| Ok(()));

        let reason = format!("读文件出错：{}", io::Error::from_raw_os_error(5));
        assert_eq!(
            gate.block,
            Some(unreadable(
                &stamp_of(&machine.registered),
                DATA_FORMAT,
                &reason
            ))
        );
    }

    #[test]
    fn the_real_probe_keeps_a_writable_registered_dir_alone_and_leaves_nothing_behind() {
        let machine = Machine::new();
        put(&machine.fallback(), STAMP_FILE, NO_NUMBER);

        let gate = inspect_installed(&machine.registered, &machine.local_app_data, DATA_FORMAT);

        assert_eq!(gate.roots, vec![machine.registered.clone()]);
        assert_eq!(gate.verdict, StampVerdict::Pass);
        assert_eq!(gate.block, None);
        assert_eq!(fs::read_dir(&machine.registered).unwrap().count(), 0);
    }

    #[test]
    fn missing_roots_count_as_format_one() {
        let temp = tempfile::tempdir().unwrap();
        // 登记了却已经不在的目录：真探针写不进去，于是两处都读，两处都没有记号
        let registered = temp.path().join("removed");
        let local_app_data = temp.path().join("LocalAppData");
        let fallback = local_app_data.join("Petalfall");

        for (supported, verdict) in [(1, StampVerdict::Pass), (2, StampVerdict::Raise)] {
            let gate = inspect_installed(&registered, &local_app_data, supported);

            assert_eq!(gate.roots, vec![registered.clone(), fallback.clone()]);
            assert_eq!(gate.stamp, stamp_of(&registered));
            assert_eq!(gate.verdict, verdict);
            assert_eq!(gate.block, None);
            let prefix = format!("{} 不可写：", registered.display());
            let reason = gate.fallback_reason.unwrap();
            assert!(reason.starts_with(&prefix), "{reason}");
        }
        assert!(!registered.exists());
    }

    #[test]
    fn a_fresh_install_reads_only_the_target() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("Games");
        let target = parent.join("Petalfall");
        // 上一层是用户选的文件夹，追加了子目录之后就不是数据根了
        put(&parent, STAMP_FILE, NO_NUMBER);

        let gate = inspect_target(&target, 1);

        assert_eq!(gate.roots, vec![target.clone()]);
        assert_eq!(gate.stamp, stamp_of(&target));
        assert_eq!(gate.verdict, StampVerdict::Pass);
        assert_eq!(gate.block, None);
        assert_eq!(gate.fallback_reason, None);

        put_stamp(&target, 2, Some("1.0.0-dev.3"));

        let gate = inspect_target(&target, 1);

        assert_eq!(
            gate.block,
            Some(too_new(
                &stamp_of(&target),
                2,
                1,
                Some(("1.0.0-dev.3", Channel::Dev))
            ))
        );
    }

    #[test]
    fn blocked_exactly_when_the_recorded_format_is_above_the_package() {
        let edges = [
            (1, 1),
            (1, 2),
            (2, 1),
            (2, 2),
            (1, u32::MAX),
            (u32::MAX, 1),
            (u32::MAX - 1, u32::MAX),
            (u32::MAX, u32::MAX - 1),
            (u32::MAX, u32::MAX),
        ];
        let mut seeded = Seeded(0x5EED_DA7A_F0F0_0001);
        let drawn: Vec<(u32, u32)> = (0..40)
            .map(|_| (1 + seeded.below(6) as u32, 1 + seeded.below(6) as u32))
            .collect();

        for (recorded, supported) in edges.into_iter().chain(drawn) {
            let machine = Machine::new();
            put_stamp(&machine.registered, recorded, Some("1.0.0"));

            let gate = machine.inspect(supported, |_| Ok(()));

            let case = format!("记号 {recorded}，安装包 {supported}");
            if recorded > supported {
                assert_eq!(
                    gate.block,
                    Some(too_new(
                        &stamp_of(&machine.registered),
                        recorded,
                        supported,
                        Some(("1.0.0", Channel::Stable))
                    )),
                    "{case}"
                );
            } else {
                let verdict = if recorded == supported {
                    StampVerdict::Pass
                } else {
                    StampVerdict::Raise
                };
                assert_eq!(gate.verdict, verdict, "{case}");
                assert_eq!(gate.block, None, "{case}");
            }
        }
    }

    #[test]
    fn written_by_that_is_not_a_release_version_leaves_both_fields_empty() {
        let too_long = format!("1.2.0-dev.{}", "1".repeat(39));
        assert_eq!(too_long.len(), 49);
        for raw in [
            "1.2.0-rc.1",
            "1.2.0+build.5",
            "01.2.0",
            "1.2.0-DEV.3",
            "v1.2.0",
            "",
            "https://example.invalid/1.2.0",
            too_long.as_str(),
        ] {
            let machine = Machine::new();
            put_stamp(&machine.registered, 5, Some(raw));

            let gate = machine.inspect(4, |_| Ok(()));

            assert_eq!(
                gate.block,
                Some(too_new(&stamp_of(&machine.registered), 5, 4, None)),
                "{raw:?}"
            );
        }

        // 不是字符串的 written_by 同样当作没有，记号照常有效
        let machine = Machine::new();
        put(
            &machine.registered,
            STAMP_FILE,
            r#"{"data_format":5,"written_by":7}"#,
        );

        let gate = machine.inspect(4, |_| Ok(()));

        assert_eq!(
            gate.block,
            Some(too_new(&stamp_of(&machine.registered), 5, 4, None))
        );
    }
}
