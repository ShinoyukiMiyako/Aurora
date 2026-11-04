// 登录弹窗自己的文案；与账户页、启动拦截共用的词（按钮名、失败对照、外置登录说明）从 flows.ts 取。

import { MICROSOFT_LOGIN_COPY, accountKindLabel } from "./flows";

export const DEVICE_DIALOG_COPY = {
  title: "添加微软账户",
  doneTitle: "登录完成",
  subtitle: "在浏览器里登录微软账户，完成后这里会自动继续",
  successSub: "正版验证通过，之后启动游戏都会用这个账户",
  accountLine: `${accountKindLabel("microsoft", null)} · ${MICROSOFT_LOGIN_COPY.setCurrent}`,
  codeLabel: (code: string) => `登录代码 ${code}`,
  remaining: "代码剩余有效期",
  close: "关闭",
  copied: "已复制",
  cancelLogin: "取消登录",
} as const;

export const OFFLINE_DIALOG_COPY = {
  title: "添加离线账户",
  subtitle: "不联网、不验证正版，用来玩单人世界或离线服务器",
  nameLabel: "用户名",
  placeholder: "例如 Sakura_Miner",
  uuidLabel: "UUID",
  uuidEmpty: "输入用户名后生成",
  note: "同一个用户名在任何电脑上算出的 UUID 都相同，单人存档里的物品与进度跟着它走；改名就是换了一个人。",
  preview: (name: string) => `${name} 的角色预览`,
  previewEmpty: "角色预览：史蒂夫与艾利克斯",
  cancel: "取消",
} as const;

/** 经外层统一错误处理执行时的失败标题。 */
export const LOGIN_ERROR = {
  close: "登录弹窗没能关闭",
  openPage: "没能打开网页",
  probe: "没能连接外置登录服务器",
} as const;

export const AUTHLIB_DIALOG_COPY = {
  steps: ["服务器", "登录", "选择角色"],
  stepsLabel: "外置登录的步骤",
  cancel: "取消",
  back: "上一步",
  willUse: (url: string) => `将使用 ${url}`,
  invalidUrl: "这不是一个有效的网址",
  showPassword: "显示密码",
  profiles: "选择一个角色",
  profileHint: (server: string) => `这个账户在 ${server} 上有多个角色，选一个用来进游戏`,
  changeServer: "换一个服务器",
} as const;
