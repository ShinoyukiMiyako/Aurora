// 新建、导入还没装好的实例：实例详情各标签在这段时间里的说法。
// 盘上还没有装好的实例目录，标签里该有的存档、Mod、设置、日志与诊断都还读不到，所以不画骨架，直接说明在装什么、进度去哪看。

/** 句末补句号；原因原文自己已带句末标点时不重复。 */
function sentence(text: string): string {
  return /[。！？.!?]$/.test(text) ? text : `${text}。`;
}

const PROGRESS_WHERE = "进度可以在下载任务里查看。";

export const INSTALL_STAGE_COPY = {
  title: "安装完成后可用",
  /** 安装任务在跑：任务标题本身就是「安装 1.21.1 + Fabric 0.16.10」「导入整合包 RLCraft」这样的动宾短语。 */
  running: (taskTitle: string) => `正在${taskTitle}，${PROGRESS_WHERE}`,
  queued: `安装任务排队中，等前面的任务完成后自动开始，${PROGRESS_WHERE}`,
  /** 概览顶部的安装横幅已经写了在装什么、给了进度与入口，下面这块只说装好后这里有什么。 */
  overviewAfter: "装好后这里会显示存档、Mod 与实例信息。",
  /** 任务已经结束、实例列表还没重扫到结果：装好了还是没装成，扫完才知道。 */
  landing: "安装任务已经结束，正在刷新实例列表…",
  failedTitle: { create: "安装没有完成", modpack: "导入没有完成" },
  failedBody: (reason: string) => `${sentence(reason)}可以重试，或到下载任务里查看。`,
  /** 有文件要手动下载：重试必然还是这个结果，下一步在「查看这些文件」的清单里。 */
  failedBlockedBody: (reason: string) => sentence(reason),
  retry: "重试",
  viewBlocked: "查看这些文件",
  viewTasks: "查看下载任务",
} as const;
