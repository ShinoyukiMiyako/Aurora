// 下载任务页的数值常量。吞吐曲线只在本页挂载期间采样，离开即丢弃，所以这些值只属于本页。

/** 吞吐曲线窗口里的采样点数（每秒一个，即最近这么多秒）。 */
export const THROUGHPUT_SAMPLES = 48;
/**
 * 吞吐采样保留的个数：比窗口多一个。曲线每秒向左滑一格，滑完时最旧的那一个正好出左缘，滑的途中左缘还看得见它；
 * 只留窗口那么多的话，左缘每秒会缺一格。
 */
export const THROUGHPUT_KEPT = THROUGHPUT_SAMPLES + 1;
/** 采样间隔：总速度与剩余时间每秒刷新一次。 */
export const SAMPLE_INTERVAL_MS = 1000;
/** 剩余时间按最近这么多个采样（秒）的平均速度估算，单个瞬时值抖动太大。 */
export const ETA_WINDOW_SAMPLES = 5;
/** 曲线纵轴的最低上限：低速下载不至于被放大成满格的锯齿。 */
export const CHART_MIN_CEILING_BPS = 4 * 1024 * 1024;
/**
 * 曲线纵轴上限的回落：峰值滑出窗口后，上限每个采样只降到上一次的这么多倍（约 15 秒降到五分之一），
 * 整条曲线慢慢长高，而不是峰值一出窗口就被一下拉满。
 */
export const CHART_CEILING_DECAY = 0.9;
/** 曲线的视图坐标：宽 100、高 30，线条最高画到距顶 5 的位置，给描边留出余量。 */
export const CHART_VIEW = { width: 100, height: 30, peak: 25 } as const;
/** 曲线上相邻两个采样的横向间距（视图坐标）：窗口里的采样首尾正好铺满视图宽。曲线每个采样间隔向左滑这么多。 */
export const CHART_STEP = CHART_VIEW.width / (THROUGHPUT_SAMPLES - 1);
/** 已结束任务的相对时间（「5 分钟前」）的刷新间隔；逐秒跳动只会分散注意力。 */
export const RELATIVE_TIME_REFRESH_MS = 30_000;
/** 并行通道卡排队说明里最多画几个排队圆点。 */
export const QUEUE_DOTS_MAX = 6;
/**
 * 总览行（吞吐卡与通道卡）的高度：通道卡的自然高度，描边 2 + 上下内边距 32 + 卡头 40 与下距 12
 * + 三条通道 3 × 38 与两道间距 16 + 排队说明 18 与上距 4。骨架照它画，总览行也至少这么高，换上内容时不变高。
 */
export const OVERVIEW_HEIGHT = 238;
/** 骨架里状态筛选条的宽度：四项带计数的分段控件大约这么宽。 */
export const FILTER_SKELETON_WIDTH = 360;
/** 骨架里任务列表画几行：首屏常见的量，多出的高度差由让位接住。 */
export const LIST_SKELETON_ROWS = 3;
