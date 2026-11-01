//! 安装目录校验：选目录页的提示和发起安装前的复核走同一个函数，优先级只在这里定一次。
//!
//! 这个目录同时是数据根：便携判定写得进就把配置、账户和 `.minecraft` 放在 exe 旁边。NSIS 自己只做
//! 弱校验，`/D=` 不合格时静默回落默认目录且退出码照常，所以能拦的都要在发起安装前拦住。
//!
//! 优先级：空 > 相对路径 > `!` > 禁区 > 网络 > 游戏目录 > 写不进 > 空间不足。网络排在游戏目录前，
//! 是因为判定游戏目录要读目录内容，断开的网络位置会让这一步卡几十秒。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::contract::{DirCheck, DirIssue, Failure, FailureCode};
use crate::existing::{APP_EXE, CONFIG_FILE, unquote};

/// 非空目录追加的子目录名，也是默认安装目录的末段。
pub const APP_FOLDER: &str = "Petalfall";
const GAME_FOLDER: &str = ".minecraft";
const VERSIONS_FOLDER: &str = "versions";
/// 沿用启动器便携判定的探针名，留下残骸时看得出是谁的。
const WRITE_PROBE: &str = ".petalfall-write-probe";
/// NSIS 对超过 MAX_PATH 的行为没有保证，而游戏文件还要落在这个目录更深处，这里保守收紧。按 UTF-16 码元算。
const MAX_PATH_UNITS: usize = 200;
/// 目标盘在 exe 之外要多留的：uninstall.exe、快捷方式和簇对齐的余量。
const TARGET_SLACK_BYTES: u64 = 10 * 1024 * 1024;

/// 安装占用的空间，按所在的盘分开算。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpaceNeed {
    /// 目标目录所在的盘。
    pub target: u64,
    /// 临时目录所在的盘：目标选 D 盘而 C 盘已满时，解开载荷这一步就会失败。
    pub temp: u64,
}

impl SpaceNeed {
    /// 按载荷头的长度估算。NSIS 包是 solid 压缩，先把整段数据解到临时文件再写目标，
    /// 所以临时盘上同时有载荷本身和一份解开的 exe。
    pub fn for_payload(payload_len: u64, exe_len: u64) -> Self {
        Self {
            target: exe_len + TARGET_SLACK_BYTES,
            temp: payload_len + exe_len,
        }
    }

    fn fits(&self, target: &Volume, temp: &Volume) -> bool {
        if target.id == temp.id {
            target.free_bytes >= self.target + self.temp
        } else {
            target.free_bytes >= self.target && temp.free_bytes >= self.temp
        }
    }
}

/// 一个卷的身份和剩余空间。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Volume {
    /// 目标和临时目录在同一个卷上时空间要合起来算，盘符认不出挂载到文件夹的卷。
    pub id: String,
    pub free_bytes: u64,
}

/// 判定里要问系统的部分。抽出来是为了让测试不依赖这台电脑的系统目录、盘符和磁盘空间，
/// 临时目录本身也在禁区名单里，测试要能把名单换掉才写得了探针。
pub trait TargetEnv {
    /// 不能安装的目录，含子目录。
    fn blocked_roots(&self) -> Vec<String>;
    fn temp_dir(&self) -> PathBuf;
    /// 第一个系统代码页表示不了的字符。
    fn char_outside_code_page(&self, text: &str) -> Option<char>;
    /// `root` 形如 `D:\`。
    fn is_remote_drive(&self, root: &str) -> bool;
    /// 把已存在的路径规整成长路径：短路径写进注册表后，身份比较全都对不上。
    fn long_path(&self, path: &Path) -> io::Result<String>;
    fn volume(&self, dir: &Path) -> io::Result<Volume>;
}

/// 校验用户给的目录，`normalized` 是实际该传给安装的路径。
///
/// `not_empty` 说的是用户给的目录里有别人的文件，这时 `normalized` 已经追加了一层；`has_config` 说的是
/// `normalized` 这个目录里有上次的数据。
///
/// `resume_dir` 是已知属于落樱、要接着用的目录：半装记录里的目录可能只写了一半文件，卸载后留下的
/// 上次安装目录里只剩数据，目录内容都证明不了归属，不传的话会被当成别人的非空目录再套一层。
pub fn check_dir(
    input: &str,
    need: SpaceNeed,
    resume_dir: Option<&str>,
    env: &dyn TargetEnv,
) -> DirCheck {
    let cleaned = clean(input);
    // 有阻断问题时界面只显示问题，其余字段没人看
    evaluate(&cleaned, need, resume_dir, env).unwrap_or_else(|issue| DirCheck {
        normalized: cleaned,
        issue: Some(issue),
        has_config: false,
        not_empty: false,
        free_bytes: 0,
    })
}

/// 问题码是固定的八个，归类按「用户该怎么办」：不是不能写、而是不该装的都算 forbidden，
/// 包括代码页外字符和盘根；物理上落不了地的都算 unwritable，包括保留名、不存在的盘和超长路径。
fn evaluate(
    path: &str,
    need: SpaceNeed,
    resume_dir: Option<&str>,
    env: &dyn TargetEnv,
) -> Result<DirCheck, DirIssue> {
    if path.is_empty() {
        return Err(DirIssue::Empty);
    }
    if !is_unc(path) && !has_drive(path) {
        return Err(DirIssue::Relative);
    }

    let roots = env.blocked_roots();
    check_text(path, &roots, env)?;
    if is_unc(path) {
        return Err(DirIssue::Network);
    }
    // 保留名不能拿去问文件系统：`D:\NUL` 会被当成设备，看起来是存在的
    if !path.split('\\').skip(1).all(segment_is_valid) {
        return Err(DirIssue::Unwritable);
    }
    if env.is_remote_drive(&path[..3]) {
        return Err(DirIssue::Network);
    }

    let anchor = nearest_existing(Path::new(path)).map_err(unwritable)?;
    let missing = Path::new(path)
        .strip_prefix(anchor)
        .map_err(|_| DirIssue::Unwritable)?;
    let long = rejoin(&env.long_path(anchor).map_err(unwritable)?, missing);
    // 短路径能藏住 `!` 和代码页外的字符，也躲得过名单的字符串比较
    if long != path {
        check_text(&long, &roots, env)?;
    }
    check_resolved(anchor, missing, &roots)?;

    let mut contents = read_contents(Path::new(&long)).map_err(unwritable)?;
    if last_segment(&long).eq_ignore_ascii_case(GAME_FOLDER) || contents.versions {
        return Err(DirIssue::Minecraft);
    }
    // config.json 不算凭据：别的程序目录里也常有这个名字，当成自己的就会读写或改名人家的配置、
    // 覆盖同名 uninstall.exe。多套一层最坏是新开一份数据，不会毁东西
    let ours = contents.exe
        || resume_dir.is_some_and(|dir| lowered_segments(dir) == lowered_segments(&long));
    let not_empty = contents.any && !ours;

    let mut target = long;
    // 已经叫这个名字的目录不再套一层：再套只会得到 Petalfall\Petalfall，也不比这里干净
    if not_empty && !last_segment(&target).eq_ignore_ascii_case(APP_FOLDER) {
        target = format!(r"{target}\{APP_FOLDER}");
        contents = read_contents(Path::new(&target)).map_err(unwritable)?;
        if contents.versions {
            return Err(DirIssue::Minecraft);
        }
    }

    if target.encode_utf16().count() > MAX_PATH_UNITS {
        return Err(DirIssue::Unwritable);
    }
    let anchor = nearest_existing(Path::new(&target)).map_err(unwritable)?;
    probe_write(anchor).map_err(unwritable)?;

    let volume = env.volume(anchor).map_err(unwritable)?;
    let temp = env.volume(&env.temp_dir()).map_err(unwritable)?;
    let issue = (!need.fits(&volume, &temp)).then_some(DirIssue::NoSpace);
    Ok(DirCheck {
        normalized: target,
        issue,
        has_config: contents.config,
        not_empty,
        free_bytes: volume.free_bytes,
    })
}

