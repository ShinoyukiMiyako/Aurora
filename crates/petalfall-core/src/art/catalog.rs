//! 方块目录：从客户端 jar 的方块状态与模型推出哪些方块是完整立方体、各面用哪张材质、要不要染色，
//! 实例卡面因此可以选材质源里任意一种完整方块，而不只是预设的 16 种。
//!
//! 只认方块状态的 variants 写法，取朝北的那个变体（物品栏里画的就是它；没有朝向的取第一个，数组取第一个）；
//! 发射器、投掷器的第一个变体是朝下的竖放模型，取第一个会把顶面画成正面。multipart 是栅栏、墙这类按连接拼出来的
//! 形状，不收。沿模型父链合并 textures（子覆盖父），直到碰上原版的立方体模板，由模板决定顶面、侧面、
//! 正面各取哪个变量；先碰上带 elements 的别的模型就是自定义形状（台阶、花、按钮），不收。草方块的模型
//! 带染色覆盖层，按规则是自定义形状，但它是最常见的封面，单独收录。
//!
//! 这里只看传进来的字节，不碰磁盘；读 jar、抽材质在 `disk_cache`。

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::rc::Rc;

use image::RgbaImage;
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use super::whitelist::{is_block_name, is_block_texture};

/// 乘色 `[r, g, b]`。
pub type Rgb = [u8; 3];

/// 草方块顶面的染色：原版物品栏里草方块的颜色（草地色图在温度 0.5、湿度 1.0 处）。顶面材质是灰度，
/// 不染就是一块灰板；侧面材质的草边自带颜色，不染。
pub const GRASS_TOP_TINT: Rgb = [124, 189, 107];

/// 没有物品定义的老 jar（1.21.4 之前）里树叶的染色，取值与 1.21.4 起物品定义写的固定染色相同。
/// 表外的树叶（樱花、杜鹃、苍白橡树等）材质自带颜色，不染。
const LEGACY_LEAF_TINTS: [(&str, Rgb); 7] = [
    ("oak_leaves", [72, 181, 24]),
    ("jungle_leaves", [72, 181, 24]),
    ("acacia_leaves", [72, 181, 24]),
    ("dark_oak_leaves", [72, 181, 24]),
    ("spruce_leaves", [97, 153, 97]),
    ("birch_leaves", [128, 167, 85]),
    ("mangrove_leaves", [146, 198, 72]),
];

/// 不进目录的方块：命令方块、结构方块、拼图方块、测试方块是管理员工具，霜冰只由冰霜行者临时生成，
/// 创造模式物品栏里默认都看不到，放进选择框只会让玩家困惑。
const EXCLUDED: [&str; 8] = [
    "command_block",
    "chain_command_block",
    "repeating_command_block",
    "structure_block",
    "jigsaw",
    "test_block",
    "test_instance_block",
    "frosted_ice",
];

const BLOCKSTATES: &str = "assets/minecraft/blockstates/";
const MODELS: &str = "assets/minecraft/models/";
const ITEMS: &str = "assets/minecraft/items/";

/// 父链与 `#` 引用的最大跳数：原版最深不过四五层，超过就当成环。
const MAX_HOPS: usize = 32;

/// 一个材质源的方块目录，`blocks` 按 id 排序。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockCatalog {
    pub version_id: String,
    pub blocks: Vec<CatalogBlock>,
}

/// 目录里的一种完整立方体方块。序列化形状就是前端的 `CatalogBlockDto`，材质路径都在 `block/` 下，
/// 取图经协议的 `/art/` 路径。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogBlock {
    /// 方块 id，即实例设置里的 cover 值。
    pub id: String,
    /// 顶面材质路径，如 `block/oak_log_top`。
    pub top: String,
    pub side: String,
    /// 正面（熔炉、发射器这类有朝向的方块），等距方块画在左面；没有为 None。
    pub front: Option<String>,
    /// 顶面乘色（草方块顶、树叶）；不用染色为 None。
    pub top_tint: Option<Rgb>,
    /// 侧面与正面乘色（树叶四面都染）；不用染色为 None。
    pub side_tint: Option<Rgb>,
    /// 侧面乘过染色后平均色的 HSL 色相，0..=359。
    pub hue: u16,
    /// 英文名来自 jar 里的 en_us，中文名来自资源索引里的 zh_cn；读不到为 None。
    pub name_en: Option<String>,
    pub name_zh: Option<String>,
}

/// 推导目录要读的 jar 条目原文：方块状态、模型与物品定义。
#[derive(Debug, Default)]
pub struct ModelFiles {
    /// 键为方块 id。
    blockstates: BTreeMap<String, Vec<u8>>,
    /// 键为 `models/` 下不带扩展名的路径，如 `block/cube_all`。
    models: HashMap<String, Vec<u8>>,
    /// 键为物品 id；jar 里没有 items 目录（1.21.4 之前）时为 None，树叶改用表里的染色。
    items: Option<HashMap<String, Vec<u8>>>,
}

impl ModelFiles {
    /// 这个 jar 条目是不是推导要用的；不要的条目调用方不必解压。
    pub fn wants(name: &str) -> bool {
        name.ends_with(".json")
            && [BLOCKSTATES, MODELS, ITEMS]
                .iter()
                .any(|prefix| name.starts_with(prefix))
    }

