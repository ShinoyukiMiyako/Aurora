use std::path::Path;

use aurora_modpack::path::{PathValidationError, SafeRelativePath, validate_relative_path};

#[test]
fn accepts_portable_relative_paths_and_resolves_by_component() {
    for path in [
        "mods/sodium-0.5.3.jar",
        "config/wok client.toml",
        "资源包/蓝色档案.zip",
        "defaultconfigs/index.json",
        "options.txt",
    ] {
        assert!(
            validate_relative_path(path).is_ok(),
            "合法路径被拒绝: {path}"
        );
    }

    let path = SafeRelativePath::new("config/nested/client.toml").unwrap();
    assert_eq!(
        path.resolve_under(Path::new("D:/instances/wok")),
        Path::new("D:/instances/wok")
            .join("config")
            .join("nested")
            .join("client.toml")
    );
}

#[test]
fn rejects_launcher_metadata_root_case_insensitively() {
    let meta = aurora_instance::AURORA_META_DIR;
    for path in [
        format!("{meta}/modpack.json"),
        format!("{}/settings.json", meta.to_uppercase()),
        format!("{meta}/nested/file.txt"),
    ] {
        assert!(
            matches!(
                validate_relative_path(&path),
                Err(PathValidationError::ProtectedTopLevel { .. })
            ),
            "元数据目录路径未被拒绝: {path}"
        );
    }
    // 只有顶层算：深层同名目录是整合包自己的事。
    assert!(validate_relative_path(&format!("config/{meta}/a.txt")).is_ok());
}

#[test]
fn allows_bundled_worlds_screenshots_and_logs() {
    // 地图类整合包自带存档，这些目录对导入为新实例的整合包是正常内容。
    for path in [
        "saves/world/level.dat",
        "screenshots/2026-08-17.png",
        "logs/latest.log",
    ] {
        assert!(validate_relative_path(path).is_ok(), "被误拒: {path}");
    }
}

#[test]
fn rejects_absolute_traversal_drive_and_noncanonical_separators() {
    let cases = [
        ("", PathValidationError::Empty),
        ("/mods/a.jar", PathValidationError::Absolute),
        ("\\\\server\\share", PathValidationError::Absolute),
        ("mods\\a.jar", PathValidationError::Backslash),
        ("C:/mods/a.jar", PathValidationError::DrivePrefix),
        ("z:mods/a.jar", PathValidationError::DrivePrefix),
        ("../options.txt", PathValidationError::ParentTraversal),
        ("mods/../options.txt", PathValidationError::ParentTraversal),
        ("./options.txt", PathValidationError::CurrentDirectory),
        ("mods//a.jar", PathValidationError::EmptyComponent),
        ("mods/", PathValidationError::EmptyComponent),
    ];

    for (path, expected) in cases {
        assert_eq!(validate_relative_path(path), Err(expected), "路径: {path}");
    }
}

#[test]
fn rejects_windows_reserved_names_with_case_and_extensions() {
    for component in [
        "CON",
        "con.txt",
        "PrN.cfg",
        "AUX",
        "nul.dat",
        "COM1",
        "com9.jar",
        "LPT1",
        "lpt9.txt",
        "CLOCK$",
        "CONIN$",
        "CONOUT$",
        "COM¹",
        "com².txt",
        "COM³",
        "LPT¹",
        "lpt².cfg",
        "LPT³",
        "CON .txt",
    ] {
        let path = format!("config/{component}");
        assert!(
            matches!(
                validate_relative_path(&path),
                Err(PathValidationError::ReservedName { .. })
            ),
            "保留名未被拒绝: {path}"
        );
    }

    for component in ["COM0", "COM10", "LPT0", "LPT10", "console.txt"] {
        let path = format!("config/{component}");
        assert!(
            validate_relative_path(&path).is_ok(),
            "普通名称被误拒绝: {path}"
        );
    }
}

#[test]
fn rejects_windows_aliases_invalid_characters_and_controls() {
    for path in [
        "config/name. ",
        "config/name.",
        "config/a:b.txt",
        "config/a?.txt",
        "config/a*.txt",
        "config/a|b.txt",
        "config/a<b.txt",
        "config/a>b.txt",
        "config/a\"b.txt",
        "config/a\u{0000}b.txt",
        "config/a\u{001f}b.txt",
        "config/a\u{007f}b.txt",
    ] {
        assert!(
            validate_relative_path(path).is_err(),
            "危险路径未被拒绝: {path:?}"
        );
    }

    for path in [
        "mods/LONGFI~1.JAR",
        "config/screen~12/options.txt",
        "mods/资源包~2.zip",
    ] {
        assert!(
            matches!(
                validate_relative_path(path),
                Err(PathValidationError::DosShortName { .. })
            ),
            "DOS 短文件名别名未被拒绝: {path}"
        );
    }
}

/// 这些原文经错误详情显示在界面上，中文句子里用全角冒号。
#[test]
fn rejection_messages_use_full_width_colons() {
    let meta = aurora_instance::AURORA_META_DIR;
    assert_eq!(
        validate_relative_path(&format!("{meta}/a"))
            .unwrap_err()
            .to_string(),
        format!(
            "路径进入{}元数据目录：{meta}",
            aurora_base::brand::APP_NAME
        )
    );
    for (path, message) in [
        ("mods/a.", "路径组件以点或空格结尾：a."),
        ("mods/a?.jar", "路径组件含 Windows 非法字符：a?.jar"),
        ("mods/CON.jar", "路径组件是 Windows 保留设备名：CON.jar"),
        ("mods/PROGRA~1", "路径组件疑似 DOS 短文件名别名：PROGRA~1"),
    ] {
        assert_eq!(
            validate_relative_path(path).unwrap_err().to_string(),
            message
        );
    }
}
