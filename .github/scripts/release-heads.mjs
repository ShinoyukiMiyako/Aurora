// 发布流水线在编译之前读出各通道真正发布过的最高版本，供后面的版本先后检查与数据格式号检查使用。
// 某个通道「发布过某个版本」只采信用该通道公钥验得过签名的清单或 Release 附件，tag 名只用来定位：
// 伪造的 tag、乱写的清单都抬不高也压不低结果，最多让构建失败。
// 用法见 USAGE。失败时打 ::error:: 并以非零退出；给 shell 读的输出一行一条，字段用 tab 分隔。
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareVersions } from "./dev-distribution.mjs";
import { verifyTrustedComment } from "./verify-update-signature.mjs";

// 测试按共用版本向量对拍的就是这里用的比较器
export { compareVersions };

const USAGE = [
  "用法：",
  "  release-heads.mjs read <仓库> <heads 文件>",
  "仓库写成 owner/name。",
].join("\n");

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const CHANNEL_NAMES = Object.freeze(["dev", "beta", "stable"]);
const LABELS = Object.freeze({ dev: "预览版", beta: "测试版", stable: "正式版" });

// 与启动器 updater.rs 里钉住的三份香港清单地址、滚动预发布的 tag 逐字相同：这里读的必须是客户端在读的那几份
export const HK_MANIFEST_URLS = Object.freeze({
  dev: "https://petalfall.org/updates/dev/latest.json",
  beta: "https://petalfall.org/updates/beta/latest.json",
  stable: "https://petalfall.org/updates/stable/latest.json",
});
export const DEV_RELEASE_TAG = "dev-build";
export const PUBKEY_FILES = Object.freeze({
  dev: ".github/dev-updater.pub",
  beta: ".github/release-updater.pub",
  stable: ".github/release-updater.pub",
});
// 与香港机 put-manifest 收清单的上限相同
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const FETCH_RETRIES = 3;
export const FETCH_TIMEOUT_MS = 60_000;
export const RETRY_DELAY_MS = 5_000;

const PLATFORM = "windows-x86_64";
const NUM = "(?:0|[1-9][0-9]*)";
const CORE = `${NUM}\\.${NUM}\\.${NUM}`;
// 旧项目时期的 v0.1.0 到 v0.1.5 是主版本 0 的正式版 tag，测试版、正式版只认主版本至少为 1 的；
// dev 的清单还停在 0.1.0-dev.N，dev 允许主版本 0。
const SHAPES = Object.freeze({
  dev: new RegExp(`^${CORE}-dev\\.${NUM}$`),
  beta: new RegExp(`^[1-9][0-9]*\\.${NUM}\\.${NUM}-beta\\.${NUM}$`),
  stable: new RegExp(`^[1-9][0-9]*\\.${NUM}\\.${NUM}$`),
});
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

class UsageError extends Error {}

export function channelShapeOf(version) {
  if (typeof version !== "string") return null;
  const channel = CHANNEL_NAMES.find((name) => SHAPES[name].test(version));
  return channel === undefined ? null : channel;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function githubRemote(repo) {
  return `https://github.com/${repo}.git`;
}

export function releaseManifestUrl(repo, tag) {
  return `https://github.com/${repo}/releases/download/${tag}/latest.json`;
}

// 两个 .pub 与签名都是 tauri 的格式：base64 包着 minisign 文本。全局签名盖住「文件签名加可信注释」，
// 不盖安装包本身，所以只凭清单就能确认这把钥签发过哪个版本，不用下载安装包。
// tag 只在来源是某个 v* Release 时给：附件里签的版本必须就是这个 tag，换到别的 tag 下的附件不算数。
export function verifyManifest(bytes, { channel, pubkey, tag }) {
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`正文不是 UTF-8 编码的 JSON：${error.message}`, { cause: error });
  }
  if (!isObject(manifest) || typeof manifest.version !== "string") throw new Error("正文里没有字符串形式的 version");
  const entry = isObject(manifest.platforms) && Object.hasOwn(manifest.platforms, PLATFORM) ? manifest.platforms[PLATFORM] : undefined;
  if (!isObject(entry) || typeof entry.signature !== "string") {
    throw new Error(`正文里没有字符串形式的 platforms.${PLATFORM}.signature`);
  }
  const { version, file } = verifyTrustedComment(pubkey, entry.signature);
  if (channelShapeOf(version) !== channel) throw new Error(`签名里的版本 ${version} 不是${LABELS[channel]}的形状`);
  if (version !== manifest.version) throw new Error(`签名里的版本 ${version} 与正文的 ${manifest.version} 不符`);
  if (tag !== undefined && `v${version}` !== tag) throw new Error(`签名里的版本 ${version} 与 tag ${tag} 不符`);
  const expectedFile = `Petalfall-Installer-${version}-x64.exe`;
  if (file !== expectedFile) throw new Error(`签名里的文件名 ${file} 应为 ${expectedFile}`);
  return version;
}

