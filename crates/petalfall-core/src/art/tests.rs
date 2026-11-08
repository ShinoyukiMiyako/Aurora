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
    // 方块面按形状放行：形状合法但缓存里没有的是 404，不是 400。
    assert_eq!(
        fx.service
            .respond("/art/block/dirt.png", Some("1.21.1"))
            .await
            .status(),
        404
    );

    for rejected in [
        "/art/block/Dirt.png",
        "/art/block/sub/dirt.png",
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
    assert_eq!(manifest["format"], json!(2));
    assert_eq!(manifest["origin"], json!("local"));
    assert_eq!(
        manifest["files"],
        json!([
            "block/blue_ice",
            "block/cherry_planks",
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

// ---- 方块目录与下载缓存 ----

const GRAY: [u8; 4] = [128, 128, 128, 255];
const ICE: [u8; 4] = [40, 120, 220, 255];
const LOG_TOP: [u8; 4] = [180, 150, 90, 255];

fn json_bytes(value: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&value).unwrap()
}

fn blockstate(id: &str, model: &str) -> (String, Vec<u8>) {
    (
        format!("assets/minecraft/blockstates/{id}.json"),
        json_bytes(json!({ "variants": { "": { "model": model } } })),
    )
}

fn block_model(path: &str, value: serde_json::Value) -> (String, Vec<u8>) {
    (
        format!("assets/minecraft/models/{path}.json"),
        json_bytes(value),
    )
}

fn texture(path: &str, rgba: [u8; 4]) -> (String, Vec<u8>) {
    (tex(path), png(16, 16, move |_, _| rgba))
}

/// 一个能推出方块目录的客户端 jar：几个原版模板、各类方块、英文语言文件与它们的材质。`items` 为 false 时
/// 模拟 1.21.4 之前没有物品定义的 jar。
fn catalog_jar(items: bool) -> Vec<(String, Vec<u8>)> {
    let cube = json!([{ "from": [0, 0, 0], "to": [16, 16, 16] }]);
    let mut entries = vec![
        block_model("block/block", json!({})),
        block_model(
            "block/cube",
            json!({ "parent": "block/block", "elements": cube }),
        ),
        block_model(
            "block/cube_all",
            json!({ "parent": "block/cube", "textures": { "up": "#all", "north": "#all", "east": "#all" } }),
        ),
        block_model(
            "block/cube_column",
            json!({ "parent": "block/cube", "textures": { "up": "#end", "north": "#side", "east": "#side" } }),
        ),
        block_model(
            "block/orientable_with_bottom",
            json!({ "parent": "block/cube", "textures": { "up": "#top", "north": "#front", "east": "#side" } }),
        ),
        block_model(
            "block/orientable",
            json!({ "parent": "block/orientable_with_bottom", "textures": { "bottom": "#top" } }),
        ),
        block_model(
            "block/leaves",
            json!({ "parent": "block/block", "elements": cube }),
        ),
        block_model(
            "block/cross",
            json!({ "parent": "block/block", "elements": cube }),
        ),
        blockstate("stone", "minecraft:block/stone"),
        block_model(
            "block/stone",
            json!({ "parent": "minecraft:block/cube_all", "textures": { "all": "minecraft:block/stone" } }),
        ),
        blockstate("blue_ice", "minecraft:block/blue_ice"),
        block_model(
            "block/blue_ice",
            json!({ "parent": "minecraft:block/cube_all", "textures": { "all": "minecraft:block/blue_ice" } }),
        ),
        blockstate("oak_log", "minecraft:block/oak_log"),
        block_model(
            "block/oak_log",
            json!({ "parent": "minecraft:block/cube_column", "textures": { "end": "minecraft:block/oak_log_top", "side": "minecraft:block/oak_log" } }),
        ),
        blockstate("furnace", "minecraft:block/furnace"),
        block_model(
            "block/furnace",
            json!({ "parent": "minecraft:block/orientable", "textures": {
                "top": "minecraft:block/furnace_top",
                "side": "minecraft:block/furnace_side",
                "front": "minecraft:block/furnace_front"
            } }),
        ),
        blockstate("crafting_table", "minecraft:block/crafting_table"),
        block_model(
            "block/crafting_table",
            json!({ "parent": "minecraft:block/cube", "textures": {
                "up": "minecraft:block/crafting_table_top",
                "north": "minecraft:block/crafting_table_front",
                "east": "minecraft:block/crafting_table_side"
            } }),
        ),
        blockstate("oak_leaves", "minecraft:block/oak_leaves"),
        block_model(
            "block/oak_leaves",
            json!({ "parent": "minecraft:block/leaves", "textures": { "all": "minecraft:block/oak_leaves" } }),
        ),
        blockstate("spruce_leaves", "minecraft:block/spruce_leaves"),
        block_model(
            "block/spruce_leaves",
            json!({ "parent": "minecraft:block/leaves", "textures": { "all": "minecraft:block/spruce_leaves" } }),
        ),
        blockstate("grass_block", "minecraft:block/grass_block"),
        block_model(
            "block/grass_block",
            json!({ "parent": "block/block", "textures": { "top": "block/grass_block_top" }, "elements": cube }),
        ),
        // 交叉植物：材质在 jar 里，但不是完整方块。
        blockstate("poppy", "minecraft:block/poppy"),
        block_model(
            "block/poppy",
            json!({ "parent": "minecraft:block/cross", "textures": { "cross": "minecraft:block/poppy" } }),
        ),
        (
            "assets/minecraft/blockstates/oak_fence.json".to_owned(),
            json_bytes(
                json!({ "multipart": [{ "apply": { "model": "minecraft:block/oak_fence_post" } }] }),
            ),
        ),
        // 侧面材质不在 jar 里：推得出来，但抽不到图，不进目录。
        blockstate("bookshelf", "minecraft:block/bookshelf"),
        block_model(
            "block/bookshelf",
            json!({ "parent": "minecraft:block/cube_column", "textures": { "end": "minecraft:block/stone", "side": "minecraft:block/bookshelf" } }),
        ),
        (
            "assets/minecraft/lang/en_us.json".to_owned(),
            json_bytes(json!({
                "block.minecraft.stone": "Stone",
                "block.minecraft.oak_log": "Oak Log",
                "block.minecraft.crafting_table": "Crafting Table",
                "block.minecraft.grass_block": "Grass Block",
                "block.minecraft.oak_leaves": "Oak Leaves"
            })),
        ),
        // 完整材质集的标志，也是预设必抽名单里的一张。
        texture("block/cherry_planks", PINK),
        texture("block/stone", [120, 120, 120, 255]),
        (
            tex("block/blue_ice"),
            png(16, 32, |_, y| if y < 16 { ICE } else { [255, 0, 0, 255] }),
        ),
        (
            format!("{}.mcmeta", tex("block/blue_ice")),
            br#"{"animation":{}}"#.to_vec(),
        ),
        texture("block/oak_log_top", LOG_TOP),
        texture("block/oak_log", [100, 80, 50, 255]),
        texture("block/furnace_top", GRAY),
        texture("block/furnace_side", [200, 100, 0, 255]),
        texture("block/furnace_front", [50, 50, 50, 255]),
        texture("block/crafting_table_top", GRAY),
        texture("block/crafting_table_front", GRAY),
        texture("block/crafting_table_side", [20, 60, 40, 255]),
        texture("block/oak_leaves", GRAY),
        texture("block/spruce_leaves", GRAY),
        texture("block/grass_block_top", GRAY),
        texture("block/grass_block_side", [134, 96, 67, 255]),
        texture("block/poppy", [200, 0, 0, 255]),
        (tex("entity/player/wide/steve"), png(64, 64, |_, _| PINK)),
    ];
    if items {
        entries.push((
            "assets/minecraft/items/oak_leaves.json".to_owned(),
            json_bytes(json!({ "model": {
                "type": "minecraft:model",
                "model": "minecraft:block/oak_leaves",
                "tints": [{ "type": "minecraft:constant", "value": -12012264 }]
            } })),
        ));
        entries.push((
            "assets/minecraft/items/spruce_leaves.json".to_owned(),
            json_bytes(
                json!({ "model": { "type": "minecraft:model", "model": "minecraft:block/spruce_leaves" } }),
            ),
        ));
    }
    entries
}

fn zh_cn_lang() -> Vec<u8> {
    json_bytes(json!({
        "block.minecraft.stone": "石头",
        "block.minecraft.oak_log": "橡木原木",
        "block.minecraft.furnace": "熔炉",
        "block.minecraft.grass_block": "草方块"
    }))
}

fn put_catalog_version(
    game_dir: &Path,
    id: &str,
    release_time: &str,
    entries: &[(String, Vec<u8>)],
) {
    put_version(
        game_dir,
        VersionSpec {
            id,
            kind: "release",
            release_time,
            inherits_from: None,
            wrong_sha1: false,
            entries: entries
                .iter()
                .map(|(name, bytes)| (name.as_str(), bytes.clone()))
                .collect(),
        },
    );
}

/// 给版本 JSON 写上资源索引，并在游戏目录的 assets 里放好索引与 zh_cn 对象。`corrupt` 为 true 时对象内容
/// 与索引声明的 SHA-1 不符。
fn put_zh_cn(game_dir: &Path, version: &str, corrupt: bool) {
    let json_path = game_dir
        .join("versions")
        .join(version)
        .join(format!("{version}.json"));
    let mut json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&json_path).unwrap()).unwrap();
    json["assetIndex"] = json!({
        "id": "29",
        "sha1": "0000000000000000000000000000000000000000",
        "size": 1,
        "url": "https://example.invalid/29.json"
    });
    std::fs::write(&json_path, json.to_string()).unwrap();

    let lang = zh_cn_lang();
    let hash = remote::sha1_hex(&lang);
    let index =
        json!({ "objects": { "minecraft/lang/zh_cn.json": { "hash": hash, "size": lang.len() } } });
    let indexes = game_dir.join("assets/indexes");
    std::fs::create_dir_all(&indexes).unwrap();
    std::fs::write(indexes.join("29.json"), index.to_string()).unwrap();
    let object = game_dir.join("assets/objects").join(&hash[..2]).join(&hash);
    std::fs::create_dir_all(object.parent().unwrap()).unwrap();
    let mut stored = lang;
    if corrupt {
        stored.push(b' ');
    }
    std::fs::write(object, stored).unwrap();
}

struct CatalogFixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    game: PathBuf,
    cache: PathBuf,
    opens: Arc<AtomicUsize>,
    service: TextureService,
}

