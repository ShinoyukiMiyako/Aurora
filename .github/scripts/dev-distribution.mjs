// dev 通道的分发链路：三个存储桶的上传目标、对象键和公网地址，以及带 x-size、x-sources 的更新清单的生成与校验。
// 上传、读回、清单都从这里取地址：传进哪个桶、从哪个主机读回、清单里写哪个地址，三者不会各算各的。
// 源名、主机白名单与启动器编译进去的、香港机 put-manifest 校验的是同一份；改这里要同时改那两处。
// 用法见 USAGE；子命令的输出给工作流里的 shell 读，一行一条，字段用 tab 分隔。
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = [
  "用法：",
  "  dev-distribution.mjs key <版本> <运行次数> <文件名>",
  "  dev-distribution.mjs upload-targets <R2 账户 ID>",
  "  dev-distribution.mjs mirror-urls <对象键>",
  "  dev-distribution.mjs build <版本> <运行次数> <引导程序> <仓库> <tag> <提交> <输出清单>",
  "  dev-distribution.mjs validate <清单> <版本> <运行次数> <引导程序> <仓库> <tag>",
].join("\n");

const PLATFORM = "windows-x86_64";
const DEV_VERSION = /^\d+\.\d+\.\d+-dev\.\d+$/;
// 对象键和地址里的每一段都不需要百分号编码：S3 的键与公网地址的路径逐字相同，读回比的就是清单里的那个地址
const SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// 插件按 RFC 3339 解析 pub_date；toISOString 写出的就是这个形状
const PUB_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const R2_ACCOUNT_ID = /^[0-9a-f]{32}$/;

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

// 带运行次数：桶上禁止覆盖写，重跑发布作业会换一个目录，不会撞上上一次传了一半的对象
export function objectKey(version, attempt, fileName) {
  if (typeof version !== "string" || !DEV_VERSION.test(version)) throw new Error(`不是 dev 版本号：${JSON.stringify(version)}`);
  if (typeof attempt !== "string" || !/^[1-9]\d*$/.test(attempt)) throw new Error(`运行次数应为正整数：${JSON.stringify(attempt)}`);
  requireSegment(fileName, "文件名");
  if (!fileName.includes(version)) throw new Error(`文件名 ${fileName} 里没有版本号 ${version}`);
  return `dev/${version}-${attempt}/${fileName}`;
}

// dev/ 之外的前缀 CI 的 RAM 子用户写不进去，也不会被 30 天的生命周期规则清掉
function requireObjectKey(key) {
  const parts = typeof key === "string" ? key.split("/") : [];
  if (parts.length !== 3 || parts[0] !== "dev" || !parts.slice(1).every((part) => SEGMENT.test(part))) {
    throw new Error(`对象键应为 dev/<目录>/<文件名>：${JSON.stringify(key)}`);
  }
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

export function sourceUrls({ version, attempt, fileName, repo, tag }) {
  return [...mirrorUrls(objectKey(version, attempt, fileName)), { name: "github", url: githubUrl(repo, tag, fileName) }];
}

// url 是 dev.35 及更早的客户端唯一会用的源，取 github：三个桶里 dev/ 下的对象 30 天后被生命周期规则删掉，dev 停更
// 超过 30 天时，指向桶的 url 会让旧客户端一直 404；github 附件跟着当前的滚动预发布走，预发布不重建就一直在、不会过期。
// x-sources 是新客户端的完整候选表，含 url 本身；新客户端按它换源，url 取哪个源不影响它们。
export function buildManifest({ version, notes, pubDate, signature, size, attempt, fileName, repo, tag }) {
  const sources = sourceUrls({ version, attempt, fileName, repo, tag });
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

export function validateManifest(manifest, { version, attempt, fileName, size, repo, tag }) {
  requireKeys(manifest, ["version", "notes", "pub_date", "platforms"], "清单");
  if (manifest.version !== version) throw new Error(`清单的 version 是 ${JSON.stringify(manifest.version)}，应为 ${version}`);
  if (typeof manifest.notes !== "string" || manifest.notes === "") throw new Error("清单的 notes 应是非空字符串");
  if (typeof manifest.pub_date !== "string" || !PUB_DATE.test(manifest.pub_date) || Number.isNaN(Date.parse(manifest.pub_date))) {
    throw new Error(`清单的 pub_date 不是 RFC 3339 时间：${JSON.stringify(manifest.pub_date)}`);
  }

  requireKeys(manifest.platforms, [PLATFORM], "platforms");
  const entry = manifest.platforms[PLATFORM];
  requireKeys(entry, ["signature", "url", "x-size", "x-sources"], PLATFORM);
  if (typeof entry.signature !== "string" || !BASE64.test(entry.signature)) throw new Error("signature 应是非空的 base64 字符串");
  if (!Number.isSafeInteger(entry["x-size"]) || entry["x-size"] <= 0) throw new Error(`x-size 应是正整数：${JSON.stringify(entry["x-size"])}`);
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

  // 三个桶传的是同一个对象键，路径带版本和运行次数；GitHub 上的文件名本身带版本
  const key = `/${objectKey(version, attempt, fileName)}`;
  for (const { name } of MIRRORS) {
    const { pathname } = urls.get(name);
    if (pathname !== key) throw new Error(`源 ${name} 的路径是 ${pathname}，应为 ${key}`);
  }
  const github = new URL(githubUrl(repo, tag, fileName)).pathname;
  if (urls.get("github").pathname !== github) throw new Error(`源 github 的路径是 ${urls.get("github").pathname}，应为 ${github}`);

  if (!sources.some((source) => source.url === entry.url)) throw new Error(`url 不在 x-sources 里：${JSON.stringify(entry.url)}`);
  // 旧客户端只认 url：指向桶的话，dev 停更 30 天后对象被删、旧客户端一直 404，github 附件不会过期，见 buildManifest
  if (entry.url !== urls.get("github").href) throw new Error(`url 应等于 github 源 ${urls.get("github").href}，实际 ${entry.url}`);
}

function expectArgs(args, count) {
  if (args.length !== count) throw new Error(USAGE);
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
      expectArgs(args, 7);
      const [version, attempt, bootstrap, repo, tag, commit, out] = args;
      if (!COMMIT.test(commit)) throw new Error(`提交应为 40 位十六进制：${JSON.stringify(commit)}`);
      const manifest = buildManifest({
        version,
        notes: `dev 分支 ${commit.slice(0, 8)} 的自动构建`,
        pubDate: new Date().toISOString(),
        signature: readFileSync(`${bootstrap}.sig`, "utf8").trim(),
        size: statSync(bootstrap).size,
        attempt,
        fileName: basename(bootstrap),
        repo,
        tag,
      });
      writeFileSync(out, JSON.stringify(manifest, null, 2));
      return "";
    }
    case "validate": {
      expectArgs(args, 6);
      const [manifestPath, version, attempt, bootstrap, repo, tag] = args;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      validateManifest(manifest, { version, attempt, fileName: basename(bootstrap), size: statSync(bootstrap).size, repo, tag });
      return `清单校验通过：${version}，${manifest.platforms[PLATFORM]["x-sources"].map(({ name }) => name).join("、")}\n`;
    }
    default:
      throw new Error(USAGE);
  }
}

// 按 node 定位入口的同一套解析（realpath 后转 URL）比较：判不出是入口时脚本什么都不做却退出 0，校验就成了摆设。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.stdout.write(runCommand(process.argv.slice(2)));
}
