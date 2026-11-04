//! 实例设置持久化（介绍 / 封面 / 隔离覆盖 / 内存 / Java / JVM 参数 / 窗口）。
//!
//! 每个实例一份，落在 `versions/<id>/.petalfall/settings.json`，随实例目录走（改名、复制目录都不丢）。
//! 缺文件表示「未自定义」，返回默认值；文件存在但损坏则冒泡为错误（不静默重置，以免悄悄丢失用户的
//! 介绍与启动设置）。读取时容忍未知字段，旧版本写下的字段不会让文件读不出来；卡面几项读入时另做规范化，
//! 新版本加的背景取值、手改出来的图片文件名只让那一项落回默认（见 [`VersionSettingsStore::load`]）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::PETALFALL_META_DIR;
use crate::error::{Error, Result};
use crate::isolation::IsolationOverride;

const SETTINGS_FILE: &str = "settings.json";

/// 实例单独设置内存时允许的最小值与步长（MB），与界面滑杆一致。
pub const MEMORY_MIN_MB: u32 = 1024;
pub const MEMORY_STEP_MB: u32 = 512;
/// 窗口宽高的允许范围（像素）。
pub const RESOLUTION_WIDTH: (u32, u32) = (320, 7680);
pub const RESOLUTION_HEIGHT: (u32, u32) = (240, 4320);
/// 封面方块 id 的最大长度。
const COVER_MAX_LEN: usize = 64;
/// 卡面图片在实例元数据目录下的子目录：`versions/<id>/.petalfall/cover/`。
pub const COVER_IMAGE_DIR: &str = "cover";

/// 卡面背景。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverBackground {
    /// 跟随外观设置里的全局默认。
    #[default]
    Follow,
    /// 色相渐变加像素花瓣。
    Art,
    /// 封面方块的材质平铺。
    Texture,
    /// 玩家自己的图片（见 [`VersionSettings::background_image`]）。
    Image,
}

/// 卡面上用玩家图片的两个位置。图片由启动器重新编码后存进 [`COVER_IMAGE_DIR`]，文件名带内容哈希：
/// 换图即换名，协议响应可以按不可变缓存。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverImageSlot {
    /// 卡面背景：不透明的存 JPEG，带透明的存 PNG。
    Background,
    /// 封面方块的面：16 × 16 的 PNG。
    Block,
}

impl CoverImageSlot {
    fn prefix(self) -> &'static str {
        match self {
            CoverImageSlot::Background => "background-",
            CoverImageSlot::Block => "block-",
        }
    }

    fn extensions(self) -> &'static [&'static str] {
        match self {
            CoverImageSlot::Background => &[".png", ".jpg"],
            CoverImageSlot::Block => &[".png"],
        }
    }

    /// 由内容哈希的前 16 位十六进制与扩展名（不带点）拼出文件名；扩展名不属于这个位置时报错。
    pub fn file_name(self, hash16: &str, extension: &str) -> std::result::Result<String, String> {
        let name = format!("{}{hash16}.{extension}", self.prefix());
        if self.accepts(&name) {
            Ok(name)
        } else {
            Err(format!("{name} 不是合法的卡面图片文件名"))
        }
    }

    /// 文件名是否形如 `<前缀><16 位小写十六进制>.<扩展名>`：既是格式校验，也挡住路径穿越。
    pub fn accepts(self, name: &str) -> bool {
        let Some(rest) = name.strip_prefix(self.prefix()) else {
            return false;
        };
        self.extensions().iter().any(|ext| {
            rest.strip_suffix(ext).is_some_and(|hash| {
                hash.len() == 16 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            })
        })
    }
}

