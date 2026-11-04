//! 材质服务的集成测试：在临时目录里搭两个候选游戏目录（设置目录与登记目录），
//! 用真 zip 写出客户端 jar，走完选择、抽取、协议读取与淘汰的全流程。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;
use wiremock::matchers::{method, path as url_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::image_rules::testing::png;
use super::*;

const PINK: [u8; 4] = [240, 160, 190, 255];

/// 写一个 jar（deflate 压缩，读的时候走真正的解压路径）。
fn write_jar(path: &Path, entries: &[(&str, Vec<u8>)]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap();
}

fn tex(path: &str) -> String {
    whitelist::jar_entry(path)
}

struct VersionSpec<'a> {
    id: &'a str,
    kind: &'a str,
    release_time: &'a str,
    inherits_from: Option<&'a str>,
    /// 为 true 时版本 JSON 里写一个错误的 SHA-1。
    wrong_sha1: bool,
    entries: Vec<(&'a str, Vec<u8>)>,
}

/// 在游戏目录里放一个版本：`versions/<id>/<id>.json` + `<id>.jar`，JSON 里声明 jar 的 SHA-1。
fn put_version(game_dir: &Path, spec: VersionSpec<'_>) {
    let dir = game_dir.join("versions").join(spec.id);
    let jar = dir.join(format!("{}.jar", spec.id));
    write_jar(&jar, &spec.entries);
    let actual = remote::sha1_hex(&std::fs::read(&jar).unwrap());
    let sha1 = if spec.wrong_sha1 {
        "0000000000000000000000000000000000000000".to_owned()
    } else {
        actual
    };
    let mut json = json!({
        "id": spec.id,
        "type": spec.kind,
        "releaseTime": spec.release_time,
        "mainClass": "net.minecraft.client.main.Main",
        "downloads": { "client": { "sha1": sha1, "size": 1, "url": "https://example.invalid/client.jar" } }
    });
    if let Some(parent) = spec.inherits_from {
        json["inheritsFrom"] = json!(parent);
    }
    std::fs::write(dir.join(format!("{}.json", spec.id)), json.to_string()).unwrap();
}

/// 把 jar 改写成新内容并同步更新版本 JSON 里的 SHA-1（模拟版本被重新下载）。
fn rewrite_jar(game_dir: &Path, id: &str, entries: &[(&str, Vec<u8>)]) {
    let dir = game_dir.join("versions").join(id);
    let jar = dir.join(format!("{id}.jar"));
    write_jar(&jar, entries);
    let json_path = dir.join(format!("{id}.json"));
    let mut json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&json_path).unwrap()).unwrap();
    json["downloads"]["client"]["sha1"] = json!(remote::sha1_hex(&std::fs::read(&jar).unwrap()));
    std::fs::write(&json_path, json.to_string()).unwrap();
}

struct Fixture {
    _root: tempfile::TempDir,
    settings: PathBuf,
    registered: PathBuf,
    cache: PathBuf,
    opens: Arc<AtomicUsize>,
    panorama_bytes: Vec<u8>,
    service: TextureService,
}

impl Fixture {
    fn candidates(&self) -> Vec<PathBuf> {
        vec![self.settings.clone(), self.registered.clone()]
    }

    async fn refresh(&self) -> ArtStatus {
        self.service.refresh(&self.candidates()).await
    }

    fn panorama_object(&self) -> PathBuf {
        let sha1 = remote::sha1_hex(&self.panorama_bytes);
        self.registered
            .join("assets/objects")
            .join(&sha1[..2])
            .join(&sha1)
    }

    fn opens(&self) -> usize {
        self.opens.load(Ordering::SeqCst)
    }
}

