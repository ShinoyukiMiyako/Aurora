//! 远端文件给出的相对路径的安全判定。
//!
//! 版本 JSON 的库路径、maven 坐标，资源索引的逻辑名与 hash，都会被原样拼进游戏目录下的落点。它们来自远端
//! （版本列表源可以是第三方镜像），文件的 sha1 也由同一份文件给出，下载校验拦不住恶意条目；落盘前一律按
//! 这里的规则拒掉能走出目标目录的值，并说清是哪一种问题。规则按 Windows 的路径解析来定：反斜杠是分隔符，
//! 冒号引出盘符或 NTFS 备用数据流，段尾的点与空格会被悄悄去掉，落盘名与声明的不一致。

/// 一个相对路径或路径段为什么不能拼进目标目录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum UnsafePath {
    /// 整个路径是空串。
    #[error("路径为空")]
    Empty,
    /// 以 `/` 开头，拼接时会替换掉目标目录。
    #[error("是绝对路径")]
    Absolute,
    /// 含反斜杠：Windows 上它也是分隔符，能藏住 `..` 段。
    #[error("含反斜杠")]
    Backslash,
    /// 含冒号：盘符（`C:`）或 NTFS 备用数据流。
    #[error("含冒号（盘符或备用数据流）")]
    Colon,
    /// 两个 `/` 之间或首尾是空段。
    #[error("含空段")]
    EmptySegment,
    /// 有 `.` 或 `..` 段。
    #[error("含 . 或 .. 段")]
    DotSegment,
    /// 有段以点或空格结尾，Windows 落盘时会去掉它们，实际文件名与声明的不一致。
    #[error("有段以点或空格结尾")]
    TrailingDotOrSpace,
    /// 要求是单个路径段，却含 `/`。
    #[error("含路径分隔符")]
    Separator,
}

/// 检查以 `/` 分隔的相对路径能否原样拼到某个目录下而不走出它。
pub fn check_relative_path(path: &str) -> Result<(), UnsafePath> {
    if path.is_empty() {
        return Err(UnsafePath::Empty);
    }
    if path.starts_with('/') {
        return Err(UnsafePath::Absolute);
    }
    if path.contains('\\') {
        return Err(UnsafePath::Backslash);
    }
    if path.contains(':') {
        return Err(UnsafePath::Colon);
    }
    path.split('/').try_for_each(check_segment_text)
}

/// 检查单个路径段（目录名或文件名）。
pub fn check_path_segment(segment: &str) -> Result<(), UnsafePath> {
    if segment.contains('/') {
        return Err(UnsafePath::Separator);
    }
    if segment.contains('\\') {
        return Err(UnsafePath::Backslash);
    }
    if segment.contains(':') {
        return Err(UnsafePath::Colon);
    }
    check_segment_text(segment)
}

/// 已知不含分隔符与冒号的一段。
fn check_segment_text(segment: &str) -> Result<(), UnsafePath> {
    if segment.is_empty() {
        return Err(UnsafePath::EmptySegment);
    }
    if segment == "." || segment == ".." {
        return Err(UnsafePath::DotSegment);
    }
    if segment.ends_with(['.', ' ']) {
        return Err(UnsafePath::TrailingDotOrSpace);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_unsafe_form_names_its_problem() {
        for (path, problem) in [
            ("", UnsafePath::Empty),
            ("/etc/passwd", UnsafePath::Absolute),
            ("//server/share/x.jar", UnsafePath::Absolute),
            ("org\\..\\..\\evil.jar", UnsafePath::Backslash),
            ("C:/Windows/evil.dll", UnsafePath::Colon),
            ("C:evil.dll", UnsafePath::Colon),
            ("lib/a.jar:stream", UnsafePath::Colon),
            ("org//evil.jar", UnsafePath::EmptySegment),
            ("org/evil/", UnsafePath::EmptySegment),
            ("../evil.jar", UnsafePath::DotSegment),
            ("org/../../evil.jar", UnsafePath::DotSegment),
            ("./evil.jar", UnsafePath::DotSegment),
            ("org/.../evil.jar", UnsafePath::TrailingDotOrSpace),
            ("org/evil.jar.", UnsafePath::TrailingDotOrSpace),
            ("org /evil.jar", UnsafePath::TrailingDotOrSpace),
        ] {
            assert_eq!(check_relative_path(path), Err(problem), "{path:?}");
        }
    }

    #[test]
    fn real_paths_pass() {
        for path in [
            "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar",
            "net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar",
            "de/oceanlabs/mcp/mcp_config/1.20.1/mcp_config-1.20.1.zip",
            "minecraft/sounds/ambient/cave/cave1.ogg",
            "sound3/random/old explode.ogg",
            "jre.bundle/Contents/Home/bin/java",
            ".minecraft",
            "a..b/c",
        ] {
            assert_eq!(check_relative_path(path), Ok(()), "{path:?}");
        }
    }

    #[test]
    fn a_segment_must_not_carry_separators() {
        assert_eq!(check_path_segment("17"), Ok(()));
        assert_eq!(check_path_segment("client-1.12.xml"), Ok(()));
        assert_eq!(check_path_segment("a/b"), Err(UnsafePath::Separator));
        assert_eq!(check_path_segment("a\\b"), Err(UnsafePath::Backslash));
        assert_eq!(check_path_segment("C:"), Err(UnsafePath::Colon));
        assert_eq!(check_path_segment(""), Err(UnsafePath::EmptySegment));
        assert_eq!(check_path_segment(".."), Err(UnsafePath::DotSegment));
        assert_eq!(
            check_path_segment("1.0."),
            Err(UnsafePath::TrailingDotOrSpace)
        );
    }
}