impl CatalogFixture {
    async fn refresh(&self) -> ArtStatus {
        self.service.refresh(std::slice::from_ref(&self.game)).await
    }

    fn opens(&self) -> usize {
        self.opens.load(Ordering::SeqCst)
    }

    fn art(&self, path: &str) -> PathBuf {
        self.cache.join("vanilla-art").join(path)
    }

    /// 在游戏目录外放一个「下载来的」jar 与中文语言文件，交给服务抽进下载缓存，然后像调用方那样删掉它们。
    async fn adopt(&self, version_id: &str, with_zh: bool) {
        let dir = self.root.join("download").join(version_id);
        let jar = dir.join("client.jar");
        let entries = catalog_jar(true);
        let borrowed: Vec<(&str, Vec<u8>)> = entries
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.clone()))
            .collect();
        write_jar(&jar, &borrowed);
        let zh_cn = with_zh.then(|| {
            let path = dir.join("zh_cn.json");
            std::fs::write(&path, zh_cn_lang()).unwrap();
            path
        });
        let client = DownloadedClient {
            version_id: version_id.to_owned(),
            jar_sha1: remote::sha1_hex(&std::fs::read(&jar).unwrap()),
            jar,
            zh_cn,
        };
        self.service.adopt_download(client).await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}

fn catalog_fixture() -> CatalogFixture {
    let root = tempfile::tempdir().unwrap();
    let game = root.path().join("game");
    let cache = root.path().join("cache");
    std::fs::create_dir_all(&game).unwrap();
    let opens = Arc::new(AtomicUsize::new(0));
    let counter = opens.clone();
    let opener: JarOpener = Arc::new(move |path| {
        counter.fetch_add(1, Ordering::SeqCst);
        std::fs::File::open(path)
    });
    let service = TextureService::with_parts(
        cache.clone(),
        petalfall_base::http::build_client().unwrap(),
        PanoramaSpec::default(),
        opener,
    );
    CatalogFixture {
        root: root.path().to_owned(),
        _root: root,
        game,
        cache,
        opens,
        service,
    }
}

