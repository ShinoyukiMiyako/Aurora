//! 原版材质的自定义协议 `petalfall-tex`。Windows 上 WebView 访问的是 `http://petalfall-tex.localhost/<路径>`。
//!
//! 用自定义协议而不是 asset 协议：asset 协议要把玩家任意位置的游戏目录整片放进作用域，也读不了
//! jar 内部条目；走 IPC 传字节又绕开了 WebView 的 HTTP 缓存。协议处理只碰独立的
//! [`TextureService`]，不取门面锁，长任务持锁时取图照常。
//!
//! 所有响应都带 `Access-Control-Allow-Origin: *`：前端要把材质画进 Canvas 逐像素染色，而协议源与
//! 页面源不同源，缺这个头 Canvas 就会被污染、`getImageData` 直接抛错。

use std::path::PathBuf;

use petalfall_core::{ArtStatus, TexResponse, TextureService};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{App, AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::commands::art::{discard_staging, ArtDownloadSlot, ArtStatusDto};
use crate::events;
use crate::facade::Facade;

/// 协议名。
pub const SCHEME: &str = "petalfall-tex";

/// 材质源、方块目录或全景可用性变化时推送，负载为 [`ArtStatusDto`]。前端收到后清空位图缓存并重绘。
pub const ART_CHANGED_EVENT: &str = "petalfall://art-changed";

/// 装配材质服务并在后台做启动时的一轮准备：选材质源、清理下载暂存、旧皮肤与过期缩略图。
/// 调用前须已托管 [`ArtDownloadSlot`]。
pub fn setup(app: &App) {
    let petalfall = tauri::async_runtime::block_on(app.state::<Facade>().snapshot());
    app.manage(petalfall.texture_service());
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let status = refresh(&handle).await;
        let staging = handle.state::<TextureService>().download_dir();
        if let Err(err) =
            discard_staging(&handle.state::<ArtDownloadSlot>(), &status, &staging).await
        {
            tracing::warn!(dir = %staging.display(), error = %err, "清理原版材质下载暂存失败，下次启动再试");
        }
        prune_caches(&handle).await;
    });
}

/// 重新选择材质源与全景；状态或方块目录有变化就推送 [`ART_CHANGED_EVENT`]。返回新状态。
///
/// 启动时与游戏目录变更、游戏版本装好或删掉之后调用。
pub async fn refresh(app: &AppHandle) -> ArtStatus {
    let candidates = app.state::<Facade>().read().await.art_candidates();
    let (after, changed) = reselect(&app.state::<TextureService>(), &candidates).await;
    if changed {
        tracing::info!(source = ?after.source, panorama = after.panorama, "原版材质状态或方块目录变化");
        events::emit(app, ART_CHANGED_EVENT, ArtStatusDto::from(after.clone()));
    }
    after
}

/// 重选材质源，返回新状态与前端要不要重取。同一版本也会重抽出不同的目录（本机后来补齐了中文语言文件，
/// 缓存重抽补上中文名），只比状态的话前端会拿着旧目录直到重启，所以目录也要比。
async fn reselect(service: &TextureService, candidates: &[PathBuf]) -> (ArtStatus, bool) {
    let (status, catalog) = (service.status(), service.catalog());
    let after = service.refresh(candidates).await;
    let changed = after != status || service.catalog() != catalog;
    (after, changed)
}

/// 命令成功后重选材质源：游戏目录换了、版本装好、删掉或改名之后，最合适的材质源可能变了，
/// 当前源也可能正是被删掉的那个。命令失败时什么都没变，不必重选。
pub async fn refresh_on_success<T, E>(app: &AppHandle, outcome: &Result<T, E>) {
    if outcome.is_ok() {
        refresh(app).await;
    }
}

