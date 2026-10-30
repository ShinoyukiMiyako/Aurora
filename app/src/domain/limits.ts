// 流程中的数值常量。页面、组件与状态层只 import，不内联同样的数字。

/** 已结束的会话（stopped）在界面上停留多久后清空。 */
export const STOPPED_LINGER_MS = 1500;
/** 结束游戏 / 取消启动的 IPC 超过这个时间未返回，回到原状态并报错。 */
export const STOP_TIMEOUT_MS = 10000;
/** 启动会话在内存里保留的日志行数上限；完整日志在后端文件里。 */
export const SESSION_LOG_LIMIT = 5000;

/** 同时处于 running 的下载任务上限，第 4 个起排队。 */
export const MAX_PARALLEL_TASKS = 3;
/** 已结束任务保留的条数。 */
export const TASK_HISTORY_LIMIT = 100;
/** 任务表变化后写入任务日志的防抖间隔。 */
export const TASK_JOURNAL_DEBOUNCE_MS = 1000;
/** 这个时间窗内的多个下载失败合并成一条通知。 */
export const FAILURE_TOAST_MERGE_MS = 10000;

/** 发起微软登录后多久仍未收到设备码即判为失败。 */
export const DEVICE_CODE_FETCH_TIMEOUT_MS = 15000;
/** 外置登录服务器元数据探测的时限。 */
export const ALI_PROBE_TIMEOUT_MS = 10000;

/** 各色调通知的自动消失时长；null 表示不自动消失。 */
export const TOAST_TTL_MS = { info: 5000, success: 5000, warning: 8000, error: null } as const;
/** 带操作按钮的通知至少停留这么久（error 仍不自动消失）。 */
export const TOAST_ACTION_MIN_TTL_MS = 8000;
export const TOAST_MAX = 4;
export const TOAST_DEDUPE_MS = 3000;
/** 暂停计时结束后，剩余寿命不足这个值的补到这个值。 */
export const TOAST_MIN_REMAIN_MS = 2000;

/** 「已复制」原位反馈的停留时长。 */
export const COPY_FEEDBACK_MS = 2000;

/** 请求在这个时间内返回就不出现任何加载态；骨架一旦出现至少保持同样的时长。 */
export const LOADING_DELAY_MS = 300;
/** 超过这个时间仍在加载时追加「比平时慢一些」的提示。 */
export const SLOW_HINT_MS = 10000;
/** 资源平台接口（搜索、详情）的超时。 */
export const PLATFORM_TIMEOUT_MS = 20000;
export const SEARCH_DEBOUNCE_MS = 300;
/** 离线期间的连通性探测间隔。 */
export const OFFLINE_PROBE_MS = 15000;

/** 窗口重新获得焦点且距上次扫描至少这么久时重扫实例列表。 */
export const INSTANCE_RESCAN_MIN_MS = 30000;
/** 侧栏固定实例的上限。 */
export const SIDEBAR_PIN_LIMIT = 5;
