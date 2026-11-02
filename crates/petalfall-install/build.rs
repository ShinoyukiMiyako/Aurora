//! 构建脚本：给本 crate 产出的可执行文件（含 cargo test 的测试二进制）嵌入 asInvoker UAC 清单。
//!
//! Windows 的「安装程序检测（Installer Detection）」启发式会因文件名里含 `install` 而给
//! `aurora_install-*.exe`（cargo 生成的测试二进制）强行索要管理员提权，导致 `cargo test` 以
//! `os error 740`（需要提升）失败。嵌入一份声明 `requestedExecutionLevel=asInvoker` 的清单即可
//! 关闭该启发式，让测试二进制以普通权限运行。仅对 MSVC 目标生效（用 link.exe 的 /MANIFESTUAC）。

fn main() {
    let is_msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let is_windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    if is_windows && is_msvc {
        // /MANIFEST:EMBED 把清单直接写进 PE，/MANIFESTUAC 指定执行级别。
        // 用通用 rustc-link-arg：它覆盖库的单元测试二进制（正是被 UAC 拦下的那个 aurora_install-*.exe）、
        // 集成测试与示例。本 crate 是纯库，无 bin 目标，故不用 -bins 作用域（无目标会报错）。
        // 用无空格的单 token 形式，避免嵌套引号被 link.exe 二次拆分（uiAccess 默认即 false）。
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTUAC:level='asInvoker'");
    }
}
