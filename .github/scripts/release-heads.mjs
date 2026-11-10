// 发布流水线在编译之前读出各通道真正发布过的最高版本，据此做版本先后检查与数据格式号不倒退的检查；
// 构建之后再核对安装包的载荷头。
// 某个通道「发布过某个版本」只采信用该通道公钥验得过签名的清单或 Release 附件，tag 名只用来定位：
// 伪造的 tag、乱写的清单都抬不高也压不低结果，最多让构建失败。
// 用法见 USAGE。失败时打 ::error:: 并以非零退出；给 shell 读的输出一行一条，字段用 tab 分隔。
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareVersions } from "./dev-distribution.mjs";
import { verifyTrustedComment } from "./verify-update-signature.mjs";

// 测试按共用版本向量对拍的就是这里用的比较器
export { compareVersions };

const USAGE = [
  "用法：",
  "  release-heads.mjs read <仓库> <heads 文件>",
  "  release-heads.mjs gate <dev|beta> <release|rehearsal> <本包版本> <heads 文件>",
  "  release-heads.mjs data-format <dev|beta> <release|rehearsal> <heads 文件> <仓库>",
  "  release-heads.mjs payload <本包版本> <magic> <版本> <data_format> <caps>",
  "仓库写成 owner/name。rehearsal 只给不在 beta 分支上的测试版演练用：版本先后与数据格式号的检查不过时只打 notice，",
  "读取出错照样失败；dev 没有演练。",
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
export const DATA_FORMAT_PATH = "crates/petalfall-release/src/data_format.rs";
// 要求恰好命中一行：常量的写法一改，这里就读不出号，CI 会挂而不是悄悄跳过
export const DATA_FORMAT_LINE = /^pub const DATA_FORMAT: u32 = ([1-9][0-9]*);$/;
// 与香港机 put-manifest 收清单的上限相同
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const FETCH_RETRIES = 3;
export const FETCH_TIMEOUT_MS = 60_000;
export const RETRY_DELAY_MS = 5_000;
export const PAYLOAD_MAGIC = "PFSETUP2";

const PLATFORM = "windows-x86_64";
const U32_MAX = 0xffff_ffffn;
const NUM = "(?:0|[1-9][0-9]*)";
const CORE = `${NUM}\\.${NUM}\\.${NUM}`;
// 旧项目时期的 v0.1.0 到 v0.1.5 是主版本 0 的正式版 tag，测试版、正式版只认主版本至少为 1 的；
// dev 的清单还停在 0.1.0-dev.N，dev 允许主版本 0。
const SHAPES = Object.freeze({
  dev: new RegExp(`^${CORE}-dev\\.${NUM}$`),
  beta: new RegExp(`^[1-9][0-9]*\\.${NUM}\\.${NUM}-beta\\.${NUM}$`),
  stable: new RegExp(`^[1-9][0-9]*\\.${NUM}\\.${NUM}$`),
});
// 本包版本只按通道的预发布标识认形状，主版本与补丁段交给基础号那一条去拒，报错才说得出为什么
const PACKAGE_SHAPES = Object.freeze({
  dev: new RegExp(`^(${CORE})-dev\\.${NUM}$`),
  beta: new RegExp(`^(${CORE})-beta\\.${NUM}$`),
});
// 补丁段留给正式版补丁：dev 一旦用 X.Y.(Z+1) 当基础号，正式版补丁就会撞号
const SHUTTLE_BASE = /^[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.0$/;
const CORE_PREFIX = /^([0-9]+)\.([0-9]+)\.([0-9]+)/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const MODES = Object.freeze(["release", "rehearsal"]);

class UsageError extends Error {}

export function channelShapeOf(version) {
  if (typeof version !== "string") return null;
  const channel = CHANNEL_NAMES.find((name) => SHAPES[name].test(version));
  return channel === undefined ? null : channel;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function coreOf(version) {
  const match = CORE_PREFIX.exec(version);
  if (match === null) throw new Error(`版本号 ${version} 没有 X.Y.Z 核心号`);
  return match.slice(1, 4).map(BigInt);
}

function compareCore(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

const formatCore = (core) => core.join(".");

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

const describeHead = (channel, head) => `已发布的${LABELS[channel]} ${head.version}（来源 ${head.source}）`;

function requireBase(base, failures) {
  if (!SHUTTLE_BASE.test(base)) {
    failures.push(`基础号 ${base} 应形如 X.Y.0、主版本至少为 1：补丁段留给正式版补丁，主版本 0 低于现行的所有版本`);
  }
}

function packageBase(channel, version) {
  const match = typeof version === "string" ? PACKAGE_SHAPES[channel].exec(version) : null;
  if (match === null) throw new UsageError(`本包版本 ${JSON.stringify(version)} 不是${LABELS[channel]}的形状 X.Y.Z-${channel}.N`);
  return match[1];
}

// 同一基础号下 beta < dev < 正式版，「预览版不低于测试版不低于正式版」不能靠共用基础号自然成立，由这几条挡住违规的构建。
// 基础号只能抬到 X.(Y+1).0 或 (X+1).0.0：把 1.1.0 手误写成 1.10.0 这种版本一发出，所有更快通道的用户都会接收，只能往前修。
export function devGate(version, heads) {
  const base = packageBase("dev", version);
  const failures = [];
  const notices = [];
  requireBase(base, failures);
  for (const channel of ["beta", "stable"]) {
    const head = heads[channel];
    if (head !== null && compareVersions(version, head.version) <= 0) {
      failures.push(`本包 ${version} 不高于${describeHead(channel, head)}：预览版必须高于测试版与正式版`);
    }
  }
  const cores = CHANNEL_NAMES.filter((channel) => heads[channel] !== null).map((channel) => coreOf(heads[channel].version));
  if (cores.length === 0) {
    notices.push("三个通道都还没有发布过，不查基础号的跨度");
  } else {
    const highest = cores.reduce((a, b) => (compareCore(a, b) >= 0 ? a : b));
    const [major, minor] = highest;
    const allowed = [highest, [major, minor + 1n, 0n], [major + 1n, 0n, 0n]];
    const core = coreOf(version);
    if (!allowed.some((candidate) => compareCore(candidate, core) === 0)) {
      failures.push(
        `本包核心号 ${formatCore(core)} 应等于各通道已发布的最高核心号 ${formatCore(highest)}，或者是它的后继 ${allowed
          .slice(1)
          .map(formatCore)
          .join("、")}：基础号一次只能抬一格`,
      );
    }
  }
  return { failures, notices };
}

// 两处 dev 清单都没有时不比低于预览版：dev 止血、清单都撤掉时不该卡住测试版。读取本身出错在 read 那一步就已失败。
export function betaGate(version, heads) {
  const base = packageBase("beta", version);
  const failures = [];
  const notices = [];
  if (heads.dev === null) {
    notices.push("预览版还没有验得过的发布，不比本包是否低于预览版");
  } else if (compareVersions(version, heads.dev.version) >= 0) {
    failures.push(`本包 ${version} 不低于${describeHead("dev", heads.dev)}：测试版必须低于预览版`);
  }
  if (heads.stable !== null && compareCore(coreOf(version), coreOf(heads.stable.version)) <= 0) {
    failures.push(`本包核心号 ${formatCore(coreOf(version))} 不高于${describeHead("stable", heads.stable)}：这个基础号已经出过正式版`);
  }
  requireBase(base, failures);
  return { failures, notices };
}

export function parseDataFormat(text, what) {
  const values = text
    .split(/\r?\n/)
    .map((line) => DATA_FORMAT_LINE.exec(line))
    .filter((match) => match !== null)
    .map((match) => match[1]);
  if (values.length !== 1) throw new Error(`${what} 里应恰好有一行 pub const DATA_FORMAT: u32 = <正整数>;，实际 ${values.length} 行`);
  if (BigInt(values[0]) > U32_MAX) throw new Error(`${what} 里的 DATA_FORMAT ${values[0]} 超出 u32`);
  return Number(values[0]);
}

// 没有这个文件的提交（这套机制之前的发布）返回 null；提交本身取不到照样报错
function dataFormatAt(deps, commit) {
  if (runGit(deps, ["ls-tree", "--name-only", commit, "--", DATA_FORMAT_PATH]).trim() === "") return null;
  return parseDataFormat(runGit(deps, ["show", `${commit}:${DATA_FORMAT_PATH}`]), `提交 ${commit} 的 ${DATA_FORMAT_PATH}`);
}

function remoteTagCommit(deps, remote, tag) {
  const refs = parseLsRemote(runGit(deps, ["ls-remote", "--tags", remote]));
  const peeled = refs.get(`refs/tags/${tag}^{}`);
  if (peeled !== undefined) return peeled;
  const direct = refs.get(`refs/tags/${tag}`);
  return direct === undefined ? null : direct;
}

// 已在本地的提交不再按深度 1 取：完整的仓库按深度取一个已有的提交，会被改成浅仓库
function ensureCommit(deps, commit) {
  if (deps.git(["cat-file", "-e", `${commit}^{commit}`]).status === 0) return;
  runGit(deps, ["fetch", "--depth=1", "origin", commit]);
}

// 「本通道上一次发布的那个提交」里的号：dev 是滚动预发布 tag 所指的提交，beta 是 v<已发布的最高测试版>。
// tag 不存在（别的运行正在重建预发布）或那个提交里还没有这个文件时跳过，返回 null。
function previousDataFormat(deps, { channel, heads, remote }, notices) {
  let tag;
  if (channel === "dev") {
    tag = DEV_RELEASE_TAG;
  } else if (heads.beta === null) {
    notices.push("测试版还没有验得过的发布，不查数据格式号是否倒退");
    return null;
  } else {
    tag = `v${heads.beta.version}`;
  }
  const commit = remoteTagCommit(deps, remote, tag);
  if (commit === null) {
    notices.push(`远端没有 tag ${tag}，不查数据格式号是否倒退`);
    return null;
  }
  ensureCommit(deps, commit);
  const value = dataFormatAt(deps, commit);
  if (value === null) {
    notices.push(`tag ${tag} 所指的提交 ${commit} 里还没有 ${DATA_FORMAT_PATH}，不查数据格式号是否倒退`);
    return null;
  }
  deps.out(`上一次发布：tag ${tag} 所指的提交 ${commit}，数据格式号 ${value}`);
  return value;
}

// 测试版只能拿 dev 上已有的号：dev 第一父链上第一次把号改成 N 的提交必须是 HEAD 的祖先。
// 把 dev 上的加号提交单独摘进 beta 时，beta 上的是摘出来的新提交，dev 上那个提交不在 HEAD 的历史里；
// 经晋级合并带进来的号，那个提交随合并成为祖先。
function ancestorFailure(deps, current) {
  const shallow = runGit(deps, ["rev-parse", "--is-shallow-repository"]).trim() === "true";
  runGit(deps, ["fetch", ...(shallow ? ["--unshallow"] : []), "origin", "+refs/heads/dev:refs/remotes/origin/dev"]);
  const commits = runGit(deps, ["log", "--first-parent", "--reverse", "--format=%H", "refs/remotes/origin/dev", "--", DATA_FORMAT_PATH])
    .split(/\r?\n/)
    .filter((line) => line !== "");
  const introduced = commits.find((commit) => dataFormatAt(deps, commit) === current);
  if (introduced === undefined) {
    return `dev 的第一父链上没有哪个提交把数据格式号改成 ${current}：测试版只能拿 dev 上已有的号`;
  }
  const check = deps.git(["merge-base", "--is-ancestor", introduced, "HEAD"]);
  if (check.status === 0) {
    deps.out(`dev 上把数据格式号改成 ${current} 的提交 ${introduced} 是 HEAD 的祖先`);
    return null;
  }
  if (check.status === 1) {
    return `dev 上把数据格式号改成 ${current} 的提交 ${introduced} 不是 HEAD 的祖先：加号的提交只能随晋级合并进入测试版，不能单独摘进来`;
  }
  throw new Error(`git merge-base --is-ancestor ${introduced} HEAD 以 ${check.status} 退出：${check.stderr.trim()}`);
}

export function checkDataFormat({ channel, heads, remote }, deps) {
  const failures = [];
  const notices = [];
  const current = dataFormatAt(deps, "HEAD");
  if (current === null) throw new Error(`HEAD 里没有 ${DATA_FORMAT_PATH}`);
  const previous = previousDataFormat(deps, { channel, heads, remote }, notices);
  if (previous !== null && current < previous) {
    failures.push(`本提交的数据格式号 ${current} 小于上一次发布的 ${previous}：号只能随加号的提交往上走，回退掉加号的提交会让旧数据被当成新格式读`);
  }
  if (channel === "beta") {
    const failure = ancestorFailure(deps, current);
    if (failure !== null) failures.push(failure);
  }
  return { current, previous, failures, notices };
}

function parseU32(value, what, failures) {
  if (!DECIMAL.test(value) || BigInt(value) > U32_MAX) {
    failures.push(`载荷头的 ${what} 应是 u32 的十进制写法：${JSON.stringify(value)}`);
    return null;
  }
  return BigInt(value);
}

export function payloadFailures({ version, magic, headerVersion, dataFormat, caps }, sourceDataFormat) {
  const failures = [];
  if (magic !== PAYLOAD_MAGIC) failures.push(`载荷头的 magic 是 ${magic}，应为 ${PAYLOAD_MAGIC}`);
  if (headerVersion !== version) failures.push(`载荷头里的版本是 ${headerVersion}，本包是 ${version}`);
  const format = parseU32(dataFormat, "data_format", failures);
  if (format !== null && format !== BigInt(sourceDataFormat)) {
    failures.push(`载荷头的 data_format 是 ${format}，源码里的 DATA_FORMAT 是 ${sourceDataFormat}`);
  }
  const bits = parseU32(caps, "caps", failures);
  if (bits !== null && (bits & 1n) === 0n) failures.push(`载荷头的 caps 是 ${bits}，第 0 位不是 1：引导程序不认得换通道安装`);
  return failures;
}

// 工作流命令的数据里换行与 % 要转义，否则多行报错只剩第一行
function annotate(kind, message) {
  return `::${kind}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;
}

// 工作流里的参数多半来自变量展开，变量没设时就是空串：报出空的是第几个、叫什么，才查得到是哪个变量没设
function expectArgs(args, names) {
  if (args.length !== names.length) {
    throw new UsageError(`参数应为 ${names.length} 个（${names.map((name) => `<${name}>`).join(" ")}），实际 ${args.length} 个`);
  }
  const empty = names.map((name, index) => (args[index] === "" ? `第 ${index + 1} 个参数 <${name}>` : null)).filter((entry) => entry !== null);
  if (empty.length > 0) throw new UsageError(`${empty.join("、")} 是空的`);
}

function channelAndMode(channel, mode) {
  if (channel !== "dev" && channel !== "beta") throw new UsageError(`通道只能是 dev 或 beta：${JSON.stringify(channel)}`);
  if (!MODES.includes(mode)) throw new UsageError(`模式只能是 ${MODES.join(" 或 ")}：${JSON.stringify(mode)}`);
  // dev 每次推送都发布，没有不发布的演练；把检查降成 notice 只会让违规的 dev 包发出去
  if (channel === "dev" && mode !== "release") throw new UsageError("dev 没有演练模式，只能传 release");
}

// 演练的测试版本来就不发布；dev 还停在旧基础号、还没有数据格式号的时候也要能演练，所以检查不过只记下来、不挡构建
function conclude(deps, { failures, notices }, mode, passed) {
  for (const notice of notices) deps.err(annotate("notice", notice));
  if (failures.length === 0) {
    deps.out(passed);
    return 0;
  }
  if (mode === "rehearsal") {
    for (const failure of failures) deps.err(annotate("notice", `演练，不挡构建：${failure}`));
    return 0;
  }
  for (const failure of failures) deps.err(annotate("error", failure));
  return 1;
}

function writeOutputs(deps, entries) {
  const path = deps.env.GITHUB_OUTPUT;
  if (typeof path !== "string" || path === "") return;
  appendFileSync(path, entries.map(([key, value]) => `${key}=${value}\n`).join(""));
}

async function dispatch([command, ...args], deps) {
  switch (command) {
    case "read": {
      expectArgs(args, ["仓库", "heads 文件"]);
      const [repo, headsPath] = args;
      const heads = await readHeads(repo, deps);
      writeFileSync(headsPath, formatHeads(heads));
      for (const channel of CHANNEL_NAMES) {
        const head = heads[channel];
        deps.out(head === null ? `${channel}\tnull\tnull` : `${channel}\t${head.version}\t${head.source}`);
      }
      return 0;
    }
    case "gate": {
      expectArgs(args, ["dev|beta", "release|rehearsal", "本包版本", "heads 文件"]);
      const [channel, mode, version, headsPath] = args;
      channelAndMode(channel, mode);
      const heads = parseHeads(readFileSync(headsPath, "utf8"));
      const result = channel === "dev" ? devGate(version, heads) : betaGate(version, heads);
      return conclude(deps, result, mode, `版本先后检查通过：${version}`);
    }
    case "data-format": {
      expectArgs(args, ["dev|beta", "release|rehearsal", "heads 文件", "仓库"]);
      const [channel, mode, headsPath, repo] = args;
      channelAndMode(channel, mode);
      requireRepo(repo);
      const heads = parseHeads(readFileSync(headsPath, "utf8"));
      const result = checkDataFormat({ channel, heads, remote: deps.remote(repo) }, deps);
      writeOutputs(deps, [
        ["data-format", String(result.current)],
        ["previous-data-format", result.previous === null ? "skipped" : String(result.previous)],
      ]);
      return conclude(deps, result, mode, `数据格式号检查通过：${result.current}`);
    }
    case "payload": {
      expectArgs(args, ["本包版本", "magic", "版本", "data_format", "caps"]);
      const [version, magic, headerVersion, dataFormat, caps] = args;
      const source = parseDataFormat(deps.dataFormatSource(), DATA_FORMAT_PATH);
      const failures = payloadFailures({ version, magic, headerVersion, dataFormat, caps }, source);
      return conclude(deps, { failures, notices: [] }, "release", `载荷头核对通过：${magic}\t${headerVersion}\t${dataFormat}\t${caps}`);
    }
    default:
      throw new UsageError(`不认识的子命令：${JSON.stringify(command)}`);
  }
}

// 返回退出码：0 通过（含演练里只打 notice 的情形），1 检查不过或读取出错，2 用法错误
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
    dataFormatSource: () => readFileSync(join(REPO_ROOT, DATA_FORMAT_PATH), "utf8"),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

// 按 node 定位入口的同一套解析（realpath 后转 URL）比较：判不出是入口时脚本什么都不做却退出 0，检查就成了摆设。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), defaultDeps());
}