/// 碰盘失败就是这里要的结论本身，`DirCheck` 没有放错误原文的字段。
fn unwritable(_: io::Error) -> DirIssue {
    DirIssue::Unwritable
}

/// 安装失败后到目标目录看一眼：载荷只给退出码，盘满和没权限都是 2，界面给这两种的退路却不一样。
/// 都没查出问题时返回 `None`，原因就只有退出码了。
///
/// 空间排在探针前：盘满时探针也写不进，说成没权限会把人带去查权限。`reclaimable` 是覆盖时腾得出来的字节，
/// 不算进去的话，空间本来就紧的机器上别的原因失败也会被说成盘满。查不出卷时 `volume` 返回 `None`，只靠探针下结论。
pub fn write_fault(
    dir: &Path,
    need: u64,
    reclaimable: u64,
    volume: impl FnOnce(&Path) -> Option<Volume>,
) -> Option<Failure> {
    let anchor = match nearest_existing(dir) {
        Ok(anchor) => anchor,
        Err(err) => return Some(refused(dir, &err)),
    };
    let short =
        volume(anchor).filter(|volume| volume.free_bytes.saturating_add(reclaimable) < need);
    if let Some(volume) = short {
        return Some(Failure {
            code: FailureCode::DiskFull,
            detail: format!(
                "{} 还剩 {} 字节，需要 {need} 字节",
                volume.id, volume.free_bytes
            ),
        });
    }
    probe_write(anchor).err().map(|err| refused(dir, &err))
}

fn refused(dir: &Path, err: &io::Error) -> Failure {
    let code = if err.kind() == io::ErrorKind::StorageFull {
        FailureCode::DiskFull
    } else {
        FailureCode::DirUnwritable
    };
    Failure {
        code,
        detail: format!("{} 写不进去：{err}", dir.display()),
    }
}

/// 去掉输入两端的空白和引号（资源管理器的「复制文件路径」带引号），盘符路径规整成唯一写法。
/// NSIS 的 `/D=` 不认引号和末尾斜杠，也不解析 `..`。
fn clean(input: &str) -> String {
    let text = unquote(input).replace('/', "\\");
    if has_drive(&text) {
        collapse(&text)
    } else if is_unc(&text) {
        text.trim_end_matches('\\').to_owned()
    } else {
        text
    }
}

fn has_drive(text: &str) -> bool {
    matches!(text.as_bytes(), [drive, b':', b'\\', ..] if drive.is_ascii_alphabetic())
}

