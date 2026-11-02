//! 第一次启动前补全 options.txt：游戏语言跟随系统显示语言，默认跳过无障碍引导。
//!
//! 游戏自己不看系统语言，没有 options.txt 就是英文；现代版本第一次进游戏还要先走一遍无障碍引导。启动前在这里
//! 补上缺的行，新建、导入、补全出来的实例都走这一步。已有的行是玩家、整合包或默认设置定下的，意思一律不动；玩家
//! 在游戏里改过之后文件里自然有这些行，这里也就不再介入。唯一的例外是 `lang:` 的大小写要跟着这一局的版本走，
//! 见 [`respell_language`]。
//!
//! 语言码查这个版本的资源索引而不按版本号判断：同一种语言 1.11 起写 `zh_cn`，更早写 `zh_CN`，索引里的
//! 写法就是这个版本认的写法；哪个版本有哪些语言（`zh_hk` 只有新版才有）也一并由索引说了算。

use std::collections::HashMap;
use std::path::Path;

use petalfall_install::GameLayout;
use petalfall_version::AssetObjectsIndex;

use crate::error::{CoreError, Result};
use crate::launch::read_asset_index;

const OPTIONS_FILE: &str = "options.txt";
const LANG_KEY: &[u8] = b"lang:";
const ONBOARDING_KEY: &[u8] = b"onboardAccessibility:";

/// 不认识这个键的旧版本会忽略这一行，所以不必按版本区分。
const SKIP_ONBOARDING_LINE: &str = "onboardAccessibility:false";

/// 游戏的 `OptionsAccessibilityOnboardFix` 挂在这个数据版本上：加载 options.txt 时，数据版本比它低的文件
/// 一律把引导标成走过，没有 `version:` 行按 0 算，所以只写了语言的新文件也在内。
const ONBOARDING_FIX_DATA_VERSION: u32 = 3319;

/// 游戏默认语言。它在客户端 jar 里，资源索引查不到，要在查索引之前认出来。
const GAME_DEFAULT: &str = "en_us";

/// 系统语言的地区在索引里没有时退到的语言码。这张表只写把握大的：表外的语言猜一个地区不如保持英文。
/// `nb` 单列：书面挪威语在游戏里叫 `no_no`，没有 `nb_no`。
const DEFAULT_LANGUAGES: [(&str, &str); 26] = [
    ("ar", "ar_sa"),
    ("cs", "cs_cz"),
    ("da", "da_dk"),
    ("de", "de_de"),
    ("el", "el_gr"),
    ("en", GAME_DEFAULT),
    ("es", "es_es"),
    ("fi", "fi_fi"),
    ("fr", "fr_fr"),
    ("he", "he_il"),
    ("hu", "hu_hu"),
    ("id", "id_id"),
    ("it", "it_it"),
    ("ja", "ja_jp"),
    ("ko", "ko_kr"),
    ("nb", "no_no"),
    ("nl", "nl_nl"),
    ("pl", "pl_pl"),
    ("pt", "pt_br"),
    ("ro", "ro_ro"),
    ("ru", "ru_ru"),
    ("sv", "sv_se"),
    ("th", "th_th"),
    ("tr", "tr_tr"),
    ("uk", "uk_ua"),
    ("vi", "vi_vn"),
];

/// 模组放默认设置的位置（YOSBR、Default Options）。这两个模组只在 options.txt 不存在时才把它铺过去，
/// 启动器抢先写一份，整合包作者调好的设置就全作废了。
const MOD_DEFAULT_OPTIONS: [&str; 2] = [
    "config/yosbr/options.txt",
    "config/defaultoptions/options.txt",
];

/// 系统语言能落到的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
enum GameLanguage {
    /// 写进 `lang:` 的语言码，大小写是索引里的原样。
    Code(String),
    /// 就是游戏默认语言，不用写。
    GameDefault,
    /// 这个版本的索引里没有对应语言。
    Unavailable,
}

/// 这个版本的索引里有的语言：全小写的语言码到索引里的原样写法。
fn index_languages(index: &AssetObjectsIndex) -> HashMap<String, &str> {
    index
        .objects
        .keys()
        .filter_map(|logical| language_code(logical))
        .map(|code| (code.to_ascii_lowercase(), code))
        .collect()
}

/// 系统语言标签在这个版本的资源索引里对应的语言。
fn resolve_game_language(system: &str, index: &AssetObjectsIndex) -> GameLanguage {
    let available = index_languages(index);
    for candidate in candidates(system) {
        if candidate == GAME_DEFAULT {
            return GameLanguage::GameDefault;
        }
        if let Some(code) = available.get(&candidate) {
            return GameLanguage::Code((*code).to_owned());
        }
    }
    GameLanguage::Unavailable
}

/// 资源逻辑名里的语言码。1.7 起是 `minecraft/lang/`，`legacy` 索引（1.6）是 `lang/`。`realms/lang/` 不算：
/// 那是 Realms 界面的翻译，有它不等于游戏有这门语言。
fn language_code(logical: &str) -> Option<&str> {
    let file = logical
        .strip_prefix("minecraft/lang/")
        .or_else(|| logical.strip_prefix("lang/"))?;
    file.strip_suffix(".json")
        .or_else(|| file.strip_suffix(".lang"))
}

/// 语言标签（`zh-Hans-CN`、`de-AT`）对应的语言码，全部小写，靠前的优先。
fn candidates(tag: &str) -> Vec<String> {
    let tag = tag.to_ascii_lowercase();
    let mut subtags = tag.split(['-', '_']);
    let Some(language) = subtags.next() else {
        return Vec::new();
    };
    // 单字母子标签之后是扩展（`-u-co-phonebk`），里面的两字母段不是地区。
    let subtags: Vec<&str> = subtags.take_while(|subtag| subtag.len() > 1).collect();
    let region = subtags.iter().copied().find(|subtag| subtag.len() == 2);
    if language == "zh" {
        return chinese_candidates(&subtags, region)
            .iter()
            .map(|code| (*code).to_owned())
            .collect();
    }
    let exact = region.map(|region| format!("{language}_{region}"));
    let default = DEFAULT_LANGUAGES
        .iter()
        .find(|(name, _)| *name == language)
        .map(|(_, code)| (*code).to_owned());
    exact.into_iter().chain(default).collect()
}

