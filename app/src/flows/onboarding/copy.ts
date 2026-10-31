// 首次启动向导的文案。产品名一律经 APP_NAME 拼入。

import type { IconName } from "../../art/Icon";
import { APP_NAME } from "../../lib/app-info";
import type { StepId } from "./model";

export const WIZARD_LABEL = "首次启动设置";

export const STEP_COPY: Readonly<Record<StepId, { name: string; title: string; desc: string }>> = {
  gameDir: {
    name: "游戏目录",
    title: "游戏文件放在哪",
    desc: "版本、存档与 Mod 都会落在这个目录里。之后可以在设置里随时改，也能添加更多文件夹。",
  },
  java: {
    name: "Java",
    title: "看看这台电脑上的 Java",
    desc: `不同游戏版本要不同的 Java。${APP_NAME}会按版本自动挑选，缺的可以自动下载。`,
  },
  account: {
    name: "账户",
    title: "用什么账户进游戏",
    desc: "正版玩家用微软账户；只玩单机或离线服，可以先建一个离线账户。现在跳过也没关系。",
  },
  appearance: {
    name: "外观",
    title: "挑一个你喜欢的样子",
    desc: "随时可以在 设置 > 外观 里改。",
  },
};

export const stepCounter = (n: number, total: number) => `第 ${n} 步，共 ${total} 步`;

export const FOOTER_COPY = {
  back: "上一步",
  skip: "跳过",
  next: "下一步",
  startNow: "直接开始",
  finish: "开始使用",
  preparing: "正在准备",
  skippedTag: "已跳过",
  stepsLabel: "向导步骤",
  finishFailed: "首次设置没有保存",
} as const;

export const DIR_COPY = {
  field: "游戏目录",
  browse: "浏览",
  useDefault: "用回默认位置",
  autoCreate: "目录不存在会自动创建",
  hasFiles: "这个目录里已经有游戏文件，会直接接管，原有存档和 Mod 不会被改动。",
  othersTitle: "发现了其他启动器的文件夹",
  othersDesc: "收下之后可以直接切过去玩，里面的存档和 Mod 不会被移动，也不会被改。",
  othersCount: (picked: number, total: number) => `${picked}/${total}`,
  none: "没有找到其他启动器的文件夹。之后可以在设置里手动添加。",
  empty: "游戏目录不能为空",
  bang: "路径里不能有「!」，Java 会读不出里面的游戏文件",
  pickFailed: "没能打开文件夹选择框",
  settingsFailed: "读不到默认的游戏目录",
  discoverFailed: "没能探测其他启动器的文件夹",
  retry: "重试",
} as const;

export const JAVA_STEP_COPY = {
  scanning: "正在查找本机的 Java…",
  runtime: (major: number) => `Java ${major}`,
  vendor: (vendor: string, version: string) => `${vendor} ${version}`,
  bits64: "64 位",
  bits32: "32 位",
  more: (n: number) => `还有 ${n} 个`,
  emptyTitle: "没有在本机找到 Java",
  emptyBody: "不用担心，打开下面的自动下载，第一次启动游戏时会下好匹配的版本。",
  autoDownload: "自动下载 Java",
  autoDownloadDesc: "启动时缺少匹配的运行时，自动下载对应版本",
  failed: "查找 Java 时出错",
  retry: "重试",
  saveFailed: "没能保存「自动下载 Java」",
} as const;

export const ACCOUNT_STEP_COPY = {
  added: "已添加",
  addMore: "继续添加",
  offlineReason: "联网后才能登录",
  loginFailed: "没能打开登录",
} as const;

export const LOGIN_OPTIONS: readonly { kind: "microsoft" | "offline" | "authlib"; name: string; desc: string; icon: IconName; online: boolean }[] = [
  { kind: "microsoft", name: "微软账户", desc: "正版验证，能进所有在线服务器", icon: "shield", online: true },
  { kind: "offline", name: "离线账户", desc: "无需联网，单人与离线服使用", icon: "user", online: false },
  { kind: "authlib", name: "外置登录", desc: "LittleSkin 等第三方验证服务器", icon: "server", online: true },
];

export const APPEARANCE_STEP_COPY = {
  mode: "明暗",
  accent: "强调色",
  petals: "飘落花瓣",
  petalsDesc: "主页背景少量像素花瓣缓慢飘落",
  saveFailed: (name: string) => `没能保存「${name}」`,
} as const;