/// 搭出测试用的两个候选目录。
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings");
    let registered = root.path().join("registered");
    let cache = root.path().join("cache");
    let cherry = tex("block/cherry_planks");
    let blue_ice = tex("block/blue_ice");
    let blue_ice_meta = format!("{blue_ice}.mcmeta");
    let steve = tex("entity/player/wide/steve");
    let stone = tex("block/stone");

    put_version(
        &settings,
        VersionSpec {
            id: "1.21.1",
            kind: "release",
            release_time: "2024-08-08T12:24:45+00:00",
            inherits_from: None,
            wrong_sha1: false,
            entries: vec![
                (cherry.as_str(), png(16, 16, |_, _| PINK)),
                // 动画材质：16x32 两帧竖排，附 .mcmeta。
                (
                    blue_ice.as_str(),
                    png(16, 32, |_, y| if y < 16 { PINK } else { [0, 0, 255, 255] }),
                ),
                (blue_ice_meta.as_str(), br#"{"animation":{}}"#.to_vec()),
                (steve.as_str(), png(64, 64, |_, _| PINK)),
            ],
        },
    );
    // 加载器版本：更新、有 cherry_planks，但有继承，必须跳过。
    put_version(
        &settings,
        VersionSpec {
            id: "fabric-loader-0.16.5-1.21.1",
            kind: "release",
            release_time: "2024-09-01T00:00:00+00:00",
            inherits_from: Some("1.21.1"),
            wrong_sha1: false,
            entries: vec![(cherry.as_str(), png(16, 16, |_, _| PINK))],
        },
    );
    // 快照：更新、有 cherry_planks，但不是 release，必须跳过。
    put_version(
        &settings,
        VersionSpec {
            id: "24w40a",
            kind: "snapshot",
            release_time: "2024-10-02T00:00:00+00:00",
            inherits_from: None,
            wrong_sha1: false,
            entries: vec![(cherry.as_str(), png(16, 16, |_, _| PINK))],
        },
    );
    // 最新的 release，但 jar 的 SHA-1 与 JSON 不符，必须跳过。
    put_version(
        &settings,
        VersionSpec {
            id: "1.21.2",
            kind: "release",
            release_time: "2024-10-22T00:00:00+00:00",
            inherits_from: None,
            wrong_sha1: true,
            entries: vec![(cherry.as_str(), png(16, 16, |_, _| PINK))],
        },
    );
    // 老版本：只有扁平化后的石头，作降级源。
    put_version(
        &settings,
        VersionSpec {
            id: "1.16.5",
            kind: "release",
            release_time: "2021-01-14T16:05:32+00:00",
            inherits_from: None,
            wrong_sha1: false,
            entries: vec![(stone.as_str(), png(16, 16, |_, _| [120, 120, 120, 255]))],
        },
    );

    let panorama_bytes = png(32, 32, |x, y| [x as u8 * 8, y as u8 * 8, 128, 255]);
    let sha1 = remote::sha1_hex(&panorama_bytes);
    let object = registered
        .join("assets/objects")
        .join(&sha1[..2])
        .join(&sha1);
    std::fs::create_dir_all(object.parent().unwrap()).unwrap();
    std::fs::write(&object, &panorama_bytes).unwrap();

    let opens = Arc::new(AtomicUsize::new(0));
    let counter = opens.clone();
    let opener: JarOpener = Arc::new(move |path| {
        counter.fetch_add(1, Ordering::SeqCst);
        std::fs::File::open(path)
    });
    let service = TextureService::with_parts(
        cache.clone(),
        petalfall_base::http::build_client().unwrap(),
        PanoramaSpec { sha1 },
        opener,
    );
    Fixture {
        _root: root,
        settings,
        registered,
        cache,
        opens,
        panorama_bytes,
        service,
    }
}

fn body(response: TexResponse) -> Arc<Vec<u8>> {
    match response {
        TexResponse::Found { body, .. } => body,
        other => panic!("期望 200，得到 {other:?}"),
    }
}

fn dims(bytes: &[u8]) -> (u32, u32) {
    let image = image::load_from_memory(bytes).unwrap();
    (image.width(), image.height())
}

#[tokio::test]
async fn picks_the_newest_trustworthy_release_with_the_full_set() {
    let fx = fixture();
    let status = fx.refresh().await;
    // 加载器版本、快照与哈希不符的 1.21.2 都更新，却都被跳过。
    assert_eq!(status.source.as_deref(), Some("1.21.1"));
    assert!(status.panorama);
    assert_eq!(fx.service.status(), status);
}