/// 中文按简繁分，不按地区名拼：`zh_sg` 这样的语言码并不存在，新加坡用的是简体。
fn chinese_candidates(subtags: &[&str], region: Option<&str>) -> &'static [&'static str] {
    if subtags.contains(&"hans") {
        return &["zh_cn"];
    }
    match region {
        Some("hk" | "mo") => &["zh_hk", "zh_tw"],
        Some("tw") => &["zh_tw"],
        _ if subtags.contains(&"hant") => &["zh_tw"],
        _ => &["zh_cn"],
    }
}

/// options.txt 里是否已有这个键的一行。按字节看：文件不一定是 UTF-8，读成字符串再写回会毁掉别的内容。
fn has_line(options: &[u8], key: &[u8]) -> bool {
    options
        .split(|byte| matches!(byte, b'\n' | b'\r'))
        .any(|line| line.starts_with(key))
}

/// 文件不存在，或存在但没有这个键。
fn lacks(existing: Option<&[u8]>, key: &[u8]) -> bool {
    !existing.is_some_and(|options| has_line(options, key))
}

/// 文件里有默认语言以外的 `lang:` 行。
fn names_another_language(options: &[u8]) -> bool {
    options
        .split(|byte| matches!(byte, b'\n' | b'\r'))
        .filter_map(|line| line.strip_prefix(LANG_KEY))
        .any(|value| !value.eq_ignore_ascii_case(GAME_DEFAULT.as_bytes()))
}

/// `lang:` 行换成这个版本的大小写后的完整内容，什么都不用改时返回 `None`。
///
/// 默认隔离策略下原版实例共用一份 options.txt，而语言码的大小写 1.11 变过：新版留下的 `zh_cn` 老版不认，老版
/// 写法的 `zh_CN` 碰上文件里新版的 `version:` 也不走游戏自己的小写迁移，两头都退回英文。只差大小写还是同一门
/// 语言，换写法不算改玩家的选择；这个版本没有的语言原样留着。
fn respell_language(options: &[u8], languages: &HashMap<String, &str>) -> Option<Vec<u8>> {
    let mut written = options.to_vec();
    for line in written.split_mut(|byte| matches!(byte, b'\n' | b'\r')) {
        if !line.starts_with(LANG_KEY) {
            continue;
        }
        let value = &mut line[LANG_KEY.len()..];
        let known = std::str::from_utf8(value)
            .ok()
            .and_then(|code| languages.get(&code.to_ascii_lowercase()));
        if let Some(code) = known {
            value.copy_from_slice(code.as_bytes());
        }
    }
    (written != options).then_some(written)
}

/// 加上这些行后的完整内容：原内容逐字节保留，换行风格跟随原文件。
fn with_lines(options: &[u8], lines: &[String]) -> Vec<u8> {
    let newline: &[u8] = match options.iter().position(|byte| *byte == b'\n') {
        Some(end) if end > 0 && options[end - 1] == b'\r' => b"\r\n",
        _ => b"\n",
    };
    let mut written = options.to_vec();
    if !options.is_empty() && !options.ends_with(b"\n") {
        written.extend_from_slice(newline);
    }
    for line in lines {
        written.extend_from_slice(line.as_bytes());
        written.extend_from_slice(newline);
    }
    written
}

/// 补上缺的行后的完整内容；`existing` 是现有内容（文件不存在时为 `None`），什么都不用补时返回 `None`。
fn fill_options(
    existing: Option<&[u8]>,
    language: Option<&str>,
    skip_onboarding: bool,
) -> Option<Vec<u8>> {
    let mut lines = Vec::new();
    if let Some(code) = language.filter(|_| lacks(existing, LANG_KEY)) {
        // 玩家要看引导时，只写语言的新文件反而会让游戏把引导标成走过（见 ONBOARDING_FIX_DATA_VERSION）。
        // 比这个版本老的游戏遇到更高的声明版本什么也不做，新文件里也没有要迁移的内容。已有的文件不加：
        // 声明版本会让它跳过自己需要的迁移，引导弹不弹本来就由它自己的版本决定。
        if existing.is_none() && !skip_onboarding {
            lines.push(format!("version:{ONBOARDING_FIX_DATA_VERSION}"));
        }
        lines.push(format!("lang:{code}"));
    }
    if skip_onboarding && lacks(existing, ONBOARDING_KEY) {
        lines.push(SKIP_ONBOARDING_LINE.to_owned());
    }
    (!lines.is_empty()).then(|| with_lines(existing.unwrap_or_default(), &lines))
}

/// 等着模组铺过去的默认设置。
async fn pending_mod_defaults(working_dir: &Path) -> Result<Option<&'static str>> {
    for relative in MOD_DEFAULT_OPTIONS {
        let path = working_dir.join(relative);
        let exists = tokio::fs::try_exists(&path)
            .await
            .map_err(|source| petalfall_base::Error::Io { path, source })?;
        if exists {
            return Ok(Some(relative));
        }
    }
    Ok(None)
}

/// 决定要补哪些行所需的启动时状态。
pub(crate) struct OptionsInputs<'a> {
    /// 系统显示语言的 BCP 47 标签；读不出来时为 `None`。
    pub(crate) system: Option<&'a str>,
    /// 这个版本的资源索引 id；版本没有资源索引时为 `None`。
    pub(crate) asset_index_id: Option<&'a str>,
    /// 配置里的 `skip_accessibility_onboarding`。
    pub(crate) skip_onboarding: bool,
}

/// 补全的经过，由调用方写进启动日志。
#[derive(Debug, Default)]
pub(crate) struct OptionsReport {
    /// 做了什么，或语言为什么没写。
    pub(crate) notes: Vec<String>,
    /// 这一步没做成的原因。这里只有便利项，不该为它挡下启动，所以不向上冒泡。
    pub(crate) failures: Vec<CoreError>,
}

/// 补全工作目录里的 options.txt。
pub(crate) async fn fill_missing_options(
    inputs: &OptionsInputs<'_>,
    layout: &GameLayout,
    working_dir: &Path,
) -> OptionsReport {
    let mut report = OptionsReport::default();
    if let Err(err) = fill(inputs, layout, working_dir, &mut report).await {
        report.failures.push(err);
    }
    report
}