const describeError = (error) => (error.cause instanceof Error ? `${error.message}：${error.cause.message}` : error.message);

// 只把连不上（网络错误、超时、读正文中途断开）当暂时性错误重试；拿到了状态码就按状态码定，
// 404 以外的非 2xx 直接交给调用方判失败，不重试。
async function fetchCapped(deps, url) {
  let lastError;
  for (let attempt = 1; attempt <= 1 + FETCH_RETRIES; attempt++) {
    try {
      const response = await deps.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, ok: false };
      }
      return { status: response.status, ok: true, ...(await readCapped(response)) };
    } catch (error) {
      lastError = error;
      if (attempt <= FETCH_RETRIES) {
        deps.err(annotate("warning", `第 ${attempt} 次取 ${url} 没连上（${describeError(error)}），${RETRY_DELAY_MS / 1000} 秒后重试`));
        await deps.sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(`取 ${url} 重试 ${FETCH_RETRIES} 次仍连不上：${describeError(lastError)}`, { cause: lastError });
}

// 边读边数，超过上限立即断开：服务端可以不给 Content-Length，也可以给假的
async function readCapped(response) {
  if (response.body === null) return { bytes: Buffer.alloc(0), tooLarge: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(chunks), tooLarge: false };
    size += value.byteLength;
    if (size > MAX_MANIFEST_BYTES) {
      await reader.cancel();
      return { bytes: null, tooLarge: true };
    }
    chunks.push(value);
  }
}

// 香港清单是客户端正在读的那一份：回了 200 却验不过，要人去查，不能当没有
async function readHk(deps, channel) {
  const url = HK_MANIFEST_URLS[channel];
  const response = await fetchCapped(deps, url);
  if (response.status === 404) {
    deps.out(`${LABELS[channel]}：香港清单 404，这一处算没有`);
    return { kind: "missing" };
  }
  if (!response.ok) throw new Error(`香港${LABELS[channel]}清单 ${url} 回了 HTTP ${response.status}`);
  if (response.tooLarge) throw new Error(`香港${LABELS[channel]}清单 ${url} 的正文超过 ${MAX_MANIFEST_BYTES} 字节`);
  const pubkey = deps.pubkey(channel);
  let version;
  try {
    version = verifyManifest(response.bytes, { channel, pubkey });
  } catch (error) {
    throw new Error(`香港${LABELS[channel]}清单 ${url} 验不过，这是客户端正在读的清单，要人去查：${error.message}`, { cause: error });
  }
  deps.out(`${LABELS[channel]}：香港清单验过，${version}`);
  return { kind: "verified", version, source: "hk" };
}