/// 一个实例的用户设置。新建实例的默认值：内存跟随全局、Java 自动、隔离跟随、1280×720、不全屏。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct VersionSettings {
    /// 实例介绍；`None` 为没有介绍。
    pub description: Option<String>,
    /// 封面方块 id（如 `cherry_planks`，可以是本机材质源里的任意方块）；`None` 时由界面按默认封面规则推导。
    pub cover: Option<String>,
    /// 封面方块用的玩家图片（[`COVER_IMAGE_DIR`] 下的文件名）；有值时方块画这张图，`cover` 只在图片读不到时兜底。
    pub cover_image: Option<String>,
    /// 卡面背景。
    pub background: CoverBackground,
    /// 卡面背景用的玩家图片（[`COVER_IMAGE_DIR`] 下的文件名）。背景换成别的样式时仍保留，换回来不用重选。
    pub background_image: Option<String>,
    /// 版本级隔离覆盖（默认跟随全局）。
    pub isolation: IsolationOverride,
    /// 最大内存（MB）；`None` 跟随全局设置。
    pub memory_mb: Option<u32>,
    /// 使用的 Java。
    pub java: JavaSelection,
    /// 追加在默认参数之后的 JVM 参数，原样保存。启动时按空白切分，双引号括起来的部分不切开、引号不传给
    /// JVM（规则见 `petalfall_launch::split_args`）。
    pub jvm_args: String,
    /// 窗口分辨率。
    pub resolution: Resolution,
    /// 是否全屏启动（开启时忽略分辨率）。
    pub fullscreen: bool,
}

/// 窗口分辨率。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

impl Default for Resolution {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
        }
    }
}

/// 实例用哪个 Java：按版本自动挑选，或指定一个 java 可执行文件。序列化为 `"auto"` 或路径字符串。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum JavaSelection {
    #[default]
    Auto,
    Path(PathBuf),
}

const JAVA_AUTO: &str = "auto";

impl Serialize for JavaSelection {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            JavaSelection::Auto => serializer.serialize_str(JAVA_AUTO),
            JavaSelection::Path(path) => serializer.serialize_str(&path.to_string_lossy()),
        }
    }
}

impl<'de> Deserialize<'de> for JavaSelection {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(if raw == JAVA_AUTO {
            JavaSelection::Auto
        } else {
            JavaSelection::Path(PathBuf::from(raw))
        })
    }
}

/// 设置里不合法的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsViolation {
    /// 字段名（与序列化名一致）。
    pub field: &'static str,
    pub reason: String,
}

impl VersionSettings {
    /// 校验整份设置。写入前调用：非法值报错，不偷偷换成默认值。
    pub fn validate(&self) -> std::result::Result<(), SettingsViolation> {
        let violation =
            |field: &'static str, reason: String| Err(SettingsViolation { field, reason });
        if let Some(description) = &self.description
            && description.trim().is_empty()
        {
            return violation("description", "没有介绍时应为 null，而不是空字符串".into());
        }
        if let Some(cover) = &self.cover {
            let well_formed = !cover.is_empty()
                && cover.len() <= COVER_MAX_LEN
                && cover
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
            if !well_formed {
                return violation(
                    "cover",
                    format!(
                        "封面方块 id 只能由小写字母、数字与下划线组成（1 到 {COVER_MAX_LEN} 个）：{cover:?}"
                    ),
                );
            }
        }
        if let Some(name) = &self.cover_image
            && !CoverImageSlot::Block.accepts(name)
        {
            return violation(
                "cover_image",
                format!("封面方块图片应形如 block-<16 位十六进制>.png：{name:?}"),
            );
        }
        if let Some(name) = &self.background_image
            && !CoverImageSlot::Background.accepts(name)
        {
            return violation(
                "background_image",
                format!("卡面背景图片应形如 background-<16 位十六进制>.png 或 .jpg：{name:?}"),
            );
        }
        if self.background == CoverBackground::Image && self.background_image.is_none() {
            return violation(
                "background",
                "背景设为图片时 background_image 不能为空".into(),
            );
        }
        if let Some(memory) = self.memory_mb
            && (memory < MEMORY_MIN_MB || memory % MEMORY_STEP_MB != 0)
        {
            return violation(
                "memory_mb",
                format!(
                    "内存至少 {MEMORY_MIN_MB} MB 且为 {MEMORY_STEP_MB} 的整数倍，收到 {memory}"
                ),
            );
        }
        if let JavaSelection::Path(path) = &self.java
            && !path.is_absolute()
        {
            return violation(
                "java",
                format!(
                    "Java 应为 \"auto\" 或 java 可执行文件的绝对路径，收到 {}",
                    path.display()
                ),
            );
        }
        let Resolution { width, height } = self.resolution;
        if !(RESOLUTION_WIDTH.0..=RESOLUTION_WIDTH.1).contains(&width)
            || !(RESOLUTION_HEIGHT.0..=RESOLUTION_HEIGHT.1).contains(&height)
        {
            return violation(
                "resolution",
                format!(
                    "宽应在 {}-{}、高应在 {}-{} 之间，收到 {width}×{height}",
                    RESOLUTION_WIDTH.0,
                    RESOLUTION_WIDTH.1,
                    RESOLUTION_HEIGHT.0,
                    RESOLUTION_HEIGHT.1
                ),
            );
        }
        Ok(())
    }

