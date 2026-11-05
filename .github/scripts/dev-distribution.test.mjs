import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SOURCE_HOSTS,
  SOURCE_NAMES,
  buildManifest,
  githubUrl,
  mirrorUrls,
  objectKey,
  runCommand,
  sourceUrls,
  uploadTargets,
  validateManifest,
} from "./dev-distribution.mjs";

const SCRIPT = fileURLToPath(new URL("./dev-distribution.mjs", import.meta.url));
const VERSION = `0.${randomInt(0, 50)}.${randomInt(0, 50)}-dev.${randomInt(1, 100_000)}`;
// 第一次运行是 1，重跑才往上加；两种都要覆盖到
const ATTEMPT = String(randomInt(1, 3) === 1 ? 1 : randomInt(2, 20));
const FILE_NAME = `Petalfall-Installer-${VERSION}-x64.exe`;
const REPO = "ShinoyukiMiyako/Petalfall";
const TAG = "dev-build";
const KEY = `dev/${VERSION}-${ATTEMPT}/${FILE_NAME}`;
const CN = `https://petalfall-dl-cn.oss-cn-hangzhou.aliyuncs.com/${KEY}`;
const HK = `https://petalfall-dl.oss-cn-hongkong.aliyuncs.com/${KEY}`;
const GLOBAL = `https://dl.petalfall.org/${KEY}`;
const GITHUB = `https://github.com/${REPO}/releases/download/${TAG}/${FILE_NAME}`;
const SIZE = randomInt(1, 64 * 1024 * 1024);
const SIGNATURE = randomBytes(randomInt(200, 400)).toString("base64");
const ACCOUNT = randomBytes(16).toString("hex");

const root = mkdtempSync(join(tmpdir(), "dev-distribution-"));
after(() => rmSync(root, { recursive: true, force: true }));

const expected = { version: VERSION, attempt: ATTEMPT, fileName: FILE_NAME, size: SIZE, repo: REPO, tag: TAG };

function manifest() {
  return buildManifest({
    version: VERSION,
    notes: "dev 分支 0123abcd 的自动构建",
    pubDate: new Date().toISOString(),
    signature: SIGNATURE,
    size: SIZE,
    attempt: ATTEMPT,
    fileName: FILE_NAME,
    repo: REPO,
    tag: TAG,
  });
}

const entryOf = (m) => m.platforms["windows-x86_64"];
const sourceOf = (m, name) => entryOf(m)["x-sources"].find((source) => source.name === name);

describe("源名与主机", () => {
  it("恰好四个源，顺序是 cn、hk、global、github，各自绑定一个主机", () => {
    assert.deepEqual(SOURCE_NAMES, ["cn", "hk", "global", "github"]);
    assert.deepEqual(SOURCE_HOSTS, {
      cn: "petalfall-dl-cn.oss-cn-hangzhou.aliyuncs.com",
      hk: "petalfall-dl.oss-cn-hongkong.aliyuncs.com",
      global: "dl.petalfall.org",
      github: "github.com",
    });
  });
});

describe("objectKey", () => {
  it("是 dev/<版本>-<运行次数>/<文件名>", () => {
    assert.equal(objectKey(VERSION, ATTEMPT, FILE_NAME), KEY);
    assert.equal(objectKey(VERSION, "1", FILE_NAME), `dev/${VERSION}-1/${FILE_NAME}`);
  });

  it("版本号不是 dev 版本时拒绝", () => {
    for (const version of ["0.1.0", "0.1.0-beta.1", `v${VERSION}`, `${VERSION}.1`, ""]) {
      assert.throws(() => objectKey(version, ATTEMPT, `x-${version}.exe`), /不是 dev 版本号/, version);
    }
  });

  it("运行次数不是正整数字符串时拒绝", () => {
    for (const attempt of ["0", "", "01", "1.5", "-1", 1]) {
      assert.throws(() => objectKey(VERSION, attempt, FILE_NAME), /运行次数应为正整数/, String(attempt));
    }
  });

  it("文件名带路径分隔、要转义的字符或不含版本号时拒绝", () => {
    for (const fileName of [`a/${FILE_NAME}`, `${FILE_NAME} `, `${FILE_NAME}?x`, "..", ""]) {
      assert.throws(() => objectKey(VERSION, ATTEMPT, fileName), /文件名只能由/, fileName);
    }
    assert.throws(() => objectKey(VERSION, ATTEMPT, "Petalfall-Installer-x64.exe"), {
      message: `文件名 Petalfall-Installer-x64.exe 里没有版本号 ${VERSION}`,
    });
  });
});

