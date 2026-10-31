//! 外观偏好：明暗（日樱 / 夜樱）、强调色、花瓣、樱花林全景背景与减少动画。
//!
//! 偏好跟随本机而非账户，写在全局配置 `appearance` 段里随数据目录走：重装 WebView2、清浏览器
//! 存储都不会丢。前端在首帧渲染前读它，把明暗与强调色写到根元素上，窗口显示时就是最终外观。
//!
//! 枚举一律 snake_case；未知取值反序列化失败而不是回落默认——前端传了拼错的值，应当在第一时间
//! 暴露出来，而不是悄悄变回日樱。config.json 里的未知取值由配置载入按字段退回默认，并经启动提示
//! 告诉用户（见 `config` 模块）。

use serde::{Deserialize, Serialize};

/// 明暗模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppearanceMode {
    /// 日樱（浅色）。
    #[default]
    Day,
    /// 夜樱（深色）。
    Night,
}

/// 强调色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccentColor {
    /// 樱粉。
    #[default]
    Sakura,
    /// 紫水晶。
    Amethyst,
    /// 青苔。
    Moss,
}

/// 完整的外观偏好。配置里缺的字段取默认值，便于以后增项时旧配置照常载入。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Appearance {
    /// 明暗模式。
    pub mode: AppearanceMode,
    /// 强调色。
    pub accent: AccentColor,
    /// 是否飘落花瓣。
    pub petals: bool,
    /// 是否显示樱花林全景背景（读本机原版材质，默认关）。
    pub panorama: bool,
    /// 是否减少动画（与系统的减少动态效果设置取或）。
    pub reduce_motion: bool,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            mode: AppearanceMode::Day,
            accent: AccentColor::Sakura,
            petals: true,
            panorama: false,
            reduce_motion: false,
        }
    }
}

/// 一次外观修改：只带要改的字段，`None` 表示不动。
///
/// 拒绝未知字段：前端把 `reduceMotion` 写成驼峰或拼错键名时应当报错，而不是被当成「什么都没改」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppearancePatch {
    pub mode: Option<AppearanceMode>,
    pub accent: Option<AccentColor>,
    pub petals: Option<bool>,
    pub panorama: Option<bool>,
    pub reduce_motion: Option<bool>,
}

impl Appearance {
    /// 把修改合进当前偏好，未给出的字段保持原值。
    pub fn apply(&mut self, patch: AppearancePatch) {
        if let Some(mode) = patch.mode {
            self.mode = mode;
        }
        if let Some(accent) = patch.accent {
            self.accent = accent;
        }
        if let Some(petals) = patch.petals {
            self.petals = petals;
        }
        if let Some(panorama) = patch.panorama {
            self.panorama = panorama;
        }
        if let Some(reduce_motion) = patch.reduce_motion {
            self.reduce_motion = reduce_motion;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_day_sakura_with_petals_only() {
        let a = Appearance::default();
        assert_eq!(a.mode, AppearanceMode::Day);
        assert_eq!(a.accent, AccentColor::Sakura);
        assert!(a.petals);
        assert!(!a.panorama);
        assert!(!a.reduce_motion);
    }

    #[test]
    fn serializes_with_snake_case_fields_and_values() {
        let a = Appearance {
            mode: AppearanceMode::Night,
            accent: AccentColor::Amethyst,
            petals: false,
            panorama: true,
            reduce_motion: true,
        };
        let json = serde_json::to_value(a).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "mode": "night",
                "accent": "amethyst",
                "petals": false,
                "panorama": true,
                "reduce_motion": true
            })
        );
        let back: Appearance = serde_json::from_value(json).unwrap();
        assert_eq!(back, a);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let a: Appearance = serde_json::from_str(r#"{"accent":"moss"}"#).unwrap();
        assert_eq!(a.accent, AccentColor::Moss);
        assert_eq!(a.mode, AppearanceMode::Day);
        assert!(a.petals);
    }

    #[test]
    fn unknown_enum_values_fail_to_deserialize() {
        for bad in [
            r#"{"accent":"pink"}"#,
            r#"{"accent":"Sakura"}"#,
            r#"{"mode":"dark"}"#,
            r#"{"mode":""}"#,
        ] {
            assert!(
                serde_json::from_str::<Appearance>(bad).is_err(),
                "{bad} 应当反序列化失败"
            );
            assert!(
                serde_json::from_str::<AppearancePatch>(bad).is_err(),
                "补丁 {bad} 应当反序列化失败"
            );
        }
    }

    #[test]
    fn patch_rejects_unknown_fields() {
        let err = serde_json::from_str::<AppearancePatch>(r#"{"reduceMotion":true}"#);
        assert!(err.is_err(), "驼峰键名不应被静默忽略");
    }

    #[test]
    fn apply_changes_only_given_fields() {
        let mut a = Appearance::default();
        let patch: AppearancePatch =
            serde_json::from_str(r#"{"mode":"night","reduce_motion":true}"#).unwrap();
        a.apply(patch);
        assert_eq!(a.mode, AppearanceMode::Night);
        assert!(a.reduce_motion);
        // 未给出的字段保持原值。
        assert_eq!(a.accent, AccentColor::Sakura);
        assert!(a.petals);
        assert!(!a.panorama);

        // 空补丁什么都不改。
        let before = a;
        a.apply(AppearancePatch::default());
        assert_eq!(a, before);

        // 布尔字段能改回 false（区分「不改」与「改成 false」）。
        a.apply(AppearancePatch {
            petals: Some(false),
            ..AppearancePatch::default()
        });
        assert!(!a.petals);
    }
}
