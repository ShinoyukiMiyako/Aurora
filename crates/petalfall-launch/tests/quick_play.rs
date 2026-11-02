//! 直达存档与服务器的命令行断言。1.20.1 与 1.21.1 的夹具从官方版本 JSON 摘出，`arguments.game` 逐字
//! 保留（含四个 Quick Play 条件块）；1.12.2 是旧式 `minecraftArguments`。另有两份内联样例：1.19.4 式的
//! 新式参数（有 `arguments.game`、没有 Quick Play 块），以及不含 `--username` 的位置参数式旧版。

use std::path::PathBuf;

use aurora_launch::{
    AuthValues, CommandBuilder, GamePaths, LaunchError, QuickPlayMode, QuickPlaySupport,
    QuickPlayTarget, legacy_server_args, quick_play_support,
};
use aurora_version::{OsName, RuntimeContext, VersionJson};

const V1_12_2: &str = include_str!("fixtures/1.12.2.json");
const V1_20_1: &str = include_str!("fixtures/1.20.1.json");
const V1_21_1: &str = include_str!("fixtures/1.21.1.json");

/// 1.19.4 式：结构化 arguments，条件块只有试玩与自定义分辨率两个，与官方 1.19.4 一致。
const V1_19_4_STYLE: &str = r#"{
    "id": "1.19.4",
    "type": "release",
    "mainClass": "net.minecraft.client.main.Main",
    "assets": "3",
    "arguments": {
        "game": [
            "--username", "${auth_player_name}",
            "--version", "${version_name}",
            "--gameDir", "${game_directory}",
            "--versionType", "${version_type}",
            {"rules": [{"action": "allow", "features": {"is_demo_user": true}}], "value": "--demo"},
            {"rules": [{"action": "allow", "features": {"has_custom_resolution": true}}], "value": ["--width", "${resolution_width}", "--height", "${resolution_height}"]}
        ],
        "jvm": ["-cp", "${classpath}"]
    }
}"#;

/// 位置参数式的旧版：玩家名与会话是裸位置参数，没有 `--username`。
const POSITIONAL_LEGACY: &str = r#"{
    "id": "1.5.2",
    "type": "release",
    "mainClass": "net.minecraft.client.Minecraft",
    "minecraftArguments": "${auth_player_name} ${auth_session} --workDir ${game_directory}"
}"#;

fn version(json: &str) -> VersionJson {
    VersionJson::from_json_str(json).expect("夹具应能解析")
}

fn s(value: &str) -> String {
    value.to_owned()
}

fn singleplayer(world: &str) -> QuickPlayTarget {
    QuickPlayTarget::Singleplayer {
        world_dir_name: s(world),
    }
}

fn multiplayer(address: &str, host: &str, port: u16) -> QuickPlayTarget {
    QuickPlayTarget::Multiplayer {
        address: s(address),
        host: s(host),
        port,
    }
}

fn builder(version: &VersionJson) -> CommandBuilder<'_> {
    let root = PathBuf::from("D:/mc/.minecraft");
    CommandBuilder::new(
        version,
        RuntimeContext::new(OsName::Windows, "x86_64", 64).with_os_version("10.0.22631"),
        PathBuf::from("C:/jdk/bin/java.exe"),
        GamePaths::standard(&root, &version.id),
        &root,
        AuthValues::offline("Steve", "0123456789abcdef0123456789abcdef"),
        "1.0.0",
    )
}

fn args_with(version: &VersionJson, target: Option<QuickPlayTarget>) -> Vec<String> {
    let mut builder = builder(version);
    if let Some(target) = target {
        builder = builder.with_quick_play(target);
    }
    builder.build().expect("应拼出命令行").args
}

/// `args` 里有没有紧挨着的这一段。
fn has_run(args: &[String], run: &[&str]) -> bool {
    args.windows(run.len())
        .any(|window| window.iter().zip(run).all(|(a, b)| a == b))
}

fn count(args: &[String], token: &str) -> usize {
    args.iter().filter(|a| *a == token).count()
}

/// 任何情况下都不能出现的参数：记录路径与 Realms 不置 feature，新版没有 `--server`。
fn assert_no_forbidden(args: &[String]) {
    for token in ["--quickPlayPath", "--quickPlayRealms"] {
        assert_eq!(count(args, token), 0, "不该出现 {token}：{args:?}");
    }
    assert!(
        !args.iter().any(|a| a.contains("${quickPlay")),
        "残留了 Quick Play 占位符：{args:?}"
    );
}

/// 末尾几个 token。
fn tail(args: &[String], n: usize) -> Vec<&str> {
    args[args.len() - n..].iter().map(String::as_str).collect()
}

