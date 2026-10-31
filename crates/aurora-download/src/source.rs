//! 下载源调度：官方源与 BMCLAPI 镜像之间的优先级列表、URL 解析与测速探针。
//!
//! [`SourcePlan`] 持有一组按优先级排列的 [`MirrorSource`]，并通过 [`SourceResolver`] 把一个
//! 官方 URL 展开成一组「候选具体 URL」（去重、保序）。引擎按此列表依次尝试，某源重试耗尽即切换
//! 下一个。解析器是可注入的接口：生产用 [`MirrorResolver`]（走 aurora-base 的镜像改写表），
//! 单元测试可注入自定义映射把不同源指向不同的本地 mock 端点。测速结论的缓存见
//! [`crate::speed::SourceSpeedCache`]。

use std::sync::Arc;
use std::time::{Duration, Instant};

use aurora_base::mirror::{self, MirrorSource};
use tokio::task::JoinSet;

use crate::error::{Error, Result};

/// 把「官方 URL + 下载源」解析为该源上的具体请求 URL。
pub trait SourceResolver: Send + Sync {
    /// 解析。非法 URL 等应返回错误而非静默兜底。
    fn resolve(&self, url: &str, source: MirrorSource) -> Result<String>;
}

/// 生产用解析器：直接套用 [`aurora_base::mirror::rewrite`] 的官方与 BMCLAPI 之间的改写规则。
pub struct MirrorResolver;

impl SourceResolver for MirrorResolver {
    fn resolve(&self, url: &str, source: MirrorSource) -> Result<String> {
        Ok(mirror::rewrite(url, source)?)
    }
}

/// 下载源优先级方案。
#[derive(Clone)]
pub struct SourcePlan {
    /// 按优先级排列的下载源，引擎从头到尾依次尝试。
    pub sources: Vec<MirrorSource>,
    resolver: Arc<dyn SourceResolver>,
}

impl std::fmt::Debug for SourcePlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourcePlan")
            .field("sources", &self.sources)
            .finish_non_exhaustive()
    }
}

impl Default for SourcePlan {
    /// 默认官方优先、BMCLAPI 兜底：直连可用时走官方，被墙/超时后自动切镜像。
    fn default() -> Self {
        Self::new(vec![MirrorSource::Official, MirrorSource::BmclApi])
    }
}

impl SourcePlan {
    /// 用默认（镜像表）解析器构造。
    pub fn new(sources: Vec<MirrorSource>) -> Self {
        Self {
            sources,
            resolver: Arc::new(MirrorResolver),
        }
    }

    /// 注入自定义解析器构造（测试或特殊源改写场景）。
    pub fn with_resolver(sources: Vec<MirrorSource>, resolver: Arc<dyn SourceResolver>) -> Self {
        Self { sources, resolver }
    }

    /// 把一个官方 URL 展开为按优先级排列、去重后的候选 URL 列表。
    ///
    /// 去重很关键：无镜像的域名（如 Modrinth）在所有源下解析结果相同，去重后只尝试一次，
    /// 不做无谓的重复请求；列表恒非空（源为空时回退到原始 URL）。
    pub fn candidates(&self, url: &str) -> Result<Vec<String>> {
        let mut out: Vec<String> = Vec::new();
        for &source in &self.sources {
            let resolved = self.resolver.resolve(url, source)?;
            if !out.contains(&resolved) {
                out.push(resolved);
            }
        }
        if out.is_empty() {
            out.push(url.to_owned());
        }
        Ok(out)
    }
}

/// 按时延升序排序：`Some(时延)` 之间比大小，`None`（探测失败/超时）一律沉到末尾。稳定排序保留同级原序。
pub fn order_by_latency(mut measured: Vec<(MirrorSource, Option<Duration>)>) -> Vec<MirrorSource> {
    use std::cmp::Ordering;
    measured.sort_by(|a, b| match (a.1, b.1) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    });
    measured.into_iter().map(|(source, _)| source).collect()
}