/// `\\?\` 和 `\\.\` 是设备路径，不是网络位置，NSIS 也不认：归到「要从盘符开始」。
fn is_unc(text: &str) -> bool {
    text.starts_with(r"\\") && !text.starts_with(r"\\?\") && !text.starts_with(r"\\.\")
}

/// 只接受 [`has_drive`] 为真的路径。
fn collapse(text: &str) -> String {
    let (drive, rest) = text.split_at(2);
    let mut segments = Vec::new();
    for segment in rest.split('\\') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    format!(r"{}\{}", drive.to_ascii_uppercase(), segments.join(r"\"))
}

/// 只看字符串就能下结论的规则。
fn check_text(path: &str, roots: &[String], env: &dyn TargetEnv) -> Result<(), DirIssue> {
    if path.contains('!') {
        return Err(DirIssue::Bang);
    }
    let segments = lowered_segments(path);
    let is_drive_root = has_drive(path) && segments.len() == 1;
    if is_drive_root
        || env.char_outside_code_page(path).is_some()
        || in_sync_folder(&segments)
        || roots.iter().any(|root| is_within(&segments, root))
    {
        return Err(DirIssue::Forbidden);
    }
    Ok(())
}

/// 规整短名和 reparse 之后再比一次：junction 能绕过字符串比较，也可能把目录带到网络位置上。
fn check_resolved(anchor: &Path, missing: &Path, roots: &[String]) -> Result<(), DirIssue> {
    let resolved = rejoin(&canonical_text(anchor).map_err(unwritable)?, missing);
    // 不存在的目录没有规整形式，也就不可能包住一条真实路径
    let resolved_roots: Vec<String> = roots
        .iter()
        .filter_map(|root| canonical_text(Path::new(root)).ok())
        .collect();
    check_resolved_text(&resolved, &resolved_roots)
}

fn check_resolved_text(resolved: &str, roots: &[String]) -> Result<(), DirIssue> {
    if is_unc(resolved) {
        return Err(DirIssue::Network);
    }
    let segments = lowered_segments(resolved);
    if in_sync_folder(&segments) || roots.iter().any(|root| is_within(&segments, root)) {
        return Err(DirIssue::Forbidden);
    }
    Ok(())
}

fn canonical_text(path: &Path) -> io::Result<String> {
    let canonical = fs::canonicalize(path)?;
    Ok(strip_verbatim(&canonical.to_string_lossy()))
}

fn strip_verbatim(text: &str) -> String {
    match text.strip_prefix(r"\\?\UNC\") {
        Some(share) => format!(r"\\{share}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(text).to_owned(),
    }
}

/// Windows 路径不分大小写。
fn lowered_segments(path: &str) -> Vec<String> {
    path.split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// 按段比，`Program Files Extra` 不在 `Program Files` 之内。
fn is_within(segments: &[String], root: &str) -> bool {
    let root = lowered_segments(root);
    !root.is_empty() && segments.starts_with(&root)
}

/// 同步时占用、替换或按需下载正在读写的文件，存档和 Mod 可能读不全。这里认默认文件夹名，
/// 改过位置的 OneDrive 靠 [`TargetEnv::blocked_roots`] 里的根目录认出来。
fn in_sync_folder(segments: &[String]) -> bool {
    segments.iter().any(|segment| {
        segment == "onedrive"
            || segment.starts_with("onedrive - ")
            || segment == "iclouddrive"
            || segment == "icloud drive"
    })
}

fn segment_is_valid(segment: &str) -> bool {
    let bad_char =
        |ch: char| ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*');
    // Windows 会悄悄去掉末尾的空格和点，界面上的路径和落盘的路径就不是同一个了
    !segment.ends_with([' ', '.']) && !segment.contains(bad_char) && !is_reserved_name(segment)
}

/// 带扩展名同样是保留名：`NUL.txt` 也指向设备。
fn is_reserved_name(segment: &str) -> bool {
    let stem = segment
        .split_once('.')
        .map_or(segment, |(stem, _)| stem)
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    let numbered = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"));
    numbered.is_some_and(|rest| {
        let mut chars = rest.chars();
        matches!(
            (chars.next(), chars.next()),
            (Some('0'..='9' | '¹' | '²' | '³'), None)
        )
    })
}

/// 路径上最近的已存在目录。路径上有一段是文件、盘不存在时返回错误：NSIS 对这两种都会静默回落。
fn nearest_existing(path: &Path) -> io::Result<&Path> {
    let mut current = path;
    loop {
        match fs::metadata(current) {
            Ok(meta) if meta.is_dir() => return Ok(current),
            Ok(_) => return Err(io::ErrorKind::NotADirectory.into()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => match current.parent() {
                Some(parent) => current = parent,
                None => return Err(err),
            },
            Err(err) => return Err(err),
        }
    }
}

/// 不用 [`Path::join`]：空的 `missing` 会多出一个末尾反斜杠。
fn rejoin(base: &str, missing: &Path) -> String {
    if missing.as_os_str().is_empty() {
        return base.to_owned();
    }
    format!(r"{}\{}", base.trim_end_matches('\\'), missing.display())
}

fn last_segment(path: &str) -> &str {
    path.rsplit('\\').next().unwrap_or(path)
}

#[derive(Debug, Default)]
struct Contents {
    any: bool,
    exe: bool,
    config: bool,
    versions: bool,
}

/// 目录还不存在时什么都没有。
fn read_contents(dir: &Path) -> io::Result<Contents> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Contents::default()),
        Err(err) => return Err(err),
    };
    let mut contents = Contents::default();
    for entry in entries {
        let entry = entry?;
        contents.any = true;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.eq_ignore_ascii_case(APP_EXE) {
            contents.exe = entry.path().is_file();
        } else if name.eq_ignore_ascii_case(CONFIG_FILE) {
            contents.config = entry.path().is_file();
        } else if name.eq_ignore_ascii_case(VERSIONS_FOLDER) {
            contents.versions = entry.path().is_dir();
        }
    }
    Ok(contents)
}

/// 在 `dir` 里真建一层目录、真写一个文件，再全删掉。查权限位靠不住：网络盘、只读介质、组策略重定向
/// 都可能让权限位看着没问题却写不进去。
///
/// 建目录而不是只写文件：`C:\` 的默认权限许普通用户建目录、不许建文件，只写文件会把
/// `C:\Petalfall` 误判成写不进。名字带随机后缀，上次崩溃留下的残骸不会让这次失败。
fn probe_write(dir: &Path) -> io::Result<()> {
    let probe = tempfile::Builder::new()
        .prefix(WRITE_PROBE)
        .tempdir_in(dir)?;
    fs::write(probe.path().join(WRITE_PROBE), b"")?;
    probe.close()
}

#[cfg(windows)]
pub use system::SystemEnv;

#[cfg(windows)]
mod system {
    use std::ffi::{OsStr, OsString};
    use std::io;
    use std::iter::once;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::S_OK;
    use windows_sys::Win32::Globalization::{
        CP_UTF8, GetACP, WC_NO_BEST_FIT_CHARS, WideCharToMultiByte,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLongPathNameW, GetVolumePathNameW,
    };
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_Documents, FOLDERID_Favorites, FOLDERID_Music, FOLDERID_Pictures,
        FOLDERID_ProgramData, FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86,
        FOLDERID_PublicDocuments, FOLDERID_PublicMusic, FOLDERID_PublicPictures,
        FOLDERID_PublicVideos, FOLDERID_Videos, FOLDERID_Windows, KF_FLAG_DEFAULT,
        SHGetKnownFolderPath,
    };
    use windows_sys::core::GUID;

    use super::{TargetEnv, Volume};

    /// 这个常量所在的模块没有开进依赖，它的值是系统 ABI，不会变。
    const DRIVE_REMOTE: u32 = 4;

    /// 够放下任何卷的挂载点路径。
    const VOLUME_PATH_UNITS: usize = 1024;

    /// OneDrive 客户端设置的根目录环境变量：改过位置的同步目录不一定叫 OneDrive。
    const ONEDRIVE_ENV_VARS: [&str; 3] = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"];

    /// 系统目录要管理员权限，提权运行时探针又会通过，只能靠名单；受控文件夹默认保护的目录在开启时
    /// 写入被拦，启动器的便携判定跟着翻转。Known Folder 返回的是重定向之后的实际位置。
    const BLOCKED_FOLDERS: [GUID; 13] = [
        FOLDERID_ProgramFiles,
        FOLDERID_ProgramFilesX86,
        FOLDERID_Windows,
        FOLDERID_ProgramData,
        FOLDERID_Documents,
        FOLDERID_Favorites,
        FOLDERID_Music,
        FOLDERID_Pictures,
        FOLDERID_Videos,
        FOLDERID_PublicDocuments,
        FOLDERID_PublicMusic,
        FOLDERID_PublicPictures,
        FOLDERID_PublicVideos,
    ];

    /// 真实的系统环境。
    #[derive(Debug, Clone, Copy, Default)]
    pub struct SystemEnv;

    impl TargetEnv for SystemEnv {
        fn blocked_roots(&self) -> Vec<String> {
            let folders = BLOCKED_FOLDERS.iter().filter_map(known_folder);
            let sync_roots = ONEDRIVE_ENV_VARS
                .iter()
                .filter_map(std::env::var_os)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string_lossy().into_owned());
            folders
                .chain(sync_roots)
                .chain(once(self.temp_dir().to_string_lossy().into_owned()))
                .collect()
        }

        fn temp_dir(&self) -> PathBuf {
            std::env::temp_dir()
        }

        fn char_outside_code_page(&self, text: &str) -> Option<char> {
            // SAFETY: 无参数，只读进程的系统代码页。
            let code_page = unsafe { GetACP() };
            char_outside_code_page(text, code_page)
        }

        fn is_remote_drive(&self, root: &str) -> bool {
            let root = wide(OsStr::new(root));
            // SAFETY: root 以 NUL 结尾且活过这次调用。
            unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE }
        }

        fn long_path(&self, path: &Path) -> io::Result<String> {
            let path = wide(path.as_os_str());
            // SAFETY: path 以 NUL 结尾；缓冲区长度传 0 时系统只返回需要的长度。
            let needed = unsafe { GetLongPathNameW(path.as_ptr(), null_mut(), 0) };
            if needed == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buffer = vec![0u16; needed as usize];
            // SAFETY: 缓冲区正好 needed 个码元，长度如实传入。
            let written = unsafe { GetLongPathNameW(path.as_ptr(), buffer.as_mut_ptr(), needed) };
            if written == 0 || written >= needed {
                return Err(io::Error::last_os_error());
            }
            buffer.truncate(written as usize);
            Ok(String::from_utf16_lossy(&buffer))
        }

        fn volume(&self, dir: &Path) -> io::Result<Volume> {
            let dir = wide(dir.as_os_str());
            let mut root = [0u16; VOLUME_PATH_UNITS];
            // SAFETY: dir 以 NUL 结尾，root 是栈上数组，长度如实传入。
            let found = unsafe {
                GetVolumePathNameW(dir.as_ptr(), root.as_mut_ptr(), VOLUME_PATH_UNITS as u32)
            };
            if found == 0 {
                return Err(io::Error::last_os_error());
            }
            let end = root
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(root.len());

            let mut free_bytes = 0u64;
            // SAFETY: dir 以 NUL 结尾，输出参数指向本地变量，其余两个输出是可选的。
            let ok = unsafe {
                GetDiskFreeSpaceExW(dir.as_ptr(), &raw mut free_bytes, null_mut(), null_mut())
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Volume {
                id: String::from_utf16_lossy(&root[..end]),
                free_bytes,
            })
        }
    }

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(once(0)).collect()
    }

    /// 这台机器上不存在的 Known Folder 取不到，也就不用拦。
    fn known_folder(id: &GUID) -> Option<String> {
        let mut path = null_mut();
        // SAFETY: id 指向常量，空令牌表示当前用户，输出参数指向本地变量。
        let status =
            unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT as u32, null_mut(), &raw mut path) };
        let text = (status == S_OK).then(|| {
            // SAFETY: 成功时 path 指向以 NUL 结尾的字符串，到释放之前都有效。
            let length = (0..)
                .take_while(|at| unsafe { *path.add(*at) } != 0)
                .count();
            // SAFETY: 前 length 个码元刚刚逐个读过。
            let units = unsafe { std::slice::from_raw_parts(path, length) };
            OsString::from_wide(units).to_string_lossy().into_owned()
        });
        // SAFETY: 不论成败这块内存都归调用方释放，失败时是空指针，CoTaskMemFree 接受空指针。
        unsafe { CoTaskMemFree(path.cast_const().cast()) };
        text
    }

    /// java.exe 按系统代码页读命令行，表示不了的字符变成问号：装得上，进不了游戏。
    pub(super) fn char_outside_code_page(text: &str, code_page: u32) -> Option<char> {
        // UTF-8 什么都表示得了，而且系统不接受它带这里的标志与输出参数。
        if code_page == CP_UTF8 {
            return None;
        }
        text.chars().filter(|ch| !ch.is_ascii()).find(|ch| {
            let mut wide = [0u16; 2];
            let wide = ch.encode_utf16(&mut wide);
            let mut encoded = [0u8; 8];
            let mut lossy = 0;
            // SAFETY: 两个缓冲区都是栈上数组，长度都小到不会截断 i32，输出参数指向本地变量。
            let written = unsafe {
                WideCharToMultiByte(
                    code_page,
                    WC_NO_BEST_FIT_CHARS,
                    wide.as_ptr(),
                    wide.len() as i32,
                    encoded.as_mut_ptr(),
                    encoded.len() as i32,
                    std::ptr::null(),
                    &raw mut lossy,
                )
            };
            written == 0 || lossy != 0
        })
    }
}

