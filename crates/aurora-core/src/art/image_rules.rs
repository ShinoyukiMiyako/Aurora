//! 原版材质与皮肤的图像校验：方块面只要 16 像素宽的 PNG（动画材质只留首帧），
//! 皮肤只要 64 × 64 或 64 × 32；以及头像要不要叠帽子层的判定。

use std::io::Cursor;

use image::{DynamicImage, ImageFormat, RgbaImage};

/// 方块材质边长（像素）。
const FACE: u32 = 16;

/// 校验并整理一张方块材质，返回可直接下发的 PNG 字节。
///
/// 有同名 `.mcmeta`、或高度是 16 的整数倍且大于 16 时视为动画材质（帧竖排），只保留
/// (0, 0, 16, 16) 的首帧重新编码；静态 16 × 16 原样返回。其余尺寸都不是方块面，报错。
pub fn process_block(bytes: &[u8], has_mcmeta: bool) -> Result<Vec<u8>, String> {
    let image = decode_png(bytes)?;
    let (width, height) = (image.width(), image.height());
    if width != FACE {
        return Err(format!("方块材质宽 {width}，不是 16"));
    }
    let animated = has_mcmeta || (height > FACE && height % FACE == 0);
    if animated {
        if height < FACE {
            return Err(format!("动画材质高 {height}，不足一帧"));
        }
        return encode_png(&image.crop_imm(0, 0, FACE, FACE));
    }
    if height != FACE {
        return Err(format!("方块材质尺寸 {width}x{height}，不是 16x16"));
    }
    Ok(bytes.to_vec())
}

/// 校验皮肤图：必须是 64 × 64 或 64 × 32 的 PNG。返回解码后的 RGBA 图供后续取帽子层。
pub fn validate_skin(bytes: &[u8]) -> Result<RgbaImage, String> {
    let image = decode_png(bytes)?;
    match (image.width(), image.height()) {
        (64, 64) | (64, 32) => Ok(image.to_rgba8()),
        (w, h) => Err(format!("皮肤尺寸 {w}x{h}，只接受 64x64 或 64x32")),
    }
}

/// 头像要不要叠帽子层：取皮肤 (40, 8) 起的 8 × 8 区域，含任何不完全不透明的像素、或颜色不全相同，
/// 就画；全不透明且纯色的帽子层多半是老皮肤留下的实心填充，叠上去只会把整张脸盖成一块色。
pub fn hat_is_meaningful(skin: &RgbaImage) -> bool {
    let first = skin.get_pixel(40, 8).0;
    for y in 8..16 {
        for x in 40..48 {
            let [r, g, b, a] = skin.get_pixel(x, y).0;
            if a < 255 || [r, g, b] != [first[0], first[1], first[2]] {
                return true;
            }
        }
    }
    false
}

fn decode_png(bytes: &[u8]) -> Result<DynamicImage, String> {
    image::load_from_memory_with_format(bytes, ImageFormat::Png)
        .map_err(|e| format!("不是可解码的 PNG：{e}"))
}

fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut out = Cursor::new(Vec::new());
    image
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|e| format!("重新编码 PNG 失败：{e}"))?;
    Ok(out.into_inner())
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use image::Rgba;

    /// 生成一张纯色 PNG（测试夹具）；`paint` 可再逐像素改色。
    pub fn png(width: u32, height: u32, paint: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let image = RgbaImage::from_fn(width, height, |x, y| Rgba(paint(x, y)));
        encode_png(&DynamicImage::ImageRgba8(image)).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::png;
    use super::*;

    const RED: [u8; 4] = [200, 30, 30, 255];

    fn dims(bytes: &[u8]) -> (u32, u32) {
        let image = decode_png(bytes).unwrap();
        (image.width(), image.height())
    }

    #[test]
    fn static_block_is_passed_through_untouched() {
        let bytes = png(16, 16, |_, _| RED);
        assert_eq!(process_block(&bytes, false).unwrap(), bytes);
    }

    #[test]
    fn animated_block_keeps_only_the_first_frame() {
        // 首帧红、第二帧蓝：裁出来必须是 16x16 且全红。
        let strip = png(16, 32, |_, y| if y < 16 { RED } else { [0, 0, 255, 255] });
        for has_mcmeta in [true, false] {
            let frame = process_block(&strip, has_mcmeta).unwrap();
            assert_eq!(dims(&frame), (16, 16));
            let rgba = decode_png(&frame).unwrap().to_rgba8();
            assert!(rgba.pixels().all(|p| p.0 == RED));
        }
        // 有 .mcmeta 的 16x16 也按动画处理，结果仍是 16x16。
        assert_eq!(
            dims(&process_block(&png(16, 16, |_, _| RED), true).unwrap()),
            (16, 16)
        );
    }

    #[test]
    fn wrong_sized_or_non_png_blocks_are_rejected() {
        assert!(process_block(&png(32, 32, |_, _| RED), false).is_err());
        assert!(process_block(&png(16, 24, |_, _| RED), false).is_err());
        assert!(process_block(b"not a png", false).is_err());
    }

    #[test]
    fn skins_must_be_64x64_or_64x32() {
        assert!(validate_skin(&png(64, 64, |_, _| RED)).is_ok());
        assert!(validate_skin(&png(64, 32, |_, _| RED)).is_ok());
        assert!(validate_skin(&png(128, 128, |_, _| RED)).is_err());
        assert!(validate_skin(&png(64, 48, |_, _| RED)).is_err());
    }

    #[test]
    fn hat_layer_rule() {
        // 帽子层全不透明且纯色：不画。
        let solid = validate_skin(&png(64, 64, |_, _| RED)).unwrap();
        assert!(!hat_is_meaningful(&solid));

        // 帽子层里有一个透明像素：画。
        let holed = validate_skin(&png(64, 64, |x, y| {
            if (x, y) == (47, 15) {
                [0, 0, 0, 0]
            } else {
                RED
            }
        }))
        .unwrap();
        assert!(hat_is_meaningful(&holed));

        // 全不透明但颜色不一：画。
        let patterned = validate_skin(&png(
            64,
            64,
            |x, _| {
                if x == 44 { [10, 10, 10, 255] } else { RED }
            },
        ))
        .unwrap();
        assert!(hat_is_meaningful(&patterned));

        // 区域外的透明像素不影响判定（边界：x=39 与 y=16 都在区域外）。
        let outside = validate_skin(&png(64, 64, |x, y| {
            if x == 39 || y == 16 {
                [0, 0, 0, 0]
            } else {
                RED
            }
        }))
        .unwrap();
        assert!(!hat_is_meaningful(&outside));
    }
}