#[tokio::test]
async fn falls_back_to_a_degraded_source_then_to_none() {
    let fx = fixture();
    std::fs::remove_dir_all(fx.settings.join("versions/1.21.1")).unwrap();
    assert_eq!(fx.refresh().await.source.as_deref(), Some("1.16.5"));

    // 降级源里名单内的方块一个都没有：请求合法，但是 404。
    let missing = fx
        .service
        .respond("/art/block/cherry_planks.png", Some("1.16.5"))
        .await;
    assert_eq!(missing.status(), 404);

    std::fs::remove_dir_all(fx.settings.join("versions/1.16.5")).unwrap();
    let status = fx.refresh().await;
    assert_eq!(status.source, None);
    let none = fx
        .service
        .respond("/art/block/cherry_planks.png", Some("1.16.5"))
        .await;
    assert_eq!(none.status(), 404);
}

#[tokio::test]
async fn only_whitelisted_paths_are_served() {
    let fx = fixture();
    fx.refresh().await;
    let ok = fx
        .service
        .respond("/art/block/cherry_planks.png", Some("1.21.1"))
        .await;
    assert_eq!(ok.status(), 200);
    assert_eq!(dims(&body(ok)), (16, 16));

    for rejected in [
        "/art/block/dirt.png",
        "/art/block/../x.png",
        "/art/item/apple.png",
        "/art/particle/cherry_0.png",
        "/art/gui/widgets.png",
        "/art/block/cherry_planks",
        "/mc/textures/block/cherry_planks.png",
        "/panorama/1.png",
        "/skin/not-a-key.png",
        "/thumb/../../secret",
    ] {
        let response = fx.service.respond(rejected, Some("1.21.1")).await;
        assert_eq!(response.status(), 400, "{rejected} 应为 400");
    }
    // 名单内但没带版本戳：也是编程错误。
    assert_eq!(
        fx.service
            .respond("/art/block/cherry_planks.png", None)
            .await
            .status(),
        400
    );
    // 版本戳过期：合法但找不到。
    assert_eq!(
        fx.service
            .respond("/art/block/cherry_planks.png", Some("1.20.1"))
            .await
            .status(),
        404
    );
}

#[tokio::test]
async fn animated_texture_is_served_as_its_first_frame() {
    let fx = fixture();
    fx.refresh().await;
    let bytes = body(
        fx.service
            .respond("/art/block/blue_ice.png", Some("1.21.1"))
            .await,
    );
    assert_eq!(dims(&bytes), (16, 16));
    let rgba = image::load_from_memory(&bytes).unwrap().to_rgba8();
    assert!(rgba.pixels().all(|p| p.0 == PINK), "首帧应全是第一帧的颜色");

    let skin = body(
        fx.service
            .respond("/art/entity/player/wide/steve.png", Some("1.21.1"))
            .await,
    );
    assert_eq!(dims(&skin), (64, 64));
}

