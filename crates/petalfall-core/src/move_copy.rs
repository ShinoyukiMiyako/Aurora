//! 移动实例用的文件搬运：盘点目录树、带校验的复制、读回比对、判断是否同卷与删整棵树。
//!
//! 全是阻塞函数，调用方放进 `spawn_blocking`。跨盘移动时实例目录与存档备份先整份复制进目标盘的暂存目录，
//! 读回比对通过才提交，所以这里的复制只管写对、写稳（每个文件落盘），失败时不清理：暂存由调用方整个删掉。
//! 符号链接与目录联接一律不跟随：跟进去可能走出实例目录，复制或删除到别处去。

use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};

use crate::CancellationToken;
use crate::error::{CoreError, Result};

/// 读写块的大小。取消与进度都按块走：块太大取消不及时，太小系统调用变多。
const CHUNK: usize = 1 << 20;

/// 目录树里的一个普通文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TreeFile {
    /// 相对树根的路径。
    pub rel: PathBuf,
    pub size: u64,
}

/// 一棵目录树的盘点：文件（相对路径与大小）、目录（相对路径，父在前，含空目录）、链接（符号链接与目录联接，
/// 相对路径，遇到不下钻也不算进文件）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TreeScan {
    pub files: Vec<TreeFile>,
    pub dirs: Vec<PathBuf>,
    pub links: Vec<PathBuf>,
    pub total_bytes: u64,
}

/// 根目录必须存在且是目录（本身是链接也算链接：报进 links，rel 为空路径）。阻塞函数。
///
/// 同一目录下按文件名排序，结果与系统枚举目录的顺序无关。
pub(crate) fn scan_tree(root: &Path) -> Result<TreeScan> {
    let file_type = fs::symlink_metadata(root)
        .map_err(|source| io_error(root, source))?
        .file_type();
    let mut scan = TreeScan::default();
    if file_type.is_symlink() {
        scan.links.push(PathBuf::new());
        return Ok(scan);
    }
    if !file_type.is_dir() {
        return Err(io_error(root, ErrorKind::NotADirectory.into()));
    }
    scan_dir(root, Path::new(""), &mut scan)?;
    Ok(scan)
}

fn scan_dir(root: &Path, rel: &Path, scan: &mut TreeScan) -> Result<()> {
    let dir = root.join(rel);
    let mut entries = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|source| io_error(&dir, source))? {
        entries.push(entry.map_err(|source| io_error(&dir, source))?);
    }
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let child = rel.join(entry.file_name());
        // 类型与大小取目录枚举带回的：不跟随链接，也省掉逐个打开文件。Windows 上 is_symlink 对符号链接与
        // 目录联接都为真，is_dir、is_file 对两者都为假。
        let meta = entry.metadata().map_err(|source| io_error(&path, source))?;
        let file_type = meta.file_type();
        if file_type.is_dir() {
            scan.dirs.push(child.clone());
            scan_dir(root, &child, scan)?;
        } else if file_type.is_file() {
            scan.total_bytes += meta.len();
            scan.files.push(TreeFile {
                rel: child,
                size: meta.len(),
            });
        } else {
            // 链接之外，Unix 上的设备、管道之类同样照搬不了，一并报出，交给预检拦下。
            scan.links.push(child);
        }
    }
    Ok(())
}

pub(crate) type Sha1Digest = [u8; 20];

/// 测试注入的写后钩子，见 [`CopyControl::with_fault`]。
#[cfg(test)]
pub(crate) type Fault<'a> = dyn Fn(&Path) -> io::Result<()> + Sync + 'a;

/// 测试注入的读回钩子，见 [`CopyControl::with_readback_hook`]。
#[cfg(test)]
pub(crate) type ReadbackHook<'a> = dyn Fn(&Path, &File) -> io::Result<()> + Sync + 'a;

/// 复制与校验的取消与进度。进度回调参数是（本次新增字节, 本次新完成文件数）。
pub(crate) struct CopyControl<'a> {
    cancel: Option<&'a CancellationToken>,
    progress: &'a (dyn Fn(u64, u64) + Sync),
    #[cfg(test)]
    fault: Option<&'a Fault<'a>>,
    #[cfg(test)]
    readback: Option<&'a ReadbackHook<'a>>,
}

impl<'a> CopyControl<'a> {
    pub(crate) fn new(
        cancel: Option<&'a CancellationToken>,
        progress: &'a (dyn Fn(u64, u64) + Sync),
    ) -> Self {
        Self {
            cancel,
            progress,
            #[cfg(test)]
            fault: None,
            #[cfg(test)]
            readback: None,
        }
    }

    /// 测试注入：每个文件写完并落盘后以它写入的路径调用（copy_tree 是目标路径；copy_file 是改名前的临时文件，
    /// 这样才能测到读回比对与改名）；返回 Err 时整次复制以这个错误失败；可以改写文件制造损坏。
    #[cfg(test)]
    pub(crate) fn with_fault(mut self, fault: &'a Fault<'a>) -> Self {
        self.fault = Some(fault);
        self
    }

    /// 测试注入：读回打开文件之后、开始读之前，以文件路径和读回用的句柄调用（用来认句柄是不是绕过了系统缓存）；
    /// 返回 Err 时当作打开读回失败。
    #[cfg(all(test, windows))]
    pub(crate) fn with_readback_hook(mut self, hook: &'a ReadbackHook<'a>) -> Self {
        self.readback = Some(hook);
        self
    }

    fn check(&self) -> Result<()> {
        if self.cancel.is_some_and(CancellationToken::is_cancelled) {
            return Err(petalfall_instance::Error::Cancelled.into());
        }
        Ok(())
    }

    fn report(&self, bytes: u64, files: u64) {
        (self.progress)(bytes, files);
    }

    #[cfg(test)]
    fn written(&self, path: &Path) -> Result<()> {
        match self.fault {
            Some(fault) => fault(path).map_err(|source| io_error(path, source)),
            None => Ok(()),
        }
    }

    #[cfg(not(test))]
    fn written(&self, _path: &Path) -> Result<()> {
        Ok(())
    }

    #[cfg(test)]
    fn readback_opened(&self, path: &Path, file: &File) -> io::Result<()> {
        match self.readback {
            Some(hook) => hook(path, file),
            None => Ok(()),
        }
    }

    #[cfg(not(test))]
    fn readback_opened(&self, _path: &Path, _file: &File) -> io::Result<()> {
        Ok(())
    }
}

/// 按清单把 src_root 复制到 dst_root（dst_root 必须不存在，由这里建）。边读边算 SHA-1，每个文件 sync_all，
/// 保留文件修改时间，dst_root 的创建时间改成 src_root 的（实例库按创建时间排序）。返回顺序同 scan.files 的摘要。
/// 失败或取消时不清理 dst_root（由调用方删暂存）。
pub(crate) fn copy_tree(
    src_root: &Path,
    dst_root: &Path,
    scan: &TreeScan,
    control: &CopyControl<'_>,
) -> Result<Vec<Sha1Digest>> {
    control.check()?;
    if let Some(parent) = dst_root.parent() {
        fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
    }
    fs::create_dir(dst_root).map_err(|source| io_error(dst_root, source))?;
    for rel in &scan.dirs {
        control.check()?;
        let dir = dst_root.join(rel);
        fs::create_dir(&dir).map_err(|source| io_error(&dir, source))?;
    }
    let mut buf = vec![0u8; CHUNK];
    let mut digests = Vec::with_capacity(scan.files.len());
    for file in &scan.files {
        control.check()?;
        let src = src_root.join(&file.rel);
        let dst = dst_root.join(&file.rel);
        let output = create_new(&dst)?;
        digests.push(copy_contents(&src, output, &dst, &mut buf, control)?);
        control.written(&dst)?;
        control.report(0, 1);
    }
    copy_created(src_root, dst_root)?;
    Ok(digests)
}