    /// 收下一个条目；不是推导要用的条目忽略。
    pub fn insert(&mut self, name: &str, bytes: Vec<u8>) {
        let Some(stem) = name.strip_suffix(".json") else {
            return;
        };
        if let Some(id) = stem.strip_prefix(BLOCKSTATES) {
            self.blockstates.insert(id.to_owned(), bytes);
        } else if let Some(path) = stem.strip_prefix(MODELS) {
            self.models.insert(path.to_owned(), bytes);
        } else if let Some(id) = stem.strip_prefix(ITEMS) {
            self.items
                .get_or_insert_with(HashMap::new)
                .insert(id.to_owned(), bytes);
        }
    }
}

/// 一种完整立方体方块的各面材质与染色，还没有色相与名称。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockFaces {
    pub id: String,
    pub top: String,
    pub side: String,
    pub front: Option<String>,
    pub top_tint: Option<Rgb>,
    pub side_tint: Option<Rgb>,
}

impl BlockFaces {
    /// 用到的材质路径：顶面、侧面、正面（可能重复）。
    pub fn textures(&self) -> impl Iterator<Item = &str> {
        [
            Some(self.top.as_str()),
            Some(self.side.as_str()),
            self.front.as_deref(),
        ]
        .into_iter()
        .flatten()
    }
}

/// 推出全部完整立方体方块，按 id 排序。单个方块的文件有问题只记 warn 并跳过它。
pub fn derive(files: &ModelFiles) -> Vec<BlockFaces> {
    let mut models = Models {
        raw: &files.models,
        parsed: HashMap::new(),
    };
    let mut blocks = Vec::new();
    for (id, bytes) in &files.blockstates {
        match classify(id, bytes, &mut models, files.items.as_ref()) {
            Ok(Some(faces)) => blocks.push(faces),
            Ok(None) => {}
            Err(reason) => {
                tracing::warn!(block = %id, %reason, "方块状态或模型不可用，这个方块不进目录")
            }
        }
    }
    blocks
}

/// `Ok(None)` 是正常的「不是完整立方体」，`Err` 是文件本身有问题。
fn classify(
    id: &str,
    bytes: &[u8],
    models: &mut Models<'_>,
    items: Option<&HashMap<String, Vec<u8>>>,
) -> Result<Option<BlockFaces>, String> {
    if !is_block_name(id) {
        return Err("方块 id 不是 1 到 64 个小写字母、数字或下划线".to_owned());
    }
    if EXCLUDED.contains(&id) {
        return Ok(None);
    }
    if id == "grass_block" {
        return Ok(Some(BlockFaces {
            id: id.to_owned(),
            top: "block/grass_block_top".to_owned(),
            side: "block/grass_block_side".to_owned(),
            front: None,
            top_tint: Some(GRASS_TOP_TINT),
            side_tint: None,
        }));
    }
    let state: BlockState =
        serde_json::from_slice(bytes).map_err(|e| format!("方块状态解析失败：{e}"))?;
    let Some(variant) = state.variants else {
        return Ok(None);
    };
    let Some((template, textures)) = resolve_chain(&variant.model, models)? else {
        return Ok(None);
    };
    let (top, side, front) = template.variables();
    let tint = match template {
        Template::Leaves => leaf_tint(id, items),
        _ => None,
    };
    Ok(Some(BlockFaces {
        id: id.to_owned(),
        top: texture(&textures, top)?,
        side: texture(&textures, side)?,
        front: front.map(|var| texture(&textures, var)).transpose()?,
        top_tint: tint,
        side_tint: tint,
    }))
}

/// 原版的立方体模板，按顶面、侧面、正面取哪个变量分组。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Template {
    All,
    Column,
    BottomTop,
    Orientable,
    Cube,
    Leaves,
}

impl Template {
    fn of(model: &str) -> Option<Template> {
        match model {
            "block/cube_all" | "block/cube_mirrored_all" | "block/cube_north_west_mirrored_all" => {
                Some(Template::All)
            }
            "block/cube_column" | "block/cube_column_horizontal" | "block/cube_column_mirrored" => {
                Some(Template::Column)
            }
            "block/cube_bottom_top" | "block/cube_top" => Some(Template::BottomTop),
            "block/orientable" | "block/orientable_with_bottom" => Some(Template::Orientable),
            "block/cube" => Some(Template::Cube),
            "block/leaves" => Some(Template::Leaves),
            _ => None,
        }
    }

    /// 顶面、侧面、正面各取哪个材质变量。
    fn variables(self) -> (&'static str, &'static str, Option<&'static str>) {
        match self {
            Template::All | Template::Leaves => ("all", "all", None),
            Template::Column => ("end", "side", None),
            Template::BottomTop => ("top", "side", None),
            Template::Orientable => ("top", "side", Some("front")),
            Template::Cube => ("up", "east", Some("north")),
        }
    }
}

/// 合并后的材质变量表：变量名到路径或 `#引用`。
type TextureVars = HashMap<String, String>;

/// 沿父链合并 textures 直到命中模板；先碰上带 elements 的模型、或链走到头都没有模板，为 `Ok(None)`。
fn resolve_chain(
    start: &str,
    models: &mut Models<'_>,
) -> Result<Option<(Template, TextureVars)>, String> {
    let mut textures = HashMap::new();
    let mut path = model_path(start).to_owned();
    for _ in 0..MAX_HOPS {
        let model = models.get(&path)?;
        for (key, value) in &model.textures {
            textures
                .entry(key.clone())
                .or_insert_with(|| value.path().to_owned());
        }
        if let Some(template) = Template::of(&path) {
            return Ok(Some((template, textures)));
        }
        if model.elements.is_some() {
            return Ok(None);
        }
        match &model.parent {
            Some(parent) => path = model_path(parent).to_owned(),
            None => return Ok(None),
        }
    }
    Err(format!("模型 {start} 的父链超过 {MAX_HOPS} 层，可能成环"))
}

