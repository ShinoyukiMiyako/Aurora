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
  channelOf,
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
// beta 分支上的主版本至少为 1；序号 0 是演练用的，同样要认
const BETA_VERSION = `${randomInt(1, 50)}.${randomInt(0, 50)}.${randomInt(0, 50)}-beta.${randomInt(0, 100_000)}`;
const BETA_TAG = `v${BETA_VERSION}`;
const BETA_FILE = `Petalfall-Installer-${BETA_VERSION}-x64.exe`;
const BETA_KEY = `beta/${BETA_VERSION}-${ATTEMPT}/${BETA_FILE}`;
const BETA_GITHUB = `https://github.com/${REPO}/releases/download/${BETA_TAG}/${BETA_FILE}`;
const BETA_SOURCES = [
  { name: "cn", url: `https://petalfall-dl-cn.oss-cn-hangzhou.aliyuncs.com/${BETA_KEY}` },
  { name: "hk", url: `https://petalfall-dl.oss-cn-hongkong.aliyuncs.com/${BETA_KEY}` },
  { name: "global", url: `https://dl.petalfall.org/${BETA_KEY}` },
  { name: "github", url: BETA_GITHUB },
];

const root = mkdtempSync(join(tmpdir(), "dev-distribution-"));
after(() => rmSync(root, { recursive: true, force: true }));

const expected = { version: VERSION, attempt: ATTEMPT, fileName: FILE_NAME, size: SIZE, repo: REPO, tag: TAG };
const betaExpected = { ...expected, version: BETA_VERSION, fileName: BETA_FILE, tag: BETA_TAG };
const betaOverrides = { version: BETA_VERSION, fileName: BETA_FILE, tag: BETA_TAG, notes: "修复了启动时的闪退" };