#[test]
fn singleplayer_passes_the_world_folder_as_one_token_right_after_the_base_args() {
    for json in [V1_20_1, V1_21_1] {
        let version = version(json);
        let args = args_with(&version, Some(singleplayer("New World")));
        // 没开分辨率与试玩，Quick Play 块就是游戏段的最后两个 token。
        assert_eq!(
            tail(&args, 4),
            vec![
                "--versionType",
                "release",
                "--quickPlaySingleplayer",
                "New World"
            ],
            "{}",
            version.id
        );
        assert_eq!(count(&args, "--quickPlaySingleplayer"), 1);
        assert_eq!(count(&args, "--quickPlayMultiplayer"), 0);
        assert_eq!(count(&args, "--server"), 0);
        assert_no_forbidden(&args);
    }
}

#[test]
fn multiplayer_passes_the_address_verbatim_without_adding_a_port() {
    for json in [V1_20_1, V1_21_1] {
        let version = version(json);
        let args = args_with(
            &version,
            Some(multiplayer("mc.example.com:25570", "mc.example.com", 25570)),
        );
        assert!(
            has_run(&args, &["--quickPlayMultiplayer", "mc.example.com:25570"]),
            "{args:?}"
        );
        assert_eq!(
            tail(&args, 2),
            vec!["--quickPlayMultiplayer", "mc.example.com:25570"]
        );
        assert_eq!(count(&args, "--quickPlaySingleplayer"), 0);
        assert_eq!(count(&args, "--server"), 0);
        assert_eq!(count(&args, "--port"), 0);
        assert_no_forbidden(&args);

        // 没写端口的裸主机原样交给游戏，由它按多人列表的规则解析（含 SRV），不补 :25565。
        let bare = args_with(
            &version,
            Some(multiplayer("play.example.com", "play.example.com", 25565)),
        );
        assert_eq!(
            tail(&bare, 2),
            vec!["--quickPlayMultiplayer", "play.example.com"]
        );
        assert!(!bare.iter().any(|a| a.contains("25565")), "{bare:?}");
        assert_eq!(count(&bare, "--server"), 0);
        assert_no_forbidden(&bare);
    }
}

#[test]
fn without_quick_play_no_quick_play_token_or_placeholder_appears() {
    for json in [V1_20_1, V1_21_1, V1_12_2, V1_19_4_STYLE] {
        let version = version(json);
        let args = args_with(&version, None);
        assert!(
            !args.iter().any(|a| a.starts_with("--quickPlay")),
            "{}: {args:?}",
            version.id
        );
        assert_eq!(count(&args, "--server"), 0, "{}", version.id);
        assert_eq!(count(&args, "--port"), 0, "{}", version.id);
        assert_no_forbidden(&args);
    }
}

#[test]
fn legacy_1_12_2_multiplayer_appends_server_and_explicit_port() {
    let version = version(V1_12_2);
    let args = args_with(
        &version,
        Some(multiplayer("mc.example.com:25570", "mc.example.com", 25570)),
    );
    assert_eq!(
        tail(&args, 6),
        vec![
            "--versionType",
            "release",
            "--server",
            "mc.example.com",
            "--port",
            "25570"
        ]
    );
    assert!(!args.iter().any(|a| a.starts_with("--quickPlay")));

    // 没写端口时调用方给的是缺省端口，照样显式写出，不依赖旧版游戏自己的缺省值。
    let default_port = args_with(
        &version,
        Some(multiplayer("mc.example.com", "mc.example.com", 25565)),
    );
    assert_eq!(
        tail(&default_port, 4),
        vec!["--server", "mc.example.com", "--port", "25565"]
    );

    // IPv6 的主机名不带方括号：--server 后面是纯地址。
    let ipv6 = args_with(
        &version,
        Some(multiplayer("[2001:db8::1]:25570", "2001:db8::1", 25570)),
    );
    assert_eq!(
        tail(&ipv6, 4),
        vec!["--server", "2001:db8::1", "--port", "25570"]
    );
}

#[test]
fn legacy_1_12_2_singleplayer_is_unsupported() {
    let version = version(V1_12_2);
    let err = builder(&version)
        .with_quick_play(singleplayer("New World"))
        .build()
        .unwrap_err();
    match err {
        LaunchError::QuickPlayUnsupported { version, mode } => {
            assert_eq!(version, "1.12.2");
            assert_eq!(mode, QuickPlayMode::Singleplayer);
        }
        other => panic!("应报不支持直达存档，实际：{other:?}"),
    }
    let message = LaunchError::QuickPlayUnsupported {
        version: s("1.12.2"),
        mode: QuickPlayMode::Singleplayer,
    }
    .to_string();
    assert_eq!(
        message,
        "版本 1.12.2 不支持直接进入存档（1.20 之前的版本没有 Quick Play）"
    );
    assert_eq!(
        LaunchError::QuickPlayUnsupported {
            version: s("1.5.2"),
            mode: QuickPlayMode::Multiplayer,
        }
        .to_string(),
        "版本 1.5.2 不支持直接加入服务器"
    );
}

