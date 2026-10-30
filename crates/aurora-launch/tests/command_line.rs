//! 表驱动的完整命令行断言：用贴近真实结构的 1.12.2（旧式 minecraftArguments）与 1.21（新式 arguments）
//! 版本 JSON，走公开的 [`CommandBuilder`]，断言拼出的整条 `java <jvm...> <主类> <游戏...>` 逐 token 正确。

use std::path::PathBuf;

use aurora_launch::{
    AuthValues, CommandBuilder, GamePaths, GcPolicy, MemoryConfig, classpath_entries,
    classpath_separator, classpath_string,
};
use aurora_version::{OsName, RuntimeContext, VersionJson};

/// 便捷：`&str -> String`。
fn s(value: &str) -> String {
    value.to_owned()
}

/// 1.12.2 旧式版本 JSON：minecraftArguments 扁平串 + 旧式 lwjgl-platform natives + 一个 linux 专属库。
const VANILLA_1_12_2: &str = r#"{
    "id": "1.12.2",
    "type": "release",
    "mainClass": "net.minecraft.client.main.Main",
    "assets": "1.12",
    "assetIndex": {"id":"1.12","sha1":"idx1121200000000000000000000000000000000","size":100,"url":"https://piston-meta.mojang.com/1.12.json"},
    "minecraftArguments": "--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type} --versionType ${version_type}",
    "logging": {"client": {"argument":"-Dlog4j.configurationFile=${path}","type":"log4j2-xml","file":{"id":"client-1.12.xml","sha1":"log1120000000000000000000000000000000000","size":900,"url":"https://piston-data.mojang.com/client-1.12.xml"}}},
    "libraries": [
        {"name":"com.mojang:netty:1.8.8","downloads":{"artifact":{"path":"com/mojang/netty/1.8.8/netty-1.8.8.jar","sha1":"a1","size":1,"url":"u"}}},
        {"name":"org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209","downloads":{"artifact":{"path":"org/lwjgl/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar","sha1":"a2","size":1,"url":"u"}}},
        {"name":"org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209","natives":{"windows":"natives-windows"},"extract":{"exclude":["META-INF/"]},"downloads":{"classifiers":{"natives-windows":{"path":"org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar","sha1":"a3","size":1,"url":"u"}}}},
        {"name":"only.linux:foo:1.0","rules":[{"action":"allow","os":{"name":"linux"}}],"downloads":{"artifact":{"path":"only/linux/foo/1.0/foo-1.0.jar","sha1":"a4","size":1,"url":"u"}}}
    ]
}"#;