/// 解析材质变量：`#` 开头的值继续查同一张表，直到落到一个材质路径。
fn texture(textures: &TextureVars, variable: &str) -> Result<String, String> {
    let mut current = variable;
    for _ in 0..MAX_HOPS {
        let value = textures
            .get(current)
            .ok_or_else(|| format!("材质变量 #{current} 没有定义"))?;
        match value.strip_prefix('#') {
            Some(next) => current = next,
            None => {
                let path = value.strip_prefix("minecraft:").unwrap_or(value);
                return if is_block_texture(path) {
                    Ok(path.to_owned())
                } else {
                    Err(format!("材质 {value} 不是 block/ 下的单层路径"))
                };
            }
        }
    }
    Err(format!(
        "材质变量 #{variable} 的引用超过 {MAX_HOPS} 跳，可能成环"
    ))
}

/// 模型引用去掉 `minecraft:` 命名空间前缀；1.13 前后的写法都有。
fn model_path(reference: &str) -> &str {
    reference.strip_prefix("minecraft:").unwrap_or(reference)
}

/// 树叶的染色。有物品定义的 jar 以物品定义为准：第一个染色源是固定色就用它，否则不染；没有物品定义的
/// 老 jar 查表。
fn leaf_tint(id: &str, items: Option<&HashMap<String, Vec<u8>>>) -> Option<Rgb> {
    let Some(items) = items else {
        return LEGACY_LEAF_TINTS
            .iter()
            .find(|(leaf, _)| *leaf == id)
            .map(|(_, rgb)| *rgb);
    };
    let bytes = items.get(id)?;
    let definition: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(definition) => definition,
        Err(err) => {
            tracing::warn!(block = %id, error = %err, "树叶的物品定义解析失败，不染色");
            return None;
        }
    };
    let tint = definition.pointer("/model/tints/0")?;
    if tint.get("type").and_then(serde_json::Value::as_str) != Some("minecraft:constant") {
        return None;
    }
    match tint.get("value").and_then(serde_json::Value::as_i64) {
        Some(argb) => Some(rgb_of_argb(argb)),
        None => {
            tracing::warn!(block = %id, %tint, "树叶物品定义的固定染色不是整数，不染色");
            None
        }
    }
}

/// 物品定义里的颜色是有符号 32 位 ARGB（如 -12012264），也可能写成无符号；只取低 24 位的 RGB。
fn rgb_of_argb(argb: i64) -> Rgb {
    let bits = argb as u32;
    [(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]
}

/// 侧面平均色的 HSL 色相：先乘染色，再按不透明度加权平均（透明像素不算颜色），四舍五入到整度；
/// 全透明或无彩色为 0。
pub fn side_hue(side: &RgbaImage, tint: Option<Rgb>) -> u16 {
    let tint = tint.map_or([1.0; 3], |t| t.map(|c| f64::from(c) / 255.0));
    let mut sum = [0.0f64; 3];
    let mut weight = 0.0f64;
    for pixel in side.pixels() {
        let [r, g, b, a] = pixel.0;
        let a = f64::from(a);
        for (channel, value) in [r, g, b].into_iter().enumerate() {
            sum[channel] += f64::from(value) * tint[channel] * a;
        }
        weight += a;
    }
    if weight <= 0.0 {
        return 0;
    }
    hue_of(sum.map(|s| s / weight))
}

fn hue_of(rgb: [f64; 3]) -> u16 {
    let (max_channel, max) =
        rgb.into_iter()
            .enumerate()
            .fold((0, f64::MIN), |best, (channel, value)| {
                if value > best.1 {
                    (channel, value)
                } else {
                    best
                }
            });
    let min = rgb.into_iter().fold(f64::MAX, f64::min);
    let delta = max - min;
    if delta <= 0.0 {
        return 0;
    }
    let [r, g, b] = rgb;
    let sector = match max_channel {
        0 => ((g - b) / delta).rem_euclid(6.0),
        1 => (b - r) / delta + 2.0,
        _ => (r - g) / delta + 4.0,
    };
    // 359.5 及以上四舍五入成 360，即 0。
    (sector * 60.0).round() as u16 % 360
}

/// 解析语言文件（键到显示名的平铺 JSON）。
pub fn parse_lang(bytes: &[u8]) -> Result<HashMap<String, String>, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("语言文件解析失败：{e}"))
}

/// 方块在语言文件里的显示名；没有这一条或是空串为 None。
pub fn block_name(lang: &HashMap<String, String>, id: &str) -> Option<String> {
    lang.get(&format!("block.minecraft.{id}"))
        .filter(|name| !name.is_empty())
        .cloned()
}

/// 解析过的模型按路径缓存：原版几百个方块共用 cube_all 这几个父模型。
struct Models<'a> {
    raw: &'a HashMap<String, Vec<u8>>,
    parsed: HashMap<String, Rc<Model>>,
}

impl Models<'_> {
    fn get(&mut self, path: &str) -> Result<Rc<Model>, String> {
        if let Some(model) = self.parsed.get(path) {
            return Ok(model.clone());
        }
        let bytes = self
            .raw
            .get(path)
            .ok_or_else(|| format!("模型 {path} 不存在"))?;
        let model: Rc<Model> = Rc::new(
            serde_json::from_slice(bytes).map_err(|e| format!("模型 {path} 解析失败：{e}"))?,
        );
        self.parsed.insert(path.to_owned(), model.clone());
        Ok(model)
    }
}

