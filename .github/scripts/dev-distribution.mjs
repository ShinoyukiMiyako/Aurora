// dev 与 beta 通道的分发链路：三个存储桶的上传目标、对象键和公网地址，以及带 x-size、x-sources 的更新清单的生成与校验。
// 通道由版本号推出，桶里的前缀和清单说明的来源都按它分：调用方不另传通道，版本号和前缀就不会对不上。
// 上传、读回、清单都从这里取地址：传进哪个桶、从哪个主机读回、清单里写哪个地址，三者不会各算各的。
// 源名、主机白名单与启动器编译进去的、香港机 put-manifest 校验的是同一份；改这里要同时改那两处。
// 用法见 USAGE；子命令的输出给工作流里的 shell 读，一行一条，字段用 tab 分隔。
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = [
  "用法：",
  "  dev-distribution.mjs key <版本> <运行标识> <文件名>",
  "  dev-distribution.mjs upload-targets <R2 账户 ID>",
  "  dev-distribution.mjs mirror-urls <对象键>",
  "  dev-distribution.mjs build <版本> <运行标识> <引导程序> <仓库> <tag> <提交> <输出清单> [说明文件]",
  "  dev-distribution.mjs validate <清单> <版本> <运行标识> <引导程序> <仓库> <tag>",
  "  dev-distribution.mjs compare <版本 a> <版本 b>",
  "  dev-distribution.mjs next-beta <基础号> <tag 列表文件>",
  "运行标识是 <运行号>-<运行次数>，工作流里写成 \"$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT\"。",
  "build 的说明文件：beta 版本必须给，dev 版本不许给。compare 按 semver 优先级打印 -1、0 或 1。",
  "next-beta 打印 tag 列表（每行一个）里 v<基础号>-beta.<N> 的最大 N 加 1，没有就打印 1。",
].join("\n");

const PLATFORM = "windows-x86_64";
// 数字段不许有前导零，与香港机 put-manifest 的 VERSION_FORMATS 一致：插件按 semver 解析版本号，dev.07 这种写法
// 到客户端直接解析失败。用 [0-9] 不用 \d，与那边同一种写法。
const NUM = "(?:0|[1-9][0-9]*)";
const CORE = `${NUM}\\.${NUM}\\.${NUM}`;
// 通道名就是桶里的前缀。没有 stable：正式版的流水线和桶上的保护规则都还没有，写进 stable/ 的对象没有任何规则管。
const CHANNELS = Object.freeze({
  dev: new RegExp(`^${CORE}-dev\\.${NUM}$`),
  beta: new RegExp(`^${CORE}-beta\\.${NUM}$`),
});
const CHANNEL_NAMES = Object.freeze(Object.keys(CHANNELS));
// 与 put-manifest 的 SEMVER 同一套形状；预发布里纯数字段的前导零另在 parseSemver 里拦
const IDENT = "[0-9A-Za-z-]+";
const SEMVER = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+${IDENT}(?:\\.${IDENT})*)?$`);
const NUMERIC_IDENT = /^[0-9]+$/;
const RELEASE_CORE = new RegExp(`^(${NUM})\\.${NUM}\\.(${NUM})$`);
// 与 put-manifest 的 MAX_NOTES_CHARS 一致。那边用 Python 的 len，数的是 Unicode 码位；JS 的 length 数 UTF-16 单元，
// 增补平面的字符会多算一个，所以这里按码位数
const MAX_NOTES_CHARS = 4000;
const SURROGATE = /\p{Cs}/u;
// 对象键和地址里的每一段都不需要百分号编码：S3 的键与公网地址的路径逐字相同，读回比的就是清单里的那个地址
const SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const R2_ACCOUNT_ID = /^[0-9a-f]{32}$/;
// 客户端与香港机 put-manifest 用的是同一个更新包上限：超过它的包新客户端读不完，put-manifest 也不收，要在发布时就挂掉
const MAX_PACKAGE_SIZE = 256 * 1024 * 1024;

// 上传目标和匿名下载用的公网主机放在同一张表里。profile 是 AWS 配置文件里的段名，上传脚本按它挑凭据。
// R2 的 S3 端点带账户 ID，账户 ID 是环境变量，所以端点写成函数。
const MIRRORS = Object.freeze([
  {
    name: "cn",
    host: "petalfall-dl-cn.oss-cn-hangzhou.aliyuncs.com",
    profile: "oss",
    bucket: "petalfall-dl-cn",
    endpoint: () => "https://s3.oss-cn-hangzhou.aliyuncs.com",
    region: "cn-hangzhou",
  },
  {
    name: "hk",
    host: "petalfall-dl.oss-cn-hongkong.aliyuncs.com",
    profile: "oss",
    bucket: "petalfall-dl",
    endpoint: () => "https://s3.oss-cn-hongkong.aliyuncs.com",
    region: "cn-hongkong",
  },
  {
    name: "global",
    host: "dl.petalfall.org",
    profile: "r2",
    bucket: "petalfall-dl",
    endpoint: (account) => `https://${account}.r2.cloudflarestorage.com`,
    region: "auto",
  },
]);