/// 读回 dst_root 下清单里的文件逐个比大小与 SHA-1；不一致报 CoreError::InstanceMoveVerifyFailed { path }。
pub(crate) fn verify_tree(
    dst_root: &Path,
    scan: &TreeScan,
    digests: &[Sha1Digest],
    control: &CopyControl<'_>,
) -> Result<()> {
    // 对不上说明调用方拿错了摘要；照 zip 截短会把没比对过的文件当成比对过，直接提交出去。
    assert_eq!(
        digests.len(),
        scan.files.len(),
        "摘要与清单不是同一次复制的"
    );
    let mut buf = ReadBuf::new();
    for (file, expected) in scan.files.iter().zip(digests) {
        control.check()?;
        let path = dst_root.join(&file.rel);
        let len = fs::symlink_metadata(&path)
            .map_err(|source| io_error(&path, source))?
            .len();
        if len != file.size || hash_file(&path, &mut buf, control, true)? != *expected {
            return Err(CoreError::InstanceMoveVerifyFailed { path });
        }
        control.report(0, 1);
    }
    Ok(())
}

/// 复制单个共用文件：先写到 dst 同目录的临时名，落盘后读回比 SHA-1，再改名到 dst；父目录按需建；
/// dst 已存在报 AlreadyExists 的 Io 错误（调用方先查，竞争时才会遇到）。失败时删掉临时文件。保留修改时间。
///
/// 字节只在写入时报：读回不算进度，调用方按要补的总字节数算进度。
pub(crate) fn copy_file(src: &Path, dst: &Path, control: &CopyControl<'_>) -> Result<()> {
    control.check()?;
    match fs::symlink_metadata(dst) {
        Ok(_) => return Err(io_error(dst, ErrorKind::AlreadyExists.into())),
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(io_error(dst, err)),
    }
    let (Some(parent), Some(name)) = (dst.parent(), dst.file_name()) else {
        return Err(io_error(dst, ErrorKind::InvalidInput.into()));
    };
    fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
    let mut temp_name = name.to_owned();
    temp_name.push(format!(".{:08x}.part", fastrand::u32(..)));
    let temp = parent.join(temp_name);
    // 临时文件建不出来时什么都不删：同名的可能是别人正在写的。
    let output = create_new(&temp)?;
    let placed = place_verified(src, output, &temp, dst, control);
    if placed.is_err() {
        discard_temp(&temp);
    }
    placed?;
    control.report(0, 1);
    Ok(())
}

fn place_verified(
    src: &Path,
    output: File,
    temp: &Path,
    dst: &Path,
    control: &CopyControl<'_>,
) -> Result<()> {
    // 复制与读回共用一块缓冲：共用文件动辄上万个，每个各分配两块不值得。
    let mut buf = ReadBuf::new();
    let written = copy_contents(src, output, temp, buf.aligned(MIN_SECTOR), control)?;
    control.written(temp)?;
    // 共用目录里的文件别的实例会直接拿来用，写坏了的不能以正式文件名出现在那里。
    if hash_file(temp, &mut buf, control, false)? != written {
        return Err(CoreError::InstanceMoveVerifyFailed {
            path: dst.to_path_buf(),
        });
    }
    control.check()?;
    rename_no_replace(temp, dst)
}

/// 复制失败后删掉临时文件。删不掉只记日志：要返回的是让复制失败的那个错误。
fn discard_temp(temp: &Path) {
    let removed = match fs::symlink_metadata(temp) {
        Ok(meta) => remove_plain(temp, &meta),
        Err(err) => Err(err),
    };
    if let Err(err) = removed
        && err.kind() != ErrorKind::NotFound
    {
        tracing::warn!(temp = %temp.display(), error = %err, "复制共用文件失败后临时文件没删掉");
    }
}

fn create_new(path: &Path) -> Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| io_error(path, source))
}

/// 把 src 的内容写进新建的 output（路径 out_path），边写边算 SHA-1；写完带上 src 的修改时间与只读属性再落盘。
/// 按块检查取消、报字节。
fn copy_contents(
    src: &Path,
    mut output: File,
    out_path: &Path,
    buf: &mut [u8],
    control: &CopyControl<'_>,
) -> Result<Sha1Digest> {
    let out_err = |source| io_error(out_path, source);
    let mut input = File::open(src).map_err(|source| io_error(src, source))?;
    let meta = input.metadata().map_err(|source| io_error(src, source))?;
    let modified = meta.modified().map_err(|source| io_error(src, source))?;
    let mut hasher = Sha1::new();
    loop {
        control.check()?;
        let read = read_chunk(&mut input, buf).map_err(|source| io_error(src, source))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        output.write_all(&buf[..read]).map_err(out_err)?;
        control.report(read as u64, 0);
    }
    // 写完才设：之后再写系统会把修改时间刷成当下。
    output.set_modified(modified).map_err(out_err)?;
    if meta.permissions().readonly() {
        // 有人把 options.txt 之类设成只读，防游戏改写；搬过去照样只读。
        let mut permissions = output.metadata().map_err(out_err)?.permissions();
        permissions.set_readonly(true);
        output.set_permissions(permissions).map_err(out_err)?;
    }
    output.sync_all().map_err(out_err)?;
    // 读回前关掉写句柄：读回看的是这个句柄再也补不进东西之后的文件。
    drop(output);
    Ok(hasher.finalize().into())
}

/// 无缓冲读的对齐下限，查不到卷的扇区大小时就按它对齐。它是页大小，常见的 512 与 4096 字节扇区都整除它。
const MIN_SECTOR: usize = 4096;

/// 读回用的缓冲：无缓冲读要求缓冲区起始地址按扇区对齐。多分配一个对齐单位的余量，从里面切出对齐的一段。
struct ReadBuf {
    raw: Vec<u8>,
}

impl ReadBuf {
    fn new() -> Self {
        Self { raw: Vec::new() }
    }

    /// 起始地址按 unit 对齐、长 CHUNK 的一段；unit 是不超过 CHUNK 的 2 的幂。
    fn aligned(&mut self, unit: usize) -> &mut [u8] {
        if self.raw.len() < CHUNK + unit {
            self.raw = vec![0u8; CHUNK + unit];
        }
        let misaligned = self.raw.as_ptr().addr() % unit;
        let start = if misaligned == 0 {
            0
        } else {
            unit - misaligned
        };
        &mut self.raw[start..start + CHUNK]
    }
}

/// 读回一遍文件算 SHA-1，按块检查取消；report 为真时按块报字节。
///
/// 读回不经系统缓存：刚写完的内容还留在缓存里，经缓存读回只是把刚交给系统的那份再读一遍，证明不了盘上写对了。
fn hash_file(
    path: &Path,
    buf: &mut ReadBuf,
    control: &CopyControl<'_>,
    report: bool,
) -> Result<Sha1Digest> {
    let failed = |source| io_error(path, readback_error(source));
    let Readback { mut file, unit } = open_readback(path)
        .and_then(|readback| {
            control.readback_opened(path, &readback.file)?;
            Ok(readback)
        })
        .map_err(failed)?;
    let chunk = buf.aligned(unit);
    let mut hasher = Sha1::new();
    loop {
        control.check()?;
        let read = read_chunk(&mut file, chunk).map_err(failed)?;
        if read > 0 {
            hasher.update(&chunk[..read]);
            if report {
                control.report(read as u64, 0);
            }
        }
        // 无缓冲读只在文件末尾读不满；读不满之后文件位置不再按扇区对齐，再读会被拒，所以到这里就读完了。
        if read < chunk.len() {
            break;
        }
    }
    Ok(hasher.finalize().into())
}

/// 读回用的句柄，与每次读的长度、缓冲区地址要对齐到的字节数。
struct Readback {
    file: File,
    unit: usize,
}

/// 以 FILE_FLAG_NO_BUFFERING 打开：读直接到盘上取，不从系统缓存拿；代价是缓冲区地址与每次读的长度都得按扇区对齐。
#[cfg(windows)]
fn open_readback(path: &Path) -> io::Result<Readback> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_NO_BUFFERING;

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_NO_BUFFERING)
        .open(path)?;
    let unit = sector_unit(&file)?;
    Ok(Readback { file, unit })
}

