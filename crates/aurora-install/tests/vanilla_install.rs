//! 原版安装端到端集成测试（本地 mock）。
//!
//! 把 VanillaInstaller 的完整链路跑通：版本清单 -> 版本 JSON（sha1 校验落盘）-> client.jar + 库 +
//! 日志配置 + assetIndex -> 资源对象补全 -> natives 解压。所有官方域名经注入的自定义 SourceResolver
//! 指向 mock 服务，资源对象走 resources.download.minecraft.net 的改写以覆盖真实下载路径。

use std::io::Cursor;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use aurora_base::retry::RetryPolicy;
use aurora_download::{
    CancellationToken, DownloadConfig, DownloadPool, Downloader, MirrorSource, SourcePlan,
    SourceResolver,
};
use aurora_install::{GameLayout, InstallContext, VanillaInstaller};
use aurora_version::{OsName, RuntimeContext};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn sha1_hex(bytes: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    base16ct::lower::encode_string(&hasher.finalize())
}

/// 把官方 assets 分发域名改写到 mock；其余官方 URL（已直接指向 mock）原样透传。
struct MockResolver {
    base: String,
}

impl SourceResolver for MockResolver {
    fn resolve(&self, url: &str, _source: MirrorSource) -> aurora_download::Result<String> {
        const OFFICIAL_ASSETS: &str = "https://resources.download.minecraft.net";
        if let Some(rest) = url.strip_prefix(OFFICIAL_ASSETS) {
            Ok(format!("{}{}", self.base, rest))
        } else {
            Ok(url.to_owned())
        }
    }
}

/// 造一个含单个 dll 的 natives jar 字节。
fn build_native_jar() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut writer = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file("aurora_test.dll", opts).unwrap();
        writer.write_all(b"native-dll-payload").unwrap();
        writer.start_file("META-INF/MANIFEST.MF", opts).unwrap();
        writer.write_all(b"Manifest-Version: 1.0\n").unwrap();
        writer.finish().unwrap();
    }
    buf
}