    /// 设置引用着的卡面图片文件名；[`COVER_IMAGE_DIR`] 里不在其中的文件都可以删。
    pub fn cover_image_files(&self) -> Vec<&str> {
        self.cover_image
            .iter()
            .chain(self.background_image.iter())
            .map(String::as_str)
            .collect()
    }

    /// 读入后把用不了的卡面图片设置落回默认，各记一条 warn；写入侧的 [`Self::validate`] 仍然严格。
    ///
    /// 文件名不符合位置格式的（手改或拷来的 settings.json 写成绝对路径、UNC、`..`、大写哈希）当作没有：
    /// 列实例时文件名会拼进卡面图片目录去探测，再登记给协议读。背景是图片却没有图片的按跟随读：界面保存是
    /// 读改写整份设置，留着它每次保存都会被 validate 拒。
    fn settle_cover_images(&mut self, path: &Path) {
        for (field, slot, name) in [
            ("cover_image", CoverImageSlot::Block, &mut self.cover_image),
            (
                "background_image",
                CoverImageSlot::Background,
                &mut self.background_image,
            ),
        ] {
            if let Some(value) = name.as_deref()
                && !slot.accepts(value)
            {
                tracing::warn!(path = %path.display(), field, value = ?value, "实例设置里的卡面图片文件名不合规，当作没有");
                *name = None;
            }
        }
        if self.background == CoverBackground::Image && self.background_image.is_none() {
            tracing::warn!(path = %path.display(), "实例设置的卡面背景是图片却没有图片，按跟随读");
            self.background = CoverBackground::Follow;
        }
    }
}

/// 卡面背景的取值以后还会增加：新版本写下、这个版本不认识的取值只让这一项按跟随读（摘掉后由
/// `#[serde(default)]` 补），其余设置照常读入，玩家切回旧通道时实例照样能启动。判定用枚举自己的 serde 名，
/// 大小写不同也算不认识。不是字符串的说明文件坏了，留给整份反序列化报错。
fn drop_unknown_background(raw: &mut serde_json::Value, path: &Path) {
    let Some(object) = raw.as_object_mut() else {
        return;
    };
    if let Some(serde_json::Value::String(value)) = object.get("background")
        && serde_json::from_value::<CoverBackground>(serde_json::Value::String(value.clone()))
            .is_err()
    {
        tracing::warn!(path = %path.display(), value = ?value, "实例设置里的卡面背景取值不认识，按跟随读");
        object.remove("background");
    }
}

/// 实例的卡面图片目录：`version_dir/.petalfall/cover/`。
pub fn cover_image_dir(version_dir: &Path) -> PathBuf {
    version_dir.join(PETALFALL_META_DIR).join(COVER_IMAGE_DIR)
}

/// 版本设置文件的读写句柄。
#[derive(Debug, Clone)]
pub struct VersionSettingsStore {
    path: PathBuf,
}

impl VersionSettingsStore {
    /// 默认路径：`version_dir/.petalfall/settings.json`（`version_dir` 即 `versions/<id>`）。
    pub fn for_version_dir(version_dir: &Path) -> Self {
        Self {
            path: version_dir.join(PETALFALL_META_DIR).join(SETTINGS_FILE),
        }
    }