// Release 附件可以被 dev 的发布作业和 CLA 作业改写，验不过只说明这一处不可信，跳过接着找；
// 但下载本身出错不能跳过：跳过会让结果偏低，低出来的结果会放行本该挡住的版本。
async function readRelease(deps, repo, channel, tag) {
  const url = releaseManifestUrl(repo, tag);
  const response = await fetchCapped(deps, url);
  if (response.status === 404) {
    deps.out(`${LABELS[channel]}：Release ${tag} 上没有 latest.json，跳过`);
    return { kind: "missing" };
  }
  if (!response.ok) throw new Error(`Release ${tag} 上的 latest.json（${url}）回了 HTTP ${response.status}，跳过会让结果偏低`);
  if (response.tooLarge) {
    deps.err(annotate("warning", `Release ${tag} 上的 latest.json 超过 ${MAX_MANIFEST_BYTES} 字节，跳过`));
    return { kind: "rejected" };
  }
  // 公钥读不出是本仓库的问题，不能混进下面「这一处验不过」的跳过里
  const pubkey = deps.pubkey(channel);
  try {
    const version = verifyManifest(response.bytes, { channel, pubkey, tag: tag === DEV_RELEASE_TAG ? undefined : tag });
    deps.out(`${LABELS[channel]}：Release ${tag} 上的清单验过，${version}`);
    return { kind: "verified", version, source: tag === DEV_RELEASE_TAG ? "dev-build" : `release:${tag}` };
  } catch (error) {
    deps.err(annotate("warning", `Release ${tag} 上的 latest.json 验不过，跳过：${error.message}`));
    return { kind: "rejected" };
  }
}

// 同号时先出现的来源优先，香港清单排在最前
function settle(channel, results) {
  let best = null;
  for (const result of results) {
    if (result.kind === "verified" && (best === null || compareVersions(result.version, best.version) > 0)) {
      best = { version: result.version, source: result.source };
    }
  }
  if (best === null && results.some((result) => result.kind === "rejected")) {
    throw new Error(`${LABELS[channel]}有来源回了清单，却一处都验不过签名`);
  }
  return best;
}