#[cfg(all(test, windows))]
mod tests {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    use super::*;

    const NEED: SpaceNeed = SpaceNeed {
        target: 100,
        temp: 50,
    };
    const FAKE_TEMP: &str = r"X:\fake-temp";

    struct FakeEnv {
        blocked: Vec<String>,
        lost_char: Option<char>,
        remote: bool,
        /// long_path 把前者换成后者，其余原样返回。
        long: Option<(String, String)>,
        target_free: u64,
        temp_free: u64,
        same_volume: bool,
    }

    impl Default for FakeEnv {
        fn default() -> Self {
            Self {
                blocked: Vec::new(),
                lost_char: None,
                remote: false,
                long: None,
                target_free: 1 << 40,
                temp_free: 1 << 40,
                same_volume: false,
            }
        }
    }

    impl TargetEnv for FakeEnv {
        fn blocked_roots(&self) -> Vec<String> {
            self.blocked.clone()
        }

        fn temp_dir(&self) -> PathBuf {
            PathBuf::from(FAKE_TEMP)
        }

        fn char_outside_code_page(&self, _text: &str) -> Option<char> {
            self.lost_char
        }

        fn is_remote_drive(&self, _root: &str) -> bool {
            self.remote
        }

        fn long_path(&self, path: &Path) -> io::Result<String> {
            let text = path.to_str().unwrap().to_owned();
            match &self.long {
                Some((from, to)) if *from == text => Ok(to.clone()),
                _ => Ok(text),
            }
        }

        fn volume(&self, dir: &Path) -> io::Result<Volume> {
            if dir == Path::new(FAKE_TEMP) {
                let id = if self.same_volume { "D:" } else { "T:" };
                return Ok(Volume {
                    id: id.into(),
                    free_bytes: self.temp_free,
                });
            }
            Ok(Volume {
                id: "D:".into(),
                free_bytes: self.target_free,
            })
        }
    }

    fn check(path: &str, env: &FakeEnv) -> DirCheck {
        check_dir(path, NEED, None, env)
    }

    fn issue(path: &str, env: &FakeEnv) -> Option<DirIssue> {
        check(path, env).issue
    }