#[tokio::test]
async fn disk_cache_is_keyed_by_jar_hash_and_old_versions_are_removed() {
    let fx = fixture();
    fx.refresh().await;
    fx.service
        .respond("/art/block/cherry_planks.png", Some("1.21.1"))
        .await;
    let manifest_path = fx.cache.join("vanilla-art/1.21.1/manifest.json");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    let jar = fx.settings.join("versions/1.21.1/1.21.1.jar");
    assert_eq!(
        manifest["jarSha1"],
        json!(remote::sha1_hex(&std::fs::read(&jar).unwrap()))
    );
    assert_eq!(manifest["versionId"], json!("1.21.1"));
    assert_eq!(
        manifest["files"],
        json!([
            "block/cherry_planks",
            "block/blue_ice",
            "entity/player/wide/steve"
        ])
    );

    // 再刷新一次，jar 没变：直接用缓存，不再为抽取打开 jar。选择阶段仍要看标志：
    // 1.21.2（有 cherry_planks、哈希不符）与 1.21.1 各一次，加载器版本与快照在打开前就被排除。
    let before = fx.opens();
    fx.refresh().await;
    assert_eq!(fx.opens() - before, 2, "jar 未变时不该再为抽取打开它");

    // 改写 jar：哈希变了，重新抽取，新文件出现在清单里。
    let cherry = tex("block/cherry_planks");
    let moss = tex("block/moss_block");
    rewrite_jar(
        &fx.settings,
        "1.21.1",
        &[
            (cherry.as_str(), png(16, 16, |_, _| PINK)),
            (moss.as_str(), png(16, 16, |_, _| [90, 140, 60, 255])),
        ],
    );
    fx.refresh().await;
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    assert_eq!(
        manifest["files"],
        json!(["block/cherry_planks", "block/moss_block"])
    );
    assert_eq!(
        manifest["jarSha1"],
        json!(remote::sha1_hex(&std::fs::read(&jar).unwrap()))
    );
    assert_eq!(
        fx.service
            .respond("/art/block/moss_block.png", Some("1.21.1"))
            .await
            .status(),
        200
    );

    // 切换材质源：新目录就绪后旧目录被删掉。
    std::fs::remove_dir_all(fx.settings.join("versions/1.21.1")).unwrap();
    assert_eq!(fx.refresh().await.source.as_deref(), Some("1.16.5"));
    assert!(fx.cache.join("vanilla-art/1.16.5/manifest.json").is_file());
    assert!(!fx.cache.join("vanilla-art/1.21.1").exists());
}

#[tokio::test]
async fn panorama_is_found_by_hash_and_corruption_disables_it() {
    let fx = fixture();
    assert!(fx.refresh().await.panorama);
    let bytes = body(fx.service.respond("/panorama/0.png", None).await);
    assert_eq!(bytes.as_slice(), fx.panorama_bytes.as_slice());

    let mut corrupted = fx.panorama_bytes.clone();
    let last = corrupted.len() - 1;
    corrupted[last] ^= 0xff;
    std::fs::write(fx.panorama_object(), corrupted).unwrap();
    assert!(!fx.refresh().await.panorama);
    assert_eq!(
        fx.service.respond("/panorama/0.png", None).await.status(),
        404
    );
}

#[tokio::test]
async fn missing_files_are_negatively_cached_without_touching_the_jar() {
    let fx = fixture();
    fx.refresh().await;
    let before = fx.opens();
    // cherry_leaves 在名单内，但这个 jar 里没有。
    for _ in 0..2 {
        let response = fx
            .service
            .respond("/art/block/cherry_leaves.png", Some("1.21.1"))
            .await;
        assert_eq!(response.status(), 404);
    }
    assert_eq!(fx.opens(), before, "请求路径不该打开 jar");
    let mut state = lock(&fx.service.inner.state);
    assert_eq!(
        state.lru.get("art:1.21.1:block/cherry_leaves"),
        Some(lru::Cached::Missing),
        "第一次 404 之后应留下负缓存"
    );
}

#[tokio::test]
async fn jar_is_not_held_open_after_serving() {
    let fx = fixture();
    fx.refresh().await;
    assert_eq!(
        fx.service
            .respond("/art/block/cherry_planks.png", Some("1.21.1"))
            .await
            .status(),
        200
    );
    // Windows 上任何仍打开的句柄都会让删除失败。
    std::fs::remove_dir_all(fx.settings.join("versions/1.21.1")).unwrap();
}