function runGit(deps, args) {
  const result = deps.git(args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} 以 ${result.status} 退出：${result.stderr.trim()}`);
  }
  return result.stdout;
}

// 每行「对象号<tab>引用名」；带 ^{} 的是附注 tag 剥到提交的那一行
function parseLsRemote(stdout) {
  const refs = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    if (line === "") continue;
    const match = /^([0-9a-f]+)\t(refs\/tags\/.+)$/.exec(line);
    if (match === null || !OBJECT_ID.test(match[1])) throw new Error(`git ls-remote 输出了认不出的行：${line}`);
    refs.set(match[2], match[1]);
  }
  return refs;
}

function listTags(deps, repo) {
  const refs = parseLsRemote(runGit(deps, ["ls-remote", "--tags", "--refs", deps.remote(repo)]));
  return [...refs.keys()].map((ref) => ref.slice("refs/tags/".length));
}

async function readDev(deps, repo) {
  const results = [await readHk(deps, "dev"), await readRelease(deps, repo, "dev", DEV_RELEASE_TAG)];
  return settle("dev", results);
}

// 先拿香港这一处验过的版本 H，再从高到低只看高于 H 的 tag，取到第一个验过的就停：正常情况下一个 Release 都不用取，
// 伪造的高号 tag 只多花一次请求
async function readTagged(deps, repo, channel, tags) {
  const hk = await readHk(deps, channel);
  const results = [hk];
  const floor = hk.kind === "verified" ? hk.version : null;
  const candidates = tags
    .filter((tag) => tag.startsWith("v") && SHAPES[channel].test(tag.slice(1)))
    .map((tag) => tag.slice(1))
    .filter((version) => floor === null || compareVersions(version, floor) > 0)
    .sort((a, b) => compareVersions(b, a));
  for (const version of candidates) {
    const result = await readRelease(deps, repo, channel, `v${version}`);
    results.push(result);
    if (result.kind === "verified") break;
  }
  return settle(channel, results);
}

export async function readHeads(repo, deps) {
  requireRepo(repo);
  const dev = await readDev(deps, repo);
  const tags = listTags(deps, repo);
  const beta = await readTagged(deps, repo, "beta", tags);
  const stable = await readTagged(deps, repo, "stable", tags);
  return { dev, beta, stable };
}

function requireRepo(repo) {
  if (typeof repo !== "string" || !REPOSITORY.test(repo)) throw new UsageError(`仓库应写成 owner/name：${JSON.stringify(repo)}`);
}

// heads 文件是这个脚本自己写出的；读的时候照样逐项核对，手改坏了或者换了别的文件进来，检查不该照着错的结果放行
export function parseHeads(text) {
  let heads;
  try {
    heads = JSON.parse(text);
  } catch (error) {
    throw new Error(`heads 文件不是 JSON：${error.message}`, { cause: error });
  }
  if (!isObject(heads) || JSON.stringify(Object.keys(heads).sort()) !== JSON.stringify([...CHANNEL_NAMES].sort())) {
    throw new Error(`heads 文件的键应恰好是 ${CHANNEL_NAMES.join("、")}`);
  }
  for (const channel of CHANNEL_NAMES) {
    const head = heads[channel];
    if (head === null) continue;
    if (!isObject(head) || JSON.stringify(Object.keys(head).sort()) !== JSON.stringify(["source", "version"])) {
      throw new Error(`heads 文件里 ${channel} 应为 null 或恰好带 version、source 的对象`);
    }
    if (channelShapeOf(head.version) !== channel) throw new Error(`heads 文件里 ${channel} 的版本 ${JSON.stringify(head.version)} 不是${LABELS[channel]}的形状`);
    const sources = channel === "dev" ? ["hk", "dev-build"] : ["hk", `release:v${head.version}`];
    if (!sources.includes(head.source)) {
      throw new Error(`heads 文件里 ${channel} 的来源 ${JSON.stringify(head.source)} 应为 ${sources.join(" 或 ")}`);
    }
  }
  return heads;
}

export function formatHeads(heads) {
  return `${JSON.stringify({ dev: heads.dev, beta: heads.beta, stable: heads.stable })}\n`;
}

// 工作流命令的数据里换行与 % 要转义，否则多行报错只剩第一行
function annotate(kind, message) {
  return `::${kind}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;
}

function expectArgs(args, count) {
  if (args.length !== count || args.some((arg) => arg === "")) throw new UsageError(`参数应为 ${count} 个非空值，实际 ${args.length} 个`);
}

async function dispatch([command, ...args], deps) {
  switch (command) {
    case "read": {
      expectArgs(args, 2);
      const [repo, headsPath] = args;
      const heads = await readHeads(repo, deps);
      writeFileSync(headsPath, formatHeads(heads));
      for (const channel of CHANNEL_NAMES) {
        const head = heads[channel];
        deps.out(head === null ? `${channel}\tnull\tnull` : `${channel}\t${head.version}\t${head.source}`);
      }
      return 0;
    }
    default:
      throw new UsageError(`不认识的子命令：${JSON.stringify(command)}`);
  }
}

// 返回退出码：0 通过，1 读取出错，2 用法错误
export async function main(argv, deps) {
  try {
    return await dispatch(argv, deps);
  } catch (error) {
    deps.err(annotate("error", error.message));
    if (error instanceof UsageError) {
      deps.err(USAGE);
      return 2;
    }
    return 1;
  }
}

function spawnGit(args) {
  // 匿名读公开仓库，不该停下来等人输口令
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.error !== undefined) throw new Error(`跑不了 git：${result.error.message}`, { cause: result.error });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function defaultDeps() {
  return {
    fetch: (url, init) => fetch(url, init),
    git: spawnGit,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    remote: githubRemote,
    pubkey: (channel) => readFileSync(join(REPO_ROOT, PUBKEY_FILES[channel]), "utf8"),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

// 按 node 定位入口的同一套解析（realpath 后转 URL）比较：判不出是入口时脚本什么都不做却退出 0，检查就成了摆设。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), defaultDeps());
}
