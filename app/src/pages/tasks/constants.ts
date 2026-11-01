// 下载任务页的数值常量。吞吐曲线只在本页挂载期间采样，离开即丢弃，所以这些值只属于本页。

/** 吞吐曲线保留的采样点数（每秒一个，即最近这么多秒）。 */
export const THROUGHPUT_SAMPLES = 48;
/** 采样间隔：总速度与剩余时间每秒刷新一次。 */
export const SAMPLE_INTERVAL_MS = 1000;
/** 剩余时间按最近这么多个采样（秒）的平均速度估算，单个瞬时值抖动太大。 */
export const ETA_WINDOW_SAMPLES = 5;
/** 曲线纵轴的最低上限：低速下载不至于被放大成满格的锯齿。 */
export const CHART_MIN_CEILING_BPS = 4 * 1024 * 1024;
/** 曲线的视图坐标：宽 100、高 30，线条最高画到距顶 5 的位置，给描边留出余量。 */
export const CHART_VIEW = { width: 100, height: 30, peak: 25 } as const;
/** 已结束任务的相对时间（「5 分钟前」）的刷新间隔；逐秒跳动只会分散注意力。 */
export const RELATIVE_TIME_REFRESH_MS = 30_000;
/** 并行通道卡排队说明里最多画几个排队圆点。 */
export const QUEUE_DOTS_MAX = 6;