/// 没有正面、不染色、没有名称的方块；其余字段在调用处用结构体更新语法覆盖。
fn plain(id: &str, top: &str, side: &str, hue: u16) -> CatalogBlock {
    CatalogBlock {
        id: id.to_owned(),
        top: top.to_owned(),
        side: side.to_owned(),
        front: None,
        top_tint: None,
        side_tint: None,
        hue,
        name_en: None,
        name_zh: None,
    }
}

fn name(text: &str) -> Option<String> {
    Some(text.to_owned())
}

/// [`catalog_jar`]（带物品定义）配上可用的中文名推出的目录。
fn expected_blocks() -> Vec<CatalogBlock> {
    let oak_tint = Some([72, 181, 24]);
    vec![
        // 动画材质的色相只看首帧 (40, 120, 220)，第二帧的红不参与。
        plain("blue_ice", "block/blue_ice", "block/blue_ice", 213),
        CatalogBlock {
            front: name("block/crafting_table_front"),
            name_en: name("Crafting Table"),
            ..plain(
                "crafting_table",
                "block/crafting_table_top",
                "block/crafting_table_side",
                150,
            )
        },
        CatalogBlock {
            front: name("block/furnace_front"),
            name_zh: name("熔炉"),
            ..plain("furnace", "block/furnace_top", "block/furnace_side", 30)
        },
        CatalogBlock {
            top_tint: Some([124, 189, 107]),
            name_en: name("Grass Block"),
            name_zh: name("草方块"),
            ..plain(
                "grass_block",
                "block/grass_block_top",
                "block/grass_block_side",
                26,
            )
        },
        // 灰度材质乘物品定义里的固定染色，色相 102。
        CatalogBlock {
            top_tint: oak_tint,
            side_tint: oak_tint,
            name_en: name("Oak Leaves"),
            ..plain("oak_leaves", "block/oak_leaves", "block/oak_leaves", 102)
        },
        CatalogBlock {
            name_en: name("Oak Log"),
            name_zh: name("橡木原木"),
            ..plain("oak_log", "block/oak_log_top", "block/oak_log", 36)
        },
        // 有物品定义但没有固定染色：不染，不查表。
        plain(
            "spruce_leaves",
            "block/spruce_leaves",
            "block/spruce_leaves",
            0,
        ),
        CatalogBlock {
            name_en: name("Stone"),
            name_zh: name("石头"),
            ..plain("stone", "block/stone", "block/stone", 0)
        },
    ]
}

