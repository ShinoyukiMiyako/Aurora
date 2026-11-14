//! 界面形状：几处由异步数据决定的版面上一次落定时的样子，前端首帧按它画占位。
//!
//! 主页最近游玩一栏有几张卡、实例库有没有修复横幅，要等实例列表读完才知道。首帧什么都不画、读完再长出来，
//! 界面会在首帧之后无过渡地变高；按上一次记下的形状先占好位，读完多半对得上，对不上的差值由前端的让位接住。
//!
//! 这是丢了能再记一次的缓存，不是设置：前端在数据落定后写回，记错了下次启动自己纠正。由此定下几条：
//! - 配置里的 `ui_shape` 段读不懂（类型对不上、取值越界、更新的版本换了写法）时只把这一段按默认读、记一条警告，
//!   不连累整份配置被当成坏文件改名重置，也不作为启动提示报给界面（见 [`read_lenient`]）。
//! - 段里不认识的键不保留，落盘时丢掉。
//! - 不涉及数据格式号：没有这个键的旧版本把它当不认识的顶层键原样写回；有这个键的版本读到什么都不会拒读。
//!
//! 写回用的补丁 [`UiShapePatch`] 反过来是严格的：前端传了拼错的键名、越界或类型不对的值，要在第一时间报错，
//! 而不是被当成「什么都没改」。

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// 最近游玩一栏最多的卡片数：前端最宽一档窗口里这一栏列的张数。
pub const MAX_RECENT_CARDS: u8 = 6;

/// 完整的界面形状。缺的字段取默认值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UiShape {
    /// 主页最近游玩一栏上次落定时的卡片数，0 到 [`MAX_RECENT_CARDS`]；0 表示这一栏没有出现。
    #[serde(deserialize_with = "recent_cards")]
    pub recent_cards: u8,
    /// 实例库上次落定时有没有修复横幅（有实例需要修复）。
    pub repair_banner: bool,
}

/// 一次形状写回：只带要改的字段，`None` 表示不动。
///
/// 拒绝未知字段，也拒绝写了键却给 `null`：前端把 `recentCards` 写成驼峰、拼错键名，或者把缺省值误传成 null，
/// 都应当报错。`recent_cards` 超过 [`MAX_RECENT_CARDS`] 同样在反序列化时拒绝，不静默钳位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiShapePatch {
    #[serde(default, deserialize_with = "present_recent_cards")]
    pub recent_cards: Option<u8>,
    #[serde(default, deserialize_with = "present")]
    pub repair_banner: Option<bool>,
}

impl UiShape {
    /// 把补丁合进当前形状，返回形状有没有变。没变时调用方不必落盘：前端每次数据落定都会写回，多数时候与上次相同。
    pub fn apply(&mut self, patch: UiShapePatch) -> bool {
        let before = *self;
        if let Some(recent_cards) = patch.recent_cards {
            self.recent_cards = recent_cards;
        }
        if let Some(repair_banner) = patch.repair_banner {
            self.repair_banner = repair_banner;
        }
        *self != before
    }
}

/// 配置里 `ui_shape` 段的读法：读不懂时这一段按默认读，记一条警告。
///
/// 整份配置是按类型严格解析的，一个字段对不上就整份改名重置，游戏目录登记、首次启动状态跟着丢。为一项缓存
/// 付这个代价不值；何况更新的版本可能换了这一段的写法（卡片上限变了、加了字段），降级之后照样要打得开。
pub(crate) fn read_lenient<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<UiShape, D::Error> {
    let raw = Value::deserialize(deserializer)?;
    match UiShape::deserialize(&raw) {
        Ok(shape) => Ok(shape),
        Err(err) => {
            tracing::warn!(error = %err, "配置里的界面形状读不懂，这一段按默认读");
            Ok(UiShape::default())
        }
    }
}

fn recent_cards<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u8, D::Error> {
    let count = u8::deserialize(deserializer)?;
    if count > MAX_RECENT_CARDS {
        return Err(D::Error::custom(format!(
            "recent_cards 最多为 {MAX_RECENT_CARDS}，收到 {count}"
        )));
    }
    Ok(count)
}

fn present_recent_cards<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u8>, D::Error> {
    recent_cards(deserializer).map(Some)
}