async fn mount_bytes(server: &MockServer, p: &str, body: Vec<u8>) {
    Mock::given(method("GET"))
        .and(path(p.to_owned()))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
        .mount(server)
        .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_vanilla_install_lands_every_artifact() {
    let server = MockServer::start().await;
    let base = server.uri();

    // ---- 造各产物字节并算 sha1 ----
    let client_bytes = b"fake-client-jar-bytes".to_vec();
    let lib_bytes = b"fake-library-jar".to_vec();
    let log_bytes = b"<Configuration/>".to_vec();
    let native_bytes = build_native_jar();
    let object_bytes = b"minecraft-lang-en-us".to_vec();
    let object_hash = sha1_hex(&object_bytes);
    let object_bucket = &object_hash[..2];

    // assetIndex 内容（标准布局，一个对象）。
    let asset_index = format!(
        r#"{{"objects":{{"minecraft/lang/en_us.json":{{"hash":"{object_hash}","size":{}}}}}}}"#,
        object_bytes.len()
    );

    // 版本 JSON：client + 一个普通库 + 一个 windows natives 库 + logging + assetIndex。
    let version_json = format!(
        r#"{{
            "id":"1.21",
            "type":"release",
            "mainClass":"net.minecraft.client.main.Main",
            "downloads":{{"client":{{"sha1":"{client_sha1}","size":{client_size},"url":"{base}/client.jar"}}}},
            "assetIndex":{{"id":"17","sha1":"{index_sha1}","size":{index_size},"url":"{base}/assetindex.json"}},
            "assets":"17",
            "logging":{{"client":{{"argument":"-Dlog4j.configurationFile=${{path}}","type":"log4j2-xml","file":{{"id":"client-1.21.xml","sha1":"{log_sha1}","size":{log_size},"url":"{base}/log.xml"}}}}}},
            "libraries":[
                {{"name":"com.example:lib:1.0","downloads":{{"artifact":{{"path":"com/example/lib/1.0/lib-1.0.jar","sha1":"{lib_sha1}","size":{lib_size},"url":"{base}/lib.jar"}}}}}},
                {{"name":"org.lwjgl:lwjgl:3.3.3:natives-windows","downloads":{{"artifact":{{"path":"org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar","sha1":"{native_sha1}","size":{native_size},"url":"{base}/natives.jar"}}}}}}
            ]
        }}"#,
        client_sha1 = sha1_hex(&client_bytes),
        client_size = client_bytes.len(),
        index_sha1 = sha1_hex(asset_index.as_bytes()),
        index_size = asset_index.len(),
        log_sha1 = sha1_hex(&log_bytes),
        log_size = log_bytes.len(),
        lib_sha1 = sha1_hex(&lib_bytes),
        lib_size = lib_bytes.len(),
        native_sha1 = sha1_hex(&native_bytes),
        native_size = native_bytes.len(),
    );

    // 版本清单指向版本 JSON（附其 sha1）。
    let manifest = format!(
        r#"{{"latest":{{"release":"1.21","snapshot":"1.21"}},
            "versions":[{{"id":"1.21","type":"release","url":"{base}/version.json","time":"t","releaseTime":"t","sha1":"{vjson_sha1}"}}]}}"#,
        vjson_sha1 = sha1_hex(version_json.as_bytes()),
    );

    // ---- 挂 mock ----
    mount_bytes(&server, "/manifest.json", manifest.into_bytes()).await;
    mount_bytes(&server, "/version.json", version_json.into_bytes()).await;
    mount_bytes(&server, "/client.jar", client_bytes.clone()).await;
    mount_bytes(&server, "/lib.jar", lib_bytes.clone()).await;
    mount_bytes(&server, "/log.xml", log_bytes.clone()).await;
    mount_bytes(&server, "/natives.jar", native_bytes.clone()).await;
    mount_bytes(
        &server,
        "/assetindex.json",
        asset_index.clone().into_bytes(),
    )
    .await;
    // 资源对象走改写后的 mock 路径 /<h2>/<hash>。
    mount_bytes(
        &server,
        &format!("/{object_bucket}/{object_hash}"),
        object_bytes.clone(),
    )
    .await;

    // ---- 组装上下文：注入把 assets 域名改写到 mock 的 resolver ----
    let client = aurora_base::http::build_client().unwrap();
    let resolver = Arc::new(MockResolver { base: base.clone() });
    let sources = SourcePlan::with_resolver(vec![MirrorSource::Official], resolver);
    let config = DownloadConfig {
        sources,
        ..Default::default()
    };
    let pool = DownloadPool::new(Downloader::new(client.clone(), config), 6);
    let dir = tempfile::tempdir().unwrap();
    let layout = GameLayout::new(dir.path());
    let runtime = RuntimeContext::new(OsName::Windows, "x86_64", 64);
    let policy = RetryPolicy {
        max_attempts: 2,
        initial_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(2),
        multiplier: 2.0,
        jitter: false,
    };
    let cx = InstallContext::new(&client, &pool, &layout, &runtime, &policy);

    let installer = VanillaInstaller::new(cx).with_manifest_url(format!("{base}/manifest.json"));
    let summary = installer.install("1.21").await.expect("原版安装应成功");

    // ---- 断言结果计数 ----
    assert_eq!(summary.id, "1.21");
    assert_eq!(summary.libraries, 2, "普通库 + natives 库");
    assert_eq!(summary.assets, 1);
    assert_eq!(summary.natives, 1, "只解出 dll，排除 META-INF");

    // ---- 断言磁盘落点与内容 ----
    assert_eq!(
        std::fs::read(layout.version_jar("1.21")).unwrap(),
        client_bytes
    );
    assert_eq!(
        std::fs::read(layout.library_path("com/example/lib/1.0/lib-1.0.jar")).unwrap(),
        lib_bytes
    );
    assert_eq!(
        std::fs::read(layout.asset_object_path(&object_hash)).unwrap(),
        object_bytes
    );
    assert_eq!(
        std::fs::read(
            layout
                .assets_dir()
                .join("log_configs")
                .join("client-1.21.xml")
        )
        .unwrap(),
        log_bytes
    );
    // 版本 JSON 原样落盘（含未建模字段也保留，这里验证关键类名在）。
    let vjson = std::fs::read(layout.version_json("1.21")).unwrap();
    assert!(String::from_utf8_lossy(&vjson).contains("net.minecraft.client.main.Main"));
    // natives 解压出的 dll。
    assert_eq!(
        std::fs::read(layout.natives_dir("1.21").join("aurora_test.dll")).unwrap(),
        b"native-dll-payload"
    );

    // 版本目录里只有这些：下载用的临时名在版本 JSON 就位后不留下。
    assert_eq!(
        dir_entries(&layout.version_dir("1.21")),
        vec!["1.21-natives", "1.21.jar", "1.21.json"]
    );

    // ---- 幂等性：再次安装应全部命中已存在校验、结果一致 ----
    let again = installer.install("1.21").await.expect("重复安装应成功");
    assert_eq!(again, summary);
    assert_eq!(
        dir_entries(&layout.version_dir("1.21")),
        vec!["1.21-natives", "1.21.jar", "1.21.json"]
    );
}