fn expected_blocks_without_zh() -> Vec<CatalogBlock> {
    expected_blocks()
        .into_iter()
        .map(|block| CatalogBlock {
            name_zh: None,
            ..block
        })
        .collect()
}

#[tokio::test]
async fn catalog_lists_full_cubes_with_faces_tints_hues_and_names() {
    let fx = catalog_fixture();
    assert_eq!(fx.service.catalog(), None, "没有材质源时没有目录");
    put_catalog_version(
        &fx.game,
        "26.3",
        "2026-10-20T00:00:00+00:00",
        &catalog_jar(true),
    );
    put_zh_cn(&fx.game, "26.3", false);

    assert_eq!(fx.refresh().await.source.as_deref(), Some("26.3"));
    let catalog = fx.service.catalog().expect("有材质源就有目录");
    assert_eq!(
        catalog,
        BlockCatalog {
            version_id: "26.3".to_owned(),
            blocks: expected_blocks(),
        }
    );

    // 抽的是目录引用到的面 + 预设必抽里 jar 有的 + 皮肤；交叉植物与缺侧面的书架都不在。
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fx.art("26.3/manifest.json")).unwrap()).unwrap();
    assert_eq!(
        manifest["files"],
        json!([
            "block/blue_ice",
            "block/cherry_planks",
            "block/crafting_table_front",
            "block/crafting_table_side",
            "block/crafting_table_top",
            "block/furnace_front",
            "block/furnace_side",
            "block/furnace_top",
            "block/grass_block_side",
            "block/grass_block_top",
            "block/oak_leaves",
            "block/oak_log",
            "block/oak_log_top",
            "block/spruce_leaves",
            "block/stone",
            "entity/player/wide/steve"
        ])
    );
    // 磁盘上的目录与内存里的一致，下次刷新直接读它。
    let on_disk: BlockCatalog =
        serde_json::from_slice(&std::fs::read(fx.art("26.3/catalog.json")).unwrap()).unwrap();
    assert_eq!(on_disk, catalog);
    let before = fx.opens();
    fx.refresh().await;
    assert_eq!(fx.opens() - before, 1, "缓存可用时只为看标志打开一次 jar");
    assert_eq!(fx.service.catalog(), Some(catalog));
}