// 源名与主机一一绑定，比「主机在白名单里」更严：cn 的地址写成香港的主机同样拒绝。顺序就是清单里 x-sources 的顺序。
export const SOURCE_HOSTS = Object.freeze({
  ...Object.fromEntries(MIRRORS.map(({ name, host }) => [name, host])),
  github: "github.com",
});
export const SOURCE_NAMES = Object.freeze(Object.keys(SOURCE_HOSTS));

function requireSegment(value, what) {
  if (typeof value !== "string" || !SEGMENT.test(value)) throw new Error(`${what}只能由字母、数字和 . _ - 组成：${JSON.stringify(value)}`);
}

export function channelOf(version) {
  const channel = typeof version === "string" ? CHANNEL_NAMES.find((name) => CHANNELS[name].test(version)) : undefined;
  if (channel === undefined) {
    throw new Error(`认不出版本号的通道：应为 X.Y.Z-<通道>.N，通道只能是 ${CHANNEL_NAMES.join("、")}，数字段不带前导零：${JSON.stringify(version)}`);
  }
  return channel;
}

// 目录带运行标识 <运行号>-<运行次数>（GITHUB_RUN_ID 与 GITHUB_RUN_ATTEMPT）：桶上禁止覆盖写，同一个键只能写一次。
// 只带运行次数不够：beta 序号只数已建的 tag，stage 传完包、建 tag 之前失败的运行不占号，下一次运行算出同一个版本号，
// 运行次数又从 1 起，键就撞上上次留在 beta/ 下、覆盖不了也删不掉的对象，stage 报错，白用一次签名审批。
// 运行号每次运行都不同、重跑时不变，运行次数再把同一次运行的各次重跑分开。dev 的版本号本身带运行序号，
// 两条通道仍用同一套键规则。
const RUN = /^[1-9][0-9]*-[1-9][0-9]*$/;

export function objectKey(version, run, fileName) {
  const channel = channelOf(version);
  if (typeof run !== "string" || !RUN.test(run)) {
    throw new Error(`运行标识应为 <运行号>-<运行次数>（$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT），两段都是不带前导零的正整数：${JSON.stringify(run)}`);
  }
  requireSegment(fileName, "文件名");
  if (!fileName.includes(version)) throw new Error(`文件名 ${fileName} 里没有版本号 ${version}`);
  return `${channel}/${version}-${run}/${fileName}`;
}

// 前缀只认通道表里的几个，不放宽成任意前缀：OSS 的 RAM 子用户各自只放行本通道的前缀，R2 的凭据却能写整个桶，
// 这里是 R2 唯一的防线。写到别的前缀就落在桶的规则之外，dev/ 的 30 天过期、beta/ 的禁止覆盖写与锁都管不到它。
function requireObjectKey(key) {
  const parts = typeof key === "string" ? key.split("/") : [];
  if (parts.length !== 3 || !Object.hasOwn(CHANNELS, parts[0]) || !parts.slice(1).every((part) => SEGMENT.test(part))) {
    throw new Error(`对象键应为 <通道>/<目录>/<文件名>，通道只能是 ${CHANNEL_NAMES.join("、")}：${JSON.stringify(key)}`);
  }
}

