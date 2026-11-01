//! aurora-version 独立错误类型。
//!
//! 本 crate 是纯解析层，出错来源只有两类：
//! 一是 JSON 反序列化失败（`Json`，context 标注是清单还是版本 JSON 便于定位；规则里非法的
//! os.version 正则也在这一步报出）；
//! 二是 inheritsFrom 继承链的结构性异常（自引用、循环、前置缺失）。
//! 加载器探测、版本号识别、规则求值都是全函数（对任意输入都有确定返回值），不产出错误。

/// 版本解析与继承合并过程中的错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// serde_json 反序列化失败；`context` 说明失败的是哪一类文档。
    #[error("{context}解析失败")]
    Json {
        context: &'static str,
        #[source]
        source: serde_json::Error,
    },

    /// 版本的 inheritsFrom 指向自身，继承链无法成立。
    #[error("版本 {id} 的 inheritsFrom 指向自身")]
    SelfInherit { id: String },

    /// 继承链上出现环（如 A -> B -> A），无法收敛为单一版本。
    #[error("继承链存在循环: {}", .chain.join(" -> "))]
    InheritCycle { chain: Vec<String> },

    /// inheritsFrom 指向的前置版本在 provider 中缺失（通常意味着尚未安装）。
    #[error("版本 {referenced_by} 依赖的前置版本 {id} 不存在")]
    MissingInherited { id: String, referenced_by: String },
}

/// crate 级 `Result` 别名。
pub type Result<T> = std::result::Result<T, Error>;