/// 1.21 新式版本 JSON：结构化 arguments（含 os/arch/feature 条件块）+ 独立 natives 条目 + osx 专属库。
const VANILLA_1_21: &str = r#"{
    "id": "1.21",
    "type": "release",
    "mainClass": "net.minecraft.client.main.Main",
    "assets": "17",
    "assetIndex": {"id":"17","sha1":"idx1700000000000000000000000000000000000","size":100,"url":"https://piston-meta.mojang.com/17.json"},
    "javaVersion": {"component":"java-runtime-delta","majorVersion":21},
    "logging": {"client": {"argument":"-Dlog4j.configurationFile=${path}","type":"log4j2-xml","file":{"id":"client-1.21.xml","sha1":"log1210000000000000000000000000000000000","size":900,"url":"https://piston-data.mojang.com/client-1.21.xml"}}},
    "arguments": {
        "jvm": [
            {"rules":[{"action":"allow","os":{"name":"osx"}}],"value":["-XstartOnFirstThread"]},
            {"rules":[{"action":"allow","os":{"name":"windows"}}],"value":"-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump"},
            {"rules":[{"action":"allow","os":{"name":"windows","version":"^10\\."}}],"value":["-Dos.name=Windows 10","-Dos.version=10.0"]},
            {"rules":[{"action":"allow","os":{"arch":"x86"}}],"value":"-Xss1M"},
            "-Djava.library.path=${natives_directory}",
            "-Djna.tmpdir=${natives_directory}",
            "-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}",
            "-Dio.netty.native.workdir=${natives_directory}",
            "-Dminecraft.launcher.brand=${launcher_name}",
            "-Dminecraft.launcher.version=${launcher_version}",
            "-cp",
            "${classpath}"
        ],
        "game": [
            "--username", "${auth_player_name}",
            "--version", "${version_name}",
            "--gameDir", "${game_directory}",
            "--assetsDir", "${assets_root}",
            "--assetIndex", "${assets_index_name}",
            "--uuid", "${auth_uuid}",
            "--accessToken", "${auth_access_token}",
            "--clientId", "${clientid}",
            "--xuid", "${auth_xuid}",
            "--userType", "${user_type}",
            "--versionType", "${version_type}",
            {"rules":[{"action":"allow","features":{"is_demo_user":true}}],"value":"--demo"},
            {"rules":[{"action":"allow","features":{"has_custom_resolution":true}}],"value":["--width","${resolution_width}","--height","${resolution_height}"]}
        ]
    },
    "libraries": [
        {"name":"com.mojang:logging:1.2.7","downloads":{"artifact":{"path":"com/mojang/logging/1.2.7/logging-1.2.7.jar","sha1":"b1","size":1,"url":"u"}}},
        {"name":"org.lwjgl:lwjgl:3.3.3","downloads":{"artifact":{"path":"org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar","sha1":"b2","size":1,"url":"u"}}},
        {"name":"org.lwjgl:lwjgl:3.3.3:natives-windows","rules":[{"action":"allow","os":{"name":"windows"}}],"downloads":{"artifact":{"path":"org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar","sha1":"b3","size":1,"url":"u"}}},
        {"name":"ca.weblite:java-objc-bridge:1.1","rules":[{"action":"allow","os":{"name":"osx"}}],"downloads":{"artifact":{"path":"ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar","sha1":"b4","size":1,"url":"u"}}}
    ]
}"#;

/// Windows 10 运行环境（os.version 命中 `^10\.` 条件）。
fn win10() -> RuntimeContext {
    RuntimeContext::new(OsName::Windows, "x86_64", 64).with_os_version("10.0.22631")
}

const UUID: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn legacy_1_12_2_full_command_line() {
    let version = VersionJson::from_json_str(VANILLA_1_12_2).unwrap();
    let ctx = win10();
    let minecraft_dir = PathBuf::from("D:/mc/.minecraft");
    let paths = GamePaths::standard(&minecraft_dir, "1.12.2");
    let game_dir = minecraft_dir.clone();
    let java = PathBuf::from("C:/jdk8/bin/java.exe");

    let command = CommandBuilder::new(
        &version,
        ctx.clone(),
        &java,
        paths.clone(),
        &game_dir,
        AuthValues::offline("Steve", UUID),
    )
    .with_memory(MemoryConfig::fixed(2048))
    .build()
    .unwrap();

    assert_eq!(command.program, java);
    assert_eq!(command.working_dir, game_dir);

    // 逐 token 构造期望值：路径相关的片段用与被测代码同源的公开 helper / PathBuf 运算得到，
    // 从而跨平台路径分隔符一致，断言聚焦「拼装顺序、条件筛选、占位符替换」这三件事。
    let natives = paths.natives_dir.display().to_string();
    let launcher_version = env!("CARGO_PKG_VERSION");
    let classpath = classpath_string(
        &classpath_entries(&version, &ctx, &paths.libraries_dir, &paths.client_jar).unwrap(),
        classpath_separator(OsName::Windows),
    );
    let log_config = paths
        .assets_dir
        .join("log_configs")
        .join("client-1.12.xml")
        .display()
        .to_string();

    let expected = vec![
        s("-Dlog4j2.formatMsgNoLookups=true"),
        s("-Dfile.encoding=UTF-8"),
        s("-Dstdout.encoding=UTF-8"),
        s("-Dstderr.encoding=UTF-8"),
        s("-Xmx2048m"),
        format!("-Djava.library.path={natives}"),
        s("-Dminecraft.launcher.brand=Petalfall"),
        format!("-Dminecraft.launcher.version={launcher_version}"),
        s("-cp"),
        classpath.clone(),
        format!("-Dlog4j.configurationFile={log_config}"),
        s("net.minecraft.client.main.Main"),
        s("--username"),
        s("Steve"),
        s("--version"),
        s("1.12.2"),
        s("--gameDir"),
        game_dir.display().to_string(),
        s("--assetsDir"),
        paths.assets_dir.display().to_string(),
        s("--assetIndex"),
        s("1.12"),
        s("--uuid"),
        s(UUID),
        s("--accessToken"),
        s("0"),
        s("--userType"),
        s("legacy"),
        s("--versionType"),
        s("release"),
    ];

    assert_eq!(command.args, expected);

    // classpath 只含 netty + lwjgl 主件 + client jar；natives 与 linux 专属库被排除。
    assert!(classpath.contains("netty-1.8.8.jar"));
    assert!(classpath.contains("lwjgl-2.9.4-nightly-20150209.jar"));
    assert!(!classpath.contains("lwjgl-platform"));
    assert!(!classpath.contains("only"));
    assert!(classpath.ends_with(&paths.client_jar.display().to_string()));
}