// beta 每版一个永久保留的 Release，tag 是 v<版本>。传成别的（比如 dev 的滚动预发布 dev-build），github 源就指向那个
// tag 的附件，它下次重建时被删，清单的 url 和 github 源一起 404。dev 的 tag 由工作流定，这里不管。
function requireReleaseTag(version, tag) {
  if (channelOf(version) === "beta" && tag !== `v${version}`) {
    throw new Error(`beta 版本 ${version} 的 tag 应为 v${version}，实际 ${JSON.stringify(tag)}`);
  }
}

// put-manifest 还拒收孤立的 UTF-16 代理项：Python 照收，插件经 serde_json 解析时却直接报错，所有客户端都查不了更新
function requireNotes(notes, what) {
  if (typeof notes !== "string" || notes === "") throw new Error(`${what} 应是非空字符串`);
  const chars = [...notes].length;
  if (chars > MAX_NOTES_CHARS) throw new Error(`${what} 有 ${chars} 个字符，超过 ${MAX_NOTES_CHARS}`);
  if (SURROGATE.test(notes)) throw new Error(`${what} 含孤立的 UTF-16 代理项，插件解析清单时会报错`);
}

// 严格按 UTF-8 解码：默认的解码会把坏字节悄悄换成 U+FFFD，更新面板里就多出一串乱码。首尾空白不算说明的一部分。
function readNotes(path) {
  const bytes = readFileSync(path);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`说明文件 ${path} 不是合法的 UTF-8`, { cause: error });
  }
  text = text.trim();
  if (text === "") throw new Error(`说明文件 ${path} 去掉首尾空白后是空的`);
  requireNotes(text, `说明文件 ${path}`);
  return text;
}

// dev 每次推送都自动发版、没人写说明，沿用提交号；beta 每版都经人审，说明取自晋级 PR 的「## 更新说明」，缺了就不发
function releaseNotes(version, commit, notesFile) {
  const channel = channelOf(version);
  switch (channel) {
    case "dev":
      if (notesFile !== undefined) throw new Error(`dev 版本的说明固定写提交号，不收说明文件：${notesFile}`);
      return `dev 分支 ${commit.slice(0, 8)} 的自动构建`;
    case "beta":
      if (notesFile === undefined) throw new Error(`beta 版本 ${version} 必须给说明文件`);
      return readNotes(notesFile);
    default:
      throw new Error(`通道 ${channel} 没有定义说明从哪来`);
  }
}

function parseSemver(version) {
  const match = typeof version === "string" ? SEMVER.exec(version) : null;
  if (match === null) throw new Error(`不是 semver 版本号：${JSON.stringify(version)}`);
  const pre = match[4] === undefined ? [] : match[4].split(".");
  if (pre.some((ident) => NUMERIC_IDENT.test(ident) && ident.length > 1 && ident.startsWith("0"))) {
    throw new Error(`${JSON.stringify(version)} 的预发布段有前导零`);
  }
  return { core: match.slice(1, 4).map(BigInt), pre };
}

const sign = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function compareIdent(a, b) {
  const numericA = NUMERIC_IDENT.test(a);
  const numericB = NUMERIC_IDENT.test(b);
  if (numericA && numericB) return sign(BigInt(a), BigInt(b));
  if (numericA !== numericB) return numericA ? -1 : 1;
  return sign(a, b);
}