/// 删掉不再被任何账户引用的皮肤缓存与过期缩略图。读不了账户库时跳过皮肤清理并记 warn。
async fn prune_caches(app: &AppHandle) {
    let service = app.state::<TextureService>();
    let petalfall = app.state::<Facade>().snapshot().await;
    match tokio::task::spawn_blocking(move || petalfall.accounts()).await {
        Ok(Ok(accounts)) => {
            let urls: Vec<String> = accounts
                .into_iter()
                .filter_map(|a| a.skin.map(|s| s.url))
                .collect();
            service.prune_skins(&urls).await;
        }
        Ok(Err(err)) => tracing::warn!(error = %err, "读取账户库失败，本次不清理皮肤缓存"),
        Err(err) => {
            tracing::warn!(error = %err, "读取账户库的后台任务异常结束，本次不清理皮肤缓存")
        }
    }
    service.prune_thumbs().await;
}

/// 协议入口：解析路径与版本戳，交给材质服务，在后台任务里异步应答。
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let path = request.uri().path().to_owned();
    let version = query_value(request.uri().query(), "v");
    tauri::async_runtime::spawn(async move {
        let service = app.state::<TextureService>();
        let response = service.respond(&path, version.as_deref()).await;
        responder.respond(http_response(response));
    });
}

/// 取查询串里某个键的值并做百分号解码（版本 id 由前端 `encodeURIComponent` 编码）。
fn query_value(query: Option<&str>, key: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| {
            percent_encoding::percent_decode_str(v)
                .decode_utf8_lossy()
                .into_owned()
        })
    })
}