#[test]
fn modern_1_21_full_command_line() {
    let version = VersionJson::from_json_str(VANILLA_1_21).unwrap();
    let ctx = win10();
    let minecraft_dir = PathBuf::from("D:/mc/.minecraft");
    let paths = GamePaths::standard(&minecraft_dir, "1.21");
    // 1.21 未装 Mod，取消隔离，工作目录即 .minecraft 根。
    let game_dir = minecraft_dir.clone();
    let java = PathBuf::from("C:/jdk21/bin/java.exe");

    let command = CommandBuilder::new(
        &version,
        ctx.clone(),
        &java,
        paths.clone(),
        &game_dir,
        AuthValues::offline("Steve", UUID),
    )
    .with_memory(MemoryConfig::fixed(4096))
    .with_gc(GcPolicy::GenerationalZgc)
    .with_resolution(1280, 720)
    .build()
    .unwrap();

    let natives = paths.natives_dir.display().to_string();
    let launcher_version = env!("CARGO_PKG_VERSION");
    let classpath = classpath_string(
        &classpath_entries(&version, &ctx, &paths.libraries_dir, &paths.client_jar).unwrap(),
        classpath_separator(OsName::Windows),
    );
    let log_config = paths
        .assets_dir
        .join("log_configs")
        .join("client-1.21.xml")
        .display()
        .to_string();

    let expected = vec![
        // 强制安全 + 编码。
        s("-Dlog4j2.formatMsgNoLookups=true"),
        s("-Dfile.encoding=UTF-8"),
        s("-Dstdout.encoding=UTF-8"),
        s("-Dstderr.encoding=UTF-8"),
        // 分代 ZGC（Java 21）。
        s("-XX:+UseZGC"),
        s("-XX:+ZGenerational"),
        // 内存。
        s("-Xmx4096m"),
        // 版本 arguments.jvm：osx 条件被排除；windows 与 ^10\. 命中；x86 arch 被排除。
        s("-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump"),
        s("-Dos.name=Windows 10"),
        s("-Dos.version=10.0"),
        format!("-Djava.library.path={natives}"),
        format!("-Djna.tmpdir={natives}"),
        format!("-Dorg.lwjgl.system.SharedLibraryExtractPath={natives}"),
        format!("-Dio.netty.native.workdir={natives}"),
        s("-Dminecraft.launcher.brand=Petalfall"),
        format!("-Dminecraft.launcher.version={launcher_version}"),
        s("-cp"),
        classpath.clone(),
        // 日志参数。
        format!("-Dlog4j.configurationFile={log_config}"),
        // 主类。
        s("net.minecraft.client.main.Main"),
        // 游戏参数：demo 被排除；custom_resolution 命中。
        s("--username"),
        s("Steve"),
        s("--version"),
        s("1.21"),
        s("--gameDir"),
        game_dir.display().to_string(),
        s("--assetsDir"),
        paths.assets_dir.display().to_string(),
        s("--assetIndex"),
        s("17"),
        s("--uuid"),
        s(UUID),
        s("--accessToken"),
        s("0"),
        s("--clientId"),
        s(""),
        s("--xuid"),
        s(""),
        s("--userType"),
        s("legacy"),
        s("--versionType"),
        s("release"),
        s("--width"),
        s("1280"),
        s("--height"),
        s("720"),
    ];

    assert_eq!(command.args, expected);

    // classpath：logging + lwjgl 主件 + client jar；natives 条目与 osx 专属库排除。
    assert!(classpath.contains("logging-1.2.7.jar"));
    assert!(classpath.contains("lwjgl-3.3.3.jar"));
    assert!(!classpath.contains("natives-windows"));
    assert!(!classpath.contains("java-objc-bridge"));
}