/// 落樱只发 Windows 版；别的平台只为编译与跑测试，读回走系统缓存。
#[cfg(not(windows))]
fn open_readback(path: &Path) -> io::Result<Readback> {
    Ok(Readback {
        file: File::open(path)?,
        unit: MIN_SECTOR,
    })
}

/// 无缓冲读要对齐到的字节数：卷的逻辑扇区（FILE_STORAGE_INFO 的文档说它是无缓冲 I/O 支持的最小单位），
/// 不足 MIN_SECTOR 按 MIN_SECTOR。网络路径之类查不到时按 MIN_SECTOR。
#[cfg(windows)]
fn sector_unit(file: &File) -> io::Result<usize> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_STORAGE_INFO, FileStorageInfo, GetFileInformationByHandleEx,
    };

    let mut info = FILE_STORAGE_INFO::default();
    // SAFETY: 句柄在调用期间有效；info 可写，长度如实给出；调用同步完成。
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileStorageInfo,
            (&raw mut info).cast(),
            size_of::<FILE_STORAGE_INFO>() as u32,
        )
    };
    if ok == 0 {
        tracing::debug!(error = %io::Error::last_os_error(), "查不到扇区大小，读回按 {MIN_SECTOR} 字节对齐");
        return Ok(MIN_SECTOR);
    }
    let unit = (info.LogicalBytesPerSector as usize).max(MIN_SECTOR);
    // 读块的长度要是它的整数倍，缓冲区的余量也只留到读块那么大。
    if !unit.is_power_of_two() || unit > CHUNK {
        return Err(io::Error::new(
            ErrorKind::Unsupported,
            format!("卷的扇区大小 {unit} 字节，对不齐 {CHUNK} 字节的读块"),
        ));
    }
    Ok(unit)
}

/// 文件系统不认无缓冲读：打开时或读时报参数错误、不支持之类。
#[cfg(windows)]
#[derive(Debug, thiserror::Error)]
#[error("所在的文件系统不支持绕过系统缓存读取，读回校验没法确认文件已经写到盘上")]
struct UncachedReadRefused(#[source] io::Error);

/// 无缓冲读被拒时照实报错，不退回经缓存读：退回去校验就又只是读自己刚写进缓存的那份，而校验通过后原件会被
/// 永久删除。换成说得清原因的错误，原来的系统错误留在来源链上；别的错误原样返回。
#[cfg(windows)]
fn readback_error(err: io::Error) -> io::Error {
    use windows_sys::Win32::Foundation::{
        ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED,
    };

    let refused = err.raw_os_error().is_some_and(|code| {
        [
            ERROR_INVALID_PARAMETER,
            ERROR_NOT_SUPPORTED,
            ERROR_INVALID_FUNCTION,
        ]
        .contains(&(code as u32))
    });
    if refused {
        io::Error::new(ErrorKind::Unsupported, UncachedReadRefused(err))
    } else {
        err
    }
}

#[cfg(not(windows))]
fn readback_error(err: io::Error) -> io::Error {
    err
}

fn read_chunk(input: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        match input.read(buf) {
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            other => return other,
        }
    }
}

/// 两个路径是否在同一个卷上；路径不存在时取最近的已存在上级。
pub(crate) fn same_volume(a: &Path, b: &Path) -> Result<bool> {
    let a = nearest_existing(a)?;
    let b = nearest_existing(b)?;
    Ok(volume_key(&a)? == volume_key(&b)?)
}

/// 路径所在卷的剩余字节；路径不存在时取最近的已存在上级（fs2::available_space，launch.rs:1522 已在用）。
pub(crate) fn available_space(path: &Path) -> Result<u64> {
    let existing = nearest_existing(path)?;
    fs2::available_space(&existing).map_err(|source| io_error(&existing, source))
}

/// 移动的目标游戏目录可以还没建：往上找到第一个存在的上级。一路都不存在（盘符不存在）时报原路径找不到。
fn nearest_existing(path: &Path) -> Result<PathBuf> {
    let absolute = std::path::absolute(path).map_err(|source| io_error(path, source))?;
    let mut candidate = absolute.as_path();
    loop {
        match fs::metadata(candidate) {
            Ok(_) => return Ok(candidate.to_path_buf()),
            Err(err) if err.kind() == ErrorKind::NotFound => match candidate.parent() {
                Some(parent) => candidate = parent,
                None => return Err(io_error(path, err)),
            },
            Err(err) => return Err(io_error(candidate, err)),
        }
    }
}

/// 卷根，规整成可以直接比较的写法。GetVolumePathNameW 会顺着目录联接走到目标所在的卷：游戏目录本身是指向
/// 别的盘的联接时，认的是数据真正所在的那个盘。
#[cfg(windows)]
fn volume_key(path: &Path) -> Result<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetVolumePathNameW;

    // 经过联接时卷根是目标那边的，长度与输入无关；按 Windows 长路径上限给缓冲。
    const CAPACITY: usize = 32_768;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut buf = vec![0u16; CAPACITY];
    // SAFETY: wide 以 NUL 结尾，buf 可写 CAPACITY 个单元，两者在调用期间都存活；调用同步完成。
    let ok = unsafe { GetVolumePathNameW(wide.as_ptr(), buf.as_mut_ptr(), CAPACITY as u32) };
    if ok == 0 {
        return Err(io_error(path, io::Error::last_os_error()));
    }
    let len = buf.iter().position(|&unit| unit == 0).unwrap_or(CAPACITY);
    Ok(comparable_volume_root(&String::from_utf16_lossy(
        &buf[..len],
    )))
}

/// 同一个卷根随输入写成 `\\?\C:\` 或 `C:\`，大小写也随输入：去掉 `\\?\` 前缀、统一小写。
#[cfg(windows)]
fn comparable_volume_root(root: &str) -> String {
    let plain = if let Some(rest) = root.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = root.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        root.to_owned()
    };
    plain.to_lowercase()
}

#[cfg(not(windows))]
fn volume_key(path: &Path) -> Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(fs::metadata(path)
        .map_err(|source| io_error(path, source))?
        .dev())
}

/// 实例库按目录的创建时间排序：暂存目录是新建的，不改回去的话移过去的实例会排到最前面。
#[cfg(windows)]
fn copy_created(src: &Path, dst: &Path) -> Result<()> {
    use std::os::windows::fs::{FileTimesExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_ATTRIBUTES,
    };

    let created = fs::metadata(src)
        .and_then(|meta| meta.created())
        .map_err(|source| io_error(src, source))?;
    // 目录只能带 FILE_FLAG_BACKUP_SEMANTICS 打开；改时间只要 FILE_WRITE_ATTRIBUTES。
    let dir = OpenOptions::new()
        .access_mode(FILE_WRITE_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(dst)
        .map_err(|source| io_error(dst, source))?;
    dir.set_times(fs::FileTimes::new().set_created(created))
        .map_err(|source| io_error(dst, source))
}

/// Linux 不能改创建时间（btime 只读），没有可做的。
#[cfg(not(windows))]
fn copy_created(_src: &Path, _dst: &Path) -> Result<()> {
    Ok(())
}

/// 改名到 dst（文件，或 Windows 上同卷的目录），dst 已存在时报 AlreadyExists 而不是覆盖：std::fs::rename 在
/// Windows 上带着 MOVEFILE_REPLACE_EXISTING，会盖掉目标目录里别的实例可能正在用的文件。
#[cfg(windows)]
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> Result<()> {
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let from_wide = verbatim_wide(from)?;
    let to_wide = verbatim_wide(to)?;
    // SAFETY: 两个缓冲都以 NUL 结尾，在调用期间存活；调用同步完成。
    if unsafe { MoveFileExW(from_wide.as_ptr(), to_wide.as_ptr(), 0) } == 0 {
        return Err(io_error(to, io::Error::last_os_error()));
    }
    Ok(())
}

/// 转成带 `\\?\` 前缀、以 NUL 结尾的绝对路径：库文件路径深，游戏目录再长一点就超过 MAX_PATH，
/// 不带前缀的系统调用会失败（std 自己的文件函数内部也这么转）。
#[cfg(windows)]
fn verbatim_wide(path: &Path) -> Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};

    let absolute = std::path::absolute(path).map_err(|source| io_error(path, source))?;
    let body: Vec<u16> = absolute.as_os_str().encode_wide().collect();
    let (lead, skip) = match absolute.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) => (r"\\?\", 0),
            // `\\server\share\...` 换成 `\\?\UNC\server\share\...`，原来开头的两个反斜杠去掉。
            Prefix::UNC(..) => (r"\\?\UNC\", 2),
            _ => ("", 0),
        },
        _ => ("", 0),
    };
    Ok(lead
        .encode_utf16()
        .chain(body[skip..].iter().copied())
        .chain(std::iter::once(0))
        .collect())
}