#[tokio::test]
async fn old_jars_without_item_definitions_tint_leaves_from_the_table() {
    let fx = catalog_fixture();
    put_catalog_version(
        &fx.game,
        "1.21.1",
        "2024-08-08T12:24:45+00:00",
        &catalog_jar(false),
    );
    fx.refresh().await;
    let catalog = fx.service.catalog().unwrap();
    let find = |id: &str| {
        catalog
            .blocks
            .iter()
            .find(|b| b.id == id)
            .unwrap_or_else(|| panic!("目录里应有 {id}"))
    };
    let oak = find("oak_leaves");
    assert_eq!(
        (oak.top_tint, oak.side_tint),
        (Some([72, 181, 24]), Some([72, 181, 24]))
    );
    let spruce = find("spruce_leaves");
    assert_eq!(
        (spruce.top_tint, spruce.side_tint),
        (Some([97, 153, 97]), Some([97, 153, 97]))
    );
    assert_eq!(spruce.hue, 120);
    // 版本 JSON 没有资源索引：只有英文名。
    assert_eq!(find("stone").name_en.as_deref(), Some("Stone"));
    assert!(catalog.blocks.iter().all(|b| b.name_zh.is_none()));
}

#[tokio::test]
async fn chinese_names_need_an_asset_object_with_the_indexed_sha1() {
    let fx = catalog_fixture();
    put_catalog_version(
        &fx.game,
        "26.3",
        "2026-10-20T00:00:00+00:00",
        &catalog_jar(true),
    );
    put_zh_cn(&fx.game, "26.3", true);
    fx.refresh().await;
    let catalog = fx.service.catalog().unwrap();
    assert_eq!(
        catalog.blocks,
        expected_blocks_without_zh(),
        "SHA-1 不符时只有英文名，其余不变"
    );
}

/// 先有 jar、后来才补下资源：jar 没变也重抽一次补上中文名；之后缓存里有中文名就不再重抽。
/// 选源时看标志文件也要打开 jar，所以按「每次刷新打开几次」比：比空转的刷新多出来的就是重抽。
#[tokio::test]
async fn chinese_names_arrive_once_the_assets_are_downloaded_later() {
    let fx = catalog_fixture();
    put_catalog_version(
        &fx.game,
        "26.3",
        "2026-10-20T00:00:00+00:00",
        &catalog_jar(true),
    );
    fx.refresh().await;
    let name_zh = |id: &str| {
        fx.service
            .catalog()
            .unwrap()
            .blocks
            .into_iter()
            .find(|b| b.id == id)
            .unwrap()
            .name_zh
    };
    let opens_per_refresh = || async {
        let before = fx.opens();
        fx.refresh().await;
        fx.opens() - before
    };
    assert_eq!(name_zh("furnace"), None);
    let idle = opens_per_refresh().await;
    // 资源对象坏着：缓存缺中文名也不重抽
    put_zh_cn(&fx.game, "26.3", true);
    assert_eq!(opens_per_refresh().await, idle, "资源对象坏着时不该重抽");
    assert_eq!(name_zh("furnace"), None);
    put_zh_cn(&fx.game, "26.3", false);
    assert!(opens_per_refresh().await > idle, "补上资源后应重抽一次");
    assert_eq!(name_zh("furnace").as_deref(), Some("熔炉"));
    assert_eq!(opens_per_refresh().await, idle, "缓存已有中文名，不再重抽");
}