async fn skin_server() -> MockServer {
    let server = MockServer::start().await;
    for (name, bytes) in [
        ("/a.png", png(64, 64, |_, _| PINK)),
        (
            "/b.png",
            png(64, 32, |x, y| {
                if (x, y) == (41, 9) {
                    [0, 0, 0, 0]
                } else {
                    PINK
                }
            }),
        ),
        ("/hd.png", png(128, 128, |_, _| PINK)),
    ] {
        Mock::given(method("GET"))
            .and(url_path(name))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
            .mount(&server)
            .await;
    }
    server
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skin_cache_follows_the_url_and_stale_files_are_pruned() {
    let fx = fixture();
    let server = skin_server().await;
    let url_a = format!("{}/a.png", server.uri());
    let url_b = format!("{}/b.png", server.uri());

    let a = fx
        .service
        .skin_info(&SkinRef {
            url: url_a.clone(),
            model: SkinModel::Wide,
        })
        .await
        .expect("合规皮肤应就绪");
    assert_eq!(a.sha1, remote::sha1_hex(url_a.as_bytes()));
    assert!(!a.hat, "帽子层纯色不透明");
    assert!(fx.cache.join(format!("skins/{}.png", a.sha1)).is_file());

    // 同一账户换了皮肤地址：按新地址的哈希落盘。
    let b = fx
        .service
        .skin_info(&SkinRef {
            url: url_b.clone(),
            model: SkinModel::Slim,
        })
        .await
        .expect("64x32 旧格式也合规");
    assert_ne!(a.sha1, b.sha1);
    assert!(b.hat, "帽子层有透明像素");
    assert_eq!(b.model, SkinModel::Slim);
    assert_eq!(
        fx.service
            .respond(&format!("/skin/{}.png", b.sha1), None)
            .await
            .status(),
        200
    );
    assert_eq!(
        fx.service
            .respond(&format!("/skin/{}.png", remote::sha1_hex(b"never")), None)
            .await
            .status(),
        404,
        "没登记过的皮肤不提供"
    );

    // 「下次启动」：只保留当前引用的地址。
    fx.service.prune_skins(std::slice::from_ref(&url_b)).await;
    assert!(!fx.cache.join(format!("skins/{}.png", a.sha1)).exists());
    assert!(fx.cache.join(format!("skins/{}.png", b.sha1)).is_file());

    // 缓存命中时不再联网。
    let requests = server.received_requests().await.unwrap().len();
    fx.service
        .skin_info(&SkinRef {
            url: url_b,
            model: SkinModel::Slim,
        })
        .await
        .unwrap();
    assert_eq!(server.received_requests().await.unwrap().len(), requests);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unusable_skins_fall_back_to_none() {
    let fx = fixture();
    let server = skin_server().await;
    for url in [
        format!("{}/hd.png", server.uri()),
        format!("{}/missing.png", server.uri()),
    ] {
        let info = fx
            .service
            .skin_info(&SkinRef {
                url: url.clone(),
                model: SkinModel::Wide,
            })
            .await;
        assert_eq!(info, None, "{url} 应回落");
        assert!(
            !fx.cache
                .join(format!("skins/{}.png", remote::sha1_hex(url.as_bytes())))
                .exists()
        );
    }
}

/// 皮肤地址来自外置登录服务器的档案，指向超大文件时不能整个读进内存：正文超过上限就中止，界面回落，
/// 不落缓存。用合规的 64x64 PNG 后面补满 2 MB：PNG 解码会忽略 IEND 之后的字节，只读完再判就会照单全收。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_skin_downloads_are_refused() {
    let fx = fixture();
    let server = MockServer::start().await;
    let mut padded = png(64, 64, |_, _| PINK);
    padded.resize(padded.len() + 2 * 1024 * 1024, 0);
    Mock::given(method("GET"))
        .and(url_path("/huge.png"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(padded))
        .mount(&server)
        .await;
    let url = format!("{}/huge.png", server.uri());

    let info = fx
        .service
        .skin_info(&SkinRef {
            url: url.clone(),
            model: SkinModel::Wide,
        })
        .await;

    assert_eq!(info, None, "超过上限的皮肤应回落");
    assert!(
        !fx.cache
            .join(format!("skins/{}.png", remote::sha1_hex(url.as_bytes())))
            .exists()
    );
}

#[tokio::test]
async fn thumbs_are_limited_to_known_hosts_and_served_from_cache() {
    let fx = fixture();
    let err = fx
        .service
        .thumb_register("https://evil.example/a.png")
        .await
        .unwrap_err();
    assert!(matches!(err, ThumbError::HostNotAllowed(_)));

    // 已在磁盘缓存里的缩略图：登记不联网，协议按内容识别类型。
    let url = "https://cdn.modrinth.com/data/AANobbMI/icon.png";
    let key = remote::sha1_hex(url.as_bytes());
    std::fs::create_dir_all(fx.cache.join("thumbs")).unwrap();
    std::fs::write(fx.cache.join("thumbs").join(&key), png(4, 4, |_, _| PINK)).unwrap();
    assert_eq!(fx.service.thumb_register(url).await.unwrap(), key);
    match fx.service.respond(&format!("/thumb/{key}"), None).await {
        TexResponse::Found { content_type, .. } => assert_eq!(content_type, "image/png"),
        other => panic!("期望 200，得到 {other:?}"),
    }
}

#[tokio::test]
async fn cover_images_are_served_only_after_registration() {
    let fx = fixture();
    let dir = fx.cache.join("instance-cover");
    std::fs::create_dir_all(&dir).unwrap();
    let png_path = dir.join("block-0123456789abcdef.png");
    let jpeg_path = dir.join("background-0123456789abcdef.jpg");
    let gif_path = dir.join("background-fedcba9876543210.png");
    let pixels = png(16, 16, |_, _| PINK);
    std::fs::write(&png_path, &pixels).unwrap();
    // 协议只按文件头认类型，不解码：JPEG 的 SOI 加 APP0 标记就够
    std::fs::write(
        &jpeg_path,
        [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F'],
    )
    .unwrap();
    std::fs::write(&gif_path, b"GIF89a not really").unwrap();

    // 键由路径决定；没登记过的键一律 404，不按路径猜文件
    let key = remote::sha1_hex(png_path.to_string_lossy().as_bytes());
    assert!(matches!(
        fx.service.respond(&format!("/cover/{key}"), None).await,
        TexResponse::NotFound(_)
    ));
    assert_eq!(fx.service.register_cover(&png_path), key);
    match fx.service.respond(&format!("/cover/{key}"), None).await {
        TexResponse::Found { content_type, body } => {
            assert_eq!(content_type, "image/png");
            assert_eq!(body.as_ref(), &pixels);
        }
        other => panic!("期望 200，得到 {other:?}"),
    }
    let jpeg_key = fx.service.register_cover(&jpeg_path);
    match fx
        .service
        .respond(&format!("/cover/{jpeg_key}"), None)
        .await
    {
        TexResponse::Found { content_type, .. } => assert_eq!(content_type, "image/jpeg"),
        other => panic!("期望 200，得到 {other:?}"),
    }
    let gif_key = fx.service.register_cover(&gif_path);
    assert!(matches!(
        fx.service.respond(&format!("/cover/{gif_key}"), None).await,
        TexResponse::Failed(_)
    ));
    // 登记后文件被删：404，界面回落
    std::fs::remove_file(&png_path).unwrap();
    assert!(matches!(
        fx.service.respond(&format!("/cover/{key}"), None).await,
        TexResponse::NotFound(_)
    ));
    assert!(matches!(
        fx.service.respond("/cover/../settings.json", None).await,
        TexResponse::BadRequest(_)
    ));
}

#[test]
fn candidates_start_with_the_configured_game_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let named = |name: &str, path: PathBuf| crate::config::NamedDirectory {
        name: name.to_owned(),
        path,
    };
    let config = crate::config::PetalfallConfig {
        extra_game_directories: vec![
            named("PCL", tmp.path().join("pcl")),
            // 与当前目录相同的登记只留一次。
            named("重复", tmp.path().join("game")),
            named("HMCL", tmp.path().join("hmcl")),
        ],
        ..crate::config::PetalfallConfig::default()
    };
    let petalfall = Petalfall::for_test(config, tmp.path().to_path_buf(), tmp.path().join("game"));
    let candidates = petalfall.art_candidates();
    assert_eq!(
        candidates[..3],
        [
            tmp.path().join("game"),
            tmp.path().join("pcl"),
            tmp.path().join("hmcl")
        ]
    );
    if let Some(official) = official_minecraft_dir() {
        assert_eq!(candidates.last(), Some(&official));
    }
    let service = petalfall.texture_service();
    assert_eq!(service.inner.cache_root, tmp.path().join("cache"));
    assert_eq!(service.status(), ArtStatus::default());
}
