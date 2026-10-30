//! 产品名的唯一定义点。
//!
//! 取值以宏给出，是为了能放进 `concat!`：崩溃规则表、User-Agent、元数据目录名都是
//! `&'static str` 常量，只能在编译期拼接。前端在 `app/src/lib/app-info.ts` 另有一份，两边取值必须一致。
//! crate 名、Rust 标识符、IPC 事件名里的 `aurora` 是内部代号，不随产品名改。

/// 中文名：界面文案、崩溃建议里指代产品，与相邻汉字之间不加空格。
#[macro_export]
macro_rules! app_name {
    () => {
        "落樱"
    };
}

/// 英文名：数据目录、User-Agent、`-Dminecraft.launcher.brand` 等系统层可见位置。
#[macro_export]
macro_rules! app_name_en {
    () => {
        "Petalfall"
    };
}

/// slug：游戏目录里的元数据目录、临时文件后缀等落盘命名。
#[macro_export]
macro_rules! app_slug {
    () => {
        "petalfall"
    };
}

pub const APP_NAME: &str = app_name!();
pub const APP_NAME_EN: &str = app_name_en!();
pub const APP_SLUG: &str = app_slug!();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_lowercase_english_name() {
        // 落盘命名一律取全小写的英文名，两者不得各改各的。
        assert_eq!(APP_SLUG, APP_NAME_EN.to_lowercase());
        assert!(
            APP_SLUG
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        );
    }
}