#[derive(Deserialize)]
struct Model {
    parent: Option<String>,
    #[serde(default)]
    textures: HashMap<String, TextureValue>,
    /// 只看有没有：有就是自己定义了形状。
    elements: Option<IgnoredAny>,
}

/// 材质变量的值：路径或 `#引用`；新版本里要强制半透明的材质写成带 `sprite` 的对象（如染色玻璃）。
#[derive(Deserialize)]
#[serde(untagged)]
enum TextureValue {
    Path(String),
    Sprite { sprite: String },
}

impl TextureValue {
    fn path(&self) -> &str {
        match self {
            TextureValue::Path(path) | TextureValue::Sprite { sprite: path } => path,
        }
    }
}

#[derive(Deserialize)]
struct BlockState {
    /// 没有 variants（multipart）为 None。
    #[serde(default, deserialize_with = "preferred_variant")]
    variants: Option<Variant>,
}

#[derive(Deserialize)]
struct Variant {
    model: String,
}

/// 一个状态对应一个模型，或按权重随机的一组。
#[derive(Deserialize)]
#[serde(untagged)]
enum VariantEntry {
    One(Variant),
    Weighted(Vec<Variant>),
}

/// 取 variants 里状态带 `facing=north` 的第一项，没有就取按文件顺序的第一项：serde_json 的 Map 默认按键排序，
/// 不能先解析成 Map 再挑。
fn preferred_variant<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Variant>, D::Error> {
    struct Preferred;

    impl<'de> Visitor<'de> for Preferred {
        type Value = Option<Variant>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("variants 对象")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut first = None;
            while let Some((state, entry)) = map.next_entry::<String, VariantEntry>()? {
                let north = state.split(',').any(|pair| pair == "facing=north");
                if north {
                    while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                    return Ok(entry.into_first());
                }
                if first.is_none() {
                    first = Some(entry);
                }
            }
            Ok(first.and_then(VariantEntry::into_first))
        }
    }

    deserializer.deserialize_map(Preferred)
}