fn dir_entries(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// 只试一次的安装环境，取消令牌同时挂在下载池与上下文上（与门面的接法一致）。
struct Bench {
    client: reqwest::Client,
    pool: DownloadPool,
    dir: tempfile::TempDir,
    layout: GameLayout,
    runtime: RuntimeContext,
    policy: RetryPolicy,
    cancel: CancellationToken,
}

impl Bench {
    fn new() -> Self {
        let once = RetryPolicy {
            max_attempts: 1,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(1),
            multiplier: 1.0,
            jitter: false,
        };
        let client = aurora_base::http::build_client().unwrap();
        let config = DownloadConfig {
            retry: once.clone(),
            sources: SourcePlan::new(vec![MirrorSource::Official]),
            ..Default::default()
        };
        let cancel = CancellationToken::new();
        let pool = DownloadPool::new(Downloader::new(client.clone(), config), 2)
            .with_cancel(cancel.clone());
        let dir = tempfile::tempdir().unwrap();
        Self {
            layout: GameLayout::new(dir.path()),
            dir,
            client,
            pool,
            runtime: RuntimeContext::new(OsName::Windows, "x86_64", 64),
            policy: once,
            cancel,
        }
    }

    fn installer(&self, server: &MockServer) -> VanillaInstaller<'_> {
        let cx = InstallContext::new(
            &self.client,
            &self.pool,
            &self.layout,
            &self.runtime,
            &self.policy,
        )
        .with_cancel(Some(&self.cancel));
        VanillaInstaller::new(cx).with_manifest_url(format!("{}/manifest.json", server.uri()))
    }
}

/// 版本 1.21：清单、版本 JSON（`version_body` 为 `None` 时给一份声明了客户端 jar 的正常 JSON）与
/// 客户端 jar 的响应。
async fn mount_release(
    server: &MockServer,
    version_body: Option<String>,
    client_jar: ResponseTemplate,
) {
    let base = server.uri();
    let manifest = format!(
        r#"{{"latest":{{"release":"1.21","snapshot":"1.21"}},"versions":[
            {{"id":"1.21","type":"release","url":"{base}/version.json","time":"t","releaseTime":"t"}}
        ]}}"#
    );
    let version_body = version_body.unwrap_or_else(|| {
        format!(
            r#"{{"id":"1.21","type":"release","mainClass":"net.minecraft.client.main.Main",
                "downloads":{{"client":{{"sha1":"{sha1}","size":6,"url":"{base}/client.jar"}}}}}}"#,
            sha1 = sha1_hex(b"client"),
        )
    });
    mount_bytes(server, "/manifest.json", manifest.into_bytes()).await;
    mount_bytes(server, "/version.json", version_body.into_bytes()).await;
    Mock::given(method("GET"))
        .and(path("/client.jar"))
        .respond_with(client_jar)
        .mount(server)
        .await;
}

/// 下不全或读不懂都算没装上：版本目录是这次建的，失败后整个不留，版本列表里既看不到这个版本，也不会
/// 多出一行「缺少版本 JSON」。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_install_leaves_nothing_of_the_version() {
    for (version_body, client_jar) in [
        (None, ResponseTemplate::new(404)),
        (
            Some(r#"{"id":"#.to_owned()),
            ResponseTemplate::new(200).set_body_bytes(b"client".to_vec()),
        ),
    ] {
        let server = MockServer::start().await;
        mount_release(&server, version_body.clone(), client_jar).await;
        let bench = Bench::new();

        bench.installer(&server).install("1.21").await.unwrap_err();

        assert!(
            !bench.layout.version_dir("1.21").exists(),
            "{version_body:?}：{:?}",
            dir_entries(&bench.dir.path().join("versions"))
        );
    }
}

