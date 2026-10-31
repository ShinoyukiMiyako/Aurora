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
    DownloadConfig, DownloadPool, Downloader, MirrorSource, SourcePlan, SourceResolver,
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

    // ---- 幂等性：再次安装应全部命中已存在校验、结果一致 ----
    let again = installer.install("1.21").await.expect("重复安装应成功");
    assert_eq!(again, summary);
}