    fn text(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    fn random_below(bound: u64) -> u64 {
        RandomState::new().build_hasher().finish() % bound
    }

    fn entries(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    fn junction(link: &Path, target: &Path) {
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }

    /// 给 `dir` 加一条拒绝写入的权限。测试结束前要撤掉，否则临时目录里的探针残骸删不掉。
    fn set_write_denied(dir: &Path, denied: bool) {
        const EVERYONE: &str = "*S-1-1-0";
        let mut command = Command::new("icacls");
        command.arg(dir);
        if denied {
            command.args(["/deny", &format!("{EVERYONE}:(AD,WD)")]);
        } else {
            command.args(["/remove:d", EVERYONE]);
        }
        let status = command.stdout(Stdio::null()).status().unwrap();
        assert!(status.success());
    }

    fn roomy(_: &Path) -> Option<Volume> {
        Some(Volume {
            id: r"D:\".into(),
            free_bytes: 1000,
        })
    }

    #[test]
    fn a_writable_target_with_room_has_no_fault_and_keeps_no_probe() {
        let temp = tempfile::tempdir().unwrap();

        assert_eq!(write_fault(temp.path(), 1000, 0, roomy), None);
        assert_eq!(entries(temp.path()), Vec::<String>::new());
    }

    #[test]
    fn a_target_short_of_space_is_disk_full_and_names_the_numbers() {
        let temp = tempfile::tempdir().unwrap();

        assert_eq!(
            write_fault(temp.path(), 1001, 0, roomy),
            Some(Failure {
                code: FailureCode::DiskFull,
                detail: r"D:\ 还剩 1000 字节，需要 1001 字节".to_owned(),
            })
        );
    }

    #[test]
    fn space_an_overwrite_gets_back_counts_towards_the_need() {
        let temp = tempfile::tempdir().unwrap();

        assert_eq!(write_fault(temp.path(), 1500, 500, roomy), None);
        assert_eq!(
            write_fault(temp.path(), 1501, 500, roomy).unwrap().code,
            FailureCode::DiskFull
        );
    }

    #[test]
    fn the_volume_is_asked_about_the_nearest_existing_directory() {
        let temp = tempfile::tempdir().unwrap();
        let asked = std::cell::RefCell::new(PathBuf::new());

        write_fault(&temp.path().join(r"a\b"), 1, 0, |dir| {
            asked.replace(dir.to_owned());
            None
        });

        assert_eq!(asked.into_inner(), temp.path());
    }

    #[test]
    fn a_directory_that_refuses_writes_is_dir_unwritable_with_the_system_error() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("Petalfall");
        set_write_denied(temp.path(), true);

        let fault = write_fault(&dir, 1000, 0, roomy);

        set_write_denied(temp.path(), false);
        let fault = fault.unwrap();
        assert_eq!(fault.code, FailureCode::DirUnwritable);
        let prefix = format!("{} 写不进去：", dir.display());
        assert!(fault.detail.starts_with(&prefix), "{}", fault.detail);
        assert!(fault.detail.contains("os error 5"), "{}", fault.detail);
    }

    #[test]
    fn an_unknown_volume_leaves_the_verdict_to_the_probe() {
        let temp = tempfile::tempdir().unwrap();

        assert_eq!(write_fault(temp.path(), 1, 0, |_| None), None);

        set_write_denied(temp.path(), true);
        let fault = write_fault(temp.path(), 1, 0, |_| None);
        set_write_denied(temp.path(), false);
        assert_eq!(fault.unwrap().code, FailureCode::DirUnwritable);
    }

    #[test]
    fn a_full_disk_is_not_blamed_on_permissions() {
        let temp = tempfile::tempdir().unwrap();
        set_write_denied(temp.path(), true);

        let fault = write_fault(temp.path(), 2000, 0, roomy);

        set_write_denied(temp.path(), false);
        assert_eq!(fault.unwrap().code, FailureCode::DiskFull);
    }

    #[test]
    fn a_probe_stopped_by_a_full_disk_is_disk_full() {
        for code in [112, 39] {
            let err = io::Error::from_raw_os_error(code);

            assert_eq!(
                refused(Path::new(r"D:\Petalfall"), &err).code,
                FailureCode::DiskFull,
                "os error {code}"
            );
        }
        let denied = io::Error::from_raw_os_error(5);
        assert_eq!(
            refused(Path::new(r"D:\Petalfall"), &denied).code,
            FailureCode::DirUnwritable
        );
    }

    #[test]
    fn blank_input_is_empty() {
        let env = FakeEnv::default();
        for input in ["", "   ", "\t", r#""""#, r#"  ""  "#] {
            assert_eq!(issue(input, &env), Some(DirIssue::Empty), "{input:?}");
        }
    }

    #[test]
    fn paths_that_do_not_start_at_a_drive_are_relative() {
        let env = FakeEnv::default();
        for input in [
            "games",
            r"games\Petalfall",
            "D:",
            "D:games",
            r"\games",
            r"..\games",
            r"\\?\D:\Games",
            r"\\.\D:\Games",
            r"1:\Games",
        ] {
            assert_eq!(issue(input, &env), Some(DirIssue::Relative), "{input:?}");
        }
    }

    #[test]
    fn bang_anywhere_in_the_path_is_rejected() {
        let env = FakeEnv::default();
        for input in [
            r"D:\my!games",
            r"D:\!\Petalfall",
            r"D:\a\b!",
            r"\\nas\my!share",
        ] {
            assert_eq!(issue(input, &env), Some(DirIssue::Bang), "{input:?}");
        }
    }

    #[test]
    fn bang_outranks_a_blocked_location() {
        let env = FakeEnv {
            blocked: vec![r"C:\Program Files".into()],
            ..FakeEnv::default()
        };
        assert_eq!(issue(r"C:\Program Files\a!b", &env), Some(DirIssue::Bang));
    }

    #[test]
    fn a_bang_collapsed_away_by_dot_dot_does_not_count() {
        let dir = tempfile::tempdir().unwrap();
        let input = format!(r"{}\a!b\..\Petalfall", text(dir.path()));
        assert_eq!(issue(&input, &FakeEnv::default()), None);
    }

    #[test]
    fn drive_roots_are_forbidden() {
        let env = FakeEnv::default();
        for input in [r"D:\", "D:/", r"d:\\", r"D:\.", r"D:\a\.."] {
            assert_eq!(issue(input, &env), Some(DirIssue::Forbidden), "{input:?}");
        }
    }

    #[test]
    fn a_sync_folder_name_is_judged_without_asking_the_drive() {
        let env = FakeEnv {
            remote: true,
            ..FakeEnv::default()
        };
        assert_eq!(
            issue(r"Z:\OneDrive\Petalfall", &env),
            Some(DirIssue::Forbidden)
        );
    }

    #[test]
    fn an_existing_extra_level_is_probed_itself() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("other.txt"), b"x").unwrap();
        let appended = dir.path().join(APP_FOLDER);
        fs::create_dir(&appended).unwrap();
        set_write_denied(&appended, true);
        let found = issue(text(dir.path()), &FakeEnv::default());
        set_write_denied(&appended, false);
        assert_eq!(found, Some(DirIssue::Unwritable));
    }

    #[test]
    fn paths_the_code_page_cannot_hold_are_forbidden() {
        let env = FakeEnv {
            lost_char: Some('\u{d55c}'),
            ..FakeEnv::default()
        };
        assert_eq!(
            issue("D:\\\u{d55c}\u{ae00}", &env),
            Some(DirIssue::Forbidden)
        );
    }

    #[test]
    fn blocked_roots_cover_their_subfolders_whatever_the_case() {
        let env = FakeEnv {
            blocked: vec![r"C:\Program Files".into(), r"C:\Users\a\Documents\".into()],
            ..FakeEnv::default()
        };
        for input in [
            r"C:\Program Files",
            r"c:\program files\Petalfall",
            r"C:\Users\A\DOCUMENTS\games\Petalfall",
        ] {
            assert_eq!(issue(input, &env), Some(DirIssue::Forbidden), "{input:?}");
        }
    }

    #[test]
    fn a_sibling_with_a_longer_name_is_not_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let env = FakeEnv {
            blocked: vec![format!(r"{}\Program Files", text(dir.path()))],
            ..FakeEnv::default()
        };
        let input = format!(r"{}\Program Files Extra\Petalfall", text(dir.path()));
        assert_eq!(issue(&input, &env), None);
    }

    #[test]
    fn default_sync_folder_names_are_forbidden() {
        let env = FakeEnv::default();
        for input in [
            r"D:\OneDrive\Petalfall",
            r"C:\Users\a\onedrive\games",
            r"C:\Users\a\OneDrive - Contoso\games",
            r"D:\iCloudDrive\games",
            r"D:\iCloud Drive\games",
        ] {
            assert_eq!(issue(input, &env), Some(DirIssue::Forbidden), "{input:?}");
        }
    }

    #[test]
    fn folders_that_merely_mention_a_sync_name_are_fine() {
        let dir = tempfile::tempdir().unwrap();
        let env = FakeEnv::default();
        for name in ["MyOneDrive", "OneDriveBackup", "iCloud"] {
            let input = format!(r"{}\{name}\Petalfall", text(dir.path()));
            assert_eq!(issue(&input, &env), None, "{input:?}");
        }
    }

    #[test]
    fn unc_paths_are_network() {
        let env = FakeEnv::default();
        for input in [r"\\nas\share\Petalfall", "//nas/share", r"\\nas\share\"] {
            assert_eq!(issue(input, &env), Some(DirIssue::Network), "{input:?}");
        }
    }

    #[test]
    fn mapped_network_drives_are_network() {
        let env = FakeEnv {
            remote: true,
            ..FakeEnv::default()
        };
        assert_eq!(issue(r"Z:\Petalfall", &env), Some(DirIssue::Network));
    }

    #[test]
    fn a_network_location_is_not_read_for_game_folders() {
        // 路径指向一个真实的游戏目录，能读到内容就会报 minecraft
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(VERSIONS_FOLDER)).unwrap();
        let env = FakeEnv {
            remote: true,
            ..FakeEnv::default()
        };
        assert_eq!(issue(text(dir.path()), &env), Some(DirIssue::Network));
    }

    #[test]
    fn names_windows_cannot_hold_are_unwritable() {
        let env = FakeEnv::default();
        for input in [
            r"D:\NUL",
            r"D:\con\Petalfall",
            r"D:\Prn.txt",
            r"D:\aux.tar.gz\Petalfall",
            r"D:\COM1",
            r"D:\lpt9\x",
            r"D:\COM¹",
            r"D:\CONIN$",
            r"D:\games.",
            r"D:\games \Petalfall",
            r"D:\a|b",
            r"D:\a?b",
            r"D:\a*b",
            r"D:\a<b>",
            r"D:\a:b",
            r#"D:\a"b"#,
            "D:\\a\tb",
        ] {
            assert_eq!(issue(input, &env), Some(DirIssue::Unwritable), "{input:?}");
        }
    }

    #[test]
    fn names_that_only_resemble_reserved_ones_are_fine() {
        let dir = tempfile::tempdir().unwrap();
        let env = FakeEnv::default();
        for name in ["CONFIG", "NULL", "COM", "COM10", "LPT", "console.d"] {
            let input = format!(r"{}\{name}", text(dir.path()));
            assert_eq!(issue(&input, &env), None, "{input:?}");
        }
    }

    #[test]
    fn a_file_on_the_path_is_unwritable() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.txt");
        fs::write(&file, b"x").unwrap();
        let env = FakeEnv::default();
        assert_eq!(issue(text(&file), &env), Some(DirIssue::Unwritable));
        let below = format!(r"{}\below\Petalfall", text(&file));
        assert_eq!(issue(&below, &env), Some(DirIssue::Unwritable));
    }

    #[test]
    fn a_drive_that_does_not_exist_is_unwritable() {
        let missing = ('A'..='Z')
            .rev()
            .map(|letter| format!(r"{letter}:\"))
            .find(|root| !Path::new(root).exists())
            .expect("这台电脑的 26 个盘符全被占用了");
        let input = format!(r"{missing}games\Petalfall");
        assert_eq!(
            issue(&input, &FakeEnv::default()),
            Some(DirIssue::Unwritable)
        );
    }

    #[test]
    fn a_folder_named_dot_minecraft_is_rejected_even_before_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        let env = FakeEnv::default();
        for name in [".minecraft", ".Minecraft", ".MINECRAFT"] {
            let input = format!(r"{}\{name}", text(dir.path()));
            assert_eq!(issue(&input, &env), Some(DirIssue::Minecraft), "{input:?}");
        }
    }

    #[test]
    fn a_folder_with_versions_inside_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Versions")).unwrap();
        assert_eq!(
            issue(text(dir.path()), &FakeEnv::default()),
            Some(DirIssue::Minecraft)
        );
    }

    #[test]
    fn a_file_named_versions_is_just_a_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(VERSIONS_FOLDER), b"x").unwrap();
        let check = check(text(dir.path()), &FakeEnv::default());
        assert_eq!(check.issue, None);
        assert!(check.not_empty);
    }

    #[test]
    fn the_appended_folder_is_rejected_when_it_is_a_game_folder() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("other.txt"), b"x").unwrap();
        fs::create_dir_all(dir.path().join(APP_FOLDER).join(VERSIONS_FOLDER)).unwrap();
        assert_eq!(
            issue(text(dir.path()), &FakeEnv::default()),
            Some(DirIssue::Minecraft)
        );
    }

    #[test]
    fn junction_into_a_blocked_folder_is_forbidden() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("blocked");
        fs::create_dir(&blocked).unwrap();
        let link = dir.path().join("link");
        junction(&link, &blocked);
        let env = FakeEnv {
            blocked: vec![text(&blocked).to_owned()],
            ..FakeEnv::default()
        };

        let input = format!(r"{}\Petalfall", text(&link));
        assert_eq!(issue(&input, &env), Some(DirIssue::Forbidden));
        assert_eq!(issue(text(&link), &env), Some(DirIssue::Forbidden));
        assert_eq!(entries(&blocked), Vec::<String>::new());
    }

    #[test]
    fn junction_into_a_default_sync_folder_is_forbidden() {
        let dir = tempfile::tempdir().unwrap();
        let sync = dir.path().join("OneDrive");
        fs::create_dir(&sync).unwrap();
        let link = dir.path().join("link");
        junction(&link, &sync);
        assert_eq!(
            issue(text(&link), &FakeEnv::default()),
            Some(DirIssue::Forbidden)
        );
    }

    #[test]
    fn a_path_that_resolves_to_a_share_is_network() {
        assert_eq!(
            check_resolved_text(r"\\nas\share\Petalfall", &[]),
            Err(DirIssue::Network)
        );
        assert_eq!(check_resolved_text(r"E:\Games\Petalfall", &[]), Ok(()));
    }

    #[test]
    fn a_short_name_cannot_hide_a_bang() {
        let dir = tempfile::tempdir().unwrap();
        let short = text(dir.path()).to_owned();
        let env = FakeEnv {
            long: Some((short.clone(), format!(r"{short}\a!b"))),
            ..FakeEnv::default()
        };
        assert_eq!(issue(&short, &env), Some(DirIssue::Bang));
    }

    #[test]
    fn a_short_name_cannot_hide_a_blocked_folder() {
        let dir = tempfile::tempdir().unwrap();
        let short = text(dir.path()).to_owned();
        let long = format!(r"{short}\Program Files");
        let env = FakeEnv {
            blocked: vec![long.clone()],
            long: Some((short.clone(), long)),
            ..FakeEnv::default()
        };
        assert_eq!(issue(&short, &env), Some(DirIssue::Forbidden));
    }

    #[test]
    fn normalized_uses_the_long_form_of_the_part_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let short = text(dir.path()).to_owned();
        let long = format!(r"{short}\长名字");
        fs::create_dir(&long).unwrap();
        let env = FakeEnv {
            long: Some((short.clone(), long.clone())),
            ..FakeEnv::default()
        };
        let input = format!(r"{short}\还没有\Petalfall");
        assert_eq!(
            check(&input, &env).normalized,
            format!(r"{long}\还没有\Petalfall")
        );
    }

    #[test]
    fn writable_new_folder_passes_and_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("游戏 目录").join("Petalfall");
        let check = check(text(&target), &FakeEnv::default());
        assert_eq!(
            check,
            DirCheck {
                normalized: text(&target).to_owned(),
                issue: None,
                has_config: false,
                not_empty: false,
                free_bytes: 1 << 40,
            }
        );
        assert_eq!(entries(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn probing_an_existing_folder_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(issue(text(dir.path()), &FakeEnv::default()), None);
        assert_eq!(entries(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn a_leftover_probe_file_does_not_fail_the_next_probe() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(WRITE_PROBE), b"").unwrap();
        probe_write(dir.path()).unwrap();
        assert_eq!(entries(dir.path()), vec![WRITE_PROBE.to_owned()]);
    }

    #[test]
    fn folder_that_refuses_writes_is_unwritable() {
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        set_write_denied(&locked, true);

        let existing = issue(text(&locked), &FakeEnv::default());
        let below = issue(
            &format!(r"{}\new\Petalfall", text(&locked)),
            &FakeEnv::default(),
        );

        set_write_denied(&locked, false);
        assert_eq!(existing, Some(DirIssue::Unwritable));
        assert_eq!(below, Some(DirIssue::Unwritable));
        assert_eq!(entries(&locked), Vec::<String>::new());
    }

    #[test]
    fn unwritable_outranks_no_space() {
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        set_write_denied(&locked, true);
        let env = FakeEnv {
            target_free: 0,
            ..FakeEnv::default()
        };
        let found = issue(text(&locked), &env);
        set_write_denied(&locked, false);
        assert_eq!(found, Some(DirIssue::Unwritable));
    }

    #[test]
    fn path_length_limit_is_two_hundred_units_inclusive() {
        let dir = tempfile::tempdir().unwrap();
        let base = text(dir.path());
        let fill = |total: usize| format!(r"{base}\{}", "x".repeat(total - base.len() - 1));
        let env = FakeEnv::default();
        assert_eq!(issue(&fill(MAX_PATH_UNITS), &env), None);
        assert_eq!(
            issue(&fill(MAX_PATH_UNITS + 1), &env),
            Some(DirIssue::Unwritable)
        );
    }

    #[test]
    fn path_length_counts_utf16_units_not_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let base = text(dir.path());
        let units = MAX_PATH_UNITS - base.len() - 1;
        let input = format!(r"{base}\{}", "樱".repeat(units));
        assert_eq!(issue(&input, &FakeEnv::default()), None);
    }

    #[test]
    fn path_length_includes_the_appended_folder() {
        let dir = tempfile::tempdir().unwrap();
        let base = text(dir.path());
        let long = format!(
            r"{base}\{}",
            "x".repeat(MAX_PATH_UNITS - base.len() - APP_FOLDER.len() - 1)
        );
        fs::create_dir(&long).unwrap();
        fs::write(Path::new(&long).join("other.txt"), b"x").unwrap();
        assert_eq!(
            issue(&long, &FakeEnv::default()),
            Some(DirIssue::Unwritable)
        );
    }

    #[test]
    fn target_volume_needs_exactly_its_share() {
        let dir = tempfile::tempdir().unwrap();
        let target = text(dir.path());
        let with_free = |target_free| FakeEnv {
            target_free,
            ..FakeEnv::default()
        };
        assert_eq!(issue(target, &with_free(NEED.target)), None);
        assert_eq!(
            issue(target, &with_free(NEED.target - 1)),
            Some(DirIssue::NoSpace)
        );
        assert_eq!(
            issue(target, &with_free(NEED.target + 1 + random_below(1 << 20))),
            None
        );
    }

    #[test]
    fn temp_volume_needs_exactly_its_share() {
        let dir = tempfile::tempdir().unwrap();
        let target = text(dir.path());
        let with_free = |temp_free| FakeEnv {
            temp_free,
            ..FakeEnv::default()
        };
        assert_eq!(issue(target, &with_free(NEED.temp)), None);
        assert_eq!(
            issue(target, &with_free(NEED.temp - 1)),
            Some(DirIssue::NoSpace)
        );
    }

    #[test]
    fn a_shared_volume_needs_both_shares_together() {
        let dir = tempfile::tempdir().unwrap();
        let target = text(dir.path());
        let with_free = |free| FakeEnv {
            target_free: free,
            temp_free: free,
            same_volume: true,
            ..FakeEnv::default()
        };
        let total = NEED.target + NEED.temp;
        assert_eq!(issue(target, &with_free(total)), None);
        assert_eq!(
            issue(target, &with_free(total - 1)),
            Some(DirIssue::NoSpace)
        );
    }

    #[test]
    fn no_space_still_reports_the_target_volume_and_the_data_found() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(APP_EXE), b"MZ").unwrap();
        fs::write(dir.path().join(CONFIG_FILE), b"{}").unwrap();
        let free = random_below(NEED.target);
        let env = FakeEnv {
            target_free: free,
            ..FakeEnv::default()
        };
        assert_eq!(
            check(text(dir.path()), &env),
            DirCheck {
                normalized: text(dir.path()).to_owned(),
                issue: Some(DirIssue::NoSpace),
                has_config: true,
                not_empty: false,
                free_bytes: free,
            }
        );
    }

    #[test]
    fn space_need_splits_by_where_the_bytes_land() {
        const MIB: u64 = 1024 * 1024;
        assert_eq!(
            SpaceNeed::for_payload(10 * MIB, 40 * MIB),
            SpaceNeed {
                target: 50 * MIB,
                temp: 50 * MIB,
            }
        );
    }

    #[test]
    fn empty_folder_is_used_as_is() {
        let dir = tempfile::tempdir().unwrap();
        let check = check(text(dir.path()), &FakeEnv::default());
        assert_eq!(check.normalized, text(dir.path()));
        assert!(!check.not_empty);
        assert!(!check.has_config);
    }

    #[test]
    fn foreign_folder_gets_an_extra_level() {
        let dir = tempfile::tempdir().unwrap();
        let name = format!("file-{}.txt", random_below(u64::MAX));
        fs::write(dir.path().join(name), b"x").unwrap();
        let check = check(text(dir.path()), &FakeEnv::default());
        assert_eq!(
            check,
            DirCheck {
                normalized: format!(r"{}\Petalfall", text(dir.path())),
                issue: None,
                has_config: false,
                not_empty: true,
                free_bytes: 1 << 40,
            }
        );
        assert!(!dir.path().join(APP_FOLDER).exists());
    }

    #[test]
    fn a_subfolder_alone_makes_a_folder_foreign() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("saves")).unwrap();
        assert_eq!(
            check(text(dir.path()), &FakeEnv::default()).normalized,
            format!(r"{}\Petalfall", text(dir.path()))
        );
    }

    #[test]
    fn checking_the_appended_path_again_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("other.txt"), b"x").unwrap();
        let env = FakeEnv::default();
        let first = check(text(dir.path()), &env).normalized;
        assert_eq!(check(&first, &env).normalized, first);
    }

    #[test]
    fn own_install_stays_in_place() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("PETALFALL.EXE"), b"MZ").unwrap();
        fs::write(dir.path().join("uninstall.exe"), b"MZ").unwrap();
        let check = check(text(dir.path()), &FakeEnv::default());
        assert_eq!(check.normalized, text(dir.path()));
        assert!(!check.not_empty);
    }

    #[test]
    fn a_folder_named_like_the_exe_does_not_make_the_install_ours() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(APP_EXE)).unwrap();
        let check = check(text(dir.path()), &FakeEnv::default());
        assert_eq!(check.normalized, format!(r"{}\Petalfall", text(dir.path())));
    }

    #[test]
    fn leftover_data_in_a_folder_named_petalfall_stays_and_reports_config() {
        let dir = tempfile::tempdir().unwrap();
        let named = dir.path().join(APP_FOLDER);
        fs::create_dir(&named).unwrap();
        fs::write(named.join("Config.JSON"), b"{}").unwrap();
        fs::create_dir(named.join(GAME_FOLDER)).unwrap();
        let check = check(text(&named), &FakeEnv::default());
        assert_eq!(check.normalized, text(&named));
        assert!(check.has_config);
    }

    #[test]
    fn leftover_data_in_the_resume_dir_stays_and_reports_config() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(CONFIG_FILE), b"{}").unwrap();
        fs::create_dir(dir.path().join(GAME_FOLDER)).unwrap();
        let check = check_dir(
            text(dir.path()),
            NEED,
            Some(text(dir.path())),
            &FakeEnv::default(),
        );
        assert_eq!(check.normalized, text(dir.path()));
        assert!(check.has_config);
        assert!(!check.not_empty);
    }

    #[test]
    fn a_foreign_config_json_does_not_make_the_folder_ours() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(CONFIG_FILE), b"{}").unwrap();
        fs::write(dir.path().join("uninstall.exe"), b"MZ").unwrap();
        assert_eq!(
            check(text(dir.path()), &FakeEnv::default()),
            DirCheck {
                normalized: format!(r"{}\Petalfall", text(dir.path())),
                issue: None,
                has_config: false,
                not_empty: true,
                free_bytes: 1 << 40,
            }
        );
        assert!(!dir.path().join(APP_FOLDER).exists());
    }

    #[test]
    fn a_folder_named_config_json_is_not_leftover_data() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(CONFIG_FILE)).unwrap();
        let check = check(text(dir.path()), &FakeEnv::default());
        assert!(!check.has_config);
        assert!(check.not_empty);
    }

    #[test]
    fn the_interrupted_target_stays_in_place() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("half-written.tmp"), b"x").unwrap();
        let resume = text(dir.path()).to_uppercase();
        let check = check_dir(text(dir.path()), NEED, Some(&resume), &FakeEnv::default());
        assert_eq!(check.normalized, text(dir.path()));
        assert!(!check.not_empty);
    }

    #[test]
    fn a_different_interrupted_target_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("other.txt"), b"x").unwrap();
        let check = check_dir(
            text(dir.path()),
            NEED,
            Some(r"D:\somewhere\else"),
            &FakeEnv::default(),
        );
        assert_eq!(check.normalized, format!(r"{}\Petalfall", text(dir.path())));
    }

    #[test]
    fn a_foreign_folder_already_named_petalfall_is_not_nested_again() {
        let dir = tempfile::tempdir().unwrap();
        let named = dir.path().join("PETALFALL");
        fs::create_dir(&named).unwrap();
        fs::write(named.join("other.txt"), b"x").unwrap();
        let check = check(text(&named), &FakeEnv::default());
        assert_eq!(check.normalized, text(&named));
        assert!(check.not_empty);
    }

    #[test]
    fn data_in_the_appended_folder_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("other.txt"), b"x").unwrap();
        fs::create_dir(dir.path().join(APP_FOLDER)).unwrap();
        fs::write(dir.path().join(APP_FOLDER).join(CONFIG_FILE), b"{}").unwrap();
        let check = check(text(dir.path()), &FakeEnv::default());
        assert_eq!(check.normalized, format!(r"{}\Petalfall", text(dir.path())));
        assert!(check.has_config);
    }

    #[test]
    fn a_file_where_the_extra_level_should_go_is_unwritable() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(APP_FOLDER), b"x").unwrap();
        assert_eq!(
            issue(text(dir.path()), &FakeEnv::default()),
            Some(DirIssue::Unwritable)
        );
    }

    #[test]
    fn input_is_normalized_to_one_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let base = text(dir.path());
        let expected = format!(r"{base}\Games\Petalfall");
        let env = FakeEnv::default();
        for input in [
            format!(r"{base}\Games\Petalfall\"),
            format!(r"{base}\Games\Petalfall\\\"),
            format!(r"  {base}\Games\Petalfall  "),
            format!(r#""{base}\Games\Petalfall""#),
            format!(r#"  "{base}\Games\Petalfall\"  "#),
            format!(r"{base}\Games\\Petalfall"),
            format!(r"{base}\.\Games\.\Petalfall"),
            format!(r"{base}\Games\other\..\Petalfall"),
            format!(r"{base}\Games\Petalfall").replace('\\', "/"),
        ] {
            assert_eq!(check(&input, &env).normalized, expected, "{input:?}");
        }
    }

    #[test]
    fn drive_letter_is_upper_cased() {
        assert_eq!(collapse(r"d:\Games"), r"D:\Games");
        assert_eq!(collapse(r"d:\"), r"D:\");
        assert_eq!(collapse(r"d:\a\..\..\b"), r"D:\b");
    }

    #[test]
    fn rejected_paths_keep_what_the_user_typed_for_display() {
        let env = FakeEnv::default();
        assert_eq!(check("  games  ", &env).normalized, "games");
        assert_eq!(check(r"D:\a!b\", &env).normalized, r"D:\a!b");
        assert_eq!(check(r"\\nas\share\", &env).normalized, r"\\nas\share");
    }

    #[test]
    fn verbatim_prefixes_come_off() {
        assert_eq!(strip_verbatim(r"\\?\D:\Games"), r"D:\Games");
        assert_eq!(strip_verbatim(r"\\?\UNC\nas\share"), r"\\nas\share");
        assert_eq!(strip_verbatim(r"D:\Games"), r"D:\Games");
    }

    #[test]
    fn code_page_check_finds_the_first_character_it_cannot_encode() {
        const GBK: u32 = 936;
        const WESTERN: u32 = 1252;
        const UTF8: u32 = 65001;
        let outside = system::char_outside_code_page;
        assert_eq!(outside(r"D:\我的世界\生存", GBK), None);
        assert_eq!(
            outside("D:\\我的世界\\\u{d55c}\u{ae00}", GBK),
            Some('\u{d55c}')
        );
        assert_eq!(outside(r"D:\games", WESTERN), None);
        assert_eq!(outside(r"D:\我的世界", WESTERN), Some('我'));
        assert_eq!(outside("D:\\\u{20BB7}", GBK), Some('\u{20BB7}'));
        assert_eq!(outside("D:\\\u{d55c}\u{20BB7}", UTF8), None);
    }

    #[test]
    fn system_blocked_roots_name_the_system_folders_and_temp() {
        let roots: Vec<Vec<String>> = SystemEnv
            .blocked_roots()
            .iter()
            .map(|root| lowered_segments(root))
            .collect();
        for variable in ["SystemRoot", "ProgramFiles", "ProgramData"] {
            let expected = lowered_segments(&std::env::var(variable).unwrap());
            assert!(roots.contains(&expected), "{variable}");
        }
        assert!(roots.contains(&lowered_segments(text(&std::env::temp_dir()))));
    }

    #[test]
    fn system_env_rejects_the_windows_folder_without_touching_it() {
        let windows = std::env::var("SystemRoot").unwrap();
        let input = format!(r"{windows}\Petalfall");
        assert_eq!(
            check_dir(&input, NEED, None, &SystemEnv).issue,
            Some(DirIssue::Forbidden)
        );
    }

    #[test]
    fn system_env_reads_the_volume_of_a_real_folder() {
        let dir = tempfile::tempdir().unwrap();
        let volume = SystemEnv.volume(dir.path()).unwrap();
        assert!(volume.id.ends_with('\\'), "{}", volume.id);
        assert!(volume.free_bytes > 0);
        assert!(
            text(dir.path())
                .to_lowercase()
                .starts_with(&volume.id.to_lowercase())
        );
    }

    #[test]
    fn system_env_sees_the_system_drive_as_local() {
        let drive = std::env::var("SystemDrive").unwrap();
        assert!(!SystemEnv.is_remote_drive(&format!(r"{drive}\")));
    }

    #[test]
    fn system_env_expands_short_names() {
        use std::os::windows::ffi::OsStrExt;

        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

        let dir = tempfile::tempdir().unwrap();
        let long = dir.path().join("a rather long folder name");
        fs::create_dir(&long).unwrap();

        let wide: Vec<u16> = long.as_os_str().encode_wide().chain([0]).collect();
        let mut short = [0u16; 1024];
        // SAFETY: wide 以 NUL 结尾，short 是栈上数组，长度如实传入。
        let written =
            unsafe { GetShortPathNameW(wide.as_ptr(), short.as_mut_ptr(), short.len() as u32) };
        assert!(written > 0);
        let short = String::from_utf16_lossy(&short[..written as usize]);

        assert_eq!(
            SystemEnv.long_path(Path::new(&short)).unwrap(),
            canonical_text(&long).unwrap()
        );
    }

    #[test]
    fn system_env_reports_a_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert!(SystemEnv.long_path(&missing).is_err());
    }
}
