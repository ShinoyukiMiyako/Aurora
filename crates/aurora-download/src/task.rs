//! 下载任务描述。
//!
//! 一个 [`DownloadTask`] 是下载引擎的最小工作单元：源 URL、落盘目标、以及可选的完整性契约
//! （sha1 与大小）。sha1 一旦提供，引擎会在合并后强制校验、不符即重下；大小一旦提供，会用于
//! 判定是否值得多线程分块以及最终的截断检查。

use std::path::PathBuf;

use crate::credential::DownloadCredential;

/// 单个文件的下载任务。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadTask {
    /// 官方源 URL（镜像改写由源调度层按 [`crate::source::SourcePlan`] 完成，任务只描述官方地址）。
    pub url: String,
    /// 落盘目标的完整路径，父目录会被自动创建。
    pub dest: PathBuf,
    /// 期望的 sha1（小写或大写均可）。提供则合并后校验，不符触发重下/换源。
    pub sha1: Option<String>,
    /// 期望的文件大小（字节）。提供则用于分块决策与最终截断检查。
    pub size: Option<u64>,
    /// 下载凭据。提供则这个任务的请求都由引擎逐跳跟随跳转，只有凭据作用域内的那一跳才带上它。
    pub credential: Option<DownloadCredential>,
}

impl DownloadTask {
    /// 构造一个只含 URL 与目标路径、无完整性契约的任务。
    pub fn new(url: impl Into<String>, dest: impl Into<PathBuf>) -> Self {
        Self {
            url: url.into(),
            dest: dest.into(),
            sha1: None,
            size: None,
            credential: None,
        }
    }

    /// 附加期望 sha1。
    pub fn with_sha1(mut self, sha1: impl Into<String>) -> Self {
        self.sha1 = Some(sha1.into());
        self
    }

    /// 附加期望大小（字节）。
    pub fn with_size(mut self, size: u64) -> Self {
        self.size = Some(size);
        self
    }

    /// 附加下载凭据。
    pub fn with_credential(mut self, credential: DownloadCredential) -> Self {
        self.credential = Some(credential);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_sets_optional_fields() {
        let task = DownloadTask::new("https://host/a.jar", "C:/data/a.jar")
            .with_sha1("ABCDEF")
            .with_size(1024);
        assert_eq!(task.url, "https://host/a.jar");
        assert_eq!(task.dest, PathBuf::from("C:/data/a.jar"));
        assert_eq!(task.sha1.as_deref(), Some("ABCDEF"));
        assert_eq!(task.size, Some(1024));
    }

    #[test]
    fn new_leaves_contract_empty() {
        let task = DownloadTask::new("https://host/b", "b");
        assert!(task.sha1.is_none());
        assert!(task.size.is_none());
        assert!(task.credential.is_none());
    }

    #[test]
    fn with_credential_attaches_it_without_touching_the_contract() {
        let credential = DownloadCredential::curseforge("k").unwrap();
        let task = DownloadTask::new("https://edge.forgecdn.net/c.jar", "c.jar")
            .with_size(7)
            .with_credential(credential.clone());
        assert_eq!(task.credential, Some(credential));
        assert_eq!(task.size, Some(7));
        assert!(task.sha1.is_none());
    }
}
