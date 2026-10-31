// 下载任务页自己的文案。跨页面共用的任务文案（类别、状态、失败原因、确认框）在 copy/flows，这里只放本页独有的。
// 插值一律经 domain/format 格式化后再传进来；数量相关的上限取自常量，不在句子里写死数字。

import { MAX_PARALLEL_TASKS } from "../../domain/limits";
import { THROUGHPUT_SAMPLES } from "./constants";

export const TASKS_COPY = {
  subtitleActive: (running: number, queued: number) => `${running} 个下载中，${queued} 个排队 · 最多 ${MAX_PARALLEL_TASKS} 个并行`,
  subtitleIdle: "队列空闲 · 新建实例、装 Mod、导入整合包都会排到这里",
  cancelAll: "全部取消",
  clearFinished: (count: number) => (count > 0 ? `清除已结束（${count}）` : "清除已结束"),

  flow: {
    ringLabel: "全部活动任务的总进度",
    running: "当前总速度",
    waiting: "等待开始",
    idle: "全部下载已完成",
    remaining: (bytes: string, eta: string) => `剩余 ${bytes} · ${eta}`,
    idleSub: "新任务开始后这里会画出吞吐曲线",
    downloaded: "已下载",
    batchTotal: "本批合计",
    chartIdle: `最近 ${THROUGHPUT_SAMPLES} 秒没有下载流量`,
  },

  lanes: {
    title: "并行通道",
    subtitle: `同一时间最多 ${MAX_PARALLEL_TASKS} 个任务在下`,
    idle: "空闲",
    queued: (count: number) => `还有 ${count} 个在排队，空出通道后按加入顺序开始`,
    none: "没有排队的任务",
    progressLabel: (title: string) => `${title} 的下载进度`,
  },

  filter: {
    ariaLabel: "按状态筛选",
    all: "全部",
    active: "进行中",
    done: "已完成",
    failed: "失败与取消",
  },

  group: {
    active: (count: number) => `进行中 · ${count}`,
    finished: (count: number) => `已结束 · ${count}`,
  },

  row: {
    listLabel: "下载任务",
    cancel: "取消任务",
    retry: "重试",
    viewInstance: "查看实例",
    failedTag: "失败",
    progressLabel: (title: string) => `${title} 的下载进度`,
    sizePending: "大小待定",
    waitingData: "等待数据",
    transfer: (done: string, total: string) => `${done} / ${total}`,
    speedEta: (speed: string, eta: string) => `${speed} · ${eta}`,
    doneWithSize: (size: string, took: string) => `${size} · 用时 ${took}`,
    doneNoSize: (took: string) => `用时 ${took}`,
    failed: (reason: string) => `失败：${reason}`,
    cancelledAt: (pct: string) => `取消于 ${pct}`,
  },

  eta: {
    soon: "即将完成",
    seconds: (n: number) => `约 ${n} 秒`,
    minutes: (n: number) => `约 ${n} 分钟`,
    overHour: "超过 1 小时",
  },

  took: {
    seconds: (n: number) => `${n} 秒`,
  },

  empty: {
    title: "下载队列是空的",
    body: `新建实例、导入整合包、安装 Mod 时，任务会排在这里，最多 ${MAX_PARALLEL_TASKS} 个同时进行。`,
    discover: "去发现",
    create: "新建实例",
  },

  filterEmpty: {
    active: { title: "没有进行中的任务" },
    done: { title: "还没有完成的任务", body: "或者已经被清除了。" },
    failed: { title: "没有失败或取消的任务" },
  },

  loadError: {
    retry: "重试",
  },


  offline: {
    title: "没有网络连接",
    body: "进行中的下载会继续重试，重试用完仍连不上时记为失败；联网后可以再重试。",
    retryReason: "联网后才能重试",
  },
} as const;
