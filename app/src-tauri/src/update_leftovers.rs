//! 清掉更新插件留在系统临时目录里的更新包。
//!
//! Windows 上插件把下好的更新包写进 `%TEMP%\{产品名}-{新版本}-updater-{6 位随机字母数字}\`，拉起后直接结束进程，
//! 目录和里面约 22 MB 的引导程序从来不删：tauri-plugin-updater 2.10.1 的 `make_temp_dir` 对目录调了 `keep`，
//! 文件的删除守卫又被 `process::exit` 跳过。引导程序就跑在这个目录里，删不掉自己，所以由之后启动的启动器来清。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use semver::Version;

/// 插件起目录名时拼在版本号和随机段之间的那段。
const DIR_MARKER: &str = "-updater-";
/// tempfile 默认的随机段长度，插件没改。
const RANDOM_LEN: usize = 6;

/// 修改时间早于这么久的才清。正在跑的引导程序的映像文件删不掉，清扫碰到会跳过；没有这层保护的只有插件写包到
/// 拉起之间那几秒（写包时文件允许删除共享），也可能是同一台机器上另一份落樱正在更新，一小时留足了余量。
pub const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Default)]
pub struct Sweep {
    pub removed: Vec<PathBuf>,
    /// 被占用或读不出属性的目录，留给下一次启动。
    pub skipped: Vec<(PathBuf, io::Error)>,
}

/// 认插件起的目录名：`{app_name}-{版本}-updater-{6 位 ASCII 字母数字}`，版本要是合法的 semver。
/// 原样比较、分大小写：插件照产品名原样起名，NTFS 保留大小写，不分大小写只会多删到别的程序起的目录。
fn is_updater_dir_name(name: &str, app_name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix(app_name)
        .and_then(|rest| rest.strip_prefix('-'))
    else {
        return false;
    };
    // 从右边切：预发布标识里也可能出现这段，随机段永远在最后
    let Some((version, random)) = rest.rsplit_once(DIR_MARKER) else {
        return false;
    };
    random.len() == RANDOM_LEN
        && random.bytes().all(|byte| byte.is_ascii_alphanumeric())
        && Version::parse(version).is_ok()
}

/// 清掉 `temp_root` 下插件给 `app_name` 留下、修改时间早于 [`STALE_AFTER`] 的目录。`now` 由调用方给，时间边界才测得了。
pub fn sweep(temp_root: &Path, app_name: &str, now: SystemTime) -> io::Result<Sweep> {
    let mut sweep = Sweep::default();
    for entry in fs::read_dir(temp_root)? {
        let entry = entry?;
        let ours = entry
            .file_name()
            .to_str()
            .is_some_and(|name| is_updater_dir_name(name, app_name));
        if !ours {
            continue;
        }
        // 联接点和符号链接的 is_dir 是假：只删插件建的目录，不顺着链接走到别处
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(err) => {
                sweep.skipped.push((path, err));
                continue;
            }
        };
        if now
            .duration_since(modified)
            .is_ok_and(|age| age >= STALE_AFTER)
        {
            match fs::remove_dir_all(&path) {
                Ok(()) => sweep.removed.push(path),
                Err(err) => sweep.skipped.push((path, err)),
            }
        }
    }
    Ok(sweep)
}