/// 取消发生在下客户端 jar 的途中：不留版本 JSON，也不留这次建的版本目录。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_leaves_nothing_of_the_version() {
    let server = MockServer::start().await;
    let stalled = ResponseTemplate::new(200)
        .set_body_bytes(b"client".to_vec())
        .set_delay(Duration::from_secs(30));
    mount_release(&server, None, stalled).await;
    let bench = Bench::new();
    let installer = bench.installer(&server);
    let attempt = installer.install("1.21");
    tokio::pin!(attempt);

    let client_jar_requested = async {
        loop {
            let requests = server.received_requests().await.unwrap();
            if requests.iter().any(|r| r.url.path() == "/client.jar") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::select! {
        _ = &mut attempt => panic!("客户端 jar 还没回来，安装不该结束"),
        () = client_jar_requested => {}
    }
    bench.cancel.cancel();
    let err = attempt.await.unwrap_err();

    assert!(err.is_cancelled(), "实际：{err:?}");
    assert!(!bench.layout.version_dir("1.21").exists());
}

/// 目录在这次安装之前就有：重装失败不动原来的东西，只收走自己的临时文件。原来的版本 JSON 还在，
/// 没有 JSON 的目录里也可能有别的启动器留下的存档。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_reinstall_keeps_what_was_already_there() {
    for (kept, content) in [
        ("1.21.json", br#"{"id":"1.21"}"#.as_slice()),
        ("options.txt", b"lang:zh_cn".as_slice()),
    ] {
        let server = MockServer::start().await;
        mount_release(&server, None, ResponseTemplate::new(404)).await;
        let bench = Bench::new();
        let dir = bench.layout.version_dir("1.21");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(kept), content).unwrap();

        bench.installer(&server).install("1.21").await.unwrap_err();

        assert_eq!(dir_entries(&dir), vec![kept], "{kept}");
        assert_eq!(std::fs::read(dir.join(kept)).unwrap(), content, "{kept}");
    }
}

/// 版本清单（可能来自镜像）给出的 id 原样拼进 versions/<id>/<id>.json：能走出版本目录的报路径越界，
/// 不去下版本 JSON，什么都不写。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifest_ids_escaping_the_versions_dir_are_rejected() {
    let server = MockServer::start().await;
    let base = server.uri();
    let manifest = format!(
        r#"{{"latest":{{"release":"1.21","snapshot":"1.21"}},"versions":[
            {{"id":"../escaped","type":"release","url":"{base}/escaped.json",
              "time":"2024-06-13T08:24:03+00:00","releaseTime":"2024-06-13T08:24:03+00:00"}}
        ]}}"#
    );
    Mock::given(method("GET"))
        .and(path("/manifest.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(manifest))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/escaped.json"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"id":"../escaped"}"#))
        .expect(0)
        .mount(&server)
        .await;

    let client = aurora_base::http::build_client().unwrap();
    let pool = DownloadPool::new(Downloader::with_defaults(client.clone()), 2);
    let dir = tempfile::tempdir().unwrap();
    let layout = GameLayout::new(dir.path());
    let runtime = RuntimeContext::new(OsName::Windows, "x86_64", 64);
    let policy = RetryPolicy {
        max_attempts: 1,
        initial_delay: Duration::from_millis(1),
        max_delay: Duration::from_millis(1),
        multiplier: 1.0,
        jitter: false,
    };
    let cx = InstallContext::new(&client, &pool, &layout, &runtime, &policy);

    let err = VanillaInstaller::new(cx)
        .with_manifest_url(format!("{base}/manifest.json"))
        .install("../escaped")
        .await
        .unwrap_err();

    assert!(
        matches!(&err, aurora_install::Error::UnsafePath { path, .. } if path == "../escaped"),
        "实际 {err:?}"
    );
    assert!(!dir.path().join("escaped.json").exists());
    assert!(!dir.path().join("versions").exists());
}
