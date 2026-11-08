//! 卡面玩家图片：把本机一张图片解码、限制、重新编码，存进实例自己的卡面图片目录，并写进实例设置。
//!
//! 原文件不直接引用：路径会失效，格式与尺寸也不受控。启动器按位置重新编码一份，文件名带内容哈希，
//! 换图即换名，协议响应可以按不可变缓存。设置不再引用的旧图在保存设置时一并删掉。

use std::borrow::Cow;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{
    DynamicImage, ExtendedColorType, GenericImageView, ImageDecoder, ImageEncoder, ImageError,
    ImageFormat, ImageReader, Limits, Rgba, RgbaImage,
};
use petalfall_instance::{
    CoverBackground, CoverImageSlot, VersionSettings, VersionSettingsStore, cover_image_dir,
};
use sha1::{Digest, Sha1};

use crate::InstanceError;
use crate::error::Result;
use crate::facade::Petalfall;
use crate::modfs::try_exists;

/// 原文件的大小上限（字节）。超过的不读进内存，按文件大小直接拒。
pub const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;
/// 解码允许的最大边长（像素）。
pub const MAX_DECODE_SIDE: u32 = 8192;
/// 解码输出缓冲的内存上限：够 8192 见方的 8 位 RGBA。16 位深的大图在同样尺寸下会超限，按超限拒，
/// 换来启动器进程的峰值内存有数。
const MAX_DECODE_BYTES: u64 = MAX_DECODE_SIDE as u64 * MAX_DECODE_SIDE as u64 * 4;
/// 背景图的最大长边（像素）：卡面最宽也到不了这么多物理像素，再大只是占盘与解码时间。
pub const BACKGROUND_MAX_SIDE: u32 = 2560;
/// 封面方块的边长，与原版方块材质一致。
pub const BLOCK_SIDE: u32 = 16;
const JPEG_QUALITY: u8 = 90;

/// 设置的读改写与图片目录的清理排队。导入先写图片文件、再把文件名写进设置，中间若有别的保存在清理，
/// 刚写下、还没被引用的图片会被当成旧图删掉；读改写交错还会让后写的盖掉先写的字段。
static SETTINGS_WRITE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 导入卡面图片失败的原因。[`CoverImageError::code`] 是给前端分支用的稳定码。
#[derive(Debug, thiserror::Error)]
pub enum CoverImageError {
    /// 文件打不开或读不完（不存在、没有权限、被占用）。
    #[error("读不了图片：{}", path.display())]
    Unreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// 原文件超过 [`MAX_SOURCE_BYTES`]。`size` 是读到的大小（至少比上限多一个字节）。
    #[error("图片超过 {} MB 的上限（{size} 字节）：{}", limit / (1024 * 1024), path.display())]
    TooLarge {
        path: PathBuf,
        size: u64,
        limit: u64,
    },
    /// 文件头不是 PNG、JPEG、WebP（扩展名不算数）。
    #[error("只支持 PNG、JPEG、WebP 图片：{}", path.display())]
    UnsupportedFormat { path: PathBuf },
    /// 文件头对得上但解不开：内容损坏，或边长、解码内存超出上限。
    #[error("{}", decode_message(path, source))]
    Decode {
        path: PathBuf,
        #[source]
        source: ImageError,
    },
    /// 重新编码失败。
    #[error("卡面图片重新编码失败")]
    Encode(#[source] ImageError),
}

impl CoverImageError {
    /// 稳定的 snake_case 码。
    pub fn code(&self) -> &'static str {
        match self {
            CoverImageError::Unreadable { .. } => "unreadable",
            CoverImageError::TooLarge { .. } => "too_large",
            CoverImageError::UnsupportedFormat { .. } => "unsupported_format",
            CoverImageError::Decode { .. } => "decode_failed",
            CoverImageError::Encode(_) => "encode_failed",
        }
    }
}

fn decode_message(path: &Path, source: &ImageError) -> String {
    let path = path.display();
    match source {
        ImageError::Limits(_) => {
            format!("图片边长超过 {MAX_DECODE_SIDE} 像素，或解码要的内存超出上限：{path}")
        }
        _ => format!("图片解不开，可能已经损坏：{path}"),
    }
}

/// 重新编码好、待写进卡面图片目录的一张图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedCover {
    /// 卡面图片目录下的文件名，见 [`CoverImageSlot::file_name`]。
    pub file_name: String,
    pub bytes: Vec<u8>,
}

/// 读入、解码 `source`，按 `slot` 重新编码。全程同步且吃 CPU，异步调用方应放进 `spawn_blocking`。
pub fn encode_cover_image(
    source: &Path,
    slot: CoverImageSlot,
) -> std::result::Result<EncodedCover, CoverImageError> {
    let bytes = read_source(source)?;
    let image = decode(source, &bytes)?;
    drop(bytes);
    let (bytes, extension) = match slot {
        CoverImageSlot::Background => encode_background(&image)?,
        CoverImageSlot::Block => (encode_block(&image)?, "png"),
    };
    Ok(EncodedCover {
        file_name: content_name(slot, &bytes, extension),
        bytes,
    })
}

fn read_source(path: &Path) -> std::result::Result<Vec<u8>, CoverImageError> {
    let unreadable = |source| CoverImageError::Unreadable {
        path: path.to_owned(),
        source,
    };
    let file = std::fs::File::open(path).map_err(unreadable)?;
    let size = file.metadata().map_err(unreadable)?.len();
    let too_large = |size| CoverImageError::TooLarge {
        path: path.to_owned(),
        size,
        limit: MAX_SOURCE_BYTES,
    };
    if size > MAX_SOURCE_BYTES {
        return Err(too_large(size));
    }
    // 元数据与读取之间文件可能还在被写大：多读一个字节，读到了就按超限拒，不信先前的大小。
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(unreadable)?;
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(too_large(bytes.len() as u64));
    }
    Ok(bytes)
}

fn decode_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DECODE_SIDE);
    limits.max_image_height = Some(MAX_DECODE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits
}