function manifest(overrides = {}) {
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
    ...overrides,
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

// 与香港机 put-manifest 的 VERSION_FORMATS 对齐：dev 与 beta 两种形状，数字段不带前导零，其余一律认不出
const UNKNOWN_CHANNEL_VERSIONS = [
  "0.1.0",
  "1.0.0",
  "1.0.0-rc.1",
  "1.0.0-alpha.1",
  "1.0.0-stable.1",
  "1.0.0-Beta.1",
  "1.0.0-beta",
  "1.0.0-beta.",
  "1.0.0-beta.1.2",
  "1.0.0-beta.1+build.5",
  "1.0.0-beta-1",
  "1.0.0-beta.01",
  "1.0.0-dev.007",
  "01.0.0-beta.1",
  "1.00.0-dev.1",
  "1.0.00-beta.1",
  "1.0-beta.1",
  "１.0.0-dev.1",
  `v${VERSION}`,
  `${VERSION}.1`,
  ` ${VERSION}`,
  "",
];

describe("channelOf", () => {
  it("-dev.N 是 dev，-beta.N 是 beta，各段为 0 也认", () => {
    assert.equal(channelOf(VERSION), "dev");
    assert.equal(channelOf(BETA_VERSION), "beta");
    assert.equal(channelOf("0.0.0-dev.0"), "dev");
    assert.equal(channelOf("0.0.0-beta.0"), "beta");
    assert.equal(channelOf("10.20.30-beta.9007199254740993"), "beta");
  });

  it("没有预发布标识、标识认不出、数字段带前导零时拒绝", () => {
    for (const version of [...UNKNOWN_CHANNEL_VERSIONS, 1, null, undefined]) {
      assert.throws(
        () => channelOf(version),
        { message: `认不出版本号的通道：应为 X.Y.Z-<通道>.N，通道只能是 dev、beta，数字段不带前导零：${JSON.stringify(version)}` },
        String(version),
      );
    }
  });
});

describe("objectKey", () => {
  it("dev 版本是 dev/<版本>-<运行次数>/<文件名>", () => {
    assert.equal(objectKey(VERSION, ATTEMPT, FILE_NAME), KEY);
    assert.equal(objectKey(VERSION, "1", FILE_NAME), `dev/${VERSION}-1/${FILE_NAME}`);
  });

  it("beta 版本是 beta/<版本>-<运行次数>/<文件名>", () => {
    assert.equal(objectKey(BETA_VERSION, ATTEMPT, BETA_FILE), BETA_KEY);
    assert.equal(objectKey("1.0.0-beta.1", "1", "Petalfall-Installer-1.0.0-beta.1-x64.exe"), "beta/1.0.0-beta.1-1/Petalfall-Installer-1.0.0-beta.1-x64.exe");
  });

  it("版本号认不出通道时拒绝", () => {
    for (const version of UNKNOWN_CHANNEL_VERSIONS) {
      assert.throws(() => objectKey(version, ATTEMPT, `x-${version}.exe`), /^Error: 认不出版本号的通道/, version);
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

  it("beta/ 下的键给出三个桶上同一个键的地址", () => {
    assert.deepEqual(mirrorUrls(BETA_KEY), BETA_SOURCES.slice(0, 3));
  });

  // 前缀是白名单，不是「任意一段」：R2 的凭据能写整个桶，这条校验是它唯一的防线
  it("不在 dev/ 或 beta/ 下、层数不对、带 .. 或要转义的字符时拒绝", () => {
    const keys = [
      "stable/a/b",
      "release/a/b",
      "Dev/a/b",
      "BETA/a/b",
      "betas/a/b",
      "dev-beta/a/b",
      "constructor/a/b",
      "__proto__/a/b",
      `/${KEY}`,
      `/${BETA_KEY}`,
      "dev/a",
      "beta/a",
      "dev/a/b/c",
      "beta/a/b/c",
      "dev/../b",
      "beta/../b",
      "dev/a/..",
      "beta/./b",
      "dev/a/b c",
      "beta/a/%2e",
      "",
    ];
    for (const key of keys) {
      assert.throws(() => mirrorUrls(key), { message: `对象键应为 <通道>/<目录>/<文件名>，通道只能是 dev、beta：${JSON.stringify(key)}` }, key);
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

  it("beta 的桶源在 beta/ 下，github 源指向这一版自己的 Release v<版本>", () => {
    assert.deepEqual(sourceUrls({ version: BETA_VERSION, attempt: ATTEMPT, fileName: BETA_FILE, repo: REPO, tag: BETA_TAG }), BETA_SOURCES);
  });

  it("beta 的 tag 不是 v<版本> 时拒绝：滚动预发布或别的版本的附件会被删、会对不上", () => {
    const other = BETA_VERSION.replace(/\d+$/, (n) => String(Number(n) + 1));
    for (const tag of [TAG, BETA_VERSION, `v${other}`, `V${BETA_VERSION}`, `${BETA_TAG}-1`]) {
      assert.throws(
        () => sourceUrls({ version: BETA_VERSION, attempt: ATTEMPT, fileName: BETA_FILE, repo: REPO, tag }),
        { message: `beta 版本 ${BETA_VERSION} 的 tag 应为 ${BETA_TAG}，实际 ${JSON.stringify(tag)}` },
        tag,
      );
    }
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

  it("beta 清单的桶源在 beta/ 下，url 等于这一版 Release 的附件", () => {
    const built = manifest(betaOverrides);
    assert.equal(built.version, BETA_VERSION);
    assert.equal(built.notes, "修复了启动时的闪退");
    assert.equal(entryOf(built).url, BETA_GITHUB);
    assert.deepEqual(entryOf(built)["x-sources"], BETA_SOURCES);
  });
});

describe("validateManifest", () => {
  it("生成的清单经 JSON 往返后通过", () => {
    assert.equal(validateManifest(JSON.parse(JSON.stringify(manifest())), expected), undefined);
  });

  it("生成的 beta 清单经 JSON 往返后通过", () => {
    assert.equal(validateManifest(JSON.parse(JSON.stringify(manifest(betaOverrides))), betaExpected), undefined);
  });

  it("dev 清单拿 beta 的期望比时拒绝，反过来也拒绝：版本、前缀和 tag 都跟着通道走", () => {
    assert.throws(() => validateManifest(manifest(), betaExpected), /^Error: 清单的 version 是 /);
    assert.throws(() => validateManifest(manifest(betaOverrides), expected), /^Error: 清单的 version 是 /);
    // 只把三个桶源的前缀换成 dev/，其余与合法的 beta 清单相同：只靠前缀拦下
    const m = manifest(betaOverrides);
    for (const source of entryOf(m)["x-sources"].slice(0, 3)) source.url = source.url.replace("/beta/", "/dev/");
    assert.throws(() => validateManifest(m, betaExpected), {
      message: `源 cn 的路径是 /dev/${BETA_VERSION}-${ATTEMPT}/${BETA_FILE}，应为 /${BETA_KEY}`,
    });
  });

  it("beta 清单的 tag 不是 v<版本> 时拒绝，哪怕 github 源与传进来的 tag 一致", () => {
    const m = manifest({ ...betaOverrides, tag: BETA_TAG });
    const wrong = TAG;
    entryOf(m)["x-sources"][3].url = BETA_GITHUB.replace(`/${BETA_TAG}/`, `/${wrong}/`);
    entryOf(m).url = entryOf(m)["x-sources"][3].url;
    assert.throws(() => validateManifest(m, { ...betaExpected, tag: wrong }), {
      message: `beta 版本 ${BETA_VERSION} 的 tag 应为 ${BETA_TAG}，实际 ${JSON.stringify(wrong)}`,
    });
  });

  // 上限与 put-manifest 一致，按 Unicode 码位数：增补平面的字符在 JS 里占两个 UTF-16 单元，按 length 数会在 2000 个时就误拒
  it("notes 恰好 4000 个码位时通过，哪怕全是增补平面的字符；再多一个就拒绝", () => {
    const clef = "\u{1D11E}";
    for (const notes of ["说".repeat(4000), clef.repeat(4000), `${"a".repeat(3999)}${clef}`]) {
      assert.equal(validateManifest(manifest({ ...betaOverrides, notes }), betaExpected), undefined, notes.length);
    }
    for (const notes of ["说".repeat(4001), clef.repeat(4001), `${clef.repeat(4000)}a`, "a".repeat(4000 + randomInt(1, 4000))]) {
      const chars = [...notes].length;
      assert.throws(
        () => validateManifest(manifest({ ...betaOverrides, notes }), betaExpected),
        { message: `清单的 notes 有 ${chars} 个字符，超过 4000` },
        String(chars),
      );
    }
  });

  it("notes 含孤立的 UTF-16 代理项时拒绝：put-manifest 拒收，插件解析清单时会报错", () => {
    for (const notes of ["修复\uD800", "\uDD1E修复", "a\uDBFFb", "\uDC00\uD800"]) {
      assert.throws(() => validateManifest(manifest({ ...betaOverrides, notes }), betaExpected), {
        message: "清单的 notes 含孤立的 UTF-16 代理项，插件解析清单时会报错",
      });
    }
  });

  it("x-sources 换了顺序照样通过：客户端按自己的规范顺序排，不看清单里的顺序", () => {
    const m = manifest();
    entryOf(m)["x-sources"].reverse();
    assert.equal(validateManifest(m, expected), undefined);
  });

  it("pub_date 是 toISOString 形状的真实时刻时通过：闰年的 2 月 29 日、一年最后一毫秒、随机时刻", () => {
    const random = new Date(randomInt(Date.UTC(2000, 0, 1), Date.UTC(2100, 0, 1))).toISOString();
    for (const pubDate of ["2028-02-29T00:00:00.000Z", "2026-12-31T23:59:59.999Z", "2026-01-01T00:00:00.000Z", random]) {
      assert.equal(validateManifest(manifest({ pubDate }), expected), undefined, pubDate);
    }
  });

  // 与客户端、put-manifest 共用的上限写成字面量：哪一处单独改了常量，这里会挂
  it("x-size 恰好 268435456 字节时通过，再多 1 字节就拒绝，哪怕引导程序确实这么大", () => {
    const limit = 268435456;
    assert.equal(validateManifest(manifest({ size: limit }), { ...expected, size: limit }), undefined);
    for (const size of [limit + 1, limit + randomInt(2, 2 ** 40), Number.MAX_SAFE_INTEGER]) {
      assert.throws(
        () => validateManifest(manifest({ size }), { ...expected, size }),
        { message: `x-size 是 ${size}，超过更新包上限 ${limit} 字节` },
        String(size),
      );
    }
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
    ["pub_date 不是 RFC 3339", (m) => Object.assign(m, { pub_date: "2026-11-04 12:00:00" }), /^清单的 pub_date 应是真实存在的 UTC 时刻/],
    ["pub_date 的月和日都越界", (m) => Object.assign(m, { pub_date: "2026-13-40T00:00:00Z" }), /^清单的 pub_date 应是真实存在的 UTC 时刻/],
    // 下面四个 Date.parse 都不报 NaN，会滚到下一天；插件解析时拒收，整份清单作废。只坏日期一处，形状与 build 写出的一致
    ...["2026-02-30T00:00:00.000Z", "2026-02-29T00:00:00.000Z", "2026-04-31T00:00:00.000Z", "2026-11-04T24:00:00.000Z"].map((pubDate) => [
      `pub_date 是不存在的时刻 ${pubDate}`,
      (m) => Object.assign(m, { pub_date: pubDate }),
      new RegExp(`^清单的 pub_date 应是真实存在的 UTC 时刻，形如 YYYY-MM-DDTHH:mm:ss\\.sssZ："${pubDate.replaceAll(".", "\\.")}"$`),
    ]),
    ["pub_date 合乎 RFC 3339 但不是 build 写出的形状", (m) => Object.assign(m, { pub_date: "2026-11-04T12:00:00Z" }), /^清单的 pub_date 应是真实存在的 UTC 时刻/],
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

  function bootstrapFixture(bytes = randomBytes(randomInt(1, 8192)), fileName = FILE_NAME) {
    const dir = join(root, String(nextCase++));
    mkdirSync(dir);
    const bootstrap = join(dir, fileName);
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

  function notesFixture(content) {
    const dir = join(root, String(nextCase++));
    mkdirSync(dir);
    const path = join(dir, "notes.md");
    writeFileSync(path, content);
    return path;
  }

  const commit = () => randomBytes(20).toString("hex");

  it("build 给 beta 版本写出的清单带说明文件去掉首尾空白后的内容，validate 照它通过", () => {
    const body = `修复了启动时的闪退 ${randomBytes(4).toString("hex")}\n\n- 第二条\n- 第三条`;
    // 4000 个码位恰好在上限上；带 BOM 和首尾空白的文件同样只取正文
    for (const [content, notes] of [
      [`\n  ${body}\n\n`, body],
      [`﻿${body}\n`, body],
      [`\n${"说".repeat(4000)}\n`, "说".repeat(4000)],
    ]) {
      const { bootstrap, manifest: out } = bootstrapFixture(undefined, BETA_FILE);
      const built = run("build", BETA_VERSION, ATTEMPT, bootstrap, REPO, BETA_TAG, commit(), out, notesFixture(content));
      assert.equal(built.status, 0, built.stderr);
      assert.equal(built.stdout, "");
      const written = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(written.version, BETA_VERSION);
      assert.equal(written.notes, notes);
      assert.deepEqual(written.platforms, {
        "windows-x86_64": { signature: SIGNATURE, url: BETA_GITHUB, "x-size": statSync(bootstrap).size, "x-sources": BETA_SOURCES },
      });

      const validated = run("validate", out, BETA_VERSION, ATTEMPT, bootstrap, REPO, BETA_TAG);
      assert.equal(validated.status, 0, validated.stderr);
      assert.equal(validated.stdout, `清单校验通过：${BETA_VERSION}，cn、hk、global、github\n`);
    }
  });

  it("build 给 dev 版本传说明文件时退出非 0，不写清单：dev 的说明固定是提交号", () => {
    const { bootstrap, manifest: out } = bootstrapFixture();
    const notes = notesFixture("说明");
    const result = run("build", VERSION, ATTEMPT, bootstrap, REPO, TAG, commit(), out, notes);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`dev 版本的说明固定写提交号，不收说明文件：${notes}`), result.stderr);
    assert.throws(() => statSync(out), { code: "ENOENT" });
  });

  it("build 给 beta 版本不传说明文件时退出非 0，不写清单", () => {
    const { bootstrap, manifest: out } = bootstrapFixture(undefined, BETA_FILE);
    const result = run("build", BETA_VERSION, ATTEMPT, bootstrap, REPO, BETA_TAG, commit(), out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`beta 版本 ${BETA_VERSION.replaceAll(".", "\\.")} 必须给说明文件`));
    assert.throws(() => statSync(out), { code: "ENOENT" });
  });

  it("build 的 beta 说明文件为空、只有空白、超过 4000 个码位或不是 UTF-8 时退出非 0，不写清单", () => {
    for (const [content, message] of [
      ["", /去掉首尾空白后是空的/],
      [" \n\t\r\n﻿", /去掉首尾空白后是空的/],
      [`${"说".repeat(4001)}\n`, /有 4001 个字符，超过 4000/],
      ["\u{1D11E}".repeat(4001), /有 4001 个字符，超过 4000/],
      // 截断的多字节字符、UTF-8 编出来的代理项、单独的 0xff
      [Buffer.from([0xe4, 0xbf, 0x0a]), /不是合法的 UTF-8/],
      [Buffer.concat([Buffer.from("修复"), Buffer.from([0xed, 0xa0, 0x80])]), /不是合法的 UTF-8/],
      [Buffer.from([0x61, 0xff]), /不是合法的 UTF-8/],
    ]) {
      const { bootstrap, manifest: out } = bootstrapFixture(undefined, BETA_FILE);
      const result = run("build", BETA_VERSION, ATTEMPT, bootstrap, REPO, BETA_TAG, commit(), out, notesFixture(content));
      assert.notEqual(result.status, 0, String(message));
      assert.match(result.stderr, message);
      assert.throws(() => statSync(out), { code: "ENOENT" });
    }
  });

  it("build 的 beta tag 不是 v<版本> 时退出非 0，不写清单", () => {
    const { bootstrap, manifest: out } = bootstrapFixture(undefined, BETA_FILE);
    const result = run("build", BETA_VERSION, ATTEMPT, bootstrap, REPO, TAG, commit(), out, notesFixture("说明"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /的 tag 应为 v/);
    assert.throws(() => statSync(out), { code: "ENOENT" });
  });

  it("参数个数不对或子命令不认识时退出非 0 并提示用法：工作流漏传参数不能被当成成功", () => {
    const build = ["build", VERSION, ATTEMPT, "boot.exe", REPO, TAG, "0".repeat(40)];
    for (const args of [
      [],
      ["key", VERSION, ATTEMPT],
      ["mirror-urls"],
      ["upload-targets", ACCOUNT, ACCOUNT],
      ["validate", "x"],
      ["publish", KEY],
      build,
      [...build, "out.json", "notes.md", "extra"],
    ]) {
      const result = run(...args);
      assert.notEqual(result.status, 0, args.join(" "));
      assert.match(result.stderr, /用法：/);
      assert.equal(result.stdout, "");
    }
  });

  it("参数里有空串时同样拒绝，可选的说明文件也一样", () => {
    assert.throws(() => runCommand(["key", VERSION, "", FILE_NAME]), /^Error: 用法：/);
    assert.throws(() => runCommand(["build", BETA_VERSION, ATTEMPT, "boot.exe", REPO, BETA_TAG, "0".repeat(40), "out.json", ""]), /^Error: 用法：/);
  });
});