/// hard_link 在目标已存在时失败，不会覆盖；挂上后删掉临时名。
#[cfg(not(windows))]
pub(crate) fn rename_no_replace(from: &Path, to: &Path) -> Result<()> {
    fs::hard_link(from, to).map_err(|source| io_error(to, source))?;
    fs::remove_file(from).map_err(|source| io_error(from, source))
}

/// 把目录的元数据（比如刚在里面做的改名）刷到盘上。删原件前对目标调它：改名若还只在系统缓存里，断电后目标那边
/// 的改名会丢，原件却已经删了。
// 删原件前由实例移动编排调用；编排接上之前没有调用方。
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn flush_dir(path: &Path) -> Result<()> {
    let dir = open_dir_for_flush(path).map_err(|source| io_error(path, source))?;
    let meta = dir.metadata().map_err(|source| io_error(path, source))?;
    if !meta.is_dir() {
        return Err(io_error(path, ErrorKind::NotADirectory.into()));
    }
    // Windows 上 sync_all 就是 FlushFileBuffers。
    dir.sync_all().map_err(|source| io_error(path, source))
}

/// 目录只能带 FILE_FLAG_BACKUP_SEMANTICS 打开；FlushFileBuffers 要求句柄有 GENERIC_WRITE，write(true) 给的就是它。
#[cfg(windows)]
fn open_dir_for_flush(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

    OpenOptions::new()
        .write(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

/// 目录只能只读打开；对它 fsync 就把其中的改名与新建落盘。
#[cfg(not(windows))]
fn open_dir_for_flush(path: &Path) -> io::Result<File> {
    File::open(path)
}

/// 删整棵树：不存在算成功；清只读属性；遇到链接只删链接本身，不顺着删到别处。
pub(crate) fn remove_tree(path: &Path) -> Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(io_error(path, err)),
    };
    remove_entry(path, &meta)
}

/// meta 必须是不跟随链接取的（symlink_metadata 或目录枚举带回的）。
fn remove_entry(path: &Path, meta: &fs::Metadata) -> Result<()> {
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return remove_link(path, file_type).map_err(|source| io_error(path, source));
    }
    if !file_type.is_dir() {
        return remove_plain(path, meta).map_err(|source| io_error(path, source));
    }
    // 先清目录自己的只读：Windows 上只读目录删不掉，Unix 上不可写的目录删不了里面的东西。
    if meta.permissions().readonly() {
        clear_readonly(path, meta).map_err(|source| io_error(path, source))?;
    }
    // 先列完再删：边枚举边删，枚举结果在各文件系统上没有保证。
    let mut entries = Vec::new();
    for entry in fs::read_dir(path).map_err(|source| io_error(path, source))? {
        entries.push(entry.map_err(|source| io_error(path, source))?);
    }
    for entry in entries {
        let child = entry.path();
        let child_meta = entry
            .metadata()
            .map_err(|source| io_error(&child, source))?;
        remove_entry(&child, &child_meta)?;
    }
    fs::remove_dir(path).map_err(|source| io_error(path, source))
}

/// 删普通文件，先清只读：Windows 上只读文件直接删会被拒（FAT 卷上 std 也没有绕开的办法）。
fn remove_plain(path: &Path, meta: &fs::Metadata) -> io::Result<()> {
    if meta.permissions().readonly() {
        clear_readonly(path, meta)?;
    }
    fs::remove_file(path)
}

/// 目录联接与目录符号链接是目录项，要用 remove_dir 删；它只删链接本身，不碰指向的目录。
#[cfg(windows)]
fn remove_link(path: &Path, file_type: fs::FileType) -> io::Result<()> {
    use std::os::windows::fs::FileTypeExt;
    if file_type.is_symlink_dir() {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(not(windows))]
fn remove_link(path: &Path, _file_type: fs::FileType) -> io::Result<()> {
    fs::remove_file(path)
}

// Windows 上 set_readonly(false) 只清只读属性，不涉及 Unix 那种对所有人放开写权限的问题。
#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)]
fn clear_readonly(path: &Path, meta: &fs::Metadata) -> io::Result<()> {
    let mut permissions = meta.permissions();
    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)
}

/// 只给属主补上写权限。
#[cfg(not(windows))]
fn clear_readonly(path: &Path, meta: &fs::Metadata) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = meta.permissions();
    permissions.set_mode(permissions.mode() | 0o200);
    fs::set_permissions(path, permissions)
}

