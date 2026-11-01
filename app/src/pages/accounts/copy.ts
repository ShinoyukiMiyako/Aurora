// 账户页自己的文案。跨页面共用的（账户类型名、通知标题、动作失败标题）取自 copy/flows，这里不重复。
// 账户名不加直角引号；副标题例外，沿用账户页定稿的「启动游戏时使用「名称」」写法。

import type { AccountKind } from "../../domain/types";

export const ACCOUNTS_COPY = {
  title: "账户",
  subtitle: (count: number, current: string) => `${count} 个账户 · 启动游戏时使用「${current}」`,
  subtitleNone: "还没有可用的账户",

  addOther: "添加其他账户",
  addMicrosoft: "添加微软账户",
  menuOffline: "离线账户",
  menuAuthlib: "外置登录",

  currentTag: "当前账户",
  addedAgo: (relative: string) => `添加于 ${relative}`,
  verifiedSuffix: "正版已验证",
  reloginSuffix: "需要重新登录",
  copyUuid: "复制 UUID",
  kvMethod: "验证方式",
  kvLastVerified: "上次验证",
  kvAdded: "添加日期",
  method: {
    microsoft: "微软账户登录",
    authlib: (server: string) => `${server} 的 Yggdrasil 验证`,
    offline: "不经过验证，只用于单人与离线服务器",
  },
  refresh: "刷新账户信息",
  relogin: "重新登录",
  refreshed: "账户信息已更新",
  deleteAccount: "删除账户",
  setCurrent: "设为当前账户",
  moreActions: (name: string) => `${name} 的更多操作`,

  allAccounts: "全部账户",
  count: (count: number) => `${count} 个`,
  inUse: "使用中",
  expiredTag: "需要重新登录",
  switchTo: "切换到此账户",

  addCard: "添加账户",
  addOptions: {
    microsoft: { name: "微软账户", description: "正版验证，能进所有在线服务器" },
    offline: { name: "离线账户", description: "无需联网，单人与离线服使用" },
    authlib: { name: "外置登录", description: "LittleSkin 等第三方验证服务器" },
  },

  empty: {
    title: "还没有账户",
    body: "启动游戏需要一个账户。正版玩家添加微软账户，单人游戏或离线服务器可以用离线账户。",
    addOffline: "添加离线账户",
    addAuthlib: "添加外置登录账户",
  },

  retry: "重试",

  offline: {
    title: "没有网络连接",
    body: "添加微软账户、外置登录和刷新账户信息需要联网，离线账户照常可用。",
    needsNetwork: "联网后才能登录",
  },
} as const;

/** 卡片舞台左上角的类型短标。 */
export const KIND_SHORT: Readonly<Record<AccountKind, string>> = {
  microsoft: "微软",
  authlib: "外置",
  offline: "离线",
};

/** 删除账户的二次确认。后果逐句拼接，每句自带句号。 */
export const DELETE_COPY = {
  title: (name: string) => `删除账户 ${name}？`,
  base: "只会移除登录信息，不影响任何存档。",
  switchTo: (next: string) => `删除后切换到 ${next}。`,
  // 删掉正在用的离线账户、又没有别的离线账户时，后端回到上一次选中的微软或外置登录账户；
  // 有多个这类账户时前端不知道是哪一个，只说回到哪一类
  switchToPreviousCredential: "删除后切换回之前用的微软或外置登录账户。",
  last: "这是最后一个账户，删除后要重新添加才能启动游戏。",
  microsoft: "以后再用要重新登录。",
  running: "正在运行的游戏不受影响。",
  confirm: "删除账户",
} as const;