#[test]
fn modern_args_without_quick_play_blocks_fall_back_to_server_and_port() {
    let version = version(V1_19_4_STYLE);
    let args = args_with(
        &version,
        Some(multiplayer("mc.example.com", "mc.example.com", 25565)),
    );
    assert_eq!(
        tail(&args, 6),
        vec![
            "--versionType",
            "release",
            "--server",
            "mc.example.com",
            "--port",
            "25565"
        ]
    );
    assert!(!args.iter().any(|a| a.starts_with("--quickPlay")));

    let err = builder(&version)
        .with_quick_play(singleplayer("New World"))
        .build()
        .unwrap_err();
    assert!(
        matches!(&err, LaunchError::QuickPlayUnsupported { version, mode: QuickPlayMode::Singleplayer } if version == "1.19.4"),
        "{err:?}"
    );
}

#[test]
fn positional_legacy_args_support_neither_mode() {
    let version = version(POSITIONAL_LEGACY);
    for target in [
        multiplayer("mc.example.com", "mc.example.com", 25565),
        singleplayer("New World"),
    ] {
        let mode = target.mode();
        let err = builder(&version)
            .with_quick_play(target)
            .build()
            .unwrap_err();
        assert!(
            matches!(&err, LaunchError::QuickPlayUnsupported { version, mode: got } if version == "1.5.2" && *got == mode),
            "{err:?}"
        );
    }
}

/// 追加的 --server 位于 --fullscreen 与自定义游戏参数之前：玩家自己写的 --server / --port 覆盖它。
#[test]
fn custom_game_args_override_the_appended_server_and_fullscreen_follows_it() {
    let version = version(V1_12_2);
    let overridden = builder(&version)
        .with_quick_play(multiplayer("mc.example.com", "mc.example.com", 25565))
        .add_game_args([s("--server"), s("other.example"), s("--port"), s("1")])
        .build()
        .unwrap()
        .args;
    assert_eq!(
        tail(&overridden, 4),
        vec!["--server", "other.example", "--port", "1"]
    );
    assert_eq!(count(&overridden, "--server"), 1);
    assert_eq!(count(&overridden, "--port"), 1);

    let fullscreen = builder(&version)
        .with_quick_play(multiplayer("mc.example.com", "mc.example.com", 25565))
        .fullscreen(true)
        .build()
        .unwrap()
        .args;
    assert_eq!(
        tail(&fullscreen, 5),
        vec![
            "--server",
            "mc.example.com",
            "--port",
            "25565",
            "--fullscreen"
        ]
    );
}

/// 自定义分辨率的块在 Quick Play 块之前：两个 feature 同时置上时互不干扰。
#[test]
fn quick_play_coexists_with_custom_resolution() {
    let version = version(V1_21_1);
    let args = builder(&version)
        .with_resolution(1280, 720)
        .with_quick_play(singleplayer("我的 世界"))
        .build()
        .unwrap()
        .args;
    assert_eq!(
        tail(&args, 6),
        vec![
            "--width",
            "1280",
            "--height",
            "720",
            "--quickPlaySingleplayer",
            "我的 世界"
        ]
    );
    assert_no_forbidden(&args);
}

#[test]
fn support_table_follows_the_argument_blocks() {
    let both = QuickPlaySupport {
        singleplayer: true,
        multiplayer: true,
    };
    let multiplayer_only = QuickPlaySupport {
        singleplayer: false,
        multiplayer: true,
    };
    let cases = [
        (V1_12_2, multiplayer_only, true),
        (V1_19_4_STYLE, multiplayer_only, true),
        (V1_20_1, both, true),
        (V1_21_1, both, true),
        (POSITIONAL_LEGACY, QuickPlaySupport::default(), false),
    ];
    for (json, expected, legacy) in cases {
        let version = version(json);
        assert_eq!(quick_play_support(&version), expected, "{}", version.id);
        assert_eq!(legacy_server_args(&version), legacy, "{}", version.id);
    }

    // 只有空的 arguments.game、也没有 minecraftArguments：两种都不支持。
    let empty = VersionJson::from_json_str(r#"{"id":"x","arguments":{"jvm":["-cp"]}}"#).unwrap();
    assert_eq!(quick_play_support(&empty), QuickPlaySupport::default());
}