fn io_error(path: &Path, source: io::Error) -> CoreError {
    petalfall_base::Error::Io {
        path: path.to_path_buf(),
        source,
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[cfg(windows)]
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime};

    /// 进度回调累计到的（字节, 文件数）。
    #[derive(Default)]
    struct Tally {
        bytes: AtomicU64,
        files: AtomicU64,
    }

    impl Tally {
        fn record(&self, bytes: u64, files: u64) {
            self.bytes.fetch_add(bytes, Ordering::Relaxed);
            self.files.fetch_add(files, Ordering::Relaxed);
        }

        fn get(&self) -> (u64, u64) {
            (
                self.bytes.load(Ordering::Relaxed),
                self.files.load(Ordering::Relaxed),
            )
        }
    }

    fn rel(path: &str) -> PathBuf {
        path.split('/').collect()
    }

    fn at(secs: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(secs)
    }

    fn modified(path: &Path) -> SystemTime {
        fs::metadata(path).unwrap().modified().unwrap()
    }

    fn set_modified(path: &Path, time: SystemTime) {
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }

    fn set_readonly(path: &Path) {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions).unwrap();
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn random_bytes(rng: &mut fastrand::Rng, len: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; len];
        rng.fill(&mut bytes);
        bytes
    }

    fn sha1_of(bytes: &[u8]) -> Sha1Digest {
        Sha1::digest(bytes).into()
    }

    /// 目录里现有的文件名，排好序。
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn io_parts(err: CoreError) -> (PathBuf, io::Error) {
        match err {
            CoreError::Base(petalfall_base::Error::Io { path, source }) => (path, source),
            other => panic!("应为带路径的 IO 错误：{other:?}"),
        }
    }

    /// 带边界大小的样本树：空文件、差一字节满块、恰好一块、多一字节、随机大小，非 ASCII 路径，两层空目录。
    /// 每个文件的修改时间各不相同且远在过去。
    fn sample_tree(root: &Path, rng: &mut fastrand::Rng) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut sizes = vec![
            ("config/a-empty.cfg".to_owned(), 0),
            ("config/b-under.bin".to_owned(), CHUNK - 1),
            ("config/c-exact.bin".to_owned(), CHUNK),
            ("config/d-over.bin".to_owned(), CHUNK + 1),
            ("options.txt".to_owned(), rng.usize(1..4096)),
            ("saves/世界 1/level.dat".to_owned(), rng.usize(1..200_000)),
        ];
        for i in 0..3 {
            sizes.push((format!("mods/m{i}.jar"), rng.usize(1..3 * CHUNK)));
        }
        let mut files = BTreeMap::new();
        for (secs, (path, len)) in (1_500_000_000..).zip(sizes) {
            let bytes = random_bytes(rng, len);
            let file = root.join(rel(&path));
            write(&file, &bytes);
            set_modified(&file, at(secs));
            files.insert(rel(&path), bytes);
        }
        for empty in ["resourcepacks", "saves/世界 1/empty/deeper"] {
            fs::create_dir_all(root.join(rel(empty))).unwrap();
        }
        files
    }

    #[cfg(windows)]
    fn set_created(path: &Path, time: SystemTime) {
        use std::os::windows::fs::{FileTimesExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_ATTRIBUTES,
        };
        OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_created(time))
            .unwrap();
    }

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
    }

    /// 测试里指向临时目录之外的联接，用完（含断言失败时）先把联接本身拆掉。
    #[cfg(windows)]
    struct JunctionGuard(PathBuf);

    #[cfg(windows)]
    impl Drop for JunctionGuard {
        fn drop(&mut self) {
            if let Err(err) = fs::remove_dir(&self.0) {
                eprintln!("拆不掉测试联接 {}：{err}", self.0.display());
            }
        }
    }

    #[test]
    fn copy_tree_reproduces_bytes_empty_dirs_and_times() {
        let tmp = tempfile::tempdir().unwrap();
        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        let src = tmp.path().join("versions").join("实例");
        let expected = sample_tree(&src, &mut rng);
        set_readonly(&src.join("options.txt"));
        #[cfg(windows)]
        set_created(&src, at(1_600_000_000));
        let dst = tmp
            .path()
            .join("target")
            .join(".petalfall")
            .join("moving")
            .join("t")
            .join("instance");

        let scan = scan_tree(&src).unwrap();
        let tally = Tally::default();
        let progress = |bytes, files| tally.record(bytes, files);
        let digests = copy_tree(&src, &dst, &scan, &CopyControl::new(None, &progress)).unwrap();

        let total: u64 = expected.values().map(|bytes| bytes.len() as u64).sum();
        assert_eq!(scan.files.len(), expected.len(), "seed={seed}");
        assert_eq!(scan.total_bytes, total, "seed={seed}");
        assert_eq!(tally.get(), (total, expected.len() as u64), "seed={seed}");
        assert_eq!(digests.len(), scan.files.len());
        for (file, digest) in scan.files.iter().zip(&digests) {
            let bytes = &expected[&file.rel];
            let copied = dst.join(&file.rel);
            assert_eq!(file.size, bytes.len() as u64, "{}", file.rel.display());
            assert_eq!(
                fs::read(&copied).unwrap(),
                *bytes,
                "{} seed={seed}",
                file.rel.display()
            );
            assert_eq!(*digest, sha1_of(bytes), "{}", file.rel.display());
            assert_eq!(
                modified(&copied),
                modified(&src.join(&file.rel)),
                "{}",
                file.rel.display()
            );
        }
        for empty in ["resourcepacks", "saves/世界 1/empty/deeper"] {
            assert!(names(&dst.join(rel(empty))).is_empty(), "{empty}");
        }
        assert!(
            fs::metadata(dst.join("options.txt"))
                .unwrap()
                .permissions()
                .readonly()
        );
        assert!(
            !fs::metadata(dst.join(rel("mods/m0.jar")))
                .unwrap()
                .permissions()
                .readonly()
        );
        #[cfg(windows)]
        assert_eq!(
            fs::metadata(&dst).unwrap().created().unwrap(),
            at(1_600_000_000)
        );

        let verified = Tally::default();
        let progress = |bytes, files| verified.record(bytes, files);
        verify_tree(&dst, &scan, &digests, &CopyControl::new(None, &progress)).unwrap();
        assert_eq!(verified.get(), (total, expected.len() as u64));
    }

    #[test]
    fn copy_tree_refuses_an_existing_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        write(&src.join("a.bin"), b"abc");
        let dst = tmp.path().join("dst");
        fs::create_dir(&dst).unwrap();
        let progress = |_: u64, _: u64| {};
        let scan = scan_tree(&src).unwrap();

        let err = copy_tree(&src, &dst, &scan, &CopyControl::new(None, &progress)).unwrap_err();

        let (path, source) = io_parts(err);
        assert_eq!(path, dst);
        assert_eq!(source.kind(), ErrorKind::AlreadyExists);
        assert!(names(&dst).is_empty());
    }

    #[test]
    fn scan_tree_lists_dirs_parent_first_and_counts_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("实例");
        write(&root.join("a.txt"), b"");
        write(&root.join(rel("config/b.cfg")), b"12345");
        write(&root.join(rel("saves/世界/level.dat")), &[1u8; 300]);
        fs::create_dir_all(root.join(rel("config/empty/deeper"))).unwrap();

        let scan = scan_tree(&root).unwrap();

        assert_eq!(
            scan,
            TreeScan {
                files: vec![
                    TreeFile {
                        rel: rel("a.txt"),
                        size: 0
                    },
                    TreeFile {
                        rel: rel("config/b.cfg"),
                        size: 5
                    },
                    TreeFile {
                        rel: rel("saves/世界/level.dat"),
                        size: 300
                    },
                ],
                dirs: vec![
                    rel("config"),
                    rel("config/empty"),
                    rel("config/empty/deeper"),
                    rel("saves"),
                    rel("saves/世界"),
                ],
                links: Vec::new(),
                total_bytes: 305,
            }
        );
    }

    #[test]
    fn scan_tree_requires_an_existing_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        let (path, source) = io_parts(scan_tree(&missing).unwrap_err());
        assert_eq!(path, missing);
        assert_eq!(source.kind(), ErrorKind::NotFound);

        let file = tmp.path().join("file.txt");
        write(&file, b"x");
        let (path, source) = io_parts(scan_tree(&file).unwrap_err());
        assert_eq!(path, file);
        assert_eq!(source.kind(), ErrorKind::NotADirectory);
    }

    #[cfg(windows)]
    #[test]
    fn scan_tree_reports_links_without_entering_them() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        write(&outside.join(rel("deep/secret.bin")), &[7u8; 4096]);
        let root = tmp.path().join("实例");
        write(&root.join(rel("config/b.cfg")), b"12345");
        write(&root.join(rel("saves/level.dat")), &[1u8; 300]);
        junction(&root.join(rel("config/linked")), &outside);
        // 符号链接要开发者模式或管理员；建不出来就只测联接。
        let dir_link =
            std::os::windows::fs::symlink_dir(&outside, root.join(rel("saves/z-dir-link"))).is_ok();
        let file_link = std::os::windows::fs::symlink_file(
            outside.join(rel("deep/secret.bin")),
            root.join("z-file-link"),
        )
        .is_ok();

        let scan = scan_tree(&root).unwrap();

        let mut links = vec![rel("config/linked")];
        if dir_link {
            links.push(rel("saves/z-dir-link"));
        }
        if file_link {
            links.push(rel("z-file-link"));
        }
        assert_eq!(
            scan,
            TreeScan {
                files: vec![
                    TreeFile {
                        rel: rel("config/b.cfg"),
                        size: 5
                    },
                    TreeFile {
                        rel: rel("saves/level.dat"),
                        size: 300
                    },
                ],
                dirs: vec![rel("config"), rel("saves")],
                links,
                total_bytes: 305,
            }
        );

        let root_link = tmp.path().join("root-link");
        junction(&root_link, &root);
        assert_eq!(
            scan_tree(&root_link).unwrap(),
            TreeScan {
                links: vec![PathBuf::new()],
                ..TreeScan::default()
            }
        );
    }

    #[test]
    fn verify_tree_names_the_file_corrupted_after_it_was_written() {
        let flip: fn(&mut Vec<u8>) = |bytes| {
            let middle = bytes.len() / 2;
            bytes[middle] ^= 0x5a;
        };
        let truncate: fn(&mut Vec<u8>) = |bytes| {
            bytes.pop();
        };
        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        for (case, corrupt) in [("同长度改一个字节", flip), ("截掉最后一个字节", truncate)]
        {
            let tmp = tempfile::tempdir().unwrap();
            let src = tmp.path().join("src");
            sample_tree(&src, &mut rng);
            let dst = tmp.path().join("dst");
            let victim = dst.join(rel("config/c-exact.bin"));
            let fault = |path: &Path| -> io::Result<()> {
                if path == victim.as_path() {
                    let mut bytes = fs::read(path)?;
                    corrupt(&mut bytes);
                    fs::write(path, bytes)?;
                }
                Ok(())
            };
            let progress = |_: u64, _: u64| {};
            let control = CopyControl::new(None, &progress).with_fault(&fault);
            let scan = scan_tree(&src).unwrap();
            let digests = copy_tree(&src, &dst, &scan, &control).unwrap();

            match verify_tree(&dst, &scan, &digests, &control).unwrap_err() {
                CoreError::InstanceMoveVerifyFailed { path } => {
                    assert_eq!(path, victim, "{case} seed={seed}");
                }
                other => panic!("{case}：应为校验不一致，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn copy_tree_fails_with_the_injected_error_and_stops_there() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        for name in ["a.bin", "b.bin", "c.bin"] {
            write(&src.join(name), name.as_bytes());
        }
        let dst = tmp.path().join("dst");
        let fault = |path: &Path| {
            if path.ends_with("b.bin") {
                Err(io::Error::other("注入的写入故障"))
            } else {
                Ok(())
            }
        };
        let progress = |_: u64, _: u64| {};
        let control = CopyControl::new(None, &progress).with_fault(&fault);
        let scan = scan_tree(&src).unwrap();

        let (path, source) = io_parts(copy_tree(&src, &dst, &scan, &control).unwrap_err());

        assert_eq!(path, dst.join("b.bin"));
        assert_eq!(source.to_string(), "注入的写入故障");
        assert_eq!(names(&dst), ["a.bin", "b.bin"]);
    }

    #[test]
    fn a_token_cancelled_beforehand_stops_before_touching_the_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        write(&src.join("a.bin"), b"abc");
        let token = CancellationToken::new();
        token.cancel();
        let tally = Tally::default();
        let progress = |bytes, files| tally.record(bytes, files);
        let control = CopyControl::new(Some(&token), &progress);
        let scan = scan_tree(&src).unwrap();
        let dst = tmp.path().join("stage").join("instance");

        let err = copy_tree(&src, &dst, &scan, &control).unwrap_err();
        assert!(err.is_cancelled(), "{err:?}");
        assert!(!tmp.path().join("stage").exists());

        let err = verify_tree(&src, &scan, &[sha1_of(b"abc")], &control).unwrap_err();
        assert!(err.is_cancelled(), "{err:?}");

        let lib = tmp.path().join("libraries").join("a.bin");
        let err = copy_file(&src.join("a.bin"), &lib, &control).unwrap_err();
        assert!(err.is_cancelled(), "{err:?}");
        assert!(!tmp.path().join("libraries").exists());
        assert_eq!(tally.get(), (0, 0));
    }

    #[test]
    fn cancelling_mid_copy_stops_at_the_next_chunk() {
        let tmp = tempfile::tempdir().unwrap();
        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        let src = tmp.path().join("src");
        write(&src.join("a.bin"), &random_bytes(&mut rng, 3 * CHUNK));
        write(&src.join("b.bin"), &random_bytes(&mut rng, CHUNK));
        let scan = scan_tree(&src).unwrap();

        let token = CancellationToken::new();
        let tally = Tally::default();
        let progress = |bytes, files| {
            tally.record(bytes, files);
            token.cancel();
        };
        let control = CopyControl::new(Some(&token), &progress);
        let dst = tmp.path().join("dst");
        let err = copy_tree(&src, &dst, &scan, &control).unwrap_err();
        assert!(err.is_cancelled(), "{err:?}");
        let (bytes, files) = tally.get();
        assert!(
            bytes > 0 && bytes <= CHUNK as u64,
            "bytes={bytes} seed={seed}"
        );
        assert_eq!(files, 0);
        assert!(!dst.join("b.bin").exists());

        let tally_file = Tally::default();
        let token = CancellationToken::new();
        let progress = |bytes, files| {
            tally_file.record(bytes, files);
            token.cancel();
        };
        let control = CopyControl::new(Some(&token), &progress);
        let lib = tmp.path().join("libraries").join("a.bin");
        let err = copy_file(&src.join("a.bin"), &lib, &control).unwrap_err();
        assert!(err.is_cancelled(), "{err:?}");
        assert_eq!(tally_file.get().1, 0);
        assert!(names(lib.parent().unwrap()).is_empty());
    }

    #[test]
    fn copy_file_places_a_verified_copy_with_its_time_and_read_only_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        let len = 2 * CHUNK + rng.usize(0..CHUNK);
        let bytes = random_bytes(&mut rng, len);
        let src = tmp.path().join("src").join("lib.jar");
        write(&src, &bytes);
        set_modified(&src, at(1_400_000_000));
        let dst = tmp.path().join(rel("target/libraries/net/x/1.0/lib.jar"));
        let tally = Tally::default();
        let progress = |bytes, files| tally.record(bytes, files);
        let control = CopyControl::new(None, &progress);

        copy_file(&src, &dst, &control).unwrap();

        assert_eq!(fs::read(&dst).unwrap(), bytes, "seed={seed}");
        assert_eq!(modified(&dst), at(1_400_000_000));
        assert!(!fs::metadata(&dst).unwrap().permissions().readonly());
        assert_eq!(names(dst.parent().unwrap()), ["lib.jar"]);
        assert_eq!(tally.get(), (bytes.len() as u64, 1));

        let locked = tmp.path().join("src").join("locked.xml");
        write(&locked, b"<Configuration/>");
        set_readonly(&locked);
        let locked_dst = dst.with_file_name("locked.xml");
        copy_file(&locked, &locked_dst, &control).unwrap();
        assert_eq!(fs::read(&locked_dst).unwrap(), b"<Configuration/>");
        assert!(fs::metadata(&locked_dst).unwrap().permissions().readonly());
        assert_eq!(names(dst.parent().unwrap()), ["lib.jar", "locked.xml"]);
    }

    #[test]
    fn copy_file_never_overwrites_an_existing_target() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src").join("lib.jar");
        write(&src, b"new");
        let dir = tmp.path().join("libraries");
        let progress = |_: u64, _: u64| {};

        let existing = dir.join("lib.jar");
        write(&existing, "旧内容".as_bytes());
        let control = CopyControl::new(None, &progress);
        let (path, source) = io_parts(copy_file(&src, &existing, &control).unwrap_err());
        assert_eq!(path, existing);
        assert_eq!(source.kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&existing).unwrap(), "旧内容".as_bytes());
        assert_eq!(names(&dir), ["lib.jar"]);

        // 查过不存在之后、改名之前被别人抢先放了一份：改名不能盖掉它。
        let raced = dir.join("raced.jar");
        let fault = |_: &Path| fs::write(&raced, "抢先".as_bytes());
        let control = CopyControl::new(None, &progress).with_fault(&fault);
        let (path, source) = io_parts(copy_file(&src, &raced, &control).unwrap_err());
        assert_eq!(path, raced);
        assert_eq!(source.kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&raced).unwrap(), "抢先".as_bytes());
        assert_eq!(names(&dir), ["lib.jar", "raced.jar"]);
    }

    #[test]
    fn copy_file_leaves_no_temp_file_when_it_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        let src = tmp.path().join("src").join("lib.jar");
        let len = CHUNK + rng.usize(1..CHUNK);
        write(&src, &random_bytes(&mut rng, len));
        let dir = tmp.path().join("libraries").join("x");
        let dst = dir.join("lib.jar");
        let progress = |_: u64, _: u64| {};

        let fault = |_: &Path| Err(io::Error::other("注入的写入故障"));
        let control = CopyControl::new(None, &progress).with_fault(&fault);
        let (_, source) = io_parts(copy_file(&src, &dst, &control).unwrap_err());
        assert_eq!(source.to_string(), "注入的写入故障");
        assert!(names(&dir).is_empty(), "{:?}", names(&dir));

        let corrupt = |path: &Path| {
            let mut bytes = fs::read(path)?;
            bytes[0] ^= 0xff;
            fs::write(path, bytes)
        };
        let control = CopyControl::new(None, &progress).with_fault(&corrupt);
        match copy_file(&src, &dst, &control).unwrap_err() {
            CoreError::InstanceMoveVerifyFailed { path } => assert_eq!(path, dst, "seed={seed}"),
            other => panic!("应为校验不一致，实际 {other:?}"),
        }
        assert!(names(&dir).is_empty(), "{:?}", names(&dir));

        let missing = tmp.path().join("src").join("missing.jar");
        let control = CopyControl::new(None, &progress);
        let (path, source) = io_parts(copy_file(&missing, &dst, &control).unwrap_err());
        assert_eq!(path, missing);
        assert_eq!(source.kind(), ErrorKind::NotFound);
        assert!(names(&dir).is_empty(), "{:?}", names(&dir));
    }

    #[test]
    fn remove_tree_clears_read_only_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("tree");
        write(&root.join(rel("a/b/locked.txt")), b"locked");
        write(&root.join(rel("a/plain.txt")), b"plain");
        write(&root.join(rel("ro-dir/inside.txt")), b"inside");
        fs::create_dir_all(root.join(rel("a/empty"))).unwrap();
        set_readonly(&root.join(rel("a/b/locked.txt")));
        set_readonly(&root.join("ro-dir"));

        remove_tree(&root).unwrap();
        assert!(fs::symlink_metadata(&root).is_err());

        let lone = tmp.path().join("lone.txt");
        write(&lone, b"lone");
        set_readonly(&lone);
        remove_tree(&lone).unwrap();
        assert!(fs::symlink_metadata(&lone).is_err());

        remove_tree(&tmp.path().join("nope").join("deeper")).unwrap();
        assert!(names(tmp.path()).is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn remove_tree_removes_links_but_not_what_they_point_to() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        write(&outside.join("keep.txt"), b"keep");
        write(&outside.join(rel("sub/deep.txt")), b"deep");
        let root = tmp.path().join("tree");
        write(&root.join(rel("mods/x.jar")), b"jar");
        junction(&root.join("linked"), &outside);
        junction(&root.join(rel("mods/linked-sub")), &outside.join("sub"));
        // 符号链接要开发者模式或管理员；建不出来就只测联接，建没建成不影响下面的断言。
        let dir_link = std::os::windows::fs::symlink_dir(&outside, root.join("dir-link")).is_ok();
        let file_link =
            std::os::windows::fs::symlink_file(outside.join("keep.txt"), root.join("file-link"))
                .is_ok();
        eprintln!("符号链接：目录 {dir_link}，文件 {file_link}");

        remove_tree(&root).unwrap();

        assert!(fs::symlink_metadata(&root).is_err());
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        assert_eq!(
            fs::read(outside.join(rel("sub/deep.txt"))).unwrap(),
            b"deep"
        );

        let root_link = tmp.path().join("root-link");
        junction(&root_link, &outside);
        remove_tree(&root_link).unwrap();
        assert!(fs::symlink_metadata(&root_link).is_err());
        assert_eq!(names(&outside), ["keep.txt", "sub"]);
        assert_eq!(
            fs::read(outside.join(rel("sub/deep.txt"))).unwrap(),
            b"deep"
        );
    }

    #[test]
    fn same_volume_holds_for_siblings_and_missing_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();

        assert!(same_volume(&a, &b).unwrap());
        assert!(same_volume(&b.join("not").join("yet").join("there"), &a).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn same_volume_ignores_case_and_tells_drives_apart_through_junctions() {
        use std::path::{Component, Prefix};

        let tmp = tempfile::tempdir().unwrap();
        let text = tmp.path().to_string_lossy();
        assert!(
            same_volume(
                Path::new(&text.to_uppercase()),
                Path::new(&text.to_lowercase())
            )
            .unwrap()
        );

        let here = match tmp.path().components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter.to_ascii_uppercase(),
                other => panic!("临时目录不在盘符下：{other:?}"),
            },
            other => panic!("临时目录没有前缀：{other:?}"),
        };
        let other = (b'A'..=b'Z')
            .filter(|&letter| letter != here)
            .map(|letter| PathBuf::from(format!("{}:\\", letter as char)))
            .find(|root| fs::metadata(root).is_ok_and(|meta| meta.is_dir()));
        let Some(other) = other else {
            eprintln!("本机只有一个盘，跳过跨盘比较");
            return;
        };
        assert!(
            !same_volume(tmp.path(), &other).unwrap(),
            "{}",
            other.display()
        );

        let link = tmp.path().join("to-other");
        junction(&link, &other);
        let _guard = JunctionGuard(link.clone());
        let through = link.join("petalfall-不存在").join("deeper");
        assert!(!same_volume(&through, tmp.path()).unwrap());
        assert!(same_volume(&through, &other).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn volume_roots_compare_without_prefix_or_case() {
        assert_eq!(
            comparable_volume_root(r"\\?\C:\"),
            comparable_volume_root(r"c:\")
        );
        assert_eq!(
            comparable_volume_root(r"\\?\UNC\Server\Share\"),
            r"\\server\share\"
        );
        assert_ne!(
            comparable_volume_root(r"C:\"),
            comparable_volume_root(r"D:\")
        );
    }

    #[test]
    fn available_space_answers_for_a_deep_missing_path() {
        let tmp = tempfile::tempdir().unwrap();
        let deep = tmp.path().join(rel("a/b/c/d"));

        let space = available_space(&deep).unwrap();
        let here = available_space(tmp.path()).unwrap();

        assert!(space > 0);
        // 同一个卷；两次读之间别的程序写盘会让数值略有出入。
        assert!(space.abs_diff(here) < 1 << 30, "space={space} here={here}");
    }

    /// 读回要覆盖的边界大小：空、一字节、差一字节满扇区、恰好一扇区、多一字节、恰好一块、多一字节的一块。
    #[cfg(windows)]
    const READBACK_SIZES: [usize; 7] = [0, 1, 4095, 4096, 4097, CHUNK, CHUNK + 1];

    /// 按 READBACK_SIZES 在 dir 下各造一个随机内容的文件，返回相对路径到内容。
    #[cfg(windows)]
    fn readback_samples(dir: &Path, rng: &mut fastrand::Rng) -> BTreeMap<PathBuf, Vec<u8>> {
        READBACK_SIZES
            .iter()
            .map(|&len| {
                let name = PathBuf::from(format!("f{len}.bin"));
                let bytes = random_bytes(rng, len);
                write(&dir.join(&name), &bytes);
                (name, bytes)
            })
            .collect()
    }

    /// 用无缓冲读的对齐要求认句柄是不是绕过了系统缓存：错开扇区读三个字节，经缓存的句柄照读，无缓冲的被拒。
    /// 探完把位置挪回开头，不影响接下来的读回。
    #[cfg(windows)]
    fn bypasses_cache(file: &File) -> bool {
        use std::io::{Seek, SeekFrom};
        use std::os::windows::fs::FileExt;
        use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;

        let mut probe = [0u8; 3];
        let rejected = match file.seek_read(&mut probe, 1) {
            Ok(_) => false,
            Err(err) => {
                assert_eq!(
                    err.raw_os_error(),
                    Some(ERROR_INVALID_PARAMETER as i32),
                    "{err}"
                );
                true
            }
        };
        let mut handle = file;
        handle.seek(SeekFrom::Start(0)).unwrap();
        rejected
    }

    #[cfg(windows)]
    #[test]
    fn verify_tree_reads_back_around_the_system_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        let src = tmp.path().join("src");
        let expected = readback_samples(&src, &mut rng);
        let dst = tmp.path().join("dst");
        let progress = |_: u64, _: u64| {};
        let scan = scan_tree(&src).unwrap();
        let digests = copy_tree(&src, &dst, &scan, &CopyControl::new(None, &progress)).unwrap();
        for (file, digest) in scan.files.iter().zip(&digests) {
            assert_eq!(*digest, sha1_of(&expected[&file.rel]), "seed={seed}");
        }

        let probed = Mutex::new(BTreeMap::new());
        let hook = |path: &Path, file: &File| {
            let bypassed = bypasses_cache(file);
            probed.lock().unwrap().insert(path.to_path_buf(), bypassed);
            Ok(())
        };
        let tally = Tally::default();
        let progress = |bytes, files| tally.record(bytes, files);
        let control = CopyControl::new(None, &progress).with_readback_hook(&hook);
        verify_tree(&dst, &scan, &digests, &control).unwrap();

        let total: u64 = expected.values().map(|bytes| bytes.len() as u64).sum();
        assert_eq!(tally.get(), (total, expected.len() as u64), "seed={seed}");
        let want: BTreeMap<PathBuf, bool> =
            expected.keys().map(|name| (dst.join(name), true)).collect();
        assert_eq!(probed.into_inner().unwrap(), want);
    }

    #[cfg(windows)]
    #[test]
    fn copy_file_reads_back_around_the_system_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        let src = tmp.path().join("src");
        let expected = readback_samples(&src, &mut rng);
        let dir = tmp.path().join(rel("libraries/net/x/1.0"));
        let progress = |_: u64, _: u64| {};

        for (name, bytes) in &expected {
            let dst = dir.join(name);
            let probed = Mutex::new(Vec::new());
            let hook = |path: &Path, file: &File| {
                let bypassed = bypasses_cache(file);
                probed.lock().unwrap().push((path.to_path_buf(), bypassed));
                Ok(())
            };
            let control = CopyControl::new(None, &progress).with_readback_hook(&hook);
            copy_file(&src.join(name), &dst, &control).unwrap();

            assert_eq!(fs::read(&dst).unwrap(), *bytes, "seed={seed}");
            let probed = probed.into_inner().unwrap();
            assert_eq!(probed.len(), 1, "{probed:?}");
            let (path, bypassed) = &probed[0];
            // 读回的是改名前的临时文件。
            assert_eq!(path.parent(), Some(dir.as_path()));
            let temp_name = path.file_name().unwrap().to_string_lossy();
            assert!(
                temp_name.starts_with(&format!("{}.", name.display()))
                    && temp_name.ends_with(".part"),
                "{temp_name}"
            );
            assert!(bypassed, "{}", name.display());
        }
        let mut names_now: Vec<String> = expected
            .keys()
            .map(|name| name.display().to_string())
            .collect();
        names_now.sort();
        assert_eq!(names(&dir), names_now);
    }

    #[test]
    fn readback_catches_tampering_in_a_partial_last_sector() {
        let seed = fastrand::u64(..);
        let mut rng = fastrand::Rng::with_seed(seed);
        let tamper = |path: &Path| -> io::Result<()> {
            let mut bytes = fs::read(path)?;
            *bytes.last_mut().unwrap() ^= 0x5a;
            fs::write(path, bytes)
        };
        for len in [1, 4097, CHUNK + 1] {
            let tmp = tempfile::tempdir().unwrap();
            let src = tmp.path().join("src");
            write(&src.join("a.bin"), &random_bytes(&mut rng, len));
            let dst = tmp.path().join("dst");
            let victim = dst.join("a.bin");
            let fault = |path: &Path| tamper(path);
            let progress = |_: u64, _: u64| {};
            let control = CopyControl::new(None, &progress).with_fault(&fault);
            let scan = scan_tree(&src).unwrap();
            let digests = copy_tree(&src, &dst, &scan, &control).unwrap();
            match verify_tree(&dst, &scan, &digests, &control).unwrap_err() {
                CoreError::InstanceMoveVerifyFailed { path } => {
                    assert_eq!(path, victim, "len={len} seed={seed}");
                }
                other => panic!("len={len}：应为校验不一致，实际 {other:?}"),
            }

            let lib_dir = tmp.path().join("libraries");
            let lib = lib_dir.join("a.jar");
            match copy_file(&src.join("a.bin"), &lib, &control).unwrap_err() {
                CoreError::InstanceMoveVerifyFailed { path } => {
                    assert_eq!(path, lib, "len={len} seed={seed}");
                }
                other => panic!("len={len}：应为校验不一致，实际 {other:?}"),
            }
            assert!(names(&lib_dir).is_empty(), "{:?}", names(&lib_dir));
        }
    }

    /// 文件系统不认无缓冲读时照实报错，不退回经缓存读；报的错说得清原因，原来的系统错误挂在来源链上。
    #[cfg(windows)]
    #[test]
    fn readback_refused_by_the_file_system_fails_instead_of_falling_back() {
        use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;

        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        write(&src.join("a.bin"), b"abc");
        let dst = tmp.path().join("dst");
        let progress = |_: u64, _: u64| {};
        let scan = scan_tree(&src).unwrap();
        let digests = copy_tree(&src, &dst, &scan, &CopyControl::new(None, &progress)).unwrap();
        let refuse =
            |_: &Path, _: &File| Err(io::Error::from_raw_os_error(ERROR_INVALID_PARAMETER as i32));
        let control = CopyControl::new(None, &progress).with_readback_hook(&refuse);
        let refused_os_error = |source: &io::Error| {
            std::error::Error::source(source)
                .and_then(|inner| inner.downcast_ref::<io::Error>())
                .and_then(io::Error::raw_os_error)
        };

        let (path, source) = io_parts(verify_tree(&dst, &scan, &digests, &control).unwrap_err());
        assert_eq!(path, dst.join("a.bin"));
        assert_eq!(source.kind(), ErrorKind::Unsupported, "{source}");
        assert_eq!(
            refused_os_error(&source),
            Some(ERROR_INVALID_PARAMETER as i32)
        );

        let lib_dir = tmp.path().join("libraries");
        let lib = lib_dir.join("a.jar");
        let (path, source) = io_parts(copy_file(&src.join("a.bin"), &lib, &control).unwrap_err());
        assert_eq!(path.parent(), Some(lib_dir.as_path()));
        assert_eq!(source.kind(), ErrorKind::Unsupported, "{source}");
        assert_eq!(
            refused_os_error(&source),
            Some(ERROR_INVALID_PARAMETER as i32)
        );
        assert!(names(&lib_dir).is_empty(), "{:?}", names(&lib_dir));

        // 别的打开错误不改写。
        let broken = |_: &Path, _: &File| Err(io::Error::other("注入的打开故障"));
        let control = CopyControl::new(None, &progress).with_readback_hook(&broken);
        let (_, source) = io_parts(verify_tree(&dst, &scan, &digests, &control).unwrap_err());
        assert_eq!(source.kind(), ErrorKind::Other);
        assert_eq!(source.to_string(), "注入的打开故障");
    }

    #[test]
    fn flush_dir_flushes_directories_and_names_the_path_it_could_not_flush() {
        let tmp = tempfile::tempdir().unwrap();
        let versions = tmp.path().join("versions");
        let staged = tmp.path().join(rel(".petalfall/moving/t/instance"));
        write(&staged.join("实例.json"), b"{}");
        fs::create_dir(&versions).unwrap();
        let instance = versions.join("实例");
        rename_no_replace(&staged, &instance).unwrap();

        flush_dir(&versions).unwrap();
        flush_dir(&instance).unwrap();
        assert_eq!(names(&versions), ["实例"]);
        assert_eq!(fs::read(instance.join("实例.json")).unwrap(), b"{}");

        let missing = tmp.path().join("nope");
        let (path, source) = io_parts(flush_dir(&missing).unwrap_err());
        assert_eq!(path, missing);
        assert_eq!(source.kind(), ErrorKind::NotFound);

        let file = instance.join("实例.json");
        let (path, source) = io_parts(flush_dir(&file).unwrap_err());
        assert_eq!(path, file);
        assert_eq!(source.kind(), ErrorKind::NotADirectory);
    }
}