fn decode(path: &Path, bytes: &[u8]) -> std::result::Result<DynamicImage, CoverImageError> {
    let format = image::guess_format(bytes)
        .ok()
        .filter(|format| {
            matches!(
                format,
                ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
            )
        })
        .ok_or_else(|| CoverImageError::UnsupportedFormat {
            path: path.to_owned(),
        })?;
    let failed = |source| CoverImageError::Decode {
        path: path.to_owned(),
        source,
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(decode_limits());
    // 不走 ImageReader::decode：要先取出 EXIF 方向，手机竖拍的照片才不会横着躺在卡面上。into_decoder
    // 只按边长查限制，输出缓冲的内存照 decode 的做法先在上限里扣掉。
    let mut decoder = reader.into_decoder().map_err(failed)?;
    decode_limits()
        .reserve(decoder.total_bytes())
        .map_err(failed)?;
    let orientation = decoder.orientation().map_err(failed)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(failed)?;
    image.apply_orientation(orientation);
    Ok(image)
}

/// 只缩不放：长边超过 [`BACKGROUND_MAX_SIDE`] 时等比缩到正好这么长，短边四舍五入、至少 1。
fn background_size(width: u32, height: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= BACKGROUND_MAX_SIDE {
        return (width, height);
    }
    let scale = |side: u32| {
        let scaled = (u64::from(side) * u64::from(BACKGROUND_MAX_SIDE) + u64::from(long) / 2)
            / u64::from(long);
        (scaled as u32).max(1)
    };
    (scale(width), scale(height))
}

/// 背景：全不透明存 JPEG，带透明存 PNG。返回编码后的字节与扩展名。
///
/// 缩小用预乘透明度的面积平均（[`box_average`]），不用 image 的 Lanczos3：那边假定输入已经预乘，直通透明度的
/// PNG 交过去，全透明像素的颜色（多半是黑）会渗进相邻的不透明像素，边缘发黑；它还要先竖向滤出一张源宽 ×
/// 目标高的 Rgba32F 中间图，8192 宽时 320 MiB，叠上解码缓冲峰值到 600 MiB 左右。面积平均直接逐像素读解码
/// 缓冲，峰值是解码缓冲加上几份输出大小的拷贝（缩放结果、透明度检查与 JPEG 前的转换）。
fn encode_background(
    image: &DynamicImage,
) -> std::result::Result<(Vec<u8>, &'static str), CoverImageError> {
    let (width, height) = background_size(image.width(), image.height());
    let resized = if (width, height) == image.dimensions() {
        Cow::Borrowed(image)
    } else {
        Cow::Owned(DynamicImage::ImageRgba8(box_average(image, width, height)))
    };
    // 带透明通道但每个像素都不透明的（常见于截图另存的 PNG）也存 JPEG。
    let translucent = resized
        .color()
        .has_alpha()
        .then(|| resized.to_rgba8())
        .filter(|rgba| rgba.pixels().any(|pixel| pixel[3] < u8::MAX));
    let mut bytes = Vec::new();
    match translucent {
        Some(rgba) => {
            write_png(&rgba, &mut bytes)?;
            Ok((bytes, "png"))
        }
        None => {
            let rgb = resized.to_rgb8();
            JpegEncoder::new_with_quality(&mut bytes, JPEG_QUALITY)
                .write_image(rgb.as_raw(), width, height, ExtendedColorType::Rgb8)
                .map_err(CoverImageError::Encode)?;
            Ok((bytes, "jpg"))
        }
    }
}

/// 封面方块：居中裁成正方形，按面积平均缩成 [`BLOCK_SIDE`] 见方，存 PNG。
fn encode_block(image: &DynamicImage) -> std::result::Result<Vec<u8>, CoverImageError> {
    let (width, height) = image.dimensions();
    let side = width.min(height);
    let square = image.view((width - side) / 2, (height - side) / 2, side, side);
    let block = box_average(&*square, BLOCK_SIDE, BLOCK_SIDE);
    let mut bytes = Vec::new();
    write_png(&block, &mut bytes)?;
    Ok(bytes)
}

fn write_png(image: &RgbaImage, out: &mut Vec<u8>) -> std::result::Result<(), CoverImageError> {
    PngEncoder::new(out)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(CoverImageError::Encode)
}

/// 一条轴上每个输出格覆盖到的源像素与覆盖长度。坐标放大 `out` 倍后全是整数：源像素 j 占
/// `[j·out, (j+1)·out)`，输出格 i 占 `[i·src, (i+1)·src)`，两段的重叠就是权重，每格权重和恒为 `src`。
fn axis_coverage(src: u32, out: u32) -> Vec<Vec<(u32, u64)>> {
    let (src, out) = (u64::from(src), u64::from(out));
    (0..out)
        .map(|i| {
            let (lo, hi) = (i * src, (i + 1) * src);
            (lo / out..=(hi - 1) / out)
                .map(|j| {
                    let overlap = hi.min((j + 1) * out) - lo.max(j * out);
                    (j as u32, overlap)
                })
                .collect()
        })
        .collect()
}

/// 把 `image` 按面积平均缩放成 `out_width × out_height`：每个输出像素取它覆盖的源区域的加权平均，边上只盖住
/// 一部分的源像素按覆盖面积计权。两条轴各算各的覆盖，宽高比例不同也成立。image 自带的 thumbnail 在比例不整除时
/// 按整像素取边界，不是真正的面积平均。
///
/// 颜色按透明度加权（预乘）再平均，全透明像素的颜色不会把边缘染暗；整格全透明时输出 (0, 0, 0, 0)。
/// 源比输出小时同一套算法就是放大，每个源像素铺满它覆盖的那些格。只逐像素读源图，除输出外只分配两条轴的
/// 覆盖表（与输出边长同量级），不复制源图。
fn box_average<I: GenericImageView<Pixel = Rgba<u8>>>(
    image: &I,
    out_width: u32,
    out_height: u32,
) -> RgbaImage {
    let (src_width, src_height) = image.dimensions();
    let columns = axis_coverage(src_width, out_width);
    let rows = axis_coverage(src_height, out_height);
    // 每格两条轴的权重和分别恒为源宽、源高，乘起来就是每格的总权重。
    let area = u64::from(src_width) * u64::from(src_height);
    RgbaImage::from_fn(out_width, out_height, |ox, oy| {
        let (mut alpha, mut color) = (0u64, [0u64; 3]);
        for &(sy, wy) in &rows[oy as usize] {
            for &(sx, wx) in &columns[ox as usize] {
                let Rgba([r, g, b, a]) = image.get_pixel(sx, sy);
                let weighted = u64::from(a) * wx * wy;
                alpha += weighted;
                for (sum, channel) in color.iter_mut().zip([r, g, b]) {
                    *sum += u64::from(channel) * weighted;
                }
            }
        }
        if alpha == 0 {
            return Rgba([0, 0, 0, 0]);
        }
        let [r, g, b] = color.map(|sum| ((sum + alpha / 2) / alpha) as u8);
        Rgba([r, g, b, ((alpha + area / 2) / area) as u8])
    })
}

/// 内容哈希命名：编码后字节 SHA-1 的前 16 位十六进制。
fn content_name(slot: CoverImageSlot, bytes: &[u8], extension: &str) -> String {
    let hash16: String = Sha1::digest(bytes)[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    slot.file_name(&hash16, extension)
        .expect("16 位小写十六进制配上这个位置自己的扩展名，文件名必定合法")
}

/// 删掉卡面图片目录里设置不再引用的文件。目录不存在说明从没导入过图片，不算错。
///
/// 失败只记 warn：设置已经落盘，留下的旧图只是占点空间，下次保存设置还会再清一次；为了清理失败让
/// 保存报错，玩家会以为设置没存上。
async fn prune_cover_images(version_dir: &Path, settings: &VersionSettings) {
    let dir = cover_image_dir(version_dir);
    let keep = settings.cover_image_files();
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
        Err(err) => {
            tracing::warn!(dir = %dir.display(), error = %err, "读不了卡面图片目录，旧图没有清理");
            return;
        }
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(err) => {
                tracing::warn!(dir = %dir.display(), error = %err, "列卡面图片目录中途失败，余下的旧图没有清理");
                break;
            }
        };
        let name = entry.file_name();
        if name.to_str().is_some_and(|name| keep.contains(&name)) {
            continue;
        }
        let path = entry.path();
        match entry.file_type().await {
            Ok(kind) if kind.is_file() => {}
            Ok(_) => continue,
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "读不出卡面图片目录里一项的类型，没有清理");
                continue;
            }
        }
        if let Err(err) = tokio::fs::remove_file(&path).await {
            tracing::warn!(path = %path.display(), error = %err, "删不掉不再引用的卡面图片");
        }
    }
}