async fn fill(
    inputs: &OptionsInputs<'_>,
    layout: &GameLayout,
    working_dir: &Path,
    report: &mut OptionsReport,
) -> Result<()> {
    let path = working_dir.join(OPTIONS_FILE);
    let existing = match tokio::fs::read(&path).await {
        Ok(bytes) => Some(bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(source) => return Err(petalfall_base::Error::Io { path, source }.into()),
    };
    let existing = existing.as_deref();
    if existing.is_none()
        && let Some(pending) = pending_mod_defaults(working_dir).await?
    {
        report.notes.push(format!(
            "{pending} 会在第一次启动时铺默认设置，游戏语言与无障碍引导留给它决定"
        ));
        return Ok(());
    }
    let language = if lacks(existing, LANG_KEY) {
        choose_language(inputs, layout, report).await
    } else {
        None
    };
    let respelled = match existing {
        Some(options) => respell_existing_language(options, inputs, layout, report).await,
        None => None,
    };
    let was_respelled = respelled.is_some();
    let filled = fill_options(
        respelled.as_deref().or(existing),
        language.as_deref(),
        inputs.skip_onboarding,
    );
    let Some(content) = filled.or(respelled) else {
        return Ok(());
    };
    petalfall_base::fs::atomic_write(&path, &content).await?;
    if let (Some(code), Some(system)) = (&language, inputs.system) {
        report
            .notes
            .push(format!("游戏语言设为 {code}，跟随系统语言 {system}"));
    }
    if was_respelled {
        report
            .notes
            .push("游戏语言的写法换成这个版本的大小写".to_owned());
    }
    if inputs.skip_onboarding && lacks(existing, ONBOARDING_KEY) {
        report.notes.push("已跳过游戏的首次无障碍引导".to_owned());
    }
    Ok(())
}

/// 现有语言按这个版本的写法改过后的内容（见 [`respell_language`]）。索引读不出来只算这一项没做成，记进
/// `report`，引导那一行照写。
async fn respell_existing_language(
    options: &[u8],
    inputs: &OptionsInputs<'_>,
    layout: &GameLayout,
    report: &mut OptionsReport,
) -> Option<Vec<u8>> {
    // 默认语言不在索引里，也没有写法之分。英文玩家每局都走到这里，不为它读一次索引。
    if !names_another_language(options) {
        return None;
    }
    let id = inputs.asset_index_id?;
    match read_asset_index(layout, id).await {
        Ok(index) => respell_language(options, &index_languages(&index)),
        Err(err) => {
            report.failures.push(err);
            None
        }
    }
}

/// 这个版本的 `lang:` 该写什么。写不了时为 `None`，原因记进 `report`：索引读不出来只算语言这一项没做成，
/// 引导那一行照写。
async fn choose_language(
    inputs: &OptionsInputs<'_>,
    layout: &GameLayout,
    report: &mut OptionsReport,
) -> Option<String> {
    let Some(system) = inputs.system else {
        report
            .notes
            .push("读不出系统语言，游戏语言保持默认".to_owned());
        return None;
    };
    let Some(id) = inputs.asset_index_id else {
        report
            .notes
            .push("这个版本没有资源索引，游戏语言保持默认".to_owned());
        return None;
    };
    let index = match read_asset_index(layout, id).await {
        Ok(index) => index,
        Err(err) => {
            report.failures.push(err);
            return None;
        }
    };
    match resolve_game_language(system, &index) {
        GameLanguage::Code(code) => Some(code),
        GameLanguage::GameDefault => None,
        GameLanguage::Unavailable => {
            report.notes.push(format!(
                "这个版本的资源索引里没有系统语言 {system}，游戏语言保持默认"
            ));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use petalfall_version::AssetObject;
    use std::collections::BTreeMap;

    /// 下面几组键节选自官方资源索引，覆盖了语言键写法变化的每一处。
    /// 1.5.2（pre-1.6）：索引里没有语言文件，语言在客户端 jar 里。
    const V1_5_2: &[&str] = &["sound/step/grass1.ogg", "music/calm1.ogg"];
    /// 1.6.4（legacy）：没有 `minecraft/` 前缀。
    const V1_6_4: &[&str] = &[
        "lang/de_DE.lang",
        "lang/en_GB.lang",
        "lang/nn_NO.lang",
        "lang/no_NO.lang",
        "lang/pt_BR.lang",
        "lang/pt_PT.lang",
        "lang/zh_CN.lang",
        "lang/zh_TW.lang",
    ];
    /// 1.7.10：`minecraft/` 与 `realms/` 各有一份，大小写是 `zh_CN`。
    const V1_7_10: &[&str] = &[
        "minecraft/lang/de_DE.lang",
        "minecraft/lang/en_GB.lang",
        "minecraft/lang/fr_FR.lang",
        "minecraft/lang/zh_CN.lang",
        "minecraft/lang/zh_TW.lang",
        "realms/lang/de_DE.lang",
        "realms/lang/zh_CN.lang",
    ];
    /// 1.8.9 写法同 1.7.10。
    const V1_8_9: &[&str] = &["minecraft/lang/zh_CN.lang", "minecraft/lang/zh_TW.lang"];
    /// 1.10.2：大写区域的最后一个大版本。
    const V1_10_2: &[&str] = &[
        "minecraft/lang/zh_CN.lang",
        "minecraft/lang/zh_TW.lang",
        "realms/lang/zh_CN.lang",
    ];
    /// 1.11.2：大小写换成 `zh_cn`，扩展名还是 `.lang`。
    const V1_11_2: &[&str] = &[
        "minecraft/lang/de_at.lang",
        "minecraft/lang/de_de.lang",
        "minecraft/lang/zh_cn.lang",
        "minecraft/lang/zh_tw.lang",
        "realms/lang/zh_cn.lang",
    ];
    /// 1.12.2 写法同 1.11.2。
    const V1_12_2: &[&str] = &["minecraft/lang/zh_cn.lang", "minecraft/lang/zh_tw.lang"];
    /// 1.13.2：扩展名换成 `.json`，还没有 `zh_hk`。
    const V1_13_2: &[&str] = &[
        "minecraft/lang/zh_cn.json",
        "minecraft/lang/zh_tw.json",
        "realms/lang/zh_cn.json",
    ];
    /// 1.20.1：有 `zh_hk`，`en_us` 在客户端 jar 里，索引里没有。
    const V1_20_1: &[&str] = &[
        "minecraft/lang/ca_es.json",
        "minecraft/lang/de_at.json",
        "minecraft/lang/de_de.json",
        "minecraft/lang/en_gb.json",
        "minecraft/lang/es_es.json",
        "minecraft/lang/es_mx.json",
        "minecraft/lang/fr_fr.json",
        "minecraft/lang/ja_jp.json",
        "minecraft/lang/ko_kr.json",
        "minecraft/lang/lzh.json",
        "minecraft/lang/nn_no.json",
        "minecraft/lang/no_no.json",
        "minecraft/lang/pt_br.json",
        "minecraft/lang/pt_pt.json",
        "minecraft/lang/ru_ru.json",
        "minecraft/lang/zh_cn.json",
        "minecraft/lang/zh_hk.json",
        "minecraft/lang/zh_tw.json",
    ];
    /// 1.21.1 的 `realms/` 下只有一个 `en_us`，它不是游戏语言；26.3 也是这样。
    const V1_21_1: &[&str] = &[
        "minecraft/lang/zh_cn.json",
        "minecraft/lang/zh_hk.json",
        "minecraft/lang/zh_tw.json",
        "realms/lang/en_us.json",
    ];

    fn index(keys: &[&str]) -> AssetObjectsIndex {
        let objects: BTreeMap<String, AssetObject> = keys
            .iter()
            .map(|key| {
                let object = AssetObject {
                    hash: "ab".repeat(20),
                    size: 1,
                };
                ((*key).to_owned(), object)
            })
            .collect();
        AssetObjectsIndex {
            objects,
            ..AssetObjectsIndex::default()
        }
    }

    fn code(code: &str) -> GameLanguage {
        GameLanguage::Code(code.to_owned())
    }

    #[test]
    fn system_language_resolves_against_the_index_of_each_version() {
        use GameLanguage::{GameDefault, Unavailable};
        let cases: &[(&str, &[&str], GameLanguage)] = &[
            // 简体：各种写法归 zh_cn，大小写跟着索引走。
            ("zh-CN", V1_21_1, code("zh_cn")),
            ("zh-CN", V1_20_1, code("zh_cn")),
            ("zh-CN", V1_13_2, code("zh_cn")),
            ("zh-CN", V1_12_2, code("zh_cn")),
            ("zh-CN", V1_11_2, code("zh_cn")),
            ("zh-CN", V1_10_2, code("zh_CN")),
            ("zh-CN", V1_8_9, code("zh_CN")),
            ("zh-CN", V1_7_10, code("zh_CN")),
            ("zh-CN", V1_6_4, code("zh_CN")),
            ("zh-Hans", V1_20_1, code("zh_cn")),
            ("zh-Hans-CN", V1_20_1, code("zh_cn")),
            ("zh-Hans-HK", V1_20_1, code("zh_cn")),
            ("zh-SG", V1_20_1, code("zh_cn")),
            ("zh-Hans-SG", V1_7_10, code("zh_CN")),
            ("zh", V1_20_1, code("zh_cn")),
            ("zh_CN", V1_20_1, code("zh_cn")),
            // 繁体。
            ("zh-TW", V1_20_1, code("zh_tw")),
            ("zh-TW", V1_7_10, code("zh_TW")),
            ("zh-Hant", V1_20_1, code("zh_tw")),
            ("zh-Hant-TW", V1_6_4, code("zh_TW")),
            // 香港优先 zh_hk，老版本没有时退到 zh_tw；澳门同理。
            ("zh-HK", V1_20_1, code("zh_hk")),
            ("zh-Hant-HK", V1_21_1, code("zh_hk")),
            ("zh-MO", V1_20_1, code("zh_hk")),
            ("zh-HK", V1_13_2, code("zh_tw")),
            ("zh-HK", V1_11_2, code("zh_tw")),
            ("zh-HK", V1_7_10, code("zh_TW")),
            // 索引里没有 en_us，但它就是游戏默认语言，不算找不到。
            ("en-US", V1_21_1, GameDefault),
            ("en-US", V1_7_10, GameDefault),
            ("en-US", V1_5_2, GameDefault),
            ("en", V1_20_1, GameDefault),
            ("en-IN", V1_20_1, GameDefault),
            ("en-NZ", V1_7_10, GameDefault),
            ("en-GB", V1_20_1, code("en_gb")),
            ("en-GB", V1_7_10, code("en_GB")),
            // 其它语言先精确匹配，没有就退到默认区域。
            ("de-AT", V1_20_1, code("de_at")),
            ("de-AT", V1_7_10, code("de_DE")),
            ("de-LU", V1_20_1, code("de_de")),
            ("de-DE-u-co-phonebk", V1_20_1, code("de_de")),
            ("fr-BE", V1_20_1, code("fr_fr")),
            ("es-MX", V1_20_1, code("es_mx")),
            ("es-419", V1_20_1, code("es_es")),
            ("pt-PT", V1_20_1, code("pt_pt")),
            ("pt-AO", V1_20_1, code("pt_br")),
            ("pt", V1_6_4, code("pt_BR")),
            ("ja", V1_20_1, code("ja_jp")),
            ("ko-KR", V1_20_1, code("ko_kr")),
            ("ru-BY", V1_20_1, code("ru_ru")),
            ("ca-ES-valencia", V1_20_1, code("ca_es")),
            // 书面挪威语在游戏里叫 no_no，索引里没有 nb_no。
            ("nb-NO", V1_20_1, code("no_no")),
            ("nb-NO", V1_6_4, code("no_NO")),
            ("nn-NO", V1_20_1, code("nn_no")),
            // 表外的语言没有精确匹配就不写，索引里没有的语言也不写。
            ("sw-KE", V1_20_1, Unavailable),
            ("xx", V1_20_1, Unavailable),
            ("", V1_20_1, Unavailable),
            ("zh-CN", V1_5_2, Unavailable),
            ("zh-CN", &[], Unavailable),
            ("ko-KR", &["minecraft/lang/zh_cn.json"], Unavailable),
            ("zh-HK", &["minecraft/lang/zh_cn.json"], Unavailable),
            // realms 的语言文件不是游戏语言。
            ("fr-FR", &["realms/lang/fr_fr.json"], Unavailable),
            ("zh-CN", &["realms/lang/zh_cn.lang"], Unavailable),
            // 语言目录外面的同名文件也不是。
            ("zh-CN", &["minecraft/texts/zh_cn.json"], Unavailable),
            ("zh-CN", &["minecraft/lang/zh_cn.png"], Unavailable),
        ];
        for (system, keys, expected) in cases {
            assert_eq!(
                resolve_game_language(system, &index(keys)),
                *expected,
                "系统语言 {system}，索引 {keys:?}"
            );
        }
    }

    /// 与 [`fill`] 同一条路：系统语言先查索引，查到的语言码再和现有内容合成要写的内容。
    fn filled(
        system: &str,
        keys: &[&str],
        existing: Option<&[u8]>,
        skip_onboarding: bool,
    ) -> Option<Vec<u8>> {
        let language = match resolve_game_language(system, &index(keys)) {
            GameLanguage::Code(code) => Some(code),
            GameLanguage::GameDefault | GameLanguage::Unavailable => None,
        };
        fill_options(existing, language.as_deref(), skip_onboarding)
    }

    fn text(content: &str) -> Option<&[u8]> {
        Some(content.as_bytes())
    }

    #[test]
    fn missing_lines_are_filled_in_one_write_and_existing_ones_stay() {
        type Case<'a> = (
            &'a str,
            &'a [&'a str],
            Option<&'a [u8]>,
            bool,
            Option<&'a [u8]>,
        );
        const SKIP: &str = "onboardAccessibility:false\n";
        let cases: &[Case] = &[
            // 文件不存在：语言与引导写进同一份内容，语言码的大小写跟着索引。
            (
                "zh-CN",
                V1_21_1,
                None,
                true,
                text("lang:zh_cn\nonboardAccessibility:false\n"),
            ),
            (
                "zh-CN",
                V1_7_10,
                None,
                true,
                text("lang:zh_CN\nonboardAccessibility:false\n"),
            ),
            (
                "zh-CN",
                V1_6_4,
                None,
                true,
                text("lang:zh_CN\nonboardAccessibility:false\n"),
            ),
            (
                "zh-TW",
                V1_20_1,
                None,
                true,
                text("lang:zh_tw\nonboardAccessibility:false\n"),
            ),
            (
                "zh-HK",
                V1_21_1,
                None,
                true,
                text("lang:zh_hk\nonboardAccessibility:false\n"),
            ),
            (
                "zh-HK",
                V1_13_2,
                None,
                true,
                text("lang:zh_tw\nonboardAccessibility:false\n"),
            ),
            // 不写语言时引导照写。
            ("en-US", V1_21_1, None, true, text(SKIP)),
            ("sw-KE", V1_21_1, None, true, text(SKIP)),
            ("zh-CN", V1_5_2, None, true, text(SKIP)),
            // 开关关掉：不写引导。新文件只有语言时带上数据版本，否则游戏会把引导标成走过。
            (
                "zh-CN",
                V1_21_1,
                None,
                false,
                text("version:3319\nlang:zh_cn\n"),
            ),
            (
                "zh-CN",
                V1_7_10,
                None,
                false,
                text("version:3319\nlang:zh_CN\n"),
            ),
            ("en-US", V1_21_1, None, false, None),
            ("sw-KE", V1_21_1, None, false, None),
            // 已有文件：缺哪行补哪行，换行风格跟随原文件，不额外声明数据版本。
            (
                "zh-CN",
                V1_21_1,
                text("version:3955\r\nfov:0.5\r\n"),
                true,
                text("version:3955\r\nfov:0.5\r\nlang:zh_cn\r\nonboardAccessibility:false\r\n"),
            ),
            (
                "zh-CN",
                V1_21_1,
                text("fov:0.5\n"),
                true,
                text("fov:0.5\nlang:zh_cn\nonboardAccessibility:false\n"),
            ),
            (
                "zh-CN",
                V1_21_1,
                text("fov:0.5\n"),
                false,
                text("fov:0.5\nlang:zh_cn\n"),
            ),
            ("zh-CN", V1_21_1, text(""), false, text("lang:zh_cn\n")),
            (
                "en-US",
                V1_21_1,
                text("fov:0.5\r\n"),
                true,
                text("fov:0.5\r\nonboardAccessibility:false\r\n"),
            ),
            ("en-US", V1_21_1, text("fov:0.5\r\n"), false, None),
            // 已有 lang 不动，哪怕和系统语言不一样。
            (
                "zh-CN",
                V1_21_1,
                text("lang:en_us\r\nfov:0.5\r\n"),
                true,
                text("lang:en_us\r\nfov:0.5\r\nonboardAccessibility:false\r\n"),
            ),
            (
                "zh-CN",
                V1_21_1,
                text("lang:en_us\r\nfov:0.5\r\n"),
                false,
                None,
            ),
            // 已有引导行不动，不管是开是关、开关怎么设。
            (
                "zh-CN",
                V1_21_1,
                text("onboardAccessibility:true\n"),
                true,
                text("onboardAccessibility:true\nlang:zh_cn\n"),
            ),
            (
                "zh-CN",
                V1_21_1,
                text("onboardAccessibility:false\n"),
                false,
                text("onboardAccessibility:false\nlang:zh_cn\n"),
            ),
            // 两行都有时什么都不写。
            (
                "zh-CN",
                V1_21_1,
                text("lang:de_de\nonboardAccessibility:true\n"),
                true,
                None,
            ),
            (
                "zh-CN",
                V1_21_1,
                text("lang:de_de\nonboardAccessibility:true\n"),
                false,
                None,
            ),
        ];
        for (system, keys, existing, skip, expected) in cases {
            assert_eq!(
                filled(system, keys, *existing, *skip).as_deref(),
                *expected,
                "系统语言 {system}，原内容 {:?}，开关 {skip}",
                existing.map(String::from_utf8_lossy),
            );
        }
    }

    #[test]
    fn only_a_real_line_counts_as_already_set() {
        let cases: &[(&[u8], &[u8], bool)] = &[
            (b"lang:en_us\n", LANG_KEY, true),
            (b"fov:90\nlang:de_de\nguiScale:2\n", LANG_KEY, true),
            (b"fov:90\r\nlang:zh_CN\r\nguiScale:2\r\n", LANG_KEY, true),
            (b"fov:90\nlang:ja_jp", LANG_KEY, true),
            // 值是空的也是一行 lang，不替玩家判断它对不对。
            (b"lang:\n", LANG_KEY, true),
            (b"\xff\xfe:\xd6\xd0\nlang:zh_cn\n", LANG_KEY, true),
            (b"", LANG_KEY, false),
            (b"fov:90\n", LANG_KEY, false),
            (b"fov:90\r\nguiScale:2\r\n", LANG_KEY, false),
            (b"language:zh_cn\n", LANG_KEY, false),
            (b"xlang:zh_cn\n", LANG_KEY, false),
            (b" lang:zh_cn\n", LANG_KEY, false),
            (b"Lang:zh_cn\n", LANG_KEY, false),
            (b"key_key.lang:key.keyboard.l\n", LANG_KEY, false),
            (b"lang\n", LANG_KEY, false),
            (b"onboardAccessibility:true\n", ONBOARDING_KEY, true),
            (
                b"fov:90\r\nonboardAccessibility:false\r\n",
                ONBOARDING_KEY,
                true,
            ),
            (b"onboardAccessibility:", ONBOARDING_KEY, true),
            (b"fov:90\n", ONBOARDING_KEY, false),
            (b"onboardAccessibility\n", ONBOARDING_KEY, false),
            (b"xonboardAccessibility:false\n", ONBOARDING_KEY, false),
        ];
        for (options, key, expected) in cases {
            assert_eq!(
                has_line(options, key),
                *expected,
                "{:?}",
                String::from_utf8_lossy(options)
            );
        }
    }

    #[test]
    fn existing_language_takes_the_spelling_of_the_version_being_launched() {
        type Case<'a> = (&'a [u8], &'a [&'a str], Option<&'a [u8]>);
        let cases: &[Case] = &[
            // 新版写下的小写，老版不认，会退回英文。
            (
                b"lang:zh_cn\nonboardAccessibility:false\n",
                V1_8_9,
                Some(b"lang:zh_CN\nonboardAccessibility:false\n"),
            ),
            (b"lang:zh_cn\n", V1_7_10, Some(b"lang:zh_CN\n")),
            (b"lang:zh_cn\n", V1_6_4, Some(b"lang:zh_CN\n")),
            (
                b"lang:zh_tw\r\nfov:0.5\r\n",
                V1_7_10,
                Some(b"lang:zh_TW\r\nfov:0.5\r\n"),
            ),
            (b"lang:de_de\n", V1_7_10, Some(b"lang:de_DE\n")),
            // 反过来：带着 version: 行的大写，新版不走自己的小写迁移，同样退回英文。
            (
                b"version:2586\nlang:zh_CN\n",
                V1_20_1,
                Some(b"version:2586\nlang:zh_cn\n"),
            ),
            (
                b"lang:zh_CN\nfov:0.5",
                V1_12_2,
                Some(b"lang:zh_cn\nfov:0.5"),
            ),
            // 其余内容逐字节留着，换行也不动。
            (
                b"\xff\xfe:1\r\nlang:zh_cn\r\nfov:0.5",
                V1_8_9,
                Some(b"\xff\xfe:1\r\nlang:zh_CN\r\nfov:0.5"),
            ),
            // 写法已经是这个版本的：不用写。
            (b"lang:zh_CN\n", V1_8_9, None),
            (b"lang:zh_cn\n", V1_20_1, None),
            // 不是同一门语言，或这个版本没有这门语言：不替玩家换语言。
            (b"lang:ja_jp\n", V1_8_9, None),
            (b"lang:zh_hk\n", V1_7_10, None),
            (b"lang:en_us\n", V1_7_10, None),
            (b"lang:\n", V1_8_9, None),
            (b"lang:\xd6\xd0\n", V1_8_9, None),
            // 索引里没有语言（1.5.2）：无从判断写法。
            (b"lang:zh_cn\n", V1_5_2, None),
            // realms 的语言文件不算。
            (b"lang:zh_cn\n", &["realms/lang/zh_CN.lang"], None),
            // 名字里带 lang 的别的键。
            (b"xlang:zh_cn\nkey_key.lang:zh_cn\n", V1_8_9, None),
            (b"fov:0.5\n", V1_8_9, None),
            (b"", V1_8_9, None),
        ];
        for (options, keys, expected) in cases {
            assert_eq!(
                respell_language(options, &index_languages(&index(keys))).as_deref(),
                *expected,
                "原内容 {:?}，索引 {keys:?}",
                String::from_utf8_lossy(options),
            );
        }
    }

    /// 随机内容：改写法只动 `lang:` 行的值，文件长度不变，其它位置一个字节不差。
    #[test]
    fn respelling_only_touches_the_language_value() {
        let languages = index(V1_8_9);
        let languages = index_languages(&languages);
        for _ in 0..200 {
            let noise = || -> Vec<u8> {
                std::iter::repeat_with(|| fastrand::u8(..))
                    .filter(|byte| !matches!(byte, b'\n' | b'\r'))
                    .take(fastrand::usize(0..512))
                    .collect()
            };
            let (before, after) = (noise(), noise());
            let lang = b"\nlang:zh_cn\n";
            let options = [&before[..], lang, &after[..]].concat();

            let written = respell_language(&options, &languages).unwrap();

            let expected = [&before[..], b"\nlang:zh_CN\n", &after[..]].concat();
            assert_eq!(written, expected);
        }
    }

    #[test]
    fn added_lines_follow_the_newline_style_of_the_file() {
        let cases: &[(&[u8], &[u8])] = &[
            (b"", b"lang:zh_cn\n"),
            (b"fov:90\n", b"fov:90\nlang:zh_cn\n"),
            (b"fov:90", b"fov:90\nlang:zh_cn\n"),
            (
                b"fov:90\r\nguiScale:2\r\n",
                b"fov:90\r\nguiScale:2\r\nlang:zh_cn\r\n",
            ),
            (
                b"fov:90\r\nguiScale:2",
                b"fov:90\r\nguiScale:2\r\nlang:zh_cn\r\n",
            ),
            // 不是 UTF-8 的内容也要原样留着。
            (b"\xd6\xd0:1\r\n", b"\xd6\xd0:1\r\nlang:zh_cn\r\n"),
        ];
        for (options, expected) in cases {
            assert_eq!(
                with_lines(options, &["lang:zh_cn".to_owned()]),
                *expected,
                "{:?}",
                String::from_utf8_lossy(options)
            );
        }
    }

    /// 随机内容：原文件必须一个字节不差地留在开头，新增的只有末尾缺的行。
    #[test]
    fn appending_keeps_every_original_byte() {
        let lines = ["lang:zh_CN".to_owned(), SKIP_ONBOARDING_LINE.to_owned()];
        for _ in 0..200 {
            let options: Vec<u8> = std::iter::repeat_with(|| fastrand::u8(..))
                .take(fastrand::usize(0..2048))
                .collect();
            let written = with_lines(&options, &lines);
            assert!(written.starts_with(&options));
            let added = &written[options.len()..];
            assert!(
                [
                    &b"lang:zh_CN\nonboardAccessibility:false\n"[..],
                    b"lang:zh_CN\r\nonboardAccessibility:false\r\n",
                    b"\nlang:zh_CN\nonboardAccessibility:false\n",
                    b"\r\nlang:zh_CN\r\nonboardAccessibility:false\r\n",
                ]
                .contains(&added),
                "{added:?}"
            );
            assert!(has_line(&written, LANG_KEY));
            assert!(has_line(&written, ONBOARDING_KEY));
        }
    }

    struct Scene {
        _tmp: tempfile::TempDir,
        layout: GameLayout,
        working_dir: std::path::PathBuf,
    }

    /// 索引 `lang-test` 在本地，内容是给定的键。
    fn scene(keys: &[&str]) -> Scene {
        let tmp = tempfile::tempdir().unwrap();
        let layout = GameLayout::new(tmp.path().join(".minecraft"));
        let path = layout.asset_index_json("lang-test").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_vec(&index(keys)).unwrap()).unwrap();
        let working_dir = tmp.path().join("instance");
        std::fs::create_dir_all(&working_dir).unwrap();
        Scene {
            _tmp: tmp,
            layout,
            working_dir,
        }
    }

    impl Scene {
        async fn fill_with(
            &self,
            system: Option<&str>,
            asset_index_id: Option<&str>,
            skip_onboarding: bool,
        ) -> OptionsReport {
            let inputs = OptionsInputs {
                system,
                asset_index_id,
                skip_onboarding,
            };
            fill_missing_options(&inputs, &self.layout, &self.working_dir).await
        }

        /// 默认配置下的一次补全，不该有任何失败。
        async fn fill(&self, system: Option<&str>) -> Vec<String> {
            let report = self.fill_with(system, Some("lang-test"), true).await;
            assert!(report.failures.is_empty(), "{:?}", report.failures);
            report.notes
        }

        fn write(&self, relative: &str, bytes: &[u8]) {
            let path = self.working_dir.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }

        fn options(&self) -> Option<Vec<u8>> {
            match std::fs::read(self.working_dir.join(OPTIONS_FILE)) {
                Ok(bytes) => Some(bytes),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
                Err(err) => panic!("读 options.txt 失败：{err}"),
            }
        }
    }

    const SKIPPED: &str = "已跳过游戏的首次无障碍引导";
    const RESPELLED: &str = "游戏语言的写法换成这个版本的大小写";

    #[tokio::test]
    async fn missing_options_file_is_created_with_both_lines() {
        let scene = scene(V1_7_10);
        let notes = scene.fill(Some("zh-CN")).await;
        assert_eq!(
            scene.options().unwrap(),
            b"lang:zh_CN\nonboardAccessibility:false\n"
        );
        assert_eq!(notes, ["游戏语言设为 zh_CN，跟随系统语言 zh-CN", SKIPPED]);
    }

    #[tokio::test]
    async fn options_file_gets_the_missing_lines_appended() {
        let scene = scene(V1_21_1);
        let original = b"version:3955\r\nfov:0.5\r\n\xff\xfe:1\r\nguiScale:2";
        scene.write(OPTIONS_FILE, original);

        scene.fill(Some("zh-HK")).await;

        let mut expected = original.to_vec();
        expected.extend_from_slice(b"\r\nlang:zh_hk\r\nonboardAccessibility:false\r\n");
        assert_eq!(scene.options().unwrap(), expected);
    }

    /// 共用 options.txt 的版本之间换着玩：语言不变，写法换成这一局的版本认的。
    #[tokio::test]
    async fn existing_language_is_respelled_for_the_version_being_launched() {
        let scene = scene(V1_8_9);
        scene.write(OPTIONS_FILE, b"lang:zh_cn\nonboardAccessibility:false\n");

        let notes = scene.fill(Some("en-US")).await;

        assert_eq!(
            scene.options().unwrap(),
            b"lang:zh_CN\nonboardAccessibility:false\n"
        );
        assert_eq!(notes, [RESPELLED]);
    }

    /// 改写法和补引导是同一次写入。
    #[tokio::test]
    async fn respelling_and_the_missing_onboarding_line_land_together() {
        let scene = scene(V1_7_10);
        scene.write(OPTIONS_FILE, b"lang:zh_tw\r\nfov:0.5\r\n");

        let notes = scene.fill(Some("zh-CN")).await;

        assert_eq!(
            scene.options().unwrap(),
            b"lang:zh_TW\r\nfov:0.5\r\nonboardAccessibility:false\r\n"
        );
        assert_eq!(notes, [RESPELLED, SKIPPED]);
    }

    /// 开关关掉也要改写法：它管的是引导，这里也不额外声明数据版本。
    #[tokio::test]
    async fn switch_off_still_respells_the_existing_language() {
        let scene = scene(V1_8_9);
        scene.write(OPTIONS_FILE, b"lang:zh_cn\n");

        let report = scene
            .fill_with(Some("zh-CN"), Some("lang-test"), false)
            .await;

        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.notes, [RESPELLED]);
        assert_eq!(scene.options().unwrap(), b"lang:zh_CN\n");
    }

    /// 写法只看文件和索引，读不出系统语言也一样改。
    #[tokio::test]
    async fn respelling_does_not_need_the_system_language() {
        let scene = scene(V1_8_9);
        scene.write(OPTIONS_FILE, b"lang:zh_cn\nonboardAccessibility:false\n");

        let notes = scene.fill(None).await;

        assert_eq!(
            scene.options().unwrap(),
            b"lang:zh_CN\nonboardAccessibility:false\n"
        );
        assert_eq!(notes, [RESPELLED]);
    }

    /// 写法对的文件一个字节都不写，换着玩的老玩家不会每局都重写一次。
    #[tokio::test]
    async fn language_already_spelled_for_this_version_leaves_the_file_alone() {
        let scene = scene(V1_8_9);
        let original = b"lang:zh_CN\r\nonboardAccessibility:false\r\nfov:0.5";
        scene.write(OPTIONS_FILE, original);

        let notes = scene.fill(Some("zh-CN")).await;

        assert!(notes.is_empty(), "{notes:?}");
        assert_eq!(scene.options().unwrap(), original);
    }

    /// 版本没有资源索引时无从判断写法，语言行原样留着，也不算失败。
    #[tokio::test]
    async fn existing_language_stays_without_an_asset_index() {
        let scene = scene(V1_8_9);
        let original = b"lang:zh_cn\nonboardAccessibility:false\n";
        scene.write(OPTIONS_FILE, original);

        let report = scene.fill_with(Some("zh-CN"), None, true).await;

        assert!(report.notes.is_empty(), "{:?}", report.notes);
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(scene.options().unwrap(), original);
    }

    /// 索引读不出来只算写法这一项没做成：报给调用方，语言行原样，引导那一行不受牵连。
    #[tokio::test]
    async fn damaged_asset_index_keeps_the_existing_language_and_still_adds_onboarding() {
        let scene = scene(V1_8_9);
        let path = scene.layout.asset_index_json("lang-test").unwrap();
        std::fs::write(path, b"{not json").unwrap();
        scene.write(OPTIONS_FILE, b"lang:zh_cn\n");

        let report = scene
            .fill_with(Some("zh-CN"), Some("lang-test"), true)
            .await;

        assert_eq!(report.failures.len(), 1, "{:?}", report.failures);
        assert_eq!(report.notes, [SKIPPED]);
        assert_eq!(
            scene.options().unwrap(),
            b"lang:zh_cn\nonboardAccessibility:false\n"
        );
    }

    /// 默认语言不用查写法，英文玩家每局启动都走这里，不该为它读索引。
    #[tokio::test]
    async fn default_language_is_left_alone_without_reading_the_index() {
        let scene = scene(V1_21_1);
        let original = b"lang:en_us\nonboardAccessibility:true\nfov:0.5\n";
        scene.write(OPTIONS_FILE, original);

        for skip_onboarding in [true, false] {
            let report = scene
                .fill_with(
                    Some("zh-CN"),
                    Some("index-that-does-not-exist"),
                    skip_onboarding,
                )
                .await;

            assert!(report.notes.is_empty(), "{:?}", report.notes);
            assert!(report.failures.is_empty(), "{:?}", report.failures);
            assert_eq!(scene.options().unwrap(), original);
        }
    }

    #[tokio::test]
    async fn game_default_language_only_gets_the_onboarding_line() {
        let scene = scene(V1_21_1);
        assert_eq!(scene.fill(Some("en-US")).await, [SKIPPED]);
        assert_eq!(scene.options().unwrap(), b"onboardAccessibility:false\n");
    }

    /// 开关关掉、又不用写语言时不创建文件：引导留给游戏，游戏第一次启动照常弹。
    #[tokio::test]
    async fn switch_off_and_game_default_language_write_nothing() {
        let scene = scene(V1_21_1);
        let report = scene
            .fill_with(Some("en-US"), Some("lang-test"), false)
            .await;
        assert!(report.notes.is_empty(), "{:?}", report.notes);
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(scene.options(), None);
    }

    /// 开关关掉时语言照写，文件里不出现引导那一行，靠数据版本让游戏别把引导标成走过。
    #[tokio::test]
    async fn switch_off_still_follows_the_system_language() {
        let scene = scene(V1_21_1);
        let report = scene
            .fill_with(Some("zh-CN"), Some("lang-test"), false)
            .await;
        assert_eq!(report.notes, ["游戏语言设为 zh_cn，跟随系统语言 zh-CN"]);
        assert_eq!(scene.options().unwrap(), b"version:3319\nlang:zh_cn\n");
    }

    #[tokio::test]
    async fn language_missing_from_the_index_only_says_why() {
        let scene = scene(V1_5_2);
        let notes = scene.fill(Some("zh-CN")).await;
        assert_eq!(scene.options().unwrap(), b"onboardAccessibility:false\n");
        assert_eq!(
            notes,
            [
                "这个版本的资源索引里没有系统语言 zh-CN，游戏语言保持默认",
                SKIPPED
            ]
        );
    }

    #[tokio::test]
    async fn unreadable_system_language_only_says_why() {
        let scene = scene(V1_21_1);
        let notes = scene.fill(None).await;
        assert_eq!(scene.options().unwrap(), b"onboardAccessibility:false\n");
        assert_eq!(notes, ["读不出系统语言，游戏语言保持默认", SKIPPED]);
    }

    #[tokio::test]
    async fn version_without_an_asset_index_only_says_why() {
        let scene = scene(V1_21_1);
        let report = scene.fill_with(Some("zh-CN"), None, true).await;
        assert_eq!(scene.options().unwrap(), b"onboardAccessibility:false\n");
        assert_eq!(
            report.notes,
            ["这个版本没有资源索引，游戏语言保持默认", SKIPPED]
        );
        assert!(report.failures.is_empty(), "{:?}", report.failures);
    }

    /// 这两个模组只在 options.txt 不存在时铺整合包作者调好的默认设置，抢先写一份就把它们顶掉了，所以语言和
    /// 引导都不写，开关开着也一样。
    #[tokio::test]
    async fn mod_defaults_waiting_to_be_copied_keep_the_options_file_absent() {
        for pending in [
            "config/yosbr/options.txt",
            "config/defaultoptions/options.txt",
        ] {
            let scene = scene(V1_21_1);
            scene.write(pending, b"fov:0.8\n");

            let notes = scene.fill(Some("zh-CN")).await;

            assert_eq!(scene.options(), None, "{pending}");
            assert_eq!(
                notes,
                [format!(
                    "{pending} 会在第一次启动时铺默认设置，游戏语言与无障碍引导留给它决定"
                )]
            );
        }
    }

    /// options.txt 已经在了，模组不会再铺默认设置，缺的行照常补。
    #[tokio::test]
    async fn mod_defaults_do_not_matter_once_the_options_file_exists() {
        let scene = scene(V1_21_1);
        scene.write("config/yosbr/options.txt", b"fov:0.8\n");
        scene.write(OPTIONS_FILE, b"fov:0.5\n");

        scene.fill(Some("zh-CN")).await;

        assert_eq!(
            scene.options().unwrap(),
            b"fov:0.5\nlang:zh_cn\nonboardAccessibility:false\n"
        );
    }

    /// 索引读不出来只算语言这一项没做成：报给调用方，引导那一行不受牵连。
    #[tokio::test]
    async fn damaged_asset_index_is_reported_and_onboarding_is_still_written() {
        let scene = scene(V1_21_1);
        let path = scene.layout.asset_index_json("lang-test").unwrap();
        std::fs::write(path, b"{not json").unwrap();

        let report = scene
            .fill_with(Some("zh-CN"), Some("lang-test"), true)
            .await;

        assert_eq!(report.failures.len(), 1, "{:?}", report.failures);
        assert_eq!(report.notes, [SKIPPED]);
        assert_eq!(scene.options().unwrap(), b"onboardAccessibility:false\n");
    }

    #[tokio::test]
    async fn damaged_asset_index_with_the_switch_off_writes_nothing() {
        let scene = scene(V1_21_1);
        let path = scene.layout.asset_index_json("lang-test").unwrap();
        std::fs::write(path, b"{not json").unwrap();

        let report = scene
            .fill_with(Some("zh-CN"), Some("lang-test"), false)
            .await;

        assert_eq!(report.failures.len(), 1, "{:?}", report.failures);
        assert!(report.notes.is_empty(), "{:?}", report.notes);
        assert_eq!(scene.options(), None);
    }
}
