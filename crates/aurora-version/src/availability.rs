//! 版本可用性检查。
//!
//! 在启动前判定一个版本是否 "结构上可启动"，把具体不可用原因逐条列出（而非只给一个布尔）。
//! 检查项：mainClass 存在、inheritsFrom 前置已安装（通过 provider 能取到）、
//! 版本号可识别。前置是否 "已安装" 借 [`VersionProvider`] 表达——provider 取不到即视为未安装。
//! 文件系统层面的 "版本文件夹是否存在" 由上层（aurora-instance）在构造 provider 时保证。

use crate::error::Error;
use crate::identify::identify_mc_version;
use crate::merge::{VersionProvider, resolve};
use crate::model::VersionJson;

/// 单条不可用原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnavailableReason {
    /// 合并后仍缺少 mainClass。
    MissingMainClass,
    /// inheritsFrom 前置未安装（provider 取不到）。
    InheritanceUnresolved {
        missing_id: String,
        referenced_by: String,
    },
    /// 继承链存在循环。
    InheritanceCycle { chain: Vec<String> },
    /// inheritsFrom 指向自身。
    SelfInheritance { id: String },
    /// 无法识别版本号。
    UnknownVersionNumber,
}

/// 可用性检查结果：原因为空即可用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionAvailability {
    pub reasons: Vec<UnavailableReason>,
}

impl VersionAvailability {
    /// 是否可用（无任何不可用原因）。
    pub fn is_available(&self) -> bool {
        self.reasons.is_empty()
    }
}

/// 对版本做可用性检查。
///
/// 会先尝试沿 provider 解析继承链：解析失败的结构性错误直接落成对应原因；解析成功后在合并结果上
/// 复核 mainClass 与版本号。当继承因前置缺失/循环无法解析时，不再武断判定 "缺 mainClass"（它本可
/// 由缺失的父版本提供），只报告继承问题这一根因。
pub fn check_availability<P>(version: &VersionJson, provider: &P) -> VersionAvailability
where
    P: VersionProvider + ?Sized,
{
    let mut reasons = Vec::new();

    let resolved = match resolve(version, provider) {
        Ok(merged) => Some(merged),
        Err(Error::MissingInherited { id, referenced_by }) => {
            reasons.push(UnavailableReason::InheritanceUnresolved {
                missing_id: id,
                referenced_by,
            });
            None
        }
        Err(Error::InheritCycle { chain }) => {
            reasons.push(UnavailableReason::InheritanceCycle { chain });
            None
        }
        Err(Error::SelfInherit { id }) => {
            reasons.push(UnavailableReason::SelfInheritance { id });
            None
        }
        // resolve 只会产出上述三类继承错误，Json 错误在解析阶段已发生、不会到这里。
        Err(_) => None,
    };

    match &resolved {
        Some(merged) => {
            if !has_main_class(merged) {
                reasons.push(UnavailableReason::MissingMainClass);
            }
            if identify_mc_version(merged).value.is_none() {
                reasons.push(UnavailableReason::UnknownVersionNumber);
            }
        }
        None => {
            // 继承未解析：只有在这是个 "本就不该有父版本" 的独立版本却仍缺 mainClass 时才追加该原因。
            if version.inherits_from.is_none() && !has_main_class(version) {
                reasons.push(UnavailableReason::MissingMainClass);
            }
            // 版本号仍尽力识别：inheritsFrom 串本身通常已能给出基准版本，避免误报未知。
            if identify_mc_version(version).value.is_none() {
                reasons.push(UnavailableReason::UnknownVersionNumber);
            }
        }
    }

    VersionAvailability { reasons }
}

fn has_main_class(version: &VersionJson) -> bool {
    version.main_class.as_deref().is_some_and(|m| !m.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn v(json: &str) -> VersionJson {
        VersionJson::from_json_str(json).expect("版本 JSON 应解析")
    }

    fn provider(versions: &[VersionJson]) -> HashMap<String, VersionJson> {
        versions.iter().map(|x| (x.id.clone(), x.clone())).collect()
    }

    #[test]
    fn healthy_vanilla_is_available() {
        let ver = v(r#"{"id":"1.21","mainClass":"net.minecraft.client.main.Main"}"#);
        let a = check_availability(&ver, &provider(&[]));
        assert!(a.is_available(), "预期可用，得到 {:?}", a.reasons);
    }

    #[test]
    fn loader_with_installed_parent_is_available() {
        let vanilla = v(r#"{"id":"1.21","mainClass":"net.minecraft.client.main.Main"}"#);
        let fabric = v(
            r#"{"id":"fabric-1.21","inheritsFrom":"1.21","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient"}"#,
        );
        let a = check_availability(&fabric, &provider(&[vanilla]));
        assert!(a.is_available(), "预期可用，得到 {:?}", a.reasons);
    }

    #[test]
    fn missing_parent_reports_inheritance_unresolved_only() {
        // 加载器 json 自身无 mainClass（本应从父继承），父缺失时只报继承未解析，不误报缺 mainClass。
        let fabric = v(r#"{"id":"fabric-1.21","inheritsFrom":"1.21"}"#);
        let a = check_availability(&fabric, &provider(&[]));
        assert!(!a.is_available());
        assert_eq!(
            a.reasons,
            vec![UnavailableReason::InheritanceUnresolved {
                missing_id: "1.21".into(),
                referenced_by: "fabric-1.21".into()
            }]
        );
    }

    #[test]
    fn standalone_without_main_class_reports_missing() {
        let ver = v(r#"{"id":"1.21"}"#);
        let a = check_availability(&ver, &provider(&[]));
        assert!(a.reasons.contains(&UnavailableReason::MissingMainClass));
    }

    #[test]
    fn merged_still_missing_main_class_is_reported() {
        // 父子都没有 mainClass，合并后仍缺 -> 报缺 mainClass。
        let parent = v(r#"{"id":"base","mainClass":""}"#);
        let child = v(r#"{"id":"child","inheritsFrom":"base"}"#);
        let a = check_availability(&child, &provider(&[parent]));
        assert!(a.reasons.contains(&UnavailableReason::MissingMainClass));
    }

    #[test]
    fn cycle_reports_inheritance_cycle() {
        let a1 = v(r#"{"id":"A","inheritsFrom":"B","mainClass":"M"}"#);
        let b1 = v(r#"{"id":"B","inheritsFrom":"A","mainClass":"M"}"#);
        let a = check_availability(&a1, &provider(&[a1.clone(), b1]));
        assert!(matches!(
            a.reasons.first(),
            Some(UnavailableReason::InheritanceCycle { .. })
        ));
    }

    #[test]
    fn opaque_id_without_version_is_flagged() {
        let ver = v(r#"{"id":"my-modpack","mainClass":"M"}"#);
        let a = check_availability(&ver, &provider(&[]));
        assert!(a.reasons.contains(&UnavailableReason::UnknownVersionNumber));
    }
}