/// Authlib-Injector 注入：javaagent 参数应出现在内存参数之后、版本 jvm 参数之前。
#[test]
fn authlib_injector_agent_is_injected() {
    let version = VersionJson::from_json_str(VANILLA_1_21).unwrap();
    let paths = GamePaths::standard(PathBuf::from("D:/mc/.minecraft"), "1.21");
    let command = CommandBuilder::new(
        &version,
        win10(),
        PathBuf::from("C:/jdk21/bin/java.exe"),
        paths,
        PathBuf::from("D:/mc/.minecraft"),
        AuthValues::offline("Steve", UUID),
    )
    .with_authlib(
        aurora_launch::AuthlibInjector::new(
            PathBuf::from("D:/aurora/authlib-injector.jar"),
            "https://skin.example/api",
        )
        .with_prefetched("eyJ0ZXN0Ijp0cnVlfQ=="),
    )
    .build()
    .unwrap();

    let agent = "-javaagent:D:/aurora/authlib-injector.jar=https://skin.example/api";
    let prefetch = "-Dauthlibinjector.yggdrasil.prefetched=eyJ0ZXN0Ijp0cnVlfQ==";
    assert!(command.args.iter().any(|a| a == agent));
    assert!(command.args.iter().any(|a| a == prefetch));
    // agent 在内存参数（-Xmx）之后，classpath 之前。
    let idx_agent = command.args.iter().position(|a| a == agent).unwrap();
    let idx_xmx = command.args.iter().position(|a| a.starts_with("-Xmx")).unwrap();
    let idx_cp = command.args.iter().position(|a| a == "-cp").unwrap();
    assert!(idx_xmx < idx_agent && idx_agent < idx_cp);
}

/// 自定义 JVM/游戏参数应参与去重与键值覆盖合并。
#[test]
fn custom_args_merge_into_command() {
    let version = VersionJson::from_json_str(VANILLA_1_21).unwrap();
    let paths = GamePaths::standard(PathBuf::from("D:/mc/.minecraft"), "1.21");
    let command = CommandBuilder::new(
        &version,
        win10(),
        PathBuf::from("C:/jdk21/bin/java.exe"),
        paths,
        PathBuf::from("D:/mc/.minecraft"),
        AuthValues::offline("Steve", UUID),
    )
    // 重复的安全参数应被去重；新增的 -Dcustom 保留。
    .add_jvm_args([s("-Dlog4j2.formatMsgNoLookups=true"), s("-Dcustom=1")])
    // 覆盖 username。
    .add_game_args([s("--username"), s("Alex")])
    .build()
    .unwrap();

    // 安全参数只出现一次。
    assert_eq!(
        command
            .args
            .iter()
            .filter(|a| *a == "-Dlog4j2.formatMsgNoLookups=true")
            .count(),
        1
    );
    assert!(command.args.iter().any(|a| a == "-Dcustom=1"));
    // username 被覆盖为 Alex，且只出现一次值。
    let idx = command.args.iter().position(|a| a == "--username").unwrap();
    assert_eq!(command.args[idx + 1], "Alex");
    assert!(!command.args.iter().any(|a| a == "Steve"));
}