#[tokio::test]
async fn catalog_faces_are_served_and_everything_else_is_404_or_400() {
    let fx = catalog_fixture();
    put_catalog_version(
        &fx.game,
        "26.3",
        "2026-10-20T00:00:00+00:00",
        &catalog_jar(true),
    );
    fx.refresh().await;
    let before = fx.opens();

    // 预设名单外、目录引用到的面。
    let log_top = body(
        fx.service
            .respond("/art/block/oak_log_top.png", Some("26.3"))
            .await,
    );
    let rgba = image::load_from_memory(&log_top).unwrap().to_rgba8();
    assert!(rgba.pixels().all(|p| p.0 == LOG_TOP));
    // 动画材质只留首帧。
    let ice = body(
        fx.service
            .respond("/art/block/blue_ice.png", Some("26.3"))
            .await,
    );
    assert_eq!(dims(&ice), (16, 16));
    let rgba = image::load_from_memory(&ice).unwrap().to_rgba8();
    assert!(rgba.pixels().all(|p| p.0 == ICE));

    // 形状合法、但不在缓存里：交叉植物（材质在 jar 里也不给）、缺图的书架、根本没有的方块。
    for missing in ["poppy", "bookshelf", "dirt"] {
        let response = fx
            .service
            .respond(&format!("/art/block/{missing}.png"), Some("26.3"))
            .await;
        assert_eq!(response.status(), 404, "block/{missing} 应为 404");
    }
    for rejected in [
        "/art/block/Stone.png",
        "/art/block/sub/stone.png",
        "/art/block/.png",
        "/art/item/apple.png",
        "/art/entity/pig.png",
        "/art/blockstates/stone.png",
    ] {
        let response = fx.service.respond(rejected, Some("26.3")).await;
        assert_eq!(response.status(), 400, "{rejected} 应为 400");
    }
    assert_eq!(fx.opens(), before, "请求路径不该打开 jar");
}

#[tokio::test]
async fn source_priority_is_local_full_then_download_then_local_degraded() {
    let fx = catalog_fixture();
    put_catalog_version(
        &fx.game,
        "26.3",
        "2026-10-20T00:00:00+00:00",
        &catalog_jar(true),
    );
    put_catalog_version(
        &fx.game,
        "1.16.5",
        "2021-01-14T16:05:32+00:00",
        &[texture("block/stone", GRAY)],
    );
    fx.adopt("26.4", true).await;

    // 本机完整集优先，即使下载来的更新；下载缓存留着。
    assert_eq!(fx.refresh().await.source.as_deref(), Some("26.3"));
    assert!(fx.art(".download-cache/manifest.json").is_file());

    // 本机只剩降级集：用下载缓存，本机旧缓存被清掉。
    std::fs::remove_dir_all(fx.game.join("versions/26.3")).unwrap();
    assert_eq!(fx.refresh().await.source.as_deref(), Some("26.4"));
    assert_eq!(fx.service.catalog().unwrap().version_id, "26.4");
    assert!(!fx.art("26.3").exists());

    // 下载缓存也没了：退到本机降级集。
    std::fs::remove_dir_all(fx.art(".download-cache")).unwrap();
    assert_eq!(fx.refresh().await.source.as_deref(), Some("1.16.5"));
    let degraded = fx.service.catalog().unwrap();
    assert_eq!(degraded.version_id, "1.16.5");
    assert_eq!(degraded.blocks, Vec::new(), "降级源的 jar 里没有方块状态");
}

