//! 没有自定义皮肤的玩家在原版客户端（1.19.3 起）里显示的默认皮肤：由 UUID 的哈希在 9 套默认皮肤
//! × 细臂、宽臂两种体型里选一套。离线账户永远没有自定义皮肤，进游戏看到的就是这一套，所以界面按它画。
//!
//! 前端添加离线账户的弹窗按同一规则预览（`flows/login/default-skin.ts`），两边用同一组测试向量钉住。

use aurora_auth::SkinModel;

/// 一套默认皮肤：材质名单里的路径与体型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefaultSkin {
    pub path: &'static str,
    pub model: SkinModel,
}

/// 原版客户端默认皮肤数组的顺序：先 9 套细臂，后 9 套宽臂，各自按名字字母序。选取结果依赖这个顺序，不能改。
const DEFAULT_SKINS: [DefaultSkin; 18] = [
    slim("entity/player/slim/alex"),
    slim("entity/player/slim/ari"),
    slim("entity/player/slim/efe"),
    slim("entity/player/slim/kai"),
    slim("entity/player/slim/makena"),
    slim("entity/player/slim/noor"),
    slim("entity/player/slim/steve"),
    slim("entity/player/slim/sunny"),
    slim("entity/player/slim/zuri"),
    wide("entity/player/wide/alex"),
    wide("entity/player/wide/ari"),
    wide("entity/player/wide/efe"),
    wide("entity/player/wide/kai"),
    wide("entity/player/wide/makena"),
    wide("entity/player/wide/noor"),
    wide("entity/player/wide/steve"),
    wide("entity/player/wide/sunny"),
    wide("entity/player/wide/zuri"),
];

const fn slim(path: &'static str) -> DefaultSkin {
    DefaultSkin {
        path,
        model: SkinModel::Slim,
    }
}

const fn wide(path: &'static str) -> DefaultSkin {
    DefaultSkin {
        path,
        model: SkinModel::Wide,
    }
}

/// Java 的 `UUID.hashCode`：高 64 位与低 64 位异或，再把结果的高、低 32 位异或，按有符号 32 位整数解释。
/// 带不带连字符、大小写都认；不是 32 位十六进制时为 None。
pub fn java_uuid_hash(uuid: &str) -> Option<i32> {
    let hex: String = uuid.chars().filter(|c| *c != '-').collect();
    // from_str_radix 认前导 '+'，先逐字确认全是十六进制数字
    if hex.len() != 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let value = u128::from_str_radix(&hex, 16).ok()?;
    let folded = ((value >> 64) as u64) ^ (value as u64);
    Some((((folded >> 32) as u32) ^ (folded as u32)) as i32)
}

/// 这个 UUID 在原版客户端里的默认皮肤：下标为哈希对 18 取非负余数（Java 的 `Math.floorMod`）。
pub fn default_skin(uuid: &str) -> Option<DefaultSkin> {
    let hash = java_uuid_hash(uuid)?;
    let index = hash.rem_euclid(DEFAULT_SKINS.len() as i32) as usize;
    Some(DEFAULT_SKINS[index])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::art::whitelist::SKIN_TEXTURES;

    // 期望值由 JDK 的 java.util.UUID.hashCode 与 Math.floorMod 独立算出，与前端测试同一组。
    #[test]
    fn hash_matches_java_uuid_hash_code() {
        for (uuid, hash) in [
            ("00000000-0000-0000-0000-000000000000", 0),
            ("00000000-0000-0000-0000-000000000011", 17),
            ("00000000-0000-0000-0000-00000000ffff", 65535),
            ("00000000-0000-0000-0000-0000ffffffff", -1),
            ("12345678-0000-0000-0000-000012345678", 0),
            ("ffffffff-ffff-ffff-ffff-ffffffffffff", 0),
            ("80000000-0000-0000-0000-000000000000", i32::MIN),
            ("069a79f4-44e9-4726-a5be-fca90e38aaf5", -369792882),
            ("853c80ef-3c37-49fd-aa49-938b674adae6", 1946714239),
            ("5627dd98-e6be-3c21-b8a8-e92344183641", 1277771483),
        ] {
            assert_eq!(java_uuid_hash(uuid), Some(hash), "{uuid}");
        }
        assert_eq!(
            java_uuid_hash("5627DD98E6BE3C21B8A8E92344183641"),
            java_uuid_hash("5627dd98-e6be-3c21-b8a8-e92344183641")
        );
    }

    #[test]
    fn non_uuid_has_no_hash() {
        for bad in [
            "",
            "5627dd98-e6be",
            "zz27dd98e6be3c21b8a8e92344183641",
            "+627dd98e6be3c21b8a8e92344183641",
            "5627dd98e6be3c21b8a8e923441836410",
        ] {
            assert_eq!(java_uuid_hash(bad), None, "{bad}");
            assert_eq!(default_skin(bad), None, "{bad}");
        }
    }

    #[test]
    fn hashes_zero_to_seventeen_walk_slim_then_wide() {
        let picks: Vec<&str> = (0..18)
            .map(|k| default_skin(&format!("{k:032x}")).unwrap().path)
            .collect();
        assert_eq!(
            picks,
            [
                "entity/player/slim/alex",
                "entity/player/slim/ari",
                "entity/player/slim/efe",
                "entity/player/slim/kai",
                "entity/player/slim/makena",
                "entity/player/slim/noor",
                "entity/player/slim/steve",
                "entity/player/slim/sunny",
                "entity/player/slim/zuri",
                "entity/player/wide/alex",
                "entity/player/wide/ari",
                "entity/player/wide/efe",
                "entity/player/wide/kai",
                "entity/player/wide/makena",
                "entity/player/wide/noor",
                "entity/player/wide/steve",
                "entity/player/wide/sunny",
                "entity/player/wide/zuri",
            ]
        );
    }

    #[test]
    fn negative_hash_uses_floor_mod() {
        for (uuid, path, model) in [
            (
                "00000000-0000-0000-0000-0000ffffffff",
                "entity/player/wide/zuri",
                SkinModel::Wide,
            ),
            (
                "80000000-0000-0000-0000-000000000000",
                "entity/player/wide/sunny",
                SkinModel::Wide,
            ),
            (
                "069a79f4-44e9-4726-a5be-fca90e38aaf5",
                "entity/player/slim/alex",
                SkinModel::Slim,
            ),
        ] {
            assert_eq!(
                default_skin(uuid),
                Some(DefaultSkin { path, model }),
                "{uuid}"
            );
        }
    }

    #[test]
    fn offline_players_get_their_in_game_default() {
        for (name, path) in [
            ("Steve", "entity/player/wide/efe"),
            ("Alex", "entity/player/slim/makena"),
            ("Notch", "entity/player/slim/makena"),
            ("jeb_", "entity/player/slim/ari"),
            ("樱花", "entity/player/wide/steve"),
        ] {
            let uuid = aurora_auth::offline_uuid(name).simple().to_string();
            assert_eq!(default_skin(&uuid).unwrap().path, path, "{name}");
        }
    }

    #[test]
    fn every_default_is_on_the_art_whitelist() {
        for skin in DEFAULT_SKINS {
            assert!(SKIN_TEXTURES.contains(&skin.path), "{}", skin.path);
            let folder = match skin.model {
                SkinModel::Slim => "entity/player/slim/",
                SkinModel::Wide => "entity/player/wide/",
            };
            assert!(skin.path.starts_with(folder), "{}", skin.path);
        }
    }
}
