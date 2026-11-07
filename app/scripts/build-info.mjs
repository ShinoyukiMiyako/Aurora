// 构建信息：版本号、发布通道与构建时间。由 vite.config.ts 在构建与开发服务器启动时读一次，经 define 注入前端。
// 版本号以 tauri.conf.json 为准：它是安装包与更新器比较时用的版本号，前端显示的必须和它是同一个。

import { readFileSync } from "node:fs";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PREVIEW_TAG = /^dev\d*$/;
const BETA_TAG = /^beta\d*$/;

/**
 * 发布通道由版本号推出：预发布标识的第一段是 dev 为预览版、beta 为测试版，后面只跟数字或什么都不跟，不分大小写；
 * 没有预发布标识时 0.x 尚未发布过正式版，算预览版，1.0 起为正式版。
 * 预发布标识只认这两种，与启动器认更新通道的规则（Rust 侧的 UpdateChannel::of）一致：rc、alpha 这类标识没有清单，
 * 启动器会判为不支持自更新，关于页再打上测试版或预览版就前后矛盾，所以直接报错，让构建停下，不猜。
 */
export function releaseChannel(version) {
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`版本号「${version}」不是语义化版本`);
  const prerelease = match[4];
  if (prerelease !== undefined) {
    const tag = prerelease.split(".")[0].toLowerCase();
    if (PREVIEW_TAG.test(tag)) return "preview";
    if (BETA_TAG.test(tag)) return "beta";
    throw new Error(`版本号「${version}」的预发布标识「${tag}」不对应任何发布通道`);
  }
  return match[1] === "0" ? "preview" : "stable";
}

/** 构建时间：设了 SOURCE_DATE_EPOCH（秒）时取它，同一份源码重复构建得到同样的产物；否则取当前时间。 */
export function buildTime(env, now) {
  const epoch = env.SOURCE_DATE_EPOCH;
  if (epoch === undefined || epoch === "") return now.toISOString();
  if (!/^\d+$/.test(epoch)) throw new Error(`SOURCE_DATE_EPOCH「${epoch}」不是以秒计的整数时间戳`);
  return new Date(Number(epoch) * 1000).toISOString();
}

export function readBuildInfo({ tauriConfPath, env, now }) {
  const conf = JSON.parse(readFileSync(tauriConfPath, "utf8"));
  const version = conf.version;
  if (typeof version !== "string") throw new Error(`${tauriConfPath} 没有写 version`);
  return { version, channel: releaseChannel(version), builtAt: buildTime(env, now) };
}