#[tokio::test]
async fn adopted_download_is_served_without_the_jar() {
    let fx = catalog_fixture();
    let before = fx.opens();
    fx.adopt("26.4", true).await;
    assert_eq!(fx.opens() - before, 1, "抽取只打开一次 jar");
    // jar 已删、游戏目录是空的：照样选中下载缓存。
    let opened = fx.opens();
    assert_eq!(fx.refresh().await.source.as_deref(), Some("26.4"));
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fx.art(".download-cache/manifest.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["origin"], json!("download"));
    assert_eq!(manifest["versionId"], json!("26.4"));
    assert_eq!(
        fx.service.catalog().unwrap(),
        BlockCatalog {
            version_id: "26.4".to_owned(),
            blocks: expected_blocks(),
        },
        "中文名来自下载来的语言文件"
    );
    let log_top = body(
        fx.service
            .respond("/art/block/oak_log_top.png", Some("26.4"))
            .await,
    );
    assert!(
        image::load_from_memory(&log_top)
            .unwrap()
            .to_rgba8()
            .pixels()
            .all(|p| p.0 == LOG_TOP)
    );
    assert_eq!(fx.opens(), opened, "选源与取图都不碰 jar");

    // 再下一次（这回没拿到中文名）：替换掉之前那份。
    fx.adopt("26.5", false).await;
    assert_eq!(fx.refresh().await.source.as_deref(), Some("26.5"));
    let catalog = fx.service.catalog().unwrap();
    assert!(catalog.blocks.iter().all(|b| b.name_zh.is_none()));
    assert_eq!(
        catalog
            .blocks
            .iter()
            .find(|b| b.id == "stone")
            .unwrap()
            .name_en
            .as_deref(),
        Some("Stone")
    );
}

#[tokio::test]
async fn caches_in_an_older_format_are_extracted_again() {
    let fx = catalog_fixture();
    put_catalog_version(
        &fx.game,
        "26.3",
        "2026-10-20T00:00:00+00:00",
        &catalog_jar(true),
    );
    fx.refresh().await;
    let manifest_path = fx.art("26.3/manifest.json");
    let current: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();

    // 第一版缓存：清单里没有格式号，也没有方块目录，jarSha1 却与 jar 一致。
    for old in [None, Some(1)] {
        let mut manifest = json!({
            "versionId": "26.3",
            "jarSha1": current["jarSha1"],
            "files": ["block/cherry_planks"]
        });
        if let Some(format) = old {
            manifest["format"] = json!(format);
        }
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();
        std::fs::remove_file(fx.art("26.3/catalog.json")).ok();

        let before = fx.opens();
        fx.refresh().await;
        assert_eq!(fx.opens() - before, 2, "看标志一次、重新抽取一次");
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        assert_eq!(manifest, current, "格式 {old:?} 的缓存应整份重抽");
        assert!(fx.art("26.3/catalog.json").is_file());
        assert_eq!(
            fx.service.catalog().unwrap().blocks,
            expected_blocks_without_zh()
        );
    }

    // 格式是当前的，但方块目录被删了：也整份重抽。
    std::fs::remove_file(fx.art("26.3/catalog.json")).unwrap();
    let before = fx.opens();
    fx.refresh().await;
    assert_eq!(fx.opens() - before, 2);
    assert!(fx.art("26.3/catalog.json").is_file());
}

#[tokio::test]
async fn stale_caches_go_but_the_download_staging_dir_stays() {
    let fx = catalog_fixture();
    put_catalog_version(
        &fx.game,
        "26.3",
        "2026-10-20T00:00:00+00:00",
        &catalog_jar(true),
    );
    // 另一个任务正在往暂存目录里下 jar；还有一份别的版本的旧缓存与半途的临时目录。
    let staging = fx.service.download_dir().join("client.jar");
    std::fs::create_dir_all(staging.parent().unwrap()).unwrap();
    std::fs::write(&staging, b"partial").unwrap();
    std::fs::create_dir_all(fx.art("1.20.1/textures")).unwrap();
    std::fs::create_dir_all(fx.art(".tmp-1.20.1-1-2/textures")).unwrap();

    assert_eq!(fx.refresh().await.source.as_deref(), Some("26.3"));
    assert_eq!(std::fs::read(&staging).unwrap(), b"partial");
    assert!(!fx.art("1.20.1").exists());
    assert!(!fx.art(".tmp-1.20.1-1-2").exists());
    assert!(fx.art("26.3/manifest.json").is_file());

    // 选中下载缓存时同样不动暂存目录。
    fx.adopt("26.4", true).await;
    std::fs::remove_dir_all(fx.game.join("versions/26.3")).unwrap();
    assert_eq!(fx.refresh().await.source.as_deref(), Some("26.4"));
    assert_eq!(std::fs::read(&staging).unwrap(), b"partial");
    assert!(!fx.art("26.3").exists());
}