describe("mirrorUrls", () => {
  it("三个桶按 cn、hk、global 给出同一个对象键的公网地址", () => {
    assert.deepEqual(mirrorUrls(KEY), [
      { name: "cn", url: CN },
      { name: "hk", url: HK },
      { name: "global", url: GLOBAL },
    ]);
  });

  it("试跑用的 dev/trial-<运行号>-<运行次数>/ 键同样可用", () => {
    const run = `${randomInt(1, 2 ** 40)}-${randomInt(1, 20)}`;
    assert.equal(mirrorUrls(`dev/trial-${run}/sample-${run}.bin`)[2].url, `https://dl.petalfall.org/dev/trial-${run}/sample-${run}.bin`);
  });

  it("不在 dev/ 下、层数不对、带 .. 或要转义的字符时拒绝", () => {
    for (const key of ["stable/a/b", `/${KEY}`, "dev/a", "dev/a/b/c", "dev/../b", "dev/a/..", "dev/./b", "dev/a/b c", "dev/a/%2e", ""]) {
      assert.throws(() => mirrorUrls(key), /对象键应为 dev\/<目录>\/<文件名>/, key);
    }
  });
});

describe("uploadTargets", () => {
  it("杭州、香港走 oss 配置段，R2 走 r2 配置段并把账户 ID 拼进端点", () => {
    assert.deepEqual(uploadTargets(ACCOUNT), [
      { name: "cn", profile: "oss", bucket: "petalfall-dl-cn", endpoint: "https://s3.oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou" },
      { name: "hk", profile: "oss", bucket: "petalfall-dl", endpoint: "https://s3.oss-cn-hongkong.aliyuncs.com", region: "cn-hongkong" },
      { name: "global", profile: "r2", bucket: "petalfall-dl", endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`, region: "auto" },
    ]);
  });

  it("账户 ID 不是 32 位小写十六进制时拒绝，报错里不带原值", () => {
    for (const account of [ACCOUNT.toUpperCase(), ACCOUNT.slice(1), `${ACCOUNT}0`, `${ACCOUNT.slice(0, 31)}g`, ""]) {
      assert.throws(
        () => uploadTargets(account),
        (err) => err.message === `R2 账户 ID 应为 32 位小写十六进制，实际长度 ${account.length}`,
        account,
      );
    }
  });
});

describe("githubUrl 与 sourceUrls", () => {
  it("github 源指向滚动预发布下同名的资产", () => {
    assert.equal(githubUrl(REPO, TAG, FILE_NAME), GITHUB);
    assert.throws(() => githubUrl("ShinoyukiMiyako", TAG, FILE_NAME), /仓库应为 owner\/name/);
    assert.throws(() => githubUrl(`${REPO}/x`, TAG, FILE_NAME), /仓库应为 owner\/name/);
  });

  it("四个源依次是 cn、hk、global、github", () => {
    assert.deepEqual(sourceUrls({ version: VERSION, attempt: ATTEMPT, fileName: FILE_NAME, repo: REPO, tag: TAG }), [
      { name: "cn", url: CN },
      { name: "hk", url: HK },
      { name: "global", url: GLOBAL },
      { name: "github", url: GITHUB },
    ]);
  });
});

describe("buildManifest", () => {
  it("插件的标准格式加 x-size 与 x-sources，url 等于不会过期的 github 源", () => {
    const pubDate = new Date(randomInt(1_700_000_000, 2_000_000_000) * 1000).toISOString();
    const built = buildManifest({ version: VERSION, notes: "说明", pubDate, signature: SIGNATURE, size: SIZE, attempt: ATTEMPT, fileName: FILE_NAME, repo: REPO, tag: TAG });
    assert.deepEqual(built, {
      version: VERSION,
      notes: "说明",
      pub_date: pubDate,
      platforms: {
        "windows-x86_64": {
          signature: SIGNATURE,
          url: GITHUB,
          "x-size": SIZE,
          "x-sources": [
            { name: "cn", url: CN },
            { name: "hk", url: HK },
            { name: "global", url: GLOBAL },
            { name: "github", url: GITHUB },
          ],
        },
      },
    });
  });
});

describe("validateManifest", () => {
  it("生成的清单经 JSON 往返后通过", () => {
    assert.equal(validateManifest(JSON.parse(JSON.stringify(manifest())), expected), undefined);
  });

  it("x-sources 换了顺序照样通过：客户端按自己的规范顺序排，不看清单里的顺序", () => {
    const m = manifest();
    entryOf(m)["x-sources"].reverse();
    assert.equal(validateManifest(m, expected), undefined);
  });

  it("拒绝：清单不是对象", () => {
    for (const value of [null, [], "{}"]) {
      assert.throws(() => validateManifest(value, expected), { message: "清单应是对象" }, JSON.stringify(value));
    }
  });

  const other = (url) => url.replace(`/${VERSION}-${ATTEMPT}/`, `/${VERSION}-${Number(ATTEMPT) + 1}/`);
  // 每条只改一处，其余保持合法，确认拦下它的就是对应那条规则
  const cases = [
    ["顶层多一个键", (m) => Object.assign(m, { "x-note": "" }), /^清单的键应为 /],
    ["version 和期望不同", (m) => Object.assign(m, { version: VERSION.replace(/\d+$/, (n) => String(Number(n) + 1)) }), /^清单的 version 是 /],
    ["notes 为空", (m) => Object.assign(m, { notes: "" }), /^清单的 notes 应是非空字符串$/],
    ["pub_date 不是 RFC 3339", (m) => Object.assign(m, { pub_date: "2026-11-04 12:00:00" }), /^清单的 pub_date 不是 RFC 3339 时间/],
    ["pub_date 的日期不存在", (m) => Object.assign(m, { pub_date: "2026-13-40T00:00:00Z" }), /^清单的 pub_date 不是 RFC 3339 时间/],
    ["多一个平台", (m) => Object.assign(m.platforms, { "darwin-aarch64": entryOf(m) }), /^platforms的键应为 windows-x86_64/],
    ["平台条目缺 x-size", (m) => delete entryOf(m)["x-size"], /^windows-x86_64的键应为 /],
    ["平台条目的扩展字段拼错", (m) => Object.assign(entryOf(m), { "x-source": entryOf(m)["x-sources"] }), /^windows-x86_64的键应为 /],
    ["signature 为空", (m) => Object.assign(entryOf(m), { signature: "" }), /^signature 应是非空的 base64 字符串$/],
    ["signature 不是 base64", (m) => Object.assign(entryOf(m), { signature: "abc def" }), /^signature 应是非空的 base64 字符串$/],
    ["x-size 是字符串", (m) => Object.assign(entryOf(m), { "x-size": String(SIZE) }), /^x-size 应是正整数/],
    ["x-size 为 0", (m) => Object.assign(entryOf(m), { "x-size": 0 }), /^x-size 应是正整数/],
    ["x-size 和引导程序不符", (m) => Object.assign(entryOf(m), { "x-size": SIZE + 1 }), new RegExp(`^x-size 是 ${SIZE + 1}，引导程序实际 ${SIZE} 字节$`)],
    ["x-sources 不是数组", (m) => Object.assign(entryOf(m), { "x-sources": { cn: CN } }), /^x-sources 应是数组$/],
    ["x-sources 为空", (m) => Object.assign(entryOf(m), { "x-sources": [] }), /^x-sources 缺源 cn、hk、global、github$/],
    ["缺 github 源", (m) => entryOf(m)["x-sources"].pop(), /^x-sources 缺源 github$/],
    ["源重复", (m) => entryOf(m)["x-sources"].splice(3, 1, { name: "hk", url: HK }), /^源 hk 重复$/],
    ["源名不在四个之列", (m) => Object.assign(sourceOf(m, "global"), { name: "cdn" }), /^源名 "cdn" 不在 cn、hk、global、github 之列$/],
    ["源条目多一个键", (m) => Object.assign(entryOf(m)["x-sources"][0], { weight: 1 }), /^x-sources 第 1 条的键应为 /],
    ["源的 url 不是字符串", (m) => Object.assign(sourceOf(m, "hk"), { url: null }), /^源 hk 的 url 应是字符串$/],
    ["源的 url 不是合法 URL", (m) => Object.assign(sourceOf(m, "hk"), { url: "not a url" }), /^源 hk 的地址不是合法 URL/],
    ["源是 http", (m) => Object.assign(sourceOf(m, "global"), { url: GLOBAL.replace("https:", "http:") }), /^源 global 的地址必须是 https/],
    ["cn 用了香港的主机", (m) => Object.assign(sourceOf(m, "cn"), { url: HK }), /^源 cn 的主机是 petalfall-dl\.oss-cn-hongkong\.aliyuncs\.com，应为 petalfall-dl-cn\.oss-cn-hangzhou\.aliyuncs\.com$/],
    ["主机不在白名单", (m) => Object.assign(sourceOf(m, "global"), { url: `https://evil.example/${KEY}` }), /^源 global 的主机是 evil\.example，应为 dl\.petalfall\.org$/],
    ["带端口", (m) => Object.assign(sourceOf(m, "global"), { url: `https://dl.petalfall.org:8443/${KEY}` }), /^源 global 的地址不能带端口、用户信息、查询串或片段/],
    ["带用户信息", (m) => Object.assign(sourceOf(m, "global"), { url: `https://u:p@dl.petalfall.org/${KEY}` }), /^源 global 的地址不能带端口、用户信息、查询串或片段/],
    ["带查询串", (m) => Object.assign(sourceOf(m, "github"), { url: `${GITHUB}?x=1` }), /^源 github 的地址不能带端口、用户信息、查询串或片段/],
    ["写了默认端口 443", (m) => Object.assign(sourceOf(m, "global"), { url: `https://dl.petalfall.org:443/${KEY}` }), /^源 global 的地址不是规范形式/],
    ["主机大写", (m) => Object.assign(sourceOf(m, "global"), { url: `https://DL.petalfall.org/${KEY}` }), /^源 global 的地址不是规范形式/],
    ["桶里的路径不带版本", (m) => Object.assign(sourceOf(m, "hk"), { url: `https://petalfall-dl.oss-cn-hongkong.aliyuncs.com/dev/latest/${FILE_NAME}` }), /^源 hk 的路径是 \/dev\/latest\//],
    ["三个桶的路径不是同一次运行", (m) => Object.assign(sourceOf(m, "global"), { url: other(GLOBAL) }), /^源 global 的路径是 /],
    ["github 源指向别的 tag", (m) => Object.assign(sourceOf(m, "github"), { url: GITHUB.replace(`/${TAG}/`, "/dev/") }), /^源 github 的路径是 /],
    ["url 不在 x-sources 里", (m) => Object.assign(entryOf(m), { url: other(CN) }), /^url 不在 x-sources 里/],
    // cn 是改指 github 之前的取法：桶里的对象 30 天后过期，dev 停更久了旧客户端会一直 404
    ...[["cn", CN], ["hk", HK], ["global", GLOBAL]].map(([name, url]) => [
      `url 是 x-sources 里的 ${name} 源`,
      (m) => Object.assign(entryOf(m), { url }),
      new RegExp(`^url 应等于 github 源 ${GITHUB.replaceAll(".", "\\.")}，实际 ${url.replaceAll(".", "\\.")}$`),
    ]),
  ];

  for (const [title, mutate, message] of cases) {
    it(`拒绝：${title}`, () => {
      const m = manifest();
      mutate(m);
      assert.throws(() => validateManifest(m, expected), { message });
    });
  }
});

describe("命令行入口", () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  let nextCase = 0;

  function bootstrapFixture(bytes = randomBytes(randomInt(1, 8192))) {
    const dir = join(root, String(nextCase++));
    mkdirSync(dir);
    const bootstrap = join(dir, FILE_NAME);
    writeFileSync(bootstrap, bytes);
    writeFileSync(`${bootstrap}.sig`, `${SIGNATURE}\n`);
    return { dir, bootstrap, manifest: join(dir, "latest.json") };
  }

  it("key 打印对象键", () => {
    const result = run("key", VERSION, ATTEMPT, FILE_NAME);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${KEY}\n`);
  });

  it("upload-targets 每个桶一行，字段用 tab 分隔", () => {
    const result = run("upload-targets", ACCOUNT);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        "cn\toss\tpetalfall-dl-cn\thttps://s3.oss-cn-hangzhou.aliyuncs.com\tcn-hangzhou",
        "hk\toss\tpetalfall-dl\thttps://s3.oss-cn-hongkong.aliyuncs.com\tcn-hongkong",
        `global\tr2\tpetalfall-dl\thttps://${ACCOUNT}.r2.cloudflarestorage.com\tauto`,
        "",
      ].join("\n"),
    );
  });

  it("mirror-urls 每个桶一行源名和地址", () => {
    const result = run("mirror-urls", KEY);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `cn\t${CN}\nhk\t${HK}\nglobal\t${GLOBAL}\n`);
  });

  it("build 写出的清单带签名文件的内容、引导程序的字节数和这次提交，validate 照它通过", () => {
    const { bootstrap, manifest: out } = bootstrapFixture();
    const commit = randomBytes(20).toString("hex");
    const before = Date.now();
    const built = run("build", VERSION, ATTEMPT, bootstrap, REPO, TAG, commit, out);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(built.stdout, "");

    const written = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(written.notes, `dev 分支 ${commit.slice(0, 8)} 的自动构建`);
    const published = Date.parse(written.pub_date);
    assert.ok(published >= before - 1000 && published <= Date.now(), written.pub_date);
    assert.deepEqual(written.platforms, {
      "windows-x86_64": {
        signature: SIGNATURE,
        url: GITHUB,
        "x-size": statSync(bootstrap).size,
        "x-sources": [
          { name: "cn", url: CN },
          { name: "hk", url: HK },
          { name: "global", url: GLOBAL },
          { name: "github", url: GITHUB },
        ],
      },
    });

    const validated = run("validate", out, VERSION, ATTEMPT, bootstrap, REPO, TAG);
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(validated.stdout, `清单校验通过：${VERSION}，cn、hk、global、github\n`);
  });

  it("validate 拿另一个引导程序比时退出非 0：x-size 对不上", () => {
    const bytes = randomBytes(randomInt(2, 8192));
    const { bootstrap, manifest: out } = bootstrapFixture(bytes);
    assert.equal(run("build", VERSION, ATTEMPT, bootstrap, REPO, TAG, randomBytes(20).toString("hex"), out).status, 0);
    writeFileSync(bootstrap, bytes.subarray(1));
    const result = run("validate", out, VERSION, ATTEMPT, bootstrap, REPO, TAG);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`x-size 是 ${bytes.length}，引导程序实际 ${bytes.length - 1} 字节`));
    assert.equal(result.stdout, "");
  });

  it("validate 用另一次运行的次数比时退出非 0：读回验的和清单写的不是同一批对象", () => {
    const { bootstrap, manifest: out } = bootstrapFixture();
    assert.equal(run("build", VERSION, ATTEMPT, bootstrap, REPO, TAG, randomBytes(20).toString("hex"), out).status, 0);
    const result = run("validate", out, VERSION, String(Number(ATTEMPT) + 1), bootstrap, REPO, TAG);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /源 cn 的路径是 /);
  });

  it("build 的提交不是 40 位十六进制时退出非 0，不写清单", () => {
    const { bootstrap, manifest: out } = bootstrapFixture();
    const result = run("build", VERSION, ATTEMPT, bootstrap, REPO, TAG, "0123abcd", out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /提交应为 40 位十六进制/);
    assert.throws(() => statSync(out), { code: "ENOENT" });
  });

  it("参数个数不对或子命令不认识时退出非 0 并提示用法：工作流漏传参数不能被当成成功", () => {
    for (const args of [[], ["key", VERSION, ATTEMPT], ["mirror-urls"], ["upload-targets", ACCOUNT, ACCOUNT], ["validate", "x"], ["publish", KEY]]) {
      const result = run(...args);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.match(result.stderr, /用法：/);
      assert.equal(result.stdout, "");
    }
  });

  it("参数里有空串时同样拒绝", () => {
    assert.throws(() => runCommand(["key", VERSION, "", FILE_NAME]), /^Error: 用法：/);
  });
});