/// 补丁里出现的键必须带值：键不出现才是「不动」（由 `#[serde(default)]` 补 `None`）。
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_is_no_recent_cards_and_no_banner() {
        let shape = UiShape::default();
        assert_eq!(shape.recent_cards, 0);
        assert!(!shape.repair_banner);
        assert_eq!(
            serde_json::to_value(shape).unwrap(),
            json!({ "recent_cards": 0, "repair_banner": false })
        );
    }

    #[test]
    fn serializes_with_snake_case_fields_and_roundtrips() {
        let shape = UiShape {
            recent_cards: MAX_RECENT_CARDS,
            repair_banner: true,
        };
        let json = serde_json::to_value(shape).unwrap();
        assert_eq!(json, json!({ "recent_cards": 6, "repair_banner": true }));
        assert_eq!(serde_json::from_value::<UiShape>(json).unwrap(), shape);

        // 缺的字段取默认。
        assert_eq!(
            serde_json::from_value::<UiShape>(json!({ "repair_banner": true })).unwrap(),
            UiShape {
                recent_cards: 0,
                repair_banner: true,
            }
        );
    }

    /// 0 到 6 收下原值，7 起（含 u8 装不下的数）一律拒绝；整份形状与补丁同一条规则。
    #[test]
    fn recent_cards_accepts_exactly_zero_to_six() {
        for count in 0u32..=300 {
            let shape = serde_json::from_value::<UiShape>(json!({ "recent_cards": count }));
            let patch = serde_json::from_value::<UiShapePatch>(json!({ "recent_cards": count }));
            if count <= 6 {
                assert_eq!(shape.unwrap().recent_cards, count as u8, "{count}");
                assert_eq!(patch.unwrap().recent_cards, Some(count as u8), "{count}");
            } else {
                assert!(shape.is_err(), "整份形状不该收下 {count}");
                let err = patch.expect_err("补丁不该收下越界的卡片数").to_string();
                if count <= 255 {
                    assert!(err.contains(&format!("最多为 6，收到 {count}")), "{err}");
                }
            }
        }
        for bad in [json!(-1), json!(2.5), json!("3"), json!(true)] {
            assert!(
                serde_json::from_value::<UiShapePatch>(json!({ "recent_cards": bad })).is_err(),
                "{bad}"
            );
            assert!(
                serde_json::from_value::<UiShape>(json!({ "recent_cards": bad })).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn patch_rejects_unknown_fields_nulls_and_non_objects() {
        for bad in [
            json!({ "recentCards": 1 }),
            json!({ "repairBanner": true }),
            json!({ "pack_rows": [] }),
            json!({ "recent_cards": null }),
            json!({ "repair_banner": null }),
            json!({ "repair_banner": "yes" }),
            json!({ "repair_banner": 1 }),
            json!(null),
            json!("recent_cards"),
        ] {
            assert!(
                serde_json::from_value::<UiShapePatch>(bad.clone()).is_err(),
                "{bad} 应当被拒绝"
            );
        }
        let err = serde_json::from_value::<UiShapePatch>(json!({ "recentCards": 1 }))
            .unwrap_err()
            .to_string();
        assert!(err.contains("recentCards"), "错误里要指出是哪个键：{err}");

        assert_eq!(
            serde_json::from_value::<UiShapePatch>(json!({})).unwrap(),
            UiShapePatch::default()
        );
        assert_eq!(
            serde_json::from_value::<UiShapePatch>(
                json!({ "recent_cards": 0, "repair_banner": false })
            )
            .unwrap(),
            UiShapePatch {
                recent_cards: Some(0),
                repair_banner: Some(false),
            }
        );
    }

    #[test]
    fn apply_changes_only_given_fields_and_reports_change() {
        let mut shape = UiShape::default();
        assert!(!shape.apply(UiShapePatch::default()), "空补丁不算变化");
        assert!(
            !shape.apply(UiShapePatch {
                recent_cards: Some(0),
                repair_banner: Some(false),
            }),
            "写回与现值相同不算变化"
        );
        assert_eq!(shape, UiShape::default());

        assert!(shape.apply(UiShapePatch {
            recent_cards: Some(4),
            ..UiShapePatch::default()
        }));
        assert_eq!(
            shape,
            UiShape {
                recent_cards: 4,
                repair_banner: false,
            }
        );

        assert!(shape.apply(UiShapePatch {
            repair_banner: Some(true),
            ..UiShapePatch::default()
        }));
        assert_eq!(
            shape,
            UiShape {
                recent_cards: 4,
                repair_banner: true,
            },
            "未给出的字段保持原值"
        );

        // 两项里只有一项变了也算变化；布尔能改回 false（区分「不动」与「改成 false」）。
        assert!(shape.apply(UiShapePatch {
            recent_cards: Some(4),
            repair_banner: Some(false),
        }));
        assert_eq!(
            shape,
            UiShape {
                recent_cards: 4,
                repair_banner: false,
            }
        );
        assert!(!shape.apply(UiShapePatch {
            recent_cards: Some(4),
            repair_banner: Some(false),
        }));
    }

    /// 所有合法的起始形状与补丁两两组合：合并结果逐项等于补丁给出的值或原值，报告的变化与结果是否不同一致。
    #[test]
    fn apply_over_every_legal_shape_and_patch() {
        let shapes = (0..=MAX_RECENT_CARDS).flat_map(|recent_cards| {
            [false, true].map(|repair_banner| UiShape {
                recent_cards,
                repair_banner,
            })
        });
        let counts: Vec<Option<u8>> = std::iter::once(None)
            .chain((0..=MAX_RECENT_CARDS).map(Some))
            .collect();
        let mut combinations = 0;
        for before in shapes {
            for &recent_cards in &counts {
                for repair_banner in [None, Some(false), Some(true)] {
                    let mut after = before;
                    let changed = after.apply(UiShapePatch {
                        recent_cards,
                        repair_banner,
                    });
                    let expected = UiShape {
                        recent_cards: recent_cards.unwrap_or(before.recent_cards),
                        repair_banner: repair_banner.unwrap_or(before.repair_banner),
                    };
                    assert_eq!(
                        after, expected,
                        "{before:?} + {recent_cards:?}/{repair_banner:?}"
                    );
                    assert_eq!(changed, expected != before, "{before:?} -> {expected:?}");
                    combinations += 1;
                }
            }
        }
        assert_eq!(combinations, 14 * 8 * 3);
    }
}