/// 在设置写入排队中保存设置，随后清掉不再引用的卡面图片。`settings` 须已校验过。
pub(crate) async fn save_settings_and_prune(
    version_dir: &Path,
    settings: &VersionSettings,
) -> Result<()> {
    let _write = SETTINGS_WRITE.lock().await;
    VersionSettingsStore::for_version_dir(version_dir)
        .save(settings)
        .await?;
    prune_cover_images(version_dir, settings).await;
    Ok(())
}

impl Petalfall {
    /// 把本机图片 `source` 导入成实例 `id` 的卡面背景或封面方块，返回写下的设置。
    ///
    /// 背景位同时把 `background` 设为图片；方块位只写 `cover_image`，`cover` 留作图片读不到时的兜底。
    /// 被换下的旧图随之删掉。图片的问题报 [`CoverImageError`]（经 [`crate::CoreError::CoverImage`]），
    /// 实例不存在报 [`crate::CoreError::VersionNotInstalled`]；失败时设置不变。
    pub async fn import_cover_image(
        &self,
        id: &str,
        slot: CoverImageSlot,
        source: &Path,
    ) -> Result<VersionSettings> {
        let dir = self.existing_instance_dir(id).await?;
        let owned = source.to_path_buf();
        let encoded =
            tokio::task::spawn_blocking(move || encode_cover_image(&owned, slot)).await??;

        let _write = SETTINGS_WRITE.lock().await;
        let store = VersionSettingsStore::for_version_dir(&dir);
        let mut settings = store.load().await?;
        match slot {
            CoverImageSlot::Background => {
                settings.background = CoverBackground::Image;
                settings.background_image = Some(encoded.file_name.clone());
            }
            CoverImageSlot::Block => settings.cover_image = Some(encoded.file_name.clone()),
        }
        settings
            .validate()
            .map_err(|violation| InstanceError::InvalidSettings {
                field: violation.field,
                reason: violation.reason,
            })?;
        // 文件名就是内容哈希：同名文件内容必然相同，不必再写。协议正读着它时，Windows 上覆盖还会失败。
        let target = cover_image_dir(&dir).join(&encoded.file_name);
        if !try_exists(&target).await? {
            petalfall_base::fs::atomic_write(&target, &encoded.bytes).await?;
        }
        store.save(&settings).await?;
        prune_cover_images(&dir, &settings).await;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CoreError;
    use crate::instances::tests::{petalfall_at, vanilla_json, write_version};
    use image::RgbImage;
    use image::codecs::webp::WebPEncoder;

    fn png(image: &RgbaImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_png(image, &mut bytes).unwrap();
        bytes
    }

    fn rgb_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        PngEncoder::new(&mut bytes)
            .write_image(
                RgbImage::from_pixel(width, height, image::Rgb([90, 140, 200])).as_raw(),
                width,
                height,
                ExtendedColorType::Rgb8,
            )
            .unwrap();
        bytes
    }