// semver 2.0 第 11 条的优先级，与 put-manifest 的 precedence 同一套规则：先比三段核心；同核心时不带预发布段的更高；
// 预发布段逐个比，纯数字段按数值比且低于含字母的段，含字母的段按 ASCII 比；前面都相同时段多的更高；构建元数据不参与。
// 数值用 BigInt：版本号来自 tag 和清单，超过 2^53 时 Number 会把相邻的两个数当成相等。
export function compareVersions(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return sign(x.core[i], y.core[i]);
  }
  if (x.pre.length === 0 || y.pre.length === 0) return sign(y.pre.length, x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const order = compareIdent(x.pre[i], y.pre[i]);
    if (order !== 0) return order;
  }
  return sign(x.pre.length, y.pre.length);
}

// beta 序号取已发布的 v<基础号>-beta.N 里最大的加 1：被拒批、失败的运行和演练都不建 tag，所以不占号。
// 基础号是下一个要发的正式版号，必须是 X.Y.0、主版本至少为 1：dev 已在 1.0.0 及以上，0.x 的 beta 版本低于所有现行的
// dev 版本；补丁段留给正式版补丁，基础号用过 X.Y.1，正式版补丁 X.Y.1 就与它撞号，而且比 X.Y.1-dev.N、X.Y.1-beta.N 都高。
export function nextBeta(base, tags) {
  const match = typeof base === "string" ? RELEASE_CORE.exec(base) : null;
  if (match === null) throw new Error(`基础号应为 X.Y.Z，数字段不带前导零：${JSON.stringify(base)}`);
  if (match[1] === "0") {
    throw new Error(`基础号 ${base} 的主版本小于 1：基础号应为 X.Y.0 且主版本至少为 1，dev 已在 1.0.0 及以上，${base}-beta.N 低于所有现行的 dev 版本`);
  }
  if (match[2] !== "0") {
    throw new Error(`基础号 ${base} 的补丁段不为 0：基础号是下一个要发的正式版号，应为 X.Y.0；补丁段留给正式版补丁，拿它作基础号会与正式版补丁 ${base} 撞号`);
  }
  const pattern = new RegExp(`^v${base.replaceAll(".", "\\.")}-beta\\.(${NUM})$`);
  let max = 0n;
  for (const tag of tags) {
    const found = pattern.exec(tag);
    if (found !== null && BigInt(found[1]) > max) max = BigInt(found[1]);
  }
  return String(max + 1n);
}

export function mirrorUrls(key) {
  requireObjectKey(key);
  return MIRRORS.map(({ name, host }) => ({ name, url: `https://${host}/${key}` }));
}

export function uploadTargets(r2AccountId) {
  if (typeof r2AccountId !== "string" || !R2_ACCOUNT_ID.test(r2AccountId)) {
    throw new Error(`R2 账户 ID 应为 32 位小写十六进制，实际长度 ${typeof r2AccountId === "string" ? r2AccountId.length : typeof r2AccountId}`);
  }
  return MIRRORS.map(({ name, profile, bucket, endpoint, region }) => ({ name, profile, bucket, endpoint: endpoint(r2AccountId), region }));
}

export function githubUrl(repo, tag, fileName) {
  if (typeof repo !== "string" || !REPOSITORY.test(repo)) throw new Error(`仓库应为 owner/name：${JSON.stringify(repo)}`);
  requireSegment(tag, "tag ");
  requireSegment(fileName, "文件名");
  return `https://github.com/${repo}/releases/download/${tag}/${fileName}`;
}

export function sourceUrls({ version, run, fileName, repo, tag }) {
  requireReleaseTag(version, tag);
  return [...mirrorUrls(objectKey(version, run, fileName)), { name: "github", url: githubUrl(repo, tag, fileName) }];
}

// url 是 dev.35 及更早的客户端唯一会用的源，取 github：三个桶里 dev/ 下的对象 30 天后被生命周期规则删掉，dev 停更
// 超过 30 天时，指向桶的 url 会让旧客户端一直 404；github 附件跟着当前的滚动预发布走，预发布不重建就一直在、不会过期。
// beta 没有旧客户端，照样取 github：每版一个永久保留的 Release，附件地址就是这一版的永久地址。
// x-sources 是新客户端的完整候选表，含 url 本身；新客户端按它换源，url 取哪个源不影响它们。
export function buildManifest({ version, notes, pubDate, signature, size, run, fileName, repo, tag }) {
  const sources = sourceUrls({ version, run, fileName, repo, tag });
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      [PLATFORM]: {
        signature,
        url: sources.find(({ name }) => name === "github").url,
        "x-size": size,
        "x-sources": sources,
      },
    },
  };
}