/// 启动时在后台清一次。插件用的是系统临时目录，这里也是。结果只进日志：残留只占空间，这次清不掉的下次启动再清。
pub fn sweep_in_background(app_name: String) {
    tauri::async_runtime::spawn_blocking(move || {
        let temp_root = std::env::temp_dir();
        match sweep(&temp_root, &app_name, SystemTime::now()) {
            Ok(sweep) => {
                for path in &sweep.removed {
                    tracing::info!(path = %path.display(), "清掉了更新留下的安装包目录");
                }
                for (path, err) in &sweep.skipped {
                    tracing::warn!(path = %path.display(), error = %err, "更新留下的安装包目录这次没清掉");
                }
            }
            Err(err) => {
                tracing::warn!(dir = %temp_root.display(), error = %err, "清扫更新留下的安装包目录失败");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::collections::hash_map::RandomState;
    use std::collections::BTreeSet;
    use std::hash::{BuildHasher, Hasher};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    use windows::Win32::System::Threading::CREATE_NO_WINDOW;

    use super::*;

    const APP: &str = "Petalfall";
    // winnt.h 与 winbase.h 里的值：改目录的时间要 FILE_WRITE_ATTRIBUTES，目录要带 FILE_FLAG_BACKUP_SEMANTICS 才打得开
    const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

    fn random_u64() -> u64 {
        RandomState::new().build_hasher().finish()
    }

    /// 0 到约 18 小时之间的随机时长，叠在边界上测「早于多久」。
    fn random_age() -> Duration {
        Duration::from_secs(random_u64() % (18 * 60 * 60))
    }

    /// 照插件的建法起目录、放包：目录名的随机段就由 tempfile 现场生成，认名规则测的是真实产物。
    fn plugin_dir(temp: &Path, version: &str) -> PathBuf {
        let dir = tempfile::Builder::new()
            .prefix(&format!("{APP}-{version}{DIR_MARKER}"))
            .tempdir_in(temp)
            .unwrap()
            .keep();
        let len = 64 + (random_u64() % 4096) as usize;
        let bytes: Vec<u8> = (0..len).map(|_| random_u64() as u8).collect();
        fs::write(dir.join(format!("{APP}-{version}-installer.exe")), bytes).unwrap();
        dir
    }

    /// 把目录的修改时间拨到 `now` 之前 `age`：一次清扫里要同时有过期的和新鲜的。
    fn backdate(path: &Path, now: SystemTime, age: Duration) {
        fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .unwrap()
            .set_modified(now - age)
            .unwrap();
    }

    fn names(paths: &[PathBuf]) -> BTreeSet<String> {
        paths
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    fn name_of(path: &Path) -> String {
        path.file_name().unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn names_follow_what_the_plugin_builds() {
        for name in [
            "Petalfall-0.1.0-dev.18-updater-aB3xZ9",
            "Petalfall-1.0.0-updater-000000",
            "Petalfall-1.2.3+build.7-updater-Zz09aA",
            // 预发布标识里含这段时，从右边切才对得上
            "Petalfall-1.0.0-updater-x-updater-abcdef",
        ] {
            assert!(is_updater_dir_name(name, APP), "{name}");
        }
        for name in [
            "petalfall-0.1.0-dev.18-updater-aB3xZ9",
            "Petalfall0.1.0-updater-aB3xZ9",
            "Aurora-0.1.0-dev.18-updater-aB3xZ9",
            "Petalfall-Setup-aB3xZ9",
            "Petalfall-latest-updater-aB3xZ9",
            "Petalfall--updater-aB3xZ9",
            "Petalfall-0.1.0-updater-aB3xZ",
            "Petalfall-0.1.0-updater-aB3xZ9a",
            "Petalfall-0.1.0-updater-aB3-Z9",
            "Petalfall-0.1.0-installer.exe",
            "Petalfall-0.1.0-dev.18-updater-",
        ] {
            assert!(!is_updater_dir_name(name, APP), "{name}");
        }
    }

    #[test]
    fn sweep_removes_only_stale_updater_dirs_of_this_app() {
        let temp = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let stale = plugin_dir(temp.path(), "0.1.0-dev.13");
        let older = plugin_dir(temp.path(), "0.1.0-dev.18");
        let at_edge = plugin_dir(temp.path(), "0.1.0-dev.19");
        let fresh = plugin_dir(temp.path(), "0.1.0-dev.20");
        let just_now = plugin_dir(temp.path(), "0.1.0-dev.20");
        backdate(&stale, now, STALE_AFTER * 24 * 30 + random_age());
        backdate(&older, now, STALE_AFTER + random_age());
        backdate(&at_edge, now, STALE_AFTER);
        backdate(&fresh, now, STALE_AFTER - Duration::from_secs(1));

        let mut kept = Vec::new();
        for name in [
            "Aurora-0.1.0-dev.18-updater-aB3xZ9",
            "petalfall-0.1.0-dev.18-updater-aB3xZ9",
            "Petalfall-Setup-aB3xZ9",
            "Petalfall-latest-updater-aB3xZ9",
        ] {
            let dir = temp.path().join(name);
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("keep.txt"), b"not ours").unwrap();
            backdate(&dir, now, STALE_AFTER * 2 + random_age());
            kept.push(dir);
        }
        let file = temp.path().join("Petalfall-0.1.0-dev.18-updater-fILe00");
        fs::write(&file, b"a file, not a directory").unwrap();
        // 拨旧了才走得到类型判断，否则年龄那一关就放过了
        backdate(&file, now, STALE_AFTER * 2 + random_age());
        kept.push(file);

        let sweep = sweep(temp.path(), APP, now).unwrap();

        assert_eq!(
            names(&sweep.removed),
            names(&[stale.clone(), older.clone(), at_edge.clone()])
        );
        assert!(sweep.skipped.is_empty(), "{:?}", sweep.skipped);
        for gone in [&stale, &older, &at_edge] {
            assert!(!gone.exists(), "{}", name_of(gone));
        }
        for left in kept.iter().chain([&fresh, &just_now]) {
            assert!(left.exists(), "{}", name_of(left));
        }
    }

    #[test]
    fn sweep_skips_a_stale_dir_whose_installer_is_still_running() {
        // cmd.exe 的副本代替引导程序：要证明正在运行的映像删不掉，又不能碰真实安装包
        let cmd = Path::new(&std::env::var_os("SystemRoot").unwrap()).join(r"System32\cmd.exe");
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("Petalfall-0.1.0-dev.19-updater-Run123");
        fs::create_dir(&dir).unwrap();
        let installer = dir.join("Petalfall-0.1.0-dev.19-installer.exe");
        fs::copy(cmd, &installer).unwrap();
        let now = SystemTime::now();
        backdate(&dir, now, STALE_AFTER + random_age());
        // /k 读着管道等输入，直到被杀
        let mut running = Command::new(&installer)
            .args(["/d", "/k"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW.0)
            .spawn()
            .unwrap();

        let busy = sweep(temp.path(), APP, now).unwrap();
        running.kill().unwrap();
        running.wait().unwrap();

        assert!(busy.removed.is_empty());
        assert_eq!(busy.skipped.len(), 1);
        assert_eq!(busy.skipped[0].0, dir);
        assert!(installer.exists());

        let after_exit = sweep(temp.path(), APP, now).unwrap();
        assert_eq!(after_exit.removed, vec![dir.clone()]);
        assert!(!dir.exists());
    }

    #[test]
    fn sweep_does_not_follow_a_junction_named_like_an_updater_dir() {
        let temp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        fs::write(elsewhere.path().join("keep.txt"), b"not ours").unwrap();
        let junction = temp.path().join("Petalfall-0.1.0-dev.18-updater-Link00");
        // 建联接点不要管理员权限，符号链接要
        let status = Command::new("cmd")
            .arg("/c")
            .arg("mklink")
            .arg("/J")
            .arg(&junction)
            .arg(elsewhere.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW.0)
            .status()
            .unwrap();
        assert!(status.success());
        let now = SystemTime::now() + STALE_AFTER * 2 + random_age();

        let sweep = sweep(temp.path(), APP, now).unwrap();

        assert!(sweep.removed.is_empty());
        assert!(fs::symlink_metadata(&junction).is_ok(), "联接点本身也留着");
        assert!(elsewhere.path().join("keep.txt").exists());
    }

    #[test]
    fn sweep_on_a_missing_root_is_an_error() {
        let temp = tempfile::tempdir().unwrap();

        assert!(sweep(&temp.path().join("gone"), APP, SystemTime::now()).is_err());
    }
}