impl VariantEntry {
    fn into_first(self) -> Option<Variant> {
        match self {
            VariantEntry::One(variant) => Some(variant),
            VariantEntry::Weighted(list) => list.into_iter().next(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use serde_json::json;

    fn files(entries: &[(&str, serde_json::Value)]) -> ModelFiles {
        let mut files = ModelFiles::default();
        for (name, value) in entries {
            assert!(ModelFiles::wants(name), "{name} 应是推导要用的条目");
            files.insert(name, serde_json::to_vec(value).unwrap());
        }
        files
    }

    fn state(id: &str, model: &str) -> (String, serde_json::Value) {
        (
            format!("{BLOCKSTATES}{id}.json"),
            json!({ "variants": { "": { "model": model } } }),
        )
    }

    fn model(path: &str, value: serde_json::Value) -> (String, serde_json::Value) {
        (format!("{MODELS}{path}.json"), value)
    }

    /// 原版的模板模型：cube 带 elements，其余模板只改变量名。
    fn templates() -> Vec<(String, serde_json::Value)> {
        let faces = |down: &str, up: &str, north: &str, east: &str| json!({ "particle": north, "down": down, "up": up, "north": north, "east": east, "south": east, "west": east });
        vec![
            model(
                "block/block",
                json!({ "display": { "gui": { "rotation": [30, 225, 0] } } }),
            ),
            model(
                "block/cube",
                json!({ "parent": "block/block", "elements": [{ "from": [0, 0, 0], "to": [16, 16, 16] }] }),
            ),
            model(
                "block/cube_all",
                json!({ "parent": "block/cube", "textures": faces("#all", "#all", "#all", "#all") }),
            ),
            model(
                "block/cube_mirrored",
                json!({ "parent": "block/block", "elements": [{ "from": [0, 0, 0], "to": [16, 16, 16] }] }),
            ),
            model(
                "block/cube_mirrored_all",
                json!({ "parent": "block/cube_mirrored", "textures": faces("#all", "#all", "#all", "#all") }),
            ),
            model(
                "block/cube_column",
                json!({ "parent": "block/cube", "textures": faces("#end", "#end", "#side", "#side") }),
            ),
            model(
                "block/cube_column_horizontal",
                json!({ "parent": "block/block", "elements": [{ "from": [0, 0, 0], "to": [16, 16, 16] }] }),
            ),
            model(
                "block/cube_bottom_top",
                json!({ "parent": "block/cube", "textures": faces("#bottom", "#top", "#side", "#side") }),
            ),
            model(
                "block/cube_top",
                json!({ "parent": "block/cube", "textures": faces("#side", "#top", "#side", "#side") }),
            ),
            model(
                "block/orientable_with_bottom",
                json!({ "parent": "block/cube", "textures": faces("#bottom", "#top", "#front", "#side") }),
            ),
            model(
                "block/orientable",
                json!({ "parent": "block/orientable_with_bottom", "textures": { "bottom": "#top" } }),
            ),
            model(
                "block/leaves",
                json!({ "parent": "block/block", "textures": { "particle": "#all" }, "elements": [{ "from": [0, 0, 0], "to": [16, 16, 16] }] }),
            ),
            model(
                "block/cross",
                json!({ "parent": "block/block", "elements": [{ "from": [0.8, 0, 8], "to": [15.2, 16, 8] }] }),
            ),
        ]
    }

    fn derive_from(extra: Vec<(String, serde_json::Value)>) -> Vec<BlockFaces> {
        let mut entries = templates();
        entries.extend(extra);
        let borrowed: Vec<(&str, serde_json::Value)> = entries
            .iter()
            .map(|(name, value)| (name.as_str(), value.clone()))
            .collect();
        derive(&files(&borrowed))
    }

    fn faces(
        id: &str,
        top: &str,
        side: &str,
        front: Option<&str>,
        tint: Option<Rgb>,
    ) -> BlockFaces {
        BlockFaces {
            id: id.to_owned(),
            top: top.to_owned(),
            side: side.to_owned(),
            front: front.map(str::to_owned),
            top_tint: tint,
            side_tint: tint,
        }
    }

    fn find<'a>(blocks: &'a [BlockFaces], id: &str) -> Option<&'a BlockFaces> {
        blocks.iter().find(|b| b.id == id)
    }

    #[test]
    fn cube_templates_map_to_top_side_and_front() {
        let blocks = derive_from(vec![
            state("stone", "minecraft:block/stone"),
            model(
                "block/stone",
                json!({ "parent": "minecraft:block/cube_all", "textures": { "all": "minecraft:block/stone" } }),
            ),
            // 1.13 时代的写法：没有命名空间前缀。
            state("dirt", "block/dirt"),
            model(
                "block/dirt",
                json!({ "parent": "block/cube_all", "textures": { "all": "block/dirt" } }),
            ),
            state("netherrack", "minecraft:block/netherrack"),
            model(
                "block/netherrack",
                json!({ "parent": "minecraft:block/cube_mirrored_all", "textures": { "all": "minecraft:block/netherrack" } }),
            ),
            state("oak_log", "minecraft:block/oak_log_horizontal"),
            model(
                "block/oak_log_horizontal",
                json!({ "parent": "minecraft:block/cube_column_horizontal", "textures": { "end": "minecraft:block/oak_log_top", "side": "minecraft:block/oak_log" } }),
            ),
            state("tnt", "minecraft:block/tnt"),
            model(
                "block/tnt",
                json!({ "parent": "minecraft:block/cube_bottom_top", "textures": { "bottom": "minecraft:block/tnt_bottom", "side": "minecraft:block/tnt_side", "top": "minecraft:block/tnt_top" } }),
            ),
            state("jukebox", "minecraft:block/jukebox"),
            model(
                "block/jukebox",
                json!({ "parent": "minecraft:block/cube_top", "textures": { "side": "minecraft:block/jukebox_side", "top": "minecraft:block/jukebox_top" } }),
            ),
            state("furnace", "minecraft:block/furnace"),
            model(
                "block/furnace",
                json!({ "parent": "minecraft:block/orientable", "textures": { "front": "minecraft:block/furnace_front", "side": "minecraft:block/furnace_side", "top": "minecraft:block/furnace_top" } }),
            ),
            state("crafting_table", "minecraft:block/crafting_table"),
            model(
                "block/crafting_table",
                json!({ "parent": "minecraft:block/cube", "textures": {
                    "particle": "minecraft:block/crafting_table_front",
                    "down": "minecraft:block/oak_planks",
                    "up": "minecraft:block/crafting_table_top",
                    "north": "minecraft:block/crafting_table_front",
                    "east": "minecraft:block/crafting_table_side",
                    "south": "minecraft:block/crafting_table_side",
                    "west": "minecraft:block/crafting_table_front"
                } }),
            ),
        ]);
        assert_eq!(
            blocks,
            vec![
                faces(
                    "crafting_table",
                    "block/crafting_table_top",
                    "block/crafting_table_side",
                    Some("block/crafting_table_front"),
                    None
                ),
                faces("dirt", "block/dirt", "block/dirt", None, None),
                faces(
                    "furnace",
                    "block/furnace_top",
                    "block/furnace_side",
                    Some("block/furnace_front"),
                    None
                ),
                faces(
                    "jukebox",
                    "block/jukebox_top",
                    "block/jukebox_side",
                    None,
                    None
                ),
                faces(
                    "netherrack",
                    "block/netherrack",
                    "block/netherrack",
                    None,
                    None
                ),
                faces("oak_log", "block/oak_log_top", "block/oak_log", None, None),
                faces("stone", "block/stone", "block/stone", None, None),
                faces("tnt", "block/tnt_top", "block/tnt_side", None, None),
            ]
        );
    }

    #[test]
    fn child_textures_override_parents_and_references_resolve_recursively() {
        let blocks = derive_from(vec![
            state("polished", "minecraft:block/polished"),
            // 中间层把 all 指向 #base，子模型再给 base 赋值；父层的 all 被子层覆盖。
            model(
                "block/stone_family",
                json!({ "parent": "minecraft:block/cube_all", "textures": { "all": "#base", "base": "minecraft:block/stone" } }),
            ),
            model(
                "block/polished",
                json!({ "parent": "minecraft:block/stone_family", "textures": { "base": "#inner", "inner": "minecraft:block/polished_stone" } }),
            ),
            // 新版本的染色玻璃：材质值是带 sprite 的对象。
            state("red_stained_glass", "minecraft:block/red_stained_glass"),
            model(
                "block/red_stained_glass",
                json!({ "parent": "minecraft:block/cube_all", "textures": { "all": { "force_translucent": true, "sprite": "minecraft:block/red_stained_glass" } } }),
            ),
        ]);
        assert_eq!(
            blocks,
            vec![
                faces(
                    "polished",
                    "block/polished_stone",
                    "block/polished_stone",
                    None,
                    None
                ),
                faces(
                    "red_stained_glass",
                    "block/red_stained_glass",
                    "block/red_stained_glass",
                    None,
                    None
                ),
            ]
        );
    }

    #[test]
    fn first_variant_in_file_order_decides_the_model() {
        // 键 "z" 在文件里排第一：按键排序会错取 "a" 的台阶模型。
        let raw = br#"{ "variants": {
            "z=1": [ { "model": "minecraft:block/log_y" }, { "model": "minecraft:block/slab", "y": 90 } ],
            "a=1": { "model": "minecraft:block/slab" }
        } }"#;
        let mut entries = files(&[]);
        for (name, value) in templates() {
            entries.insert(&name, serde_json::to_vec(&value).unwrap());
        }
        entries.insert(&format!("{BLOCKSTATES}log.json"), raw.to_vec());
        entries.insert(
            &format!("{MODELS}block/log_y.json"),
            serde_json::to_vec(&json!({ "parent": "block/cube_column", "textures": { "end": "block/log_top", "side": "block/log" } })).unwrap(),
        );
        entries.insert(
            &format!("{MODELS}block/slab.json"),
            serde_json::to_vec(&json!({ "parent": "block/block", "elements": [{ "from": [0, 0, 0], "to": [16, 8, 16] }] })).unwrap(),
        );
        assert_eq!(
            derive(&entries),
            vec![faces("log", "block/log_top", "block/log", None, None)]
        );
    }

    #[test]
    fn north_facing_variant_wins_over_the_first_one() {
        // 发射器的第一个变体是朝下的竖放模型：取它会把正面画成顶面
        let raw = br#"{ "variants": {
            "facing=down,triggered=false": { "model": "minecraft:block/dispenser_vertical", "x": 180 },
            "facing=east,triggered=false": { "model": "minecraft:block/dispenser", "y": 90 },
            "facing=north,triggered=false": { "model": "minecraft:block/dispenser" },
            "facing=up,triggered=false": { "model": "minecraft:block/dispenser_vertical" }
        } }"#;
        let mut entries = files(&[]);
        for (name, value) in templates() {
            entries.insert(&name, serde_json::to_vec(&value).unwrap());
        }
        entries.insert(&format!("{BLOCKSTATES}dispenser.json"), raw.to_vec());
        entries.insert(
            &format!("{MODELS}block/dispenser.json"),
            serde_json::to_vec(&json!({ "parent": "block/orientable", "textures": { "top": "block/furnace_top", "front": "block/dispenser_front", "side": "block/furnace_side" } })).unwrap(),
        );
        entries.insert(
            &format!("{MODELS}block/dispenser_vertical.json"),
            serde_json::to_vec(&json!({ "parent": "block/orientable", "textures": { "top": "block/dispenser_front_vertical", "front": "block/furnace_top", "side": "block/furnace_top" } })).unwrap(),
        );
        assert_eq!(
            derive(&entries),
            vec![faces(
                "dispenser",
                "block/furnace_top",
                "block/furnace_side",
                Some("block/dispenser_front"),
                None
            )]
        );
    }

    #[test]
    fn operator_and_technical_blocks_are_left_out() {
        let blocks = derive_from(vec![
            state("command_block", "minecraft:block/command_block"),
            model(
                "block/command_block",
                json!({ "parent": "minecraft:block/cube_all", "textures": { "all": "minecraft:block/command_block_front" } }),
            ),
            state("frosted_ice", "minecraft:block/frosted_ice_0"),
            model(
                "block/frosted_ice_0",
                json!({ "parent": "minecraft:block/cube_all", "textures": { "all": "minecraft:block/frosted_ice_0" } }),
            ),
            state("stone", "minecraft:block/stone"),
            model(
                "block/stone",
                json!({ "parent": "minecraft:block/cube_all", "textures": { "all": "minecraft:block/stone" } }),
            ),
        ]);
        assert_eq!(
            blocks.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(),
            ["stone"]
        );
    }

    #[test]
    fn custom_shapes_multipart_and_broken_files_are_excluded() {
        let blocks = derive_from(vec![
            // 交叉植物：父链先碰上带 elements 的 cross。
            state("poppy", "minecraft:block/poppy"),
            model(
                "block/poppy",
                json!({ "parent": "minecraft:block/cross", "textures": { "cross": "minecraft:block/poppy" } }),
            ),
            // 自己带 elements 的模型（台阶）。
            state("stone_slab", "minecraft:block/stone_slab"),
            model(
                "block/stone_slab",
                json!({ "parent": "minecraft:block/block", "textures": { "side": "minecraft:block/stone" }, "elements": [] }),
            ),
            // multipart：栅栏。
            (
                format!("{BLOCKSTATES}oak_fence.json"),
                json!({ "multipart": [ { "apply": { "model": "minecraft:block/oak_fence_post" } } ] }),
            ),
            // 没有父模型也没有 elements（箱子这类由代码画的方块）。
            state("chest", "minecraft:block/chest"),
            model(
                "block/chest",
                json!({ "textures": { "particle": "minecraft:block/oak_planks" } }),
            ),
            // 父模型缺失、引用成环、变量没定义、材质在子目录里：文件有问题，跳过并记 warn。
            state("missing_parent", "minecraft:block/missing_parent"),
            model(
                "block/missing_parent",
                json!({ "parent": "minecraft:block/nowhere", "textures": { "all": "minecraft:block/x" } }),
            ),
            state("loop", "minecraft:block/loop_a"),
            model(
                "block/loop_a",
                json!({ "parent": "minecraft:block/loop_b" }),
            ),
            model(
                "block/loop_b",
                json!({ "parent": "minecraft:block/loop_a" }),
            ),
            state("undefined", "minecraft:block/undefined"),
            model(
                "block/undefined",
                json!({ "parent": "minecraft:block/cube_all", "textures": { "side": "minecraft:block/x" } }),
            ),
            state("self_ref", "minecraft:block/self_ref"),
            model(
                "block/self_ref",
                json!({ "parent": "minecraft:block/cube_all", "textures": { "all": "#all" } }),
            ),
            state("nested", "minecraft:block/nested"),
            model(
                "block/nested",
                json!({ "parent": "minecraft:block/cube_all", "textures": { "all": "minecraft:block/sub/nested" } }),
            ),
            state("Upper", "minecraft:block/stone"),
            model(
                "block/stone",
                json!({ "parent": "minecraft:block/cube_all", "textures": { "all": "minecraft:block/stone" } }),
            ),
            (format!("{BLOCKSTATES}garbage.json"), json!("not an object")),
        ]);
        assert_eq!(blocks, Vec::<BlockFaces>::new());
    }

    #[test]
    fn grass_block_is_kept_despite_its_custom_model() {
        let blocks = derive_from(vec![
            state("grass_block", "minecraft:block/grass_block"),
            model(
                "block/grass_block",
                json!({ "parent": "block/block", "textures": { "top": "block/grass_block_top" }, "elements": [] }),
            ),
        ]);
        assert_eq!(
            blocks,
            vec![BlockFaces {
                id: "grass_block".to_owned(),
                top: "block/grass_block_top".to_owned(),
                side: "block/grass_block_side".to_owned(),
                front: None,
                top_tint: Some([124, 189, 107]),
                side_tint: None,
            }]
        );
    }

    fn leaves(id: &str) -> Vec<(String, serde_json::Value)> {
        vec![
            state(id, &format!("minecraft:block/{id}")),
            model(
                &format!("block/{id}"),
                json!({ "parent": "minecraft:block/leaves", "textures": { "all": format!("minecraft:block/{id}") } }),
            ),
        ]
    }

    fn item(id: &str, tints: serde_json::Value) -> (String, serde_json::Value) {
        (
            format!("{ITEMS}{id}.json"),
            json!({ "model": { "type": "minecraft:model", "model": format!("minecraft:block/{id}"), "tints": tints } }),
        )
    }

    #[test]
    fn leaves_take_the_constant_tint_from_item_definitions() {
        let mut entries = Vec::new();
        for id in [
            "oak_leaves",
            "spruce_leaves",
            "birch_leaves",
            "cherry_leaves",
        ] {
            entries.extend(leaves(id));
        }
        entries.extend([
            // 26.3 实测值。
            item(
                "oak_leaves",
                json!([{ "type": "minecraft:constant", "value": -12012264 }]),
            ),
            // 写成无符号也认，只取 RGB。
            item(
                "spruce_leaves",
                json!([{ "type": "minecraft:constant", "value": 4284586337u64 }]),
            ),
            // 有物品定义但染色不是固定色：不染，也不回落到表。
            item(
                "birch_leaves",
                json!([{ "type": "minecraft:foliage", "default": -8345771 }]),
            ),
            (
                format!("{ITEMS}cherry_leaves.json"),
                json!({ "model": { "type": "minecraft:model", "model": "minecraft:block/cherry_leaves" } }),
            ),
        ]);
        let blocks = derive_from(entries);
        assert_eq!(
            blocks,
            vec![
                faces(
                    "birch_leaves",
                    "block/birch_leaves",
                    "block/birch_leaves",
                    None,
                    None
                ),
                faces(
                    "cherry_leaves",
                    "block/cherry_leaves",
                    "block/cherry_leaves",
                    None,
                    None
                ),
                faces(
                    "oak_leaves",
                    "block/oak_leaves",
                    "block/oak_leaves",
                    None,
                    Some([72, 181, 24])
                ),
                faces(
                    "spruce_leaves",
                    "block/spruce_leaves",
                    "block/spruce_leaves",
                    None,
                    Some([97, 153, 97])
                ),
            ]
        );
    }

    #[test]
    fn leaves_in_jars_without_item_definitions_use_the_table() {
        let mut entries = Vec::new();
        for id in [
            "oak_leaves",
            "jungle_leaves",
            "acacia_leaves",
            "dark_oak_leaves",
            "spruce_leaves",
            "birch_leaves",
            "mangrove_leaves",
            "cherry_leaves",
            "azalea_leaves",
        ] {
            entries.extend(leaves(id));
        }
        let blocks = derive_from(entries);
        let tint = |id: &str| find(&blocks, id).expect(id).side_tint;
        assert_eq!(tint("oak_leaves"), Some([72, 181, 24]));
        assert_eq!(tint("jungle_leaves"), Some([72, 181, 24]));
        assert_eq!(tint("acacia_leaves"), Some([72, 181, 24]));
        assert_eq!(tint("dark_oak_leaves"), Some([72, 181, 24]));
        assert_eq!(tint("spruce_leaves"), Some([97, 153, 97]));
        assert_eq!(tint("birch_leaves"), Some([128, 167, 85]));
        assert_eq!(tint("mangrove_leaves"), Some([146, 198, 72]));
        assert_eq!(tint("cherry_leaves"), None);
        assert_eq!(tint("azalea_leaves"), None);
        // 树叶四面都染。
        let oak = find(&blocks, "oak_leaves").unwrap();
        assert_eq!(oak.top_tint, oak.side_tint);
    }

    #[test]
    fn legacy_table_matches_the_item_definition_values() {
        // 26.3 的物品定义：oak -12012264、spruce -10380959、birch -8345771、mangrove -7158200。
        let table = |id: &str| {
            LEGACY_LEAF_TINTS
                .iter()
                .find(|(leaf, _)| *leaf == id)
                .unwrap()
                .1
        };
        assert_eq!(rgb_of_argb(-12012264), table("oak_leaves"));
        assert_eq!(rgb_of_argb(-10380959), table("spruce_leaves"));
        assert_eq!(rgb_of_argb(-8345771), table("birch_leaves"));
        assert_eq!(rgb_of_argb(-7158200), table("mangrove_leaves"));
    }

    fn solid(rgba: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(16, 16, Rgba(rgba))
    }

    #[test]
    fn hue_is_the_alpha_weighted_mean_after_tinting() {
        assert_eq!(side_hue(&solid([255, 0, 0, 255]), None), 0);
        assert_eq!(side_hue(&solid([0, 255, 0, 255]), None), 120);
        assert_eq!(side_hue(&solid([0, 0, 255, 255]), None), 240);
        assert_eq!(side_hue(&solid([255, 255, 0, 255]), None), 60);
        // 无彩色与全透明都是 0。
        assert_eq!(side_hue(&solid([128, 128, 128, 255]), None), 0);
        assert_eq!(side_hue(&solid([255, 0, 0, 0]), None), 0);
        // 359.77 四舍五入成 360，回到 0；359.4 留在 359。
        assert_eq!(side_hue(&solid([255, 0, 1, 255]), None), 0);
        assert_eq!(side_hue(&solid([255, 0, 3, 255]), None), 359);

        // 左半红、右半蓝，红的不透明度 255、蓝的 85：加权均值 (191.25, 0, 63.75)，色相 340。
        let mixed = RgbaImage::from_fn(16, 16, |x, _| {
            if x < 8 {
                Rgba([255, 0, 0, 255])
            } else {
                Rgba([0, 0, 255, 85])
            }
        });
        assert_eq!(side_hue(&mixed, None), 340);
        // 透明像素的颜色不算：一半全透明的绿不影响红。
        let holed = RgbaImage::from_fn(16, 16, |x, _| {
            if x < 8 {
                Rgba([255, 0, 0, 255])
            } else {
                Rgba([0, 255, 0, 0])
            }
        });
        assert_eq!(side_hue(&holed, None), 0);

        // 灰度树叶乘橡树叶染色 (72, 181, 24)：色相 102，不乘就是 0。
        let gray = solid([128, 128, 128, 255]);
        assert_eq!(side_hue(&gray, Some([72, 181, 24])), 102);
        assert_eq!(side_hue(&gray, Some([97, 153, 97])), 120);
    }

    #[test]
    fn names_come_from_block_keys() {
        let lang = parse_lang(
            br#"{ "block.minecraft.stone": "Stone", "block.minecraft.air": "", "item.minecraft.stone": "x" }"#,
        )
        .unwrap();
        assert_eq!(block_name(&lang, "stone").as_deref(), Some("Stone"));
        assert_eq!(block_name(&lang, "air"), None);
        assert_eq!(block_name(&lang, "dirt"), None);
        assert!(parse_lang(b"[1, 2]").is_err());
    }

    #[test]
    fn only_blockstates_models_and_items_are_wanted() {
        assert!(ModelFiles::wants("assets/minecraft/blockstates/stone.json"));
        assert!(ModelFiles::wants(
            "assets/minecraft/models/block/cube_all.json"
        ));
        assert!(ModelFiles::wants("assets/minecraft/items/oak_leaves.json"));
        assert!(!ModelFiles::wants(
            "assets/minecraft/textures/block/stone.png"
        ));
        assert!(!ModelFiles::wants("assets/minecraft/lang/en_us.json"));
        assert!(!ModelFiles::wants("assets/minecraft/blockstates/"));
        let mut files = ModelFiles::default();
        assert!(files.items.is_none());
        files.insert("assets/minecraft/items/oak_leaves.json", b"{}".to_vec());
        assert_eq!(files.items.as_ref().map(HashMap::len), Some(1));
    }

    #[test]
    fn catalog_block_serializes_in_the_frontend_shape() {
        let block = CatalogBlock {
            id: "oak_leaves".to_owned(),
            top: "block/oak_leaves".to_owned(),
            side: "block/oak_leaves".to_owned(),
            front: None,
            top_tint: Some([72, 181, 24]),
            side_tint: Some([72, 181, 24]),
            hue: 102,
            name_en: Some("Oak Leaves".to_owned()),
            name_zh: None,
        };
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({
                "id": "oak_leaves",
                "top": "block/oak_leaves",
                "side": "block/oak_leaves",
                "front": null,
                "top_tint": [72, 181, 24],
                "side_tint": [72, 181, 24],
                "hue": 102,
                "name_en": "Oak Leaves",
                "name_zh": null
            })
        );
    }
}