// 多余的键插件和客户端都会忽略，拼错的键因此不会在任何地方报错，只能在这里按确切的键集合拦下
function requireKeys(value, keys, what) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what}应是对象`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}的键应为 ${expected.join("、")}，实际为 ${actual.join("、") || "空"}`);
  }
}

function parseSourceUrl(name, raw) {
  if (typeof raw !== "string") throw new Error(`源 ${name} 的 url 应是字符串`);
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error(`源 ${name} 的地址不是合法 URL：${raw}`, { cause: error });
  }
  if (url.protocol !== "https:") throw new Error(`源 ${name} 的地址必须是 https：${raw}`);
  if (url.hostname !== SOURCE_HOSTS[name]) throw new Error(`源 ${name} 的主机是 ${url.hostname}，应为 ${SOURCE_HOSTS[name]}`);
  if (url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`源 ${name} 的地址不能带端口、用户信息、查询串或片段：${raw}`);
  }
  // 规范化前后不同（主机大写、写了 :443、路径里有要转义的字符）说明不是这里生成的形状
  if (url.href !== raw) throw new Error(`源 ${name} 的地址不是规范形式：${raw}`);
  return url;
}

// 插件按 RFC 3339 严格解析 pub_date，2 月 30 日、平年 2 月 29 日、24 点都拒收，整份清单作废；Date.parse 却把它们
// 滚到下一天、不报 NaN。所以要求与 toISOString 往返后逐字相等：build 写出的就是这个形状，滚动过的日期往返后会变样。
function isBuildPubDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validateManifest(manifest, { version, run, fileName, size, repo, tag }) {
  requireKeys(manifest, ["version", "notes", "pub_date", "platforms"], "清单");
  if (manifest.version !== version) throw new Error(`清单的 version 是 ${JSON.stringify(manifest.version)}，应为 ${version}`);
  requireNotes(manifest.notes, "清单的 notes");
  if (!isBuildPubDate(manifest.pub_date)) {
    throw new Error(`清单的 pub_date 应是真实存在的 UTC 时刻，形如 YYYY-MM-DDTHH:mm:ss.sssZ：${JSON.stringify(manifest.pub_date)}`);
  }

  requireKeys(manifest.platforms, [PLATFORM], "platforms");
  const entry = manifest.platforms[PLATFORM];
  requireKeys(entry, ["signature", "url", "x-size", "x-sources"], PLATFORM);
  if (typeof entry.signature !== "string" || !BASE64.test(entry.signature)) throw new Error("signature 应是非空的 base64 字符串");
  if (!Number.isSafeInteger(entry["x-size"]) || entry["x-size"] <= 0) throw new Error(`x-size 应是正整数：${JSON.stringify(entry["x-size"])}`);
  if (entry["x-size"] > MAX_PACKAGE_SIZE) throw new Error(`x-size 是 ${entry["x-size"]}，超过更新包上限 ${MAX_PACKAGE_SIZE} 字节`);
  if (entry["x-size"] !== size) throw new Error(`x-size 是 ${entry["x-size"]}，引导程序实际 ${size} 字节`);

  const sources = entry["x-sources"];
  if (!Array.isArray(sources)) throw new Error("x-sources 应是数组");
  const urls = new Map();
  sources.forEach((source, index) => {
    requireKeys(source, ["name", "url"], `x-sources 第 ${index + 1} 条`);
    const { name } = source;
    if (!Object.hasOwn(SOURCE_HOSTS, name)) throw new Error(`源名 ${JSON.stringify(name)} 不在 ${SOURCE_NAMES.join("、")} 之列`);
    if (urls.has(name)) throw new Error(`源 ${name} 重复`);
    urls.set(name, parseSourceUrl(name, source.url));
  });
  const missing = SOURCE_NAMES.filter((name) => !urls.has(name));
  if (missing.length > 0) throw new Error(`x-sources 缺源 ${missing.join("、")}`);

  // 三个桶传的是同一个对象键，路径带版本和运行标识；GitHub 上的文件名本身带版本
  const key = `/${objectKey(version, run, fileName)}`;
  for (const { name } of MIRRORS) {
    const { pathname } = urls.get(name);
    if (pathname !== key) throw new Error(`源 ${name} 的路径是 ${pathname}，应为 ${key}`);
  }
  requireReleaseTag(version, tag);
  const github = new URL(githubUrl(repo, tag, fileName)).pathname;
  if (urls.get("github").pathname !== github) throw new Error(`源 github 的路径是 ${urls.get("github").pathname}，应为 ${github}`);

  if (!sources.some((source) => source.url === entry.url)) throw new Error(`url 不在 x-sources 里：${JSON.stringify(entry.url)}`);
  // 旧客户端只认 url：指向桶的话，dev 停更 30 天后对象被删、旧客户端一直 404，github 附件不会过期，见 buildManifest
  if (entry.url !== urls.get("github").href) throw new Error(`url 应等于 github 源 ${urls.get("github").href}，实际 ${entry.url}`);
}