/// 并发对各源发起一次极小的 Range 探测并计时（响应头到达即止，不读响应体）。成功（2xx）记时延，
/// 失败或超时记 `None`。
///
/// 并发而非逐个：串行时每个不通的源都要各自等满超时，网络整体不佳（探针全数失败正是这种情形）时
/// 光探测就白搭进「源数 × 超时」，而这段延迟发生在下载开始前，直接计入玩家的等待。
///
/// 返回顺序与 `sources` 一致：[`order_by_latency`] 的稳定排序靠它保留同级源原有的优先级。
/// 解析失败在发出任何探针前整体返回错误；探测任务异常终止返回 [`Error::TaskJoin`]。
pub async fn probe_latencies(
    client: &reqwest::Client,
    sample_url: &str,
    sources: &[MirrorSource],
    resolver: &dyn SourceResolver,
    per_probe_timeout: Duration,
) -> Result<Vec<(MirrorSource, Option<Duration>)>> {
    let targets = sources
        .iter()
        .map(|&source| resolver.resolve(sample_url, source))
        .collect::<Result<Vec<_>>>()?;

    let mut set = JoinSet::new();
    for (index, url) in targets.into_iter().enumerate() {
        let client = client.clone();
        set.spawn(async move {
            let started = Instant::now();
            let probe = tokio::time::timeout(
                per_probe_timeout,
                client
                    .get(url.as_str())
                    .header(reqwest::header::RANGE, "bytes=0-0")
                    .send(),
            )
            .await;
            let latency = match probe {
                Ok(Ok(resp)) if resp.status().is_success() => Some(started.elapsed()),
                _ => None,
            };
            (index, latency)
        });
    }

    let mut latencies = vec![None; sources.len()];
    while let Some(joined) = set.join_next().await {
        let (index, latency) = joined.map_err(Error::TaskJoin)?;
        latencies[index] = latency;
    }
    Ok(sources.iter().copied().zip(latencies).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_dedup_unmapped_host_to_single() {
        // Modrinth 无 BMCLAPI 镜像，官方与镜像解析同一 URL，去重后只剩一个候选。
        let plan = SourcePlan::default();
        let got = plan
            .candidates("https://api.modrinth.com/v2/search?query=sodium")
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0], "https://api.modrinth.com/v2/search?query=sodium");
    }

    #[test]
    fn candidates_expand_mojang_url_to_two_sources() {
        let plan = SourcePlan::default();
        let got = plan
            .candidates("https://libraries.minecraft.net/foo/bar.jar")
            .unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], "https://libraries.minecraft.net/foo/bar.jar");
        assert_eq!(got[1], "https://bmclapi2.bangbang93.com/maven/foo/bar.jar");
    }

    #[test]
    fn candidates_order_follows_source_priority() {
        // 镜像优先：候选列表首个应是 BMCLAPI。
        let plan = SourcePlan::new(vec![MirrorSource::BmclApi, MirrorSource::Official]);
        let got = plan
            .candidates("https://libraries.minecraft.net/foo/bar.jar")
            .unwrap();
        assert_eq!(got[0], "https://bmclapi2.bangbang93.com/maven/foo/bar.jar");
        assert_eq!(got[1], "https://libraries.minecraft.net/foo/bar.jar");
    }

    #[test]
    fn empty_sources_fall_back_to_raw_url() {
        let plan = SourcePlan::new(vec![]);
        let got = plan.candidates("https://host/x").unwrap();
        assert_eq!(got, vec!["https://host/x".to_string()]);
    }

    #[test]
    fn order_by_latency_sorts_ascending_failed_last() {
        let measured = vec![
            (MirrorSource::Official, Some(Duration::from_millis(300))),
            (MirrorSource::BmclApi, Some(Duration::from_millis(80))),
        ];
        assert_eq!(
            order_by_latency(measured),
            vec![MirrorSource::BmclApi, MirrorSource::Official]
        );

        let with_failure = vec![
            (MirrorSource::Official, None),
            (MirrorSource::BmclApi, Some(Duration::from_millis(500))),
        ];
        assert_eq!(
            order_by_latency(with_failure),
            vec![MirrorSource::BmclApi, MirrorSource::Official]
        );
    }
}