fn http_response(response: TexResponse) -> Response<Vec<u8>> {
    let status = StatusCode::from_u16(response.status()).expect("材质响应只用标准状态码");
    let builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    let built = match response {
        // 内容随 URL 不可变：方块带版本戳、皮肤与缩略图以地址哈希为名，换图即换 URL。
        TexResponse::Found { content_type, body } => builder
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
            .body(body.as_ref().clone()),
        TexResponse::BadRequest(message)
        | TexResponse::NotFound(message)
        | TexResponse::Failed(message) => builder
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(message.into_bytes()),
    };
    built.expect("响应头全是常量，构造不会失败")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn query_value_decodes_and_ignores_other_keys() {
        assert_eq!(
            query_value(Some("v=1.21.1"), "v").as_deref(),
            Some("1.21.1")
        );
        assert_eq!(
            query_value(Some("x=1&v=1.20.1%20OptiFine"), "v").as_deref(),
            Some("1.20.1 OptiFine")
        );
        assert_eq!(query_value(Some("vv=1"), "v"), None);
        assert_eq!(query_value(None, "v"), None);
    }

    #[test]
    fn responses_carry_cors_and_cache_headers() {
        let ok = http_response(TexResponse::Found {
            content_type: "image/png",
            body: Arc::new(vec![1, 2, 3]),
        });
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(
            ok.headers()[header::CACHE_CONTROL],
            "max-age=31536000, immutable"
        );
        assert_eq!(ok.body(), &vec![1, 2, 3]);

        for (response, status) in [
            (TexResponse::BadRequest("bad".into()), 400),
            (TexResponse::NotFound("missing".into()), 404),
            (TexResponse::Failed("io".into()), 500),
        ] {
            let built = http_response(response);
            assert_eq!(built.status(), status);
            assert_eq!(built.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
            assert_eq!(built.headers()[header::CACHE_CONTROL], "no-store");
        }
    }

    /// 只有一种方块（石头）的客户端 jar：方块状态、模型、16x16 的面与英文名。
    fn write_client_jar(jar: &std::path::Path, scratch: &std::path::Path) {
        use std::io::Write;
        let face = scratch.join("stone.png");
        image::RgbaImage::from_pixel(16, 16, image::Rgba([120, 120, 120, 255]))
            .save(&face)
            .unwrap();
        let entries: [(&str, Vec<u8>); 5] = [
            (
                "assets/minecraft/blockstates/stone.json",
                br#"{ "variants": { "": { "model": "minecraft:block/stone" } } }"#.to_vec(),
            ),
            (
                "assets/minecraft/models/block/stone.json",
                br#"{ "parent": "minecraft:block/cube_all", "textures": { "all": "minecraft:block/stone" } }"#.to_vec(),
            ),
            ("assets/minecraft/models/block/cube_all.json", b"{}".to_vec()),
            (
                "assets/minecraft/textures/block/stone.png",
                std::fs::read(&face).unwrap(),
            ),
            (
                "assets/minecraft/lang/en_us.json",
                br#"{ "block.minecraft.stone": "Stone" }"#.to_vec(),
            ),
        ];
        let mut writer = zip::ZipWriter::new(std::fs::File::create(jar).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            writer.start_file(name, options).unwrap();
            writer.write_all(&bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn stone_name_zh(service: &TextureService) -> Option<String> {
        let catalog = service.catalog().expect("应有材质源");
        assert_eq!(catalog.blocks.len(), 1, "{catalog:?}");
        catalog.blocks[0].name_zh.clone()
    }

    /// 同一版本重抽补上中文名：状态没变，但目录变了，前端得重取；什么都没变时不推。
    #[tokio::test]
    async fn catalog_change_alone_counts_as_a_change() {
        let tmp = tempfile::tempdir().unwrap();
        let service = TextureService::new(
            tmp.path().join("cache"),
            petalfall_base::http::build_client().unwrap(),
        );
        let jar = tmp.path().join("client.jar");
        write_client_jar(&jar, tmp.path());
        let zh_cn = tmp.path().join("zh_cn.json");
        std::fs::write(&zh_cn, r#"{ "block.minecraft.stone": "石头" }"#).unwrap();
        let client = |zh_cn: Option<PathBuf>| petalfall_core::DownloadedClient {
            version_id: "26.1".into(),
            jar: jar.clone(),
            jar_sha1: "a9993e364706816aba3e25717850c26c9cd0d89d".into(),
            zh_cn,
        };

        service.adopt_download(client(None)).await.unwrap();
        let (first, changed) = reselect(&service, &[]).await;
        assert_eq!(first.source.as_deref(), Some("26.1"));
        assert!(changed, "从没有材质源到有");
        assert_eq!(stone_name_zh(&service), None);

        service.adopt_download(client(Some(zh_cn))).await.unwrap();
        let (second, changed) = reselect(&service, &[]).await;
        assert_eq!(second, first, "同一版本重抽，状态不变");
        assert!(changed, "目录补上了中文名，应算作变化");
        assert_eq!(stone_name_zh(&service).as_deref(), Some("石头"));

        let (third, changed) = reselect(&service, &[]).await;
        assert_eq!(third, first);
        assert!(!changed, "什么都没变就不该推送");
    }

    /// 前端 `ipc/art.ts` 里有一份同样的名单（取 URL 前先校验），两边必须逐项一致。
    #[test]
    fn frontend_whitelist_mirrors_the_backend() {
        let ts = include_str!("../../src/ipc/art.ts");
        let backend: Vec<&str> = petalfall_core::art::whitelist::BLOCK_TEXTURES
            .iter()
            .chain(petalfall_core::art::whitelist::SKIN_TEXTURES.iter())
            .copied()
            .collect();
        for path in &backend {
            assert!(
                ts.contains(&format!("\"{path}\"")),
                "ipc/art.ts 缺少 {path}"
            );
        }
        let quoted = ts.matches("\"block/").count() + ts.matches("\"entity/").count();
        assert_eq!(quoted, backend.len(), "ipc/art.ts 里多出了后端名单外的路径");

        let hosts_line = ts
            .lines()
            .find(|line| line.starts_with("export const THUMB_HOSTS"))
            .expect("ipc/art.ts 应导出 THUMB_HOSTS");
        let frontend_hosts = hosts_line.matches('"').count() / 2;
        assert_eq!(
            frontend_hosts,
            petalfall_core::art::THUMB_HOSTS.len(),
            "{hosts_line}"
        );
        for host in petalfall_core::art::THUMB_HOSTS {
            assert!(
                hosts_line.contains(&format!("\"{host}\"")),
                "THUMB_HOSTS 缺少 {host}"
            );
        }
    }
}