    /// 指定设置文件路径（测试注入）。
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 设置文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 读取设置；文件缺失返回默认值；存在但损坏则冒泡。卡面背景取值不认识、卡面图片引用用不了时只把那几项
    /// 落回默认并记 warn，其余字段照常读出；读出的设置总能通过卡面相关的校验，可以原样写回。
    pub async fn load(&self) -> Result<VersionSettings> {
        let bytes = match tokio::fs::read(&self.path).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(VersionSettings::default());
            }
            Err(source) => {
                return Err(Error::Io {
                    path: self.path.clone(),
                    source,
                });
            }
        };
        let corrupt = |source| Error::Json {
            context: "版本设置",
            path: self.path.clone(),
            source,
        };
        let mut raw: serde_json::Value = serde_json::from_slice(&bytes).map_err(corrupt)?;
        drop_unknown_background(&mut raw, &self.path);
        let mut settings: VersionSettings = serde_json::from_value(raw).map_err(corrupt)?;
        settings.settle_cover_images(&self.path);
        Ok(settings)
    }

    /// 原子写入设置。
    pub async fn save(&self, settings: &VersionSettings) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(settings).map_err(|source| Error::Json {
            context: "版本设置",
            path: self.path.clone(),
            source,
        })?;
        petalfall_base::fs::atomic_write(&self.path, &bytes).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute_java() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Java\jdk-21\bin\javaw.exe")
        } else {
            PathBuf::from("/usr/lib/jvm/21/bin/java")
        }
    }

    #[test]
    fn defaults_match_new_instance_defaults() {
        let s = VersionSettings::default();
        assert_eq!(s.memory_mb, None);
        assert_eq!(s.java, JavaSelection::Auto);
        assert_eq!(s.isolation, IsolationOverride::FollowGlobal);
        assert_eq!(
            s.resolution,
            Resolution {
                width: 1280,
                height: 720
            }
        );
        assert!(!s.fullscreen);
        assert_eq!(s.validate(), Ok(()));
    }

    #[test]
    fn java_selection_serializes_as_auto_or_path() {
        assert_eq!(
            serde_json::to_value(JavaSelection::Auto).unwrap(),
            serde_json::json!("auto")
        );
        let path = absolute_java();
        let value = serde_json::to_value(JavaSelection::Path(path.clone())).unwrap();
        assert_eq!(value, serde_json::json!(path.to_string_lossy()));
        assert_eq!(
            serde_json::from_value::<JavaSelection>(value).unwrap(),
            JavaSelection::Path(path)
        );
        assert_eq!(
            serde_json::from_value::<JavaSelection>(serde_json::json!("auto")).unwrap(),
            JavaSelection::Auto
        );
    }

    #[test]
    fn validate_rejects_each_out_of_range_field() {
        let base = VersionSettings::default();
        let cases: Vec<(VersionSettings, &str)> = vec![
            (
                VersionSettings {
                    description: Some("  ".into()),
                    ..base.clone()
                },
                "description",
            ),
            (
                VersionSettings {
                    cover: Some(String::new()),
                    ..base.clone()
                },
                "cover",
            ),
            (
                VersionSettings {
                    cover: Some("Cherry Planks".into()),
                    ..base.clone()
                },
                "cover",
            ),
            (
                VersionSettings {
                    cover: Some("a".repeat(65)),
                    ..base.clone()
                },
                "cover",
            ),
            (
                VersionSettings {
                    cover_image: Some("block-0123456789abcdef.jpg".into()),
                    ..base.clone()
                },
                "cover_image",
            ),
            (
                VersionSettings {
                    cover_image: Some("../block-0123456789abcdef.png".into()),
                    ..base.clone()
                },
                "cover_image",
            ),
            (
                VersionSettings {
                    background_image: Some("background-0123456789ABCDEF.png".into()),
                    ..base.clone()
                },
                "background_image",
            ),
            (
                VersionSettings {
                    background_image: Some("block-0123456789abcdef.png".into()),
                    ..base.clone()
                },
                "background_image",
            ),
            (
                VersionSettings {
                    background: CoverBackground::Image,
                    ..base.clone()
                },
                "background",
            ),
            (
                VersionSettings {
                    memory_mb: Some(512),
                    ..base.clone()
                },
                "memory_mb",
            ),
            (
                VersionSettings {
                    memory_mb: Some(1023),
                    ..base.clone()
                },
                "memory_mb",
            ),
            (
                VersionSettings {
                    memory_mb: Some(4100),
                    ..base.clone()
                },
                "memory_mb",
            ),
            (
                VersionSettings {
                    java: JavaSelection::Path(PathBuf::from("java.exe")),
                    ..base.clone()
                },
                "java",
            ),
            (
                VersionSettings {
                    resolution: Resolution {
                        width: 319,
                        height: 720,
                    },
                    ..base.clone()
                },
                "resolution",
            ),
            (
                VersionSettings {
                    resolution: Resolution {
                        width: 7681,
                        height: 720,
                    },
                    ..base.clone()
                },
                "resolution",
            ),
            (
                VersionSettings {
                    resolution: Resolution {
                        width: 1280,
                        height: 239,
                    },
                    ..base.clone()
                },
                "resolution",
            ),
            (
                VersionSettings {
                    resolution: Resolution {
                        width: 1280,
                        height: 4321,
                    },
                    ..base.clone()
                },
                "resolution",
            ),
        ];
        for (settings, field) in cases {
            let err = settings.validate().unwrap_err();
            assert_eq!(err.field, field, "{settings:?}");
        }
    }

    #[test]
    fn validate_accepts_boundary_values() {
        let s = VersionSettings {
            description: Some("生存存档专用".into()),
            cover: Some("cherry_planks".into()),
            memory_mb: Some(1024),
            java: JavaSelection::Path(absolute_java()),
            resolution: Resolution {
                width: 320,
                height: 4320,
            },
            ..Default::default()
        };
        assert_eq!(s.validate(), Ok(()));
        let s = VersionSettings {
            memory_mb: Some(16384),
            resolution: Resolution {
                width: 7680,
                height: 240,
            },
            ..Default::default()
        };
        assert_eq!(s.validate(), Ok(()));
        let s = VersionSettings {
            cover: Some("oak_log".into()),
            cover_image: Some("block-0123456789abcdef.png".into()),
            background: CoverBackground::Image,
            background_image: Some("background-fedcba9876543210.jpg".into()),
            ..Default::default()
        };
        assert_eq!(s.validate(), Ok(()));
        assert_eq!(
            s.cover_image_files(),
            [
                "block-0123456789abcdef.png",
                "background-fedcba9876543210.jpg"
            ]
        );
        // 背景换成别的样式后图片仍留在设置里，换回图片不用重选
        let kept = VersionSettings {
            background: CoverBackground::Texture,
            ..s
        };
        assert_eq!(kept.validate(), Ok(()));
    }

    #[test]
    fn cover_image_names_follow_the_slot_pattern() {
        let hash = "0123456789abcdef";
        assert_eq!(
            CoverImageSlot::Background.file_name(hash, "jpg").unwrap(),
            "background-0123456789abcdef.jpg"
        );
        assert_eq!(
            CoverImageSlot::Block.file_name(hash, "png").unwrap(),
            "block-0123456789abcdef.png"
        );
        assert!(CoverImageSlot::Block.file_name(hash, "jpg").is_err());
        assert!(CoverImageSlot::Background.file_name("0123", "png").is_err());
        for rejected in [
            "background-0123456789abcdef.gif",
            "background-0123456789abcde.png",
            "background-0123456789abcdefa.png",
            "background-0123456789abcdeg.png",
            "background-0123456789abcdef.png/..",
            "Background-0123456789abcdef.png",
            "",
        ] {
            assert!(!CoverImageSlot::Background.accepts(rejected), "{rejected}");
        }
    }

    #[test]
    fn background_serializes_as_snake_case_words() {
        for (background, word) in [
            (CoverBackground::Follow, "follow"),
            (CoverBackground::Art, "art"),
            (CoverBackground::Texture, "texture"),
            (CoverBackground::Image, "image"),
        ] {
            assert_eq!(
                serde_json::to_value(background).unwrap(),
                serde_json::json!(word)
            );
        }
        assert_eq!(
            VersionSettings::default().background,
            CoverBackground::Follow
        );
        assert_eq!(
            cover_image_dir(Path::new("v")),
            Path::new("v").join(crate::PETALFALL_META_DIR).join("cover")
        );
    }

    #[tokio::test]
    async fn missing_file_loads_default() {
        let tmp = tempfile::tempdir().unwrap();
        let store = VersionSettingsStore::for_version_dir(tmp.path());
        assert_eq!(
            store.path(),
            tmp.path()
                .join(crate::PETALFALL_META_DIR)
                .join("settings.json")
        );
        assert_eq!(store.load().await.unwrap(), VersionSettings::default());
    }

    #[tokio::test]
    async fn round_trip_preserves_values() {
        let tmp = tempfile::tempdir().unwrap();
        let store = VersionSettingsStore::for_version_dir(tmp.path());

        let settings = VersionSettings {
            description: Some("测试整合包".into()),
            cover: Some("amethyst_block".into()),
            cover_image: Some("block-0123456789abcdef.png".into()),
            background: CoverBackground::Image,
            background_image: Some("background-0123456789abcdef.png".into()),
            isolation: IsolationOverride::Disabled,
            memory_mb: Some(6144),
            java: JavaSelection::Path(absolute_java()),
            jvm_args: "-XX:+UseG1GC -Dfile.encoding=UTF-8".into(),
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
            fullscreen: true,
        };
        store.save(&settings).await.unwrap();

        assert_eq!(store.load().await.unwrap(), settings);
    }

    /// 旧版本写下的字段（收藏、图标、分类）不认识也照常读出，缺的字段取默认值。
    #[tokio::test]
    async fn legacy_fields_are_ignored_and_missing_fields_default() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        tokio::fs::write(
            &path,
            r#"{"description":"旧描述","favorite":true,"icon":"Command_Block","isolation":"enabled"}"#,
        )
        .await
        .unwrap();
        let loaded = VersionSettingsStore::at(&path).load().await.unwrap();
        assert_eq!(loaded.description.as_deref(), Some("旧描述"));
        assert_eq!(loaded.isolation, IsolationOverride::Enabled);
        assert_eq!(loaded.resolution, Resolution::default());
        assert_eq!(loaded.java, JavaSelection::Auto);
        // 卡面几项是后来加的：旧文件里没有，读出来是跟随、没有图片
        assert_eq!(loaded.cover_image, None);
        assert_eq!(loaded.background, CoverBackground::Follow);
        assert_eq!(loaded.background_image, None);
        assert_eq!(loaded.validate(), Ok(()));
    }

    async fn load_raw(raw: &serde_json::Value) -> Result<VersionSettings> {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        tokio::fs::write(&path, serde_json::to_vec(raw).unwrap())
            .await
            .unwrap();
        VersionSettingsStore::at(&path).load().await
    }

    /// 以后的版本加了新的背景取值、玩家又切回这个版本：只这一项按跟随读，其余字段一个不丢，读出来能原样写回。
    #[tokio::test]
    async fn unknown_background_reads_as_follow_and_keeps_the_rest() {
        let loaded = load_raw(&serde_json::json!({
            "description": "周末一起玩",
            "cover": "oak_log",
            "cover_image": "block-0123456789abcdef.png",
            "background": "aurora_shader",
            "background_image": "background-fedcba9876543210.jpg",
            "isolation": "disabled",
            "memory_mb": 6144,
            "jvm_args": "-XX:+UseG1GC",
            "resolution": { "width": 1920, "height": 1080 },
            "fullscreen": true
        }))
        .await
        .unwrap();
        assert_eq!(
            loaded,
            VersionSettings {
                description: Some("周末一起玩".into()),
                cover: Some("oak_log".into()),
                cover_image: Some("block-0123456789abcdef.png".into()),
                background: CoverBackground::Follow,
                background_image: Some("background-fedcba9876543210.jpg".into()),
                isolation: IsolationOverride::Disabled,
                memory_mb: Some(6144),
                java: JavaSelection::Auto,
                jvm_args: "-XX:+UseG1GC".into(),
                resolution: Resolution {
                    width: 1920,
                    height: 1080,
                },
                fullscreen: true,
            }
        );
        assert_eq!(loaded.validate(), Ok(()));

        // 与 serde 同一套名字：大小写不同也是不认识的取值
        assert_eq!(
            load_raw(&serde_json::json!({ "background": "Texture", "memory_mb": 2048 }))
                .await
                .unwrap(),
            VersionSettings {
                memory_mb: Some(2048),
                ..VersionSettings::default()
            }
        );
        assert_eq!(
            load_raw(&serde_json::json!({ "background": "texture" }))
                .await
                .unwrap()
                .background,
            CoverBackground::Texture
        );
        // 不是字符串说明文件坏了：整份报错，不悄悄当作跟随
        let err = load_raw(&serde_json::json!({ "background": 3 }))
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                Error::Json {
                    context: "版本设置",
                    ..
                }
            ),
            "{err:?}"
        );
    }

    /// 不符合位置格式的卡面图片文件名读入时当作没有：列实例时它们会被拼进卡面图片目录去探测、登记给协议读。
    /// 只丢这一项，别的字段照常读出。
    #[tokio::test]
    async fn malformed_cover_image_names_are_dropped_on_load() {
        for name in [
            r"\\fileserver\share\background-0123456789abcdef.png",
            r"C:\Windows\win.ini",
            "/etc/passwd",
            "../settings.json",
            "../background-0123456789abcdef.png",
            "x/../../background-0123456789abcdef.png",
            "background-0123456789ABCDEF.png",
            "block-0123456789ABCDEF.png",
            "",
        ] {
            let loaded = load_raw(&serde_json::json!({
                "description": "旧描述",
                "cover_image": name,
                "background": "texture",
                "background_image": name,
                "memory_mb": 4096
            }))
            .await
            .unwrap();
            assert_eq!(
                loaded,
                VersionSettings {
                    description: Some("旧描述".into()),
                    background: CoverBackground::Texture,
                    memory_mb: Some(4096),
                    ..VersionSettings::default()
                },
                "{name:?}"
            );
            assert_eq!(loaded.validate(), Ok(()), "{name:?}");
        }

        // 两个位置的文件名不互通
        let swapped = load_raw(&serde_json::json!({
            "cover_image": "background-0123456789abcdef.png",
            "background_image": "block-0123456789abcdef.png"
        }))
        .await
        .unwrap();
        assert_eq!(
            (swapped.cover_image, swapped.background_image),
            (None, None)
        );

        let kept = load_raw(&serde_json::json!({
            "cover_image": "block-0123456789abcdef.png",
            "background_image": "background-0123456789abcdef.png"
        }))
        .await
        .unwrap();
        assert_eq!(
            kept.cover_image_files(),
            [
                "block-0123456789abcdef.png",
                "background-0123456789abcdef.png"
            ]
        );
    }

    /// 背景是图片却没有图片（手改，或文件名不合规被丢掉）按跟随读，界面整份保存时不会被 validate 拒。
    #[tokio::test]
    async fn image_background_without_an_image_reads_as_follow() {
        for raw in [
            serde_json::json!({ "background": "image", "cover": "oak_log" }),
            serde_json::json!({ "background": "image", "background_image": null, "cover": "oak_log" }),
            serde_json::json!({ "background": "image", "background_image": "../x.png", "cover": "oak_log" }),
        ] {
            let loaded = load_raw(&raw).await.unwrap();
            assert_eq!(
                loaded,
                VersionSettings {
                    cover: Some("oak_log".into()),
                    ..VersionSettings::default()
                },
                "{raw}"
            );
            assert_eq!(loaded.validate(), Ok(()), "{raw}");
        }

        let image = load_raw(&serde_json::json!({
            "background": "image",
            "background_image": "background-0123456789abcdef.jpg"
        }))
        .await
        .unwrap();
        assert_eq!(image.background, CoverBackground::Image);
        assert_eq!(
            image.background_image.as_deref(),
            Some("background-0123456789abcdef.jpg")
        );
    }

    #[tokio::test]
    async fn corrupt_settings_file_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("settings.json");
        tokio::fs::write(&path, b"{ broken").await.unwrap();
        let store = VersionSettingsStore::at(&path);

        let err = store.load().await.unwrap_err();
        match err {
            Error::Json { context, .. } => assert_eq!(context, "版本设置"),
            other => panic!("期望 Json 错误，得到 {other:?}"),
        }
    }
}