    fn jpeg(width: u32, height: u32, exif: Option<Vec<u8>>) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut bytes, 95);
        if let Some(exif) = exif {
            encoder.set_exif_metadata(exif).unwrap();
        }
        encoder
            .write_image(
                RgbImage::from_pixel(width, height, image::Rgb([200, 80, 120])).as_raw(),
                width,
                height,
                ExtendedColorType::Rgb8,
            )
            .unwrap();
        bytes
    }

    /// 无损 WebP：解出来的像素与原图逐个相等，方块平均值可以精确断言。
    fn webp(image: &RgbaImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        WebPEncoder::new_lossless(&mut bytes)
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                ExtendedColorType::Rgba8,
            )
            .unwrap();
        bytes
    }

    fn source(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn decoded(bytes: &[u8]) -> DynamicImage {
        image::load_from_memory(bytes).unwrap()
    }

    fn sha1_prefix(bytes: &[u8]) -> String {
        Sha1::digest(bytes)[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// 只认文件头：扩展名故意写错的 PNG、JPEG、WebP 照样导入；GIF、BMP 与文本即使叫 .png 也拒。
    #[test]
    fn formats_are_recognised_by_header_not_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let opaque = RgbaImage::from_pixel(4, 3, Rgba([10, 20, 30, 255]));
        for (name, bytes) in [
            ("photo.gif", png(&opaque)),
            ("photo.png", jpeg(4, 3, None)),
            ("photo.jpg", webp(&opaque)),
        ] {
            let encoded = encode_cover_image(
                &source(tmp.path(), name, &bytes),
                CoverImageSlot::Background,
            )
            .unwrap();
            assert!(encoded.file_name.ends_with(".jpg"), "{name}");
            assert_eq!(decoded(&encoded.bytes).dimensions(), (4, 3), "{name}");
        }
        for (name, bytes) in [
            ("anim.png", b"GIF89a\x01\x00\x01\x00\x80\x00\x00".to_vec()),
            (
                "bitmap.png",
                b"BM\x3a\x00\x00\x00\x00\x00\x00\x00\x36\x00".to_vec(),
            ),
            ("notes.png", "这不是图片".as_bytes().to_vec()),
            ("empty.png", Vec::new()),
        ] {
            let path = source(tmp.path(), name, &bytes);
            let err = encode_cover_image(&path, CoverImageSlot::Block).unwrap_err();
            assert!(
                matches!(&err, CoverImageError::UnsupportedFormat { path: p } if *p == path),
                "{name}: {err:?}"
            );
            assert_eq!(err.code(), "unsupported_format");
            assert_eq!(
                err.to_string(),
                format!("只支持 PNG、JPEG、WebP 图片：{}", path.display())
            );
        }
    }

    /// 超过 20 MB 按文件大小直接拒，不读内容；正好 20 MB 的放行到格式判断（全零，认不出格式）。
    #[test]
    fn files_over_twenty_megabytes_are_refused_by_size() {
        let tmp = tempfile::tempdir().unwrap();
        let over = tmp.path().join("huge.png");
        std::fs::File::create(&over)
            .unwrap()
            .set_len(MAX_SOURCE_BYTES + 1)
            .unwrap();
        let err = encode_cover_image(&over, CoverImageSlot::Background).unwrap_err();
        match &err {
            CoverImageError::TooLarge { size, limit, .. } => {
                assert_eq!(*size, 20 * 1024 * 1024 + 1);
                assert_eq!(*limit, 20 * 1024 * 1024);
            }
            other => panic!("期望 TooLarge，得到 {other:?}"),
        }
        assert_eq!(err.code(), "too_large");
        assert_eq!(
            err.to_string(),
            format!("图片超过 20 MB 的上限（20971521 字节）：{}", over.display())
        );

        let exact = tmp.path().join("exact.png");
        std::fs::File::create(&exact)
            .unwrap()
            .set_len(MAX_SOURCE_BYTES)
            .unwrap();
        let err = encode_cover_image(&exact, CoverImageSlot::Background).unwrap_err();
        assert_eq!(err.code(), "unsupported_format");
    }

    #[test]
    fn missing_file_is_unreadable() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("gone.png");
        let err = encode_cover_image(&path, CoverImageSlot::Block).unwrap_err();
        assert!(matches!(err, CoverImageError::Unreadable { .. }), "{err:?}");
        assert_eq!(err.code(), "unreadable");
        assert_eq!(err.to_string(), format!("读不了图片：{}", path.display()));
        assert!(
            std::error::Error::source(&err).is_some(),
            "系统给的原因留在原因链里"
        );
    }

    /// 边长 8192 是上限本身，放行；任一边 8193 按解码超限拒。
    #[test]
    fn sides_over_8192_are_refused_while_decoding() {
        let tmp = tempfile::tempdir().unwrap();
        for (width, height) in [(8193, 1), (1, 8193)] {
            let path = source(tmp.path(), "wide.png", &rgb_png(width, height));
            let err = encode_cover_image(&path, CoverImageSlot::Background).unwrap_err();
            assert!(
                matches!(
                    &err,
                    CoverImageError::Decode {
                        source: ImageError::Limits(_),
                        ..
                    }
                ),
                "{width}x{height}: {err:?}"
            );
            assert_eq!(err.code(), "decode_failed");
            assert_eq!(
                err.to_string(),
                format!(
                    "图片边长超过 8192 像素，或解码要的内存超出上限：{}",
                    path.display()
                )
            );
        }
        let path = source(tmp.path(), "edge.png", &rgb_png(8192, 1));
        let encoded = encode_cover_image(&path, CoverImageSlot::Background).unwrap();
        assert_eq!(
            decoded(&encoded.bytes).dimensions(),
            (2560, 1),
            "短边缩到不足 1 时留 1"
        );
    }

    /// PNG 的一个块：长度、类型、数据，再加类型与数据的 CRC-32。
    fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let mut crc = flate2::Crc::new();
        crc.update(kind);
        crc.update(data);
        out.extend_from_slice(&crc.sum().to_be_bytes());
    }

    /// 边长 8192 不超限，但 16 位深的 RGBA 解码要 8192 × 8192 × 8 = 512 MiB，超过 256 MiB 的解码内存上限，
    /// 在分配输出缓冲之前按内存超限拒。文件只有文件头和一小段图像数据：内存检查放过的话，会先分配 512 MiB
    /// 再去解，报的是内容损坏。
    #[test]
    fn deep_images_over_the_memory_budget_are_refused_before_decoding() {
        use std::io::Write;
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&8192u32.to_be_bytes());
        ihdr.extend_from_slice(&8192u32.to_be_bytes());
        // 位深 16、颜色类型 6（RGBA），压缩、滤波、隔行取 0
        ihdr.extend_from_slice(&[16, 6, 0, 0, 0]);
        let mut idat = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        idat.write_all(&[0; 64]).unwrap();
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        png_chunk(&mut bytes, b"IHDR", &ihdr);
        png_chunk(&mut bytes, b"IDAT", &idat.finish().unwrap());
        png_chunk(&mut bytes, b"IEND", &[]);

        let tmp = tempfile::tempdir().unwrap();
        let path = source(tmp.path(), "deep.png", &bytes);
        let err = encode_cover_image(&path, CoverImageSlot::Background).unwrap_err();
        match &err {
            CoverImageError::Decode {
                source: ImageError::Limits(limit),
                ..
            } => assert_eq!(
                limit.kind(),
                image::error::LimitErrorKind::InsufficientMemory
            ),
            other => panic!("期望解码内存超限，得到 {other:?}"),
        }
        assert_eq!(err.code(), "decode_failed");
        assert_eq!(
            err.to_string(),
            format!(
                "图片边长超过 8192 像素，或解码要的内存超出上限：{}",
                path.display()
            )
        );
    }

    #[test]
    fn corrupt_body_behind_a_valid_header_fails_to_decode() {
        let tmp = tempfile::tempdir().unwrap();
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&[0x42; 64]);
        let path = source(tmp.path(), "broken.png", &bytes);
        let err = encode_cover_image(&path, CoverImageSlot::Block).unwrap_err();
        assert!(
            matches!(&err, CoverImageError::Decode { source, .. } if !matches!(source, ImageError::Limits(_))),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            format!("图片解不开，可能已经损坏：{}", path.display())
        );
    }

    #[test]
    fn background_shrinks_the_long_side_to_2560_and_never_enlarges() {
        assert_eq!(background_size(2560, 10), (2560, 10));
        assert_eq!(background_size(100, 80), (100, 80));
        assert_eq!(background_size(2561, 10), (2560, 10));
        // 100 × 2560 / 2600 = 98.46
        assert_eq!(background_size(2600, 100), (2560, 98));
        // 101 × 2560 / 2600 = 99.45
        assert_eq!(background_size(2600, 101), (2560, 99));
        assert_eq!(background_size(100, 2601), (98, 2560));
        assert_eq!(background_size(8192, 8192), (2560, 2560));
        assert_eq!(background_size(8192, 1), (2560, 1));

        let tmp = tempfile::tempdir().unwrap();
        for ((width, height), expected) in [
            ((2600, 100), (2560, 98)),
            ((100, 2601), (98, 2560)),
            ((2560, 10), (2560, 10)),
        ] {
            let path = source(tmp.path(), "bg.png", &rgb_png(width, height));
            let encoded = encode_cover_image(&path, CoverImageSlot::Background).unwrap();
            assert_eq!(decoded(&encoded.bytes).dimensions(), expected);
        }
    }

    /// 全不透明（包括带透明通道但每个像素都是 255 的）存 JPEG 质量 90；有一个像素不是 255 就存 PNG，
    /// 透明度原样保留。
    #[test]
    fn opaque_backgrounds_become_jpeg_and_translucent_ones_png() {
        let tmp = tempfile::tempdir().unwrap();
        let mut rgba = RgbaImage::from_pixel(6, 4, Rgba([30, 60, 90, 255]));
        let path = source(tmp.path(), "opaque.png", &png(&rgba));
        let encoded = encode_cover_image(&path, CoverImageSlot::Background).unwrap();
        assert!(encoded.file_name.ends_with(".jpg"));
        assert!(encoded.bytes.starts_with(&[0xff, 0xd8, 0xff]));
        let mut expected = Vec::new();
        JpegEncoder::new_with_quality(&mut expected, 90)
            .write_image(
                DynamicImage::ImageRgba8(rgba.clone()).to_rgb8().as_raw(),
                6,
                4,
                ExtendedColorType::Rgb8,
            )
            .unwrap();
        assert_eq!(encoded.bytes, expected, "质量 90 的 JPEG");

        rgba.put_pixel(5, 3, Rgba([30, 60, 90, 254]));
        let path = source(tmp.path(), "almost.png", &png(&rgba));
        let encoded = encode_cover_image(&path, CoverImageSlot::Background).unwrap();
        assert!(encoded.file_name.ends_with(".png"));
        let back = decoded(&encoded.bytes).to_rgba8();
        assert_eq!(back.get_pixel(5, 3), &Rgba([30, 60, 90, 254]));
        assert_eq!(back.get_pixel(0, 0), &Rgba([30, 60, 90, 255]));
    }

    /// 带透明的大图缩小：全透明的黑与不透明的白每 3 列相间，2601 → 2560 不整除，许多输出格横跨两种像素。
    /// 颜色按透明度加权，半透明的格仍是纯白；直通透明度交给假定已预乘的滤波（Lanczos3）会被拉暗成灰。
    #[test]
    fn shrinking_a_translucent_background_does_not_darken_its_edges() {
        let white = Rgba([255, 255, 255, 255]);
        let clear = Rgba([0, 0, 0, 0]);
        let image = RgbaImage::from_fn(
            2601,
            40,
            |x, _| if (x / 3) % 2 == 0 { clear } else { white },
        );
        let tmp = tempfile::tempdir().unwrap();
        let path = source(tmp.path(), "stripes.png", &png(&image));
        let encoded = encode_cover_image(&path, CoverImageSlot::Background).unwrap();
        assert!(encoded.file_name.ends_with(".png"));
        let back = decoded(&encoded.bytes).to_rgba8();
        assert_eq!(back.dimensions(), (2560, 39));
        let mixed = back
            .pixels()
            .filter(|pixel| (1..255).contains(&pixel[3]))
            .count();
        assert!(mixed > 1000, "横跨两种像素的格应当很多，实际 {mixed}");
        for (x, y, pixel) in back.enumerate_pixels() {
            if pixel[3] > 0 {
                assert_eq!(pixel.0[..3], [255, 255, 255], "({x}, {y}) {pixel:?}");
            }
        }
    }

    /// EXIF 方向 6（顺时针转 90 度）的 40 × 20 照片按 20 × 40 存。
    #[test]
    fn exif_orientation_is_applied_before_encoding() {
        // TIFF 头（大端）+ 一个 IFD 条目：标签 0x0112（Orientation）、类型 SHORT、数量 1、值 6。
        let exif = vec![
            b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0,
            0,
        ];
        let tmp = tempfile::tempdir().unwrap();
        let path = source(tmp.path(), "phone.jpg", &jpeg(40, 20, Some(exif)));
        let encoded = encode_cover_image(&path, CoverImageSlot::Background).unwrap();
        assert_eq!(decoded(&encoded.bytes).dimensions(), (20, 40));

        let path = source(tmp.path(), "plain.jpg", &jpeg(40, 20, None));
        let encoded = encode_cover_image(&path, CoverImageSlot::Background).unwrap();
        assert_eq!(decoded(&encoded.bytes).dimensions(), (40, 20));
    }

    /// 32 → 16 正好整除：每格是 2 × 2 的平均。颜色按透明度加权，两红两全透明得到半透明的纯红，
    /// 不是直接平均出来的暗红 (128, 0, 0)。
    #[test]
    fn block_average_divides_evenly_with_premultiplied_alpha() {
        let mut image = RgbaImage::from_pixel(32, 32, Rgba([10, 20, 30, 255]));
        image.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        image.put_pixel(1, 0, Rgba([255, 0, 0, 255]));
        image.put_pixel(0, 1, Rgba([0, 0, 0, 0]));
        image.put_pixel(1, 1, Rgba([0, 0, 0, 0]));
        image.put_pixel(2, 0, Rgba([100, 0, 0, 255]));
        image.put_pixel(3, 0, Rgba([200, 0, 0, 255]));
        image.put_pixel(2, 1, Rgba([0, 100, 0, 255]));
        image.put_pixel(3, 1, Rgba([0, 0, 100, 255]));
        for x in 30..32 {
            for y in 30..32 {
                image.put_pixel(x, y, Rgba([0, 0, 0, 0]));
            }
        }
        let block = box_average(&image, 16, 16);
        assert_eq!(block.dimensions(), (16, 16));
        assert_eq!(block.get_pixel(0, 0), &Rgba([255, 0, 0, 128]));
        assert_eq!(block.get_pixel(1, 0), &Rgba([75, 25, 25, 255]));
        assert_eq!(block.get_pixel(15, 15), &Rgba([0, 0, 0, 0]), "整格全透明");
        assert_eq!(block.get_pixel(7, 9), &Rgba([10, 20, 30, 255]));
    }

    /// 24 → 16 不整除：每格在每条轴上盖住一个整像素加半个像素，按面积 1 : 0.5 计权。
    /// 整像素取边界的平均（image 的 thumbnail）会把左上格算成 (200 + 100 + 100 + 0) / 4 = 100。
    #[test]
    fn block_average_weights_partially_covered_pixels_by_area() {
        let mut image = RgbaImage::from_pixel(24, 24, Rgba([0, 0, 0, 255]));
        image.put_pixel(0, 0, Rgba([200, 0, 0, 255]));
        image.put_pixel(1, 0, Rgba([100, 0, 0, 255]));
        image.put_pixel(0, 1, Rgba([100, 0, 0, 255]));
        image.put_pixel(2, 0, Rgba([160, 0, 0, 255]));
        let block = box_average(&image, 16, 16);
        // (200 × 1 + 100 × 0.5 + 100 × 0.5 + 0 × 0.25) / 2.25 = 133.3
        assert_eq!(block.get_pixel(0, 0), &Rgba([133, 0, 0, 255]));
        // 横向盖住 x1 的一半与整个 x2：(100 × 0.5 + 160 × 1) × 1 / 2.25 = 93.3（y1 那行都是 0）
        assert_eq!(block.get_pixel(1, 0), &Rgba([93, 0, 0, 255]));
        assert_eq!(block.get_pixel(2, 0), &Rgba([0, 0, 0, 255]));

        assert_eq!(
            axis_coverage(24, 16)[..2],
            [vec![(0, 16), (1, 8)], vec![(1, 8), (2, 16)]]
        );
        for (src, out) in [(24, 16), (7, 16), (8192, 16), (1, 16), (17, 16)] {
            for cells in axis_coverage(src, out) {
                let total: u64 = cells.iter().map(|&(_, weight)| weight).sum();
                assert_eq!(total, u64::from(src), "{src} → {out} 每格权重和为 {src}");
            }
        }
    }

    /// 源比 16 小时每个源像素铺满它覆盖的格：8 × 8 每像素占 2 × 2，1 × 1 铺满整面。
    #[test]
    fn block_average_enlarges_small_sources() {
        let image = RgbaImage::from_fn(8, 8, |x, y| Rgba([x as u8 * 30, y as u8 * 30, 7, 255]));
        let block = box_average(&image, 16, 16);
        for (x, y) in [(0, 0), (1, 1), (2, 3), (15, 14)] {
            assert_eq!(
                block.get_pixel(x, y),
                &Rgba([(x / 2) as u8 * 30, (y / 2) as u8 * 30, 7, 255])
            );
        }
        let single = box_average(&RgbaImage::from_pixel(1, 1, Rgba([1, 2, 3, 4])), 16, 16);
        assert!(single.pixels().all(|pixel| *pixel == Rgba([1, 2, 3, 4])));
    }

    /// 两条轴各算各的覆盖：3 × 2 缩成 2 × 1，横向每格盖住一个整像素加半个，竖向两行各占一半。
    #[test]
    fn area_average_handles_unequal_axes() {
        // 第一行 30 60 90，第二行 90 120 150
        let image = RgbaImage::from_fn(3, 2, |x, y| {
            Rgba([30 + 30 * x as u8 + 60 * y as u8, 0, 0, 255])
        });
        let out = box_average(&image, 2, 1);
        assert_eq!(out.dimensions(), (2, 1));
        // (30 × 1 + 60 × 0.5 + 90 × 1 + 120 × 0.5) / 3 = 70
        assert_eq!(out.get_pixel(0, 0), &Rgba([70, 0, 0, 255]));
        // (60 × 0.5 + 90 × 1 + 120 × 0.5 + 150 × 1) / 3 = 110
        assert_eq!(out.get_pixel(1, 0), &Rgba([110, 0, 0, 255]));
    }

    /// 方块居中裁成正方形：50 × 32 只取中间第 9 到 40 列，两边各 9 列（与另一个方向的 9 行）一点都不混进来。
    #[test]
    fn block_crops_the_centred_square() {
        let tmp = tempfile::tempdir().unwrap();
        let red = Rgba([255, 0, 0, 255]);
        let blue = Rgba([0, 0, 255, 255]);
        let wide = RgbaImage::from_fn(50, 32, |x, _| if (9..41).contains(&x) { red } else { blue });
        let tall = RgbaImage::from_fn(32, 50, |_, y| if (9..41).contains(&y) { red } else { blue });
        for (name, image) in [("wide.png", wide), ("tall.png", tall)] {
            let path = source(tmp.path(), name, &png(&image));
            let encoded = encode_cover_image(&path, CoverImageSlot::Block).unwrap();
            assert!(encoded.file_name.starts_with("block-") && encoded.file_name.ends_with(".png"));
            let block = decoded(&encoded.bytes).to_rgba8();
            assert_eq!(block.dimensions(), (16, 16));
            assert!(block.pixels().all(|pixel| *pixel == red), "{name}");
        }
    }

    /// 端到端：无损 WebP 经方块位解码、平均、存成 16 × 16 PNG，读回来是逐像素的面积平均。
    #[test]
    fn block_from_webp_is_a_16_pixel_png_of_area_averages() {
        let tmp = tempfile::tempdir().unwrap();
        let mut image = RgbaImage::from_pixel(24, 24, Rgba([0, 0, 0, 255]));
        image.put_pixel(0, 0, Rgba([200, 0, 0, 255]));
        image.put_pixel(1, 0, Rgba([100, 0, 0, 255]));
        image.put_pixel(0, 1, Rgba([100, 0, 0, 255]));
        let path = source(tmp.path(), "face.webp", &webp(&image));
        let encoded = encode_cover_image(&path, CoverImageSlot::Block).unwrap();
        assert!(encoded.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        let block = decoded(&encoded.bytes).to_rgba8();
        assert_eq!(block.dimensions(), (16, 16));
        assert_eq!(block.get_pixel(0, 0), &Rgba([133, 0, 0, 255]));
        assert_eq!(block.get_pixel(5, 5), &Rgba([0, 0, 0, 255]));
    }

    /// 文件名是编码后字节 SHA-1 的前 16 位：同一张图两次导入同名，内容不同就换名。
    #[test]
    fn file_names_carry_the_content_hash() {
        // SHA-1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
        assert_eq!(
            content_name(CoverImageSlot::Background, b"abc", "jpg"),
            "background-a9993e364706816a.jpg"
        );
        assert_eq!(
            content_name(CoverImageSlot::Block, b"abc", "png"),
            "block-a9993e364706816a.png"
        );

        let tmp = tempfile::tempdir().unwrap();
        let first = source(
            tmp.path(),
            "a.png",
            &png(&RgbaImage::from_pixel(3, 3, Rgba([1, 2, 3, 255]))),
        );
        let second = source(
            tmp.path(),
            "b.png",
            &png(&RgbaImage::from_pixel(3, 3, Rgba([1, 2, 4, 255]))),
        );
        let a = encode_cover_image(&first, CoverImageSlot::Block).unwrap();
        assert_eq!(a.file_name, format!("block-{}.png", sha1_prefix(&a.bytes)));
        assert_eq!(
            encode_cover_image(&first, CoverImageSlot::Block).unwrap(),
            a
        );
        let b = encode_cover_image(&second, CoverImageSlot::Block).unwrap();
        assert_ne!(a.file_name, b.file_name);
    }

    fn cover_files(version_dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = match std::fs::read_dir(cover_image_dir(version_dir)) {
            Ok(entries) => entries
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => panic!("{err}"),
        };
        names.sort();
        names
    }

    /// 导入背景：文件写进卡面图片目录，设置里背景切到图片并记下文件名，其余字段不动；方块位只写 cover_image。
    #[tokio::test]
    async fn import_writes_the_file_and_the_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(petalfall.game_dir(), "1.21.1", &vanilla_json("1.21.1"));
        let before = VersionSettings {
            description: Some("周末一起玩".into()),
            cover: Some("cherry_planks".into()),
            background: CoverBackground::Texture,
            memory_mb: Some(4096),
            ..VersionSettings::default()
        };
        petalfall
            .set_instance_settings("1.21.1", &before)
            .await
            .unwrap();
        let photo = source(tmp.path(), "photo.png", &rgb_png(30, 20));
        let face = source(tmp.path(), "face.png", &rgb_png(20, 20));

        let settings = petalfall
            .import_cover_image("1.21.1", CoverImageSlot::Background, &photo)
            .await
            .unwrap();
        let background = encode_cover_image(&photo, CoverImageSlot::Background).unwrap();
        assert_eq!(
            settings,
            VersionSettings {
                background: CoverBackground::Image,
                background_image: Some(background.file_name.clone()),
                ..before.clone()
            }
        );
        assert_eq!(
            petalfall.instance_settings("1.21.1").await.unwrap(),
            settings
        );
        assert_eq!(
            std::fs::read(cover_image_dir(&dir).join(&background.file_name)).unwrap(),
            background.bytes
        );

        let settings = petalfall
            .import_cover_image("1.21.1", CoverImageSlot::Block, &face)
            .await
            .unwrap();
        let block = encode_cover_image(&face, CoverImageSlot::Block).unwrap();
        assert_eq!(
            settings.cover_image.as_deref(),
            Some(block.file_name.as_str())
        );
        assert_eq!(
            settings.cover.as_deref(),
            Some("cherry_planks"),
            "方块 id 留作兜底"
        );
        assert_eq!(settings.background, CoverBackground::Image);
        let mut expected = vec![background.file_name.clone(), block.file_name.clone()];
        expected.sort();
        assert_eq!(cover_files(&dir), expected, "两个位置各自的图都留着");
    }

    /// 换图：旧图随之删掉，另一个位置的图不受影响；导入失败时设置与目录都不变。
    #[tokio::test]
    async fn replacing_an_image_deletes_the_old_file() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(petalfall.game_dir(), "1.21.1", &vanilla_json("1.21.1"));
        let first = source(tmp.path(), "first.png", &rgb_png(30, 20));
        let second = source(tmp.path(), "second.png", &rgb_png(31, 20));
        let face = source(tmp.path(), "face.png", &rgb_png(16, 16));

        petalfall
            .import_cover_image("1.21.1", CoverImageSlot::Block, &face)
            .await
            .unwrap();
        let old = petalfall
            .import_cover_image("1.21.1", CoverImageSlot::Background, &first)
            .await
            .unwrap();
        let new = petalfall
            .import_cover_image("1.21.1", CoverImageSlot::Background, &second)
            .await
            .unwrap();
        let old_name = old.background_image.unwrap();
        let new_name = new.background_image.clone().unwrap();
        assert_ne!(old_name, new_name);
        let mut expected = vec![new_name, new.cover_image.clone().unwrap()];
        expected.sort();
        assert_eq!(cover_files(&dir), expected);

        let text = source(tmp.path(), "notes.png", "不是图片".as_bytes());
        let err = petalfall
            .import_cover_image("1.21.1", CoverImageSlot::Background, &text)
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                CoreError::CoverImage(CoverImageError::UnsupportedFormat { .. })
            ),
            "{err:?}"
        );
        assert_eq!(petalfall.instance_settings("1.21.1").await.unwrap(), new);
        assert_eq!(cover_files(&dir), expected);
    }

    /// 经整份写设置清除图片：不再引用的图片与目录里的杂物（没写完的临时文件）一起删掉，子目录不碰；
    /// 背景换成别的样式但 background_image 还在时图片保留。
    #[tokio::test]
    async fn saving_settings_prunes_unreferenced_images() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let dir = write_version(petalfall.game_dir(), "1.21.1", &vanilla_json("1.21.1"));

        // 目录还没有时保存不报错，也不建出目录。
        petalfall
            .set_instance_settings("1.21.1", &VersionSettings::default())
            .await
            .unwrap();
        assert!(!cover_image_dir(&dir).exists());

        let photo = source(tmp.path(), "photo.png", &rgb_png(30, 20));
        let face = source(tmp.path(), "face.png", &rgb_png(16, 16));
        petalfall
            .import_cover_image("1.21.1", CoverImageSlot::Block, &face)
            .await
            .unwrap();
        let imported = petalfall
            .import_cover_image("1.21.1", CoverImageSlot::Background, &photo)
            .await
            .unwrap();
        let covers = cover_image_dir(&dir);
        std::fs::write(covers.join(".background-0123.tmp"), b"half").unwrap();
        std::fs::create_dir(covers.join("keep-me")).unwrap();

        let kept = VersionSettings {
            cover_image: None,
            background: CoverBackground::Texture,
            ..imported.clone()
        };
        petalfall
            .set_instance_settings("1.21.1", &kept)
            .await
            .unwrap();
        let background = imported.background_image.clone().unwrap();
        assert_eq!(
            cover_files(&dir),
            [background.clone(), "keep-me".to_owned()]
        );

        let cleared = VersionSettings {
            background_image: None,
            background: CoverBackground::Art,
            ..kept
        };
        petalfall
            .set_instance_settings("1.21.1", &cleared)
            .await
            .unwrap();
        assert_eq!(cover_files(&dir), ["keep-me"]);
        assert_eq!(
            petalfall.instance_settings("1.21.1").await.unwrap(),
            cleared
        );
    }

    #[tokio::test]
    async fn import_into_a_missing_instance_reports_not_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall_at(tmp.path());
        let photo = source(tmp.path(), "photo.png", &rgb_png(4, 4));
        let err = petalfall
            .import_cover_image("不存在", CoverImageSlot::Background, &photo)
            .await
            .unwrap_err();
        assert!(
            matches!(err, CoreError::VersionNotInstalled { ref id } if id == "不存在"),
            "{err:?}"
        );
    }

    #[test]
    fn error_codes_are_stable() {
        let path = PathBuf::from("p.png");
        let decode = || ImageError::IoError(std::io::Error::other("x"));
        for (err, code) in [
            (
                CoverImageError::Unreadable {
                    path: path.clone(),
                    source: std::io::Error::other("x"),
                },
                "unreadable",
            ),
            (
                CoverImageError::TooLarge {
                    path: path.clone(),
                    size: 1,
                    limit: 1,
                },
                "too_large",
            ),
            (
                CoverImageError::UnsupportedFormat { path: path.clone() },
                "unsupported_format",
            ),
            (
                CoverImageError::Decode {
                    path: path.clone(),
                    source: decode(),
                },
                "decode_failed",
            ),
            (CoverImageError::Encode(decode()), "encode_failed"),
        ] {
            assert_eq!(err.code(), code);
        }
        assert_eq!(
            CoverImageError::Encode(decode()).to_string(),
            "卡面图片重新编码失败"
        );
    }
}
