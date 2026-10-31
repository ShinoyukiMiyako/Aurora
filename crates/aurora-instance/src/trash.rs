//! 把实例文件夹移入回收站。
//!
//! 删除实例会连同其中的存档一起带走，所以不直接 `remove_dir_all`，而是交给系统回收站，误删还能找回。
//! 删除方式经 [`Disposer`] 注入：生产用 [`RecycleBin`]，测试换成移到临时目录的实现，跑测试不会往
//! 开发者自己的回收站里塞东西。

use std::path::Path;

use crate::error::{Error, Result};

/// 处置一个要删除的实例文件夹。在阻塞线程池上调用，实现可以直接做同步 IO 与系统调用。
pub trait Disposer: Send + Sync {
    fn dispose(&self, dir: &Path) -> Result<()>;
}

/// 系统回收站。
pub struct RecycleBin;

impl Disposer for RecycleBin {
    fn dispose(&self, dir: &Path) -> Result<()> {
        recycle(dir)
    }
}

#[cfg(windows)]
fn recycle(dir: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FOF_WANTNUKEWARNING, SHFILEOPSTRUCTW, SHFileOperationW,
    };

    // SHFileOperationW 只认不带 \\?\ 前缀的绝对路径，且 pFrom 是以两个 NUL 结尾的多串列表。
    if !dir.is_absolute() {
        return Err(Error::Recycle {
            path: dir.to_path_buf(),
            reason: "回收站只接受绝对路径".into(),
        });
    }
    let mut from: Vec<u16> = dir.as_os_str().encode_wide().collect();
    from.extend([0, 0]);

    // FOF_NOCONFIRMATION 免去「确定要移到回收站吗」；FOF_WANTNUKEWARNING 让系统在放不进回收站
    // （文件夹超过回收站容量、所在磁盘没有回收站）时先问用户，而不是一声不响地永久删除。
    let flags =
        FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_WANTNUKEWARNING | FOF_NOERRORUI | FOF_SILENT;
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        fFlags: flags as u16,
        ..Default::default()
    };
    // SAFETY: op 的各指针字段要么为空，要么指向本函数内存活的 from 缓冲；调用同步完成。
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(Error::Recycle {
            path: dir.to_path_buf(),
            reason: format!("系统返回错误码 0x{code:X}"),
        });
    }
    if op.fAnyOperationsAborted != 0 {
        return Err(Error::Recycle {
            path: dir.to_path_buf(),
            reason: "移入回收站的操作被取消".into(),
        });
    }
    Ok(())
}

#[cfg(not(windows))]
fn recycle(dir: &Path) -> Result<()> {
    Err(Error::Recycle {
        path: dir.to_path_buf(),
        reason: "当前平台不支持移入回收站".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真的往回收站里放一个临时文件夹。会在开发者的回收站里留下一项，默认不跑：
    /// `cargo test -p aurora-instance -- --ignored recycle_bin` 手动验证系统调用。
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn recycle_bin_moves_a_directory_out_of_place() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("petalfall-recycle-test");
        std::fs::create_dir_all(dir.join("saves")).unwrap();
        std::fs::write(dir.join("saves").join("level.dat"), b"x").unwrap();
        RecycleBin.dispose(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn relative_paths_are_refused() {
        let err = RecycleBin.dispose(Path::new("versions/x")).unwrap_err();
        assert!(matches!(err, Error::Recycle { .. }));
    }
}