function expectArgs(args, min, max = min) {
  if (args.length < min || args.length > max) throw new Error(USAGE);
  for (const arg of args) {
    if (typeof arg !== "string" || arg === "") throw new Error(USAGE);
  }
}

const tsv = (rows) => rows.map((row) => `${row.join("\t")}\n`).join("");

// 返回要打到 stdout 的文本；build 还会写出清单文件
export function runCommand([command, ...args]) {
  switch (command) {
    case "key": {
      expectArgs(args, 3);
      return `${objectKey(...args)}\n`;
    }
    case "upload-targets": {
      expectArgs(args, 1);
      return tsv(uploadTargets(args[0]).map(({ name, profile, bucket, endpoint, region }) => [name, profile, bucket, endpoint, region]));
    }
    case "mirror-urls": {
      expectArgs(args, 1);
      return tsv(mirrorUrls(args[0]).map(({ name, url }) => [name, url]));
    }
    case "build": {
      expectArgs(args, 7, 8);
      const [version, run, bootstrap, repo, tag, commit, out, notesFile] = args;
      if (!COMMIT.test(commit)) throw new Error(`提交应为 40 位十六进制：${JSON.stringify(commit)}`);
      const manifest = buildManifest({
        version,
        notes: releaseNotes(version, commit, notesFile),
        pubDate: new Date().toISOString(),
        signature: readFileSync(`${bootstrap}.sig`, "utf8").trim(),
        size: statSync(bootstrap).size,
        run,
        fileName: basename(bootstrap),
        repo,
        tag,
      });
      writeFileSync(out, JSON.stringify(manifest, null, 2));
      return "";
    }
    case "validate": {
      expectArgs(args, 6);
      const [manifestPath, version, run, bootstrap, repo, tag] = args;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      validateManifest(manifest, { version, run, fileName: basename(bootstrap), size: statSync(bootstrap).size, repo, tag });
      return `清单校验通过：${version}，${manifest.platforms[PLATFORM]["x-sources"].map(({ name }) => name).join("、")}\n`;
    }
    case "compare": {
      expectArgs(args, 2);
      return `${compareVersions(...args)}\n`;
    }
    case "next-beta": {
      expectArgs(args, 2);
      const [base, tagsFile] = args;
      return `${nextBeta(base, readFileSync(tagsFile, "utf8").split(/\r?\n/))}\n`;
    }
    default:
      throw new Error(USAGE);
  }
}

// 按 node 定位入口的同一套解析（realpath 后转 URL）比较：判不出是入口时脚本什么都不做却退出 0，校验就成了摆设。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.stdout.write(runCommand(process.argv.slice(2)));
}
