import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DATA_FORMAT_LINE,
  DATA_FORMAT_PATH,
  DEV_RELEASE_TAG,
  FETCH_RETRIES,
  HK_MANIFEST_URLS,
  MAX_MANIFEST_BYTES,
  PUBKEY_FILES,
  RETRY_DELAY_MS,
  betaGate,
  channelShapeOf,
  compareVersions,
  devGate,
  formatHeads,
  main,
  parseDataFormat,
  parseHeads,
  payloadFailures,
  readHeads,
  releaseManifestUrl,
} from "./release-heads.mjs";
import { codeOf, job, jobNames, parseWorkflow, stepKeys, steps } from "./workflow-lines.mjs";

const SCRIPT = fileURLToPath(new URL("./release-heads.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DATA_FORMAT_FILE = join(REPO_ROOT, DATA_FORMAT_PATH);
const VECTOR = JSON.parse(readFileSync(join(REPO_ROOT, "crates/petalfall-release/testdata/version-order.json"), "utf8"));
const FIXTURE_TAGS = readFileSync(fileURLToPath(new URL("./testdata/release-heads/ls-remote-tags.txt", import.meta.url)), "utf8")
  .split(/\r?\n/)
  .filter((line) => line !== "");
const REPO = "petalfall-test/petalfall";
const REMOTE = `https://github.com/${REPO}.git`;
const PLATFORM = "windows-x86_64";
const HK = HK_MANIFEST_URLS;
const releaseUrl = (tag) => releaseManifestUrl(REPO, tag);

const root = mkdtempSync(join(tmpdir(), "release-heads-"));
after(() => rmSync(root, { recursive: true, force: true }));
let nextFile = 0;
const tempPath = (name) => join(root, `${nextFile++}-${name}`);

// 固定种子：失败时能原样重现
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(0x7e1ea5e);
const randomInt = (min, max) => min + Math.floor(random() * (max - min));
const seededBytes = (length) => Buffer.from(Array.from({ length }, () => randomInt(0, 256)));

function shuffled(items, seed) {
  const next = mulberry32(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// 一次性测试钥，种子取自固定种子的随机数，私钥只在内存里
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
function keypair(keyId = seededBytes(8)) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seededBytes(32)]), format: "der", type: "pkcs8" });
  return { keyId, raw: Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url"), privateKey };
}

const wrap = (text) => Buffer.from(text, "utf8").toString("base64");

// 与 tauri signer generate 写出的 .pub 同构
const pubkeyText = ({ keyId, raw }) =>
  wrap(`untrusted comment: minisign public key: ${keyId.toString("hex").toUpperCase()}\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`);

// 与 tauri signer sign 写出的 .sig 同构；被签的安装包用随机字节代替，release-heads 只验全局签名，不看安装包
function signatureText(key, trusted) {
  const fileSignature = sign(null, createHash("blake2b512").update(seededBytes(64)).digest(), key.privateKey);
  const globalSignature = sign(null, Buffer.concat([fileSignature, Buffer.from(trusted, "utf8")]), key.privateKey);
  const bin = Buffer.concat([Buffer.from("ED"), key.keyId, fileSignature]);
  return wrap(`untrusted comment: signature from tauri secret key\n${bin.toString("base64")}\ntrusted comment: ${trusted}\n${globalSignature.toString("base64")}\n`);
}

const devKey = keypair();
const releaseKey = keypair();
// 同一个密钥号、不同的私钥：密钥号对得上，只有全局签名能把它拦下
const forgedKey = keypair(releaseKey.keyId);
const strangerKey = keypair();
const PUBKEYS = { dev: pubkeyText(devKey), beta: pubkeyText(releaseKey), stable: pubkeyText(releaseKey) };

const KEY_OF = { dev: devKey, beta: releaseKey, stable: releaseKey };

// 正文的形状照 dev-distribution.mjs 生成的清单，release-heads 只读 version 与签名
function manifest(version, { key = KEY_OF[channelShapeOf(version)], signedVersion = version, file, padTo } = {}) {
  const fileName = file === undefined ? `Petalfall-Installer-${signedVersion}-x64.exe` : file;
  const trusted = `timestamp:${randomInt(1_700_000_000, 2_000_000_000)}\tfile:${fileName}\tversion:${signedVersion}`;
  const url = `https://github.com/${REPO}/releases/download/v${version}/Petalfall-Installer-${version}-x64.exe`;
  const text = JSON.stringify(
    {
      version,
      notes: "测试清单",
      pub_date: "2026-11-10T00:00:00.000Z",
      platforms: { [PLATFORM]: { signature: signatureText(key, trusted), url, "x-size": randomInt(1, 1 << 20), "x-sources": [{ name: "github", url }] } },
    },
    null,
    2,
  );
  if (padTo === undefined) return text;
  // JSON 末尾的空白合法，用来把正文补到恰好的字节数
  return text + " ".repeat(padTo - Buffer.byteLength(text));
}

const ok = (body) => ({ status: 200, body });
const status = (code) => ({ status: code, body: `HTTP ${code}` });
const connectionError = () => new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });

// 没登记的地址回 404：草稿与没附清单的 Release 对匿名请求就是这样
function fakeNetwork(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    assert.ok(init.signal instanceof AbortSignal, "每次请求都要带超时");
    calls.push(url);
    if (!Object.hasOwn(routes, url)) return new Response("Not Found", { status: 404 });
    const route = routes[url];
    const reply = typeof route === "function" ? route(calls.filter((called) => called === url).length) : route;
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status });
  };
  return { fetch, calls };
}

function lsRemote(tagLines) {
  return (args) => {
    assert.deepEqual(args, ["ls-remote", "--tags", "--refs", REMOTE]);
    return { status: 0, stdout: tagLines.map((line) => `${line}\n`).join(""), stderr: "" };
  };
}

const tagLine = (tag) => `${createHash("sha1").update(tag).digest("hex")}\trefs/tags/${tag}`;

const unexpected = (what) => () => {
  throw new Error(`这个用例不该${what}`);
};

function makeDeps({ fetch = unexpected("联网"), git = unexpected("跑 git"), env = {}, remote = (repo) => `https://github.com/${repo}.git` } = {}) {
  const out = [];
  const err = [];
  const sleeps = [];
  const deps = {
    fetch,
    git,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    remote,
    pubkey: (channel) => PUBKEYS[channel],
    dataFormatSource: () => readFileSync(DATA_FORMAT_FILE, "utf8"),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, out, err, sleeps };
}

async function read(routes, tags = FIXTURE_TAGS) {
  const network = fakeNetwork(routes);
  const harness = makeDeps({ fetch: network.fetch, git: lsRemote(tags) });
  const heads = await readHeads(REPO, harness.deps);
  return { heads, calls: network.calls, warnings: harness.err };
}

async function readFails(routes, message, tags = FIXTURE_TAGS) {
  const network = fakeNetwork(routes);
  const harness = makeDeps({ fetch: network.fetch, git: lsRemote(tags) });
  await assert.rejects(readHeads(REPO, harness.deps), typeof message === "string" ? { message } : message);
  return { calls: network.calls, warnings: harness.err, sleeps: harness.sleeps };
}

const head = (version, source) => ({ version, source });
const DEV_57 = { [HK.dev]: ok(manifest("1.0.0-dev.57")), [releaseUrl(DEV_RELEASE_TAG)]: ok(manifest("1.0.0-dev.57")) };

describe("共用版本向量", () => {
  it("比较器与 version-order.json 的 order 逐条一致，交换两边结果取反", () => {
    assert.ok(VECTOR.order.length > 0);
    for (const { a, b, cmp } of VECTOR.order) {
      assert.equal(compareVersions(a, b), cmp, `${a} 对 ${b}`);
      assert.equal(compareVersions(b, a), cmp === 0 ? 0 : -cmp, `${b} 对 ${a}`);
    }
  });

  it("三个通道的形状与 version-order.json 的 channel 逐条一致", () => {
    assert.ok(VECTOR.channel.length > 0);
    for (const { version, channel } of VECTOR.channel) assert.equal(channelShapeOf(version), channel, version);
  });

  it("测试版与正式版只认主版本至少为 1 的，预览版允许主版本 0，前导零与构建元数据一律认不出", () => {
    const cases = {
      "0.1.0-dev.41": "dev",
      "0.1.5": null,
      "0.2.0-beta.1": null,
      "1.0.0-beta.04": null,
      "01.0.0": null,
      "1.0.0+build.1": null,
      "1.0.0-beta.3+build.1": null,
      "1.0.0-dev": null,
      "": null,
    };
    for (const [version, channel] of Object.entries(cases)) assert.equal(channelShapeOf(version), channel, version);
    assert.equal(channelShapeOf(undefined), null);
  });
});

describe("read：按验过签名的来源读出各通道的最高版本", () => {
  it("香港清单都验过、tag 都不高于香港时一个 Release 都不取；主版本 0 与形状不对的 tag 不算", async () => {
    const { heads, calls, warnings } = await read({ ...DEV_57, [HK.beta]: ok(manifest("1.0.0-beta.3")) });
    assert.deepEqual(heads, { dev: head("1.0.0-dev.57", "hk"), beta: head("1.0.0-beta.3", "hk"), stable: null });
    assert.deepEqual(calls, [HK.dev, releaseUrl(DEV_RELEASE_TAG), HK.beta, HK.stable]);
    assert.deepEqual(warnings, []);
  });

  it("dev 取香港与 dev-build 两处里验过的较高者，同号时记香港；一处 404 时只看另一处", async () => {
    const higherOnGithub = await read({ [HK.dev]: ok(manifest("1.0.0-dev.57")), [releaseUrl(DEV_RELEASE_TAG)]: ok(manifest("1.0.0-dev.58")) });
    assert.deepEqual(higherOnGithub.heads.dev, head("1.0.0-dev.58", "dev-build"));
    const higherOnHk = await read({ [HK.dev]: ok(manifest("1.0.0-dev.58")), [releaseUrl(DEV_RELEASE_TAG)]: ok(manifest("1.0.0-dev.57")) });
    assert.deepEqual(higherOnHk.heads.dev, head("1.0.0-dev.58", "hk"));
    const hkMissing = await read({ [releaseUrl(DEV_RELEASE_TAG)]: ok(manifest("0.1.0-dev.41")) });
    assert.deepEqual(hkMissing.heads.dev, head("0.1.0-dev.41", "dev-build"));
    const githubMissing = await read({ [HK.dev]: ok(manifest("1.0.0-dev.57")) });
    assert.deepEqual(githubMissing.heads.dev, head("1.0.0-dev.57", "hk"));
    const bothMissing = await read({});
    assert.deepEqual(bothMissing.heads, { dev: null, beta: null, stable: null });
  });

  describe("香港清单回了 200 却不可信时构建失败", () => {
    const rejected = (channel, reason) => `香港${{ dev: "预览版", beta: "测试版", stable: "正式版" }[channel]}清单 ${HK[channel]} 验不过，这是客户端正在读的清单，要人去查：${reason}`;

    it("换一把私钥签的：密钥号对得上也过不了全局签名", async () => {
      await readFails({ ...DEV_57, [HK.beta]: ok(manifest("1.0.0-beta.4", { key: forgedKey })) }, rejected("beta", "可信注释的签名验证失败"));
    });

    it("密钥号不是该通道公钥的：拿 dev 钥签的测试版清单", async () => {
      await readFails(
        { ...DEV_57, [HK.beta]: ok(manifest("1.0.0-beta.4", { key: devKey })) },
        rejected("beta", `签名用的密钥号 ${devKey.keyId.toString("hex")} 和公钥的 ${releaseKey.keyId.toString("hex")} 不是一对：私钥配错了`),
      );
    });

    it("签名里的版本不是本通道的形状", async () => {
      for (const version of ["1.0.0-dev.60", "0.2.0-beta.1", "1.0.0"]) {
        await readFails({ ...DEV_57, [HK.beta]: ok(manifest(version, { key: releaseKey })) }, rejected("beta", `签名里的版本 ${version} 不是测试版的形状`));
      }
    });

    it("签名里的版本与正文不符：拿旧版本的签名配新版本号", async () => {
      await readFails(
        { ...DEV_57, [HK.beta]: ok(manifest("1.0.0-beta.4", { signedVersion: "1.0.0-beta.3" })) },
        rejected("beta", "签名里的版本 1.0.0-beta.3 与正文的 1.0.0-beta.4 不符"),
      );
    });

    it("签名里的文件名不是这个版本的安装包", async () => {
      await readFails(
        { [HK.dev]: ok(manifest("1.0.0-dev.57", { file: "Petalfall-Installer-1.0.0-dev.56-x64.exe" })) },
        rejected("dev", "签名里的文件名 Petalfall-Installer-1.0.0-dev.56-x64.exe 应为 Petalfall-Installer-1.0.0-dev.57-x64.exe"),
      );
    });

    it("正文不是 JSON、没有签名或签名不是字符串", async () => {
      await readFails({ [HK.dev]: ok("<html>maintenance</html>") }, (error) => error.message.startsWith(rejected("dev", "正文不是 UTF-8 编码的 JSON：")));
      await readFails({ [HK.dev]: ok(Buffer.from([0x7b, 0xff, 0x7d])) }, (error) => error.message.startsWith(rejected("dev", "正文不是 UTF-8 编码的 JSON：")));
      await readFails({ [HK.dev]: ok("null") }, rejected("dev", "正文里没有字符串形式的 version"));
      await readFails(
        { [HK.dev]: ok(JSON.stringify({ version: "1.0.0-dev.57", platforms: { [PLATFORM]: { signature: 7 } } })) },
        rejected("dev", `正文里没有字符串形式的 platforms.${PLATFORM}.signature`),
      );
      await readFails({ [HK.dev]: ok(JSON.stringify({ version: "1.0.0-dev.57", platforms: [] })) }, rejected("dev", `正文里没有字符串形式的 platforms.${PLATFORM}.signature`));
    });

    it(`正文超过 ${MAX_MANIFEST_BYTES} 字节时失败，恰好 ${MAX_MANIFEST_BYTES} 字节时照常验`, async () => {
      const exact = manifest("1.0.0-beta.4", { padTo: MAX_MANIFEST_BYTES });
      assert.equal(Buffer.byteLength(exact), MAX_MANIFEST_BYTES);
      const { heads } = await read({ ...DEV_57, [HK.beta]: ok(exact) });
      assert.deepEqual(heads.beta, head("1.0.0-beta.4", "hk"));
      await readFails(
        { ...DEV_57, [HK.beta]: ok(manifest("1.0.0-beta.4", { padTo: MAX_MANIFEST_BYTES + 1 })) },
        `香港测试版清单 ${HK.beta} 的正文超过 ${MAX_MANIFEST_BYTES} 字节`,
      );
    });
  });

  it("香港清单回 404 以外的非 2xx 时失败，不重试", async () => {
    for (const code of [403, 429, 500, 502]) {
      const { calls, sleeps } = await readFails({ ...DEV_57, [HK.stable]: status(code) }, `香港正式版清单 ${HK.stable} 回了 HTTP ${code}`);
      assert.equal(calls.filter((url) => url === HK.stable).length, 1);
      assert.deepEqual(sleeps, []);
    }
  });

  it(`香港清单连不上时重试 ${FETCH_RETRIES} 次，每次间隔 ${RETRY_DELAY_MS} 毫秒，仍连不上就失败`, async () => {
    const { calls, warnings, sleeps } = await readFails(
      { [HK.dev]: () => connectionError() },
      `取 ${HK.dev} 重试 ${FETCH_RETRIES} 次仍连不上：fetch failed：connect ECONNREFUSED`,
    );
    assert.deepEqual(calls, Array(FETCH_RETRIES + 1).fill(HK.dev));
    assert.deepEqual(sleeps, Array(FETCH_RETRIES).fill(RETRY_DELAY_MS));
    assert.deepEqual(
      warnings,
      [1, 2, 3].map((attempt) => `::warning::第 ${attempt} 次取 ${HK.dev} 没连上（fetch failed：connect ECONNREFUSED），5 秒后重试`),
    );
  });

  it("连不上之后重试成功就照常读", async () => {
    const body = manifest("1.0.0-dev.57");
    const { heads, calls } = await read({ [HK.dev]: (attempt) => (attempt <= FETCH_RETRIES ? connectionError() : ok(body)) });
    assert.deepEqual(heads.dev, head("1.0.0-dev.57", "hk"));
    assert.equal(calls.filter((url) => url === HK.dev).length, FETCH_RETRIES + 1);
  });

  it("从高到低逐个取高于香港的 tag，Release 上没有清单就跳过，取到第一个验过的就停", async () => {
    const tags = [...FIXTURE_TAGS, tagLine("v1.0.0-beta.4"), tagLine("v1.0.0-beta.5")];
    const { heads, calls, warnings } = await read({ ...DEV_57, [releaseUrl("v1.0.0-beta.4")]: ok(manifest("1.0.0-beta.4")) }, tags);
    assert.deepEqual(heads.beta, head("1.0.0-beta.4", "release:v1.0.0-beta.4"));
    assert.deepEqual(calls, [
      HK.dev,
      releaseUrl(DEV_RELEASE_TAG),
      HK.beta,
      releaseUrl("v1.0.0-beta.5"),
      releaseUrl("v1.0.0-beta.4"),
      HK.stable,
      // 正式版只有主版本 0 的旧 tag，一个都不取
    ]);
    assert.deepEqual(warnings, []);
  });

  it("Release 上的清单验不过或签的版本与 tag 不符时记 warning、跳过，接着取下一个", async () => {
    const tags = [...FIXTURE_TAGS, ...["v1.0.0-beta.4", "v1.0.0-beta.5", "v1.0.0-beta.6"].map(tagLine)];
    const replayed = manifest("1.0.0-beta.3");
    const { heads, calls, warnings } = await read(
      {
        ...DEV_57,
        [HK.beta]: ok(replayed),
        // 把已发布的旧清单原样挂到更高的 tag 下：签名是真的，版本对不上 tag
        [releaseUrl("v1.0.0-beta.6")]: ok(replayed),
        [releaseUrl("v1.0.0-beta.5")]: ok(manifest("1.0.0-beta.5", { key: strangerKey })),
        [releaseUrl("v1.0.0-beta.4")]: ok(manifest("1.0.0-beta.4")),
      },
      tags,
    );
    assert.deepEqual(heads.beta, head("1.0.0-beta.4", "release:v1.0.0-beta.4"));
    assert.deepEqual(calls.slice(2, 6), [HK.beta, releaseUrl("v1.0.0-beta.6"), releaseUrl("v1.0.0-beta.5"), releaseUrl("v1.0.0-beta.4")]);
    assert.deepEqual(warnings, [
      "::warning::Release v1.0.0-beta.6 上的 latest.json 验不过，跳过：签名里的版本 1.0.0-beta.3 与 tag v1.0.0-beta.6 不符",
      `::warning::Release v1.0.0-beta.5 上的 latest.json 验不过，跳过：签名用的密钥号 ${strangerKey.keyId.toString("hex")} 和公钥的 ${releaseKey.keyId.toString("hex")} 不是一对：私钥配错了`,
    ]);
  });

  it("Release 上的清单都验不过、香港有验过的版本时取香港的", async () => {
    const tags = [...FIXTURE_TAGS, tagLine("v1.0.0-beta.9")];
    const { heads, warnings } = await read(
      { ...DEV_57, [HK.beta]: ok(manifest("1.0.0-beta.3")), [releaseUrl("v1.0.0-beta.9")]: ok(manifest("1.0.0-beta.9", { padTo: MAX_MANIFEST_BYTES + 1 })) },
      tags,
    );
    assert.deepEqual(heads.beta, head("1.0.0-beta.3", "hk"));
    assert.deepEqual(warnings, [`::warning::Release v1.0.0-beta.9 上的 latest.json 超过 ${MAX_MANIFEST_BYTES} 字节，跳过`]);
  });

  it("Release 下载回 404 以外的非 2xx 或连不上时失败：跳过会让结果偏低", async () => {
    const tags = [...FIXTURE_TAGS, tagLine("v1.0.0-beta.4")];
    await readFails(
      { ...DEV_57, [releaseUrl("v1.0.0-beta.4")]: status(500) },
      `Release v1.0.0-beta.4 上的 latest.json（${releaseUrl("v1.0.0-beta.4")}）回了 HTTP 500，跳过会让结果偏低`,
      tags,
    );
    await readFails(
      { [HK.dev]: ok(manifest("1.0.0-dev.57")), [releaseUrl(DEV_RELEASE_TAG)]: status(503) },
      `Release ${DEV_RELEASE_TAG} 上的 latest.json（${releaseUrl(DEV_RELEASE_TAG)}）回了 HTTP 503，跳过会让结果偏低`,
    );
    const { calls } = await readFails(
      { ...DEV_57, [releaseUrl("v1.0.0-beta.4")]: () => connectionError() },
      `取 ${releaseUrl("v1.0.0-beta.4")} 重试 ${FETCH_RETRIES} 次仍连不上：fetch failed：connect ECONNREFUSED`,
      tags,
    );
    assert.equal(calls.filter((url) => url === releaseUrl("v1.0.0-beta.4")).length, FETCH_RETRIES + 1);
  });

  it("某通道有来源回了 200 却一处都验不过时失败", async () => {
    const tags = [...FIXTURE_TAGS, tagLine("v1.0.0-beta.4")];
    const { warnings } = await readFails(
      { ...DEV_57, [releaseUrl("v1.0.0-beta.4")]: ok(manifest("1.0.0-beta.4", { key: forgedKey })) },
      "测试版有来源回了清单，却一处都验不过签名",
      tags,
    );
    assert.deepEqual(warnings, ["::warning::Release v1.0.0-beta.4 上的 latest.json 验不过，跳过：可信注释的签名验证失败"]);
    await readFails({ [releaseUrl(DEV_RELEASE_TAG)]: ok(manifest("1.0.0-dev.57", { key: releaseKey })) }, "预览版有来源回了清单，却一处都验不过签名");
  });

  it("正式版只认主版本至少为 1 的 v<X.Y.Z> tag", async () => {
    const tags = [...FIXTURE_TAGS, ...["v1.0.0", "v1.0.1"].map(tagLine)];
    const { heads, calls } = await read({ ...DEV_57, [releaseUrl("v1.0.0")]: ok(manifest("1.0.0")) }, tags);
    assert.deepEqual(heads.stable, head("1.0.0", "release:v1.0.0"));
    assert.deepEqual(calls.slice(-3), [HK.stable, releaseUrl("v1.0.1"), releaseUrl("v1.0.0")]);
  });

  it("序号超过 2^53 时按 BigInt 比：高出香港一个号的 tag 照样去取，排序也不乱", async () => {
    const above = "1.0.0-beta.9007199254740993";
    const below = "1.0.0-beta.9007199254740992";
    // Number 会把这两个序号读成同一个数
    assert.equal(Number(above.split(".").pop()), Number(below.split(".").pop()));
    const single = await read({ ...DEV_57, [HK.beta]: ok(manifest(below)), [releaseUrl(`v${above}`)]: ok(manifest(above)) }, [
      ...FIXTURE_TAGS,
      tagLine(`v${below}`),
      tagLine(`v${above}`),
    ]);
    assert.deepEqual(single.heads.beta, head(above, `release:v${above}`));

    const both = await read(
      { ...DEV_57, [HK.beta]: ok(manifest("1.0.0-beta.9007199254740991")), [releaseUrl(`v${above}`)]: ok(manifest(above)), [releaseUrl(`v${below}`)]: ok(manifest(below)) },
      [...FIXTURE_TAGS, tagLine(`v${below}`), tagLine(`v${above}`)],
    );
    assert.deepEqual(both.heads.beta, head(above, `release:v${above}`));
    assert.deepEqual(both.calls.filter((url) => url.includes("90071992547409")), [releaseUrl(`v${above}`)]);
  });

  it("tag 列表按固定种子随机打乱，结果与取的次序都不变", async () => {
    const tags = [...FIXTURE_TAGS, ...["v1.0.0-beta.4", "v1.0.0-beta.5", "v1.0.0-beta.6", "v1.1.0-beta.1", "v1.0.0", "v1.0.1"].map(tagLine)];
    const routes = {
      [HK.dev]: ok(manifest("1.0.0-dev.60")),
      [releaseUrl(DEV_RELEASE_TAG)]: ok(manifest("1.0.0-dev.60")),
      [HK.beta]: ok(manifest("1.0.0-beta.3")),
      [releaseUrl("v1.1.0-beta.1")]: ok(manifest("1.0.0-beta.5")),
      [releaseUrl("v1.0.0-beta.6")]: ok(manifest("1.0.0-beta.6", { key: strangerKey })),
      [releaseUrl("v1.0.0-beta.5")]: ok(manifest("1.0.0-beta.5")),
      [releaseUrl("v1.0.0")]: ok(manifest("1.0.0")),
    };
    const expected = {
      dev: head("1.0.0-dev.60", "hk"),
      beta: head("1.0.0-beta.5", "release:v1.0.0-beta.5"),
      stable: head("1.0.0", "release:v1.0.0"),
    };
    const expectedCalls = [
      HK.dev,
      releaseUrl(DEV_RELEASE_TAG),
      HK.beta,
      releaseUrl("v1.1.0-beta.1"),
      releaseUrl("v1.0.0-beta.6"),
      releaseUrl("v1.0.0-beta.5"),
      HK.stable,
      releaseUrl("v1.0.1"),
      releaseUrl("v1.0.0"),
    ];
    for (const seed of [1, 2, 3, 0x5eed, 0xbadc0de, 0xffffffff]) {
      const { heads, calls } = await read(routes, shuffled(tags, seed));
      assert.deepEqual(heads, expected, `种子 ${seed}`);
      assert.deepEqual(calls, expectedCalls, `种子 ${seed}`);
    }
  });

  it("git ls-remote 失败或输出认不出时失败", async () => {
    const network = fakeNetwork(DEV_57);
    const failing = makeDeps({ fetch: network.fetch, git: () => ({ status: 128, stdout: "", stderr: "fatal: unable to access\n" }) });
    await assert.rejects(readHeads(REPO, failing.deps), { message: `git ls-remote --tags --refs ${REMOTE} 以 128 退出：fatal: unable to access` });
    const garbled = makeDeps({ fetch: fakeNetwork(DEV_57).fetch, git: lsRemote(["not a ref line"]) });
    await assert.rejects(readHeads(REPO, garbled.deps), { message: "git ls-remote 输出了认不出的行：not a ref line" });
  });

  it("命令行写出 heads 文件并逐通道打印版本与来源", async () => {
    const network = fakeNetwork({ ...DEV_57, [HK.beta]: ok(manifest("1.0.0-beta.3")) });
    const harness = makeDeps({ fetch: network.fetch, git: lsRemote(FIXTURE_TAGS) });
    const headsPath = tempPath("heads.json");
    assert.equal(await main(["read", REPO, headsPath], harness.deps), 0);
    assert.equal(
      readFileSync(headsPath, "utf8"),
      '{"dev":{"version":"1.0.0-dev.57","source":"hk"},"beta":{"version":"1.0.0-beta.3","source":"hk"},"stable":null}\n',
    );
    assert.deepEqual(harness.out.slice(-3), ["dev\t1.0.0-dev.57\thk", "beta\t1.0.0-beta.3\thk", "stable\tnull\tnull"]);
    assert.deepEqual(harness.err, []);
  });

  it("命令行读取失败时打 ::error:: 并以 1 退出，不写 heads 文件", async () => {
    const network = fakeNetwork({ [HK.dev]: status(500) });
    const harness = makeDeps({ fetch: network.fetch, git: lsRemote(FIXTURE_TAGS) });
    const headsPath = tempPath("heads.json");
    assert.equal(await main(["read", REPO, headsPath], harness.deps), 1);
    assert.deepEqual(harness.err, [`::error::香港预览版清单 ${HK.dev} 回了 HTTP 500`]);
    assert.throws(() => readFileSync(headsPath), { code: "ENOENT" });
  });
});

describe("heads 文件", () => {
  const valid = { dev: head("1.0.0-dev.57", "dev-build"), beta: head("1.0.0-beta.3", "release:v1.0.0-beta.3"), stable: null };

  it("写出的与读回的一致", () => {
    assert.deepEqual(parseHeads(formatHeads(valid)), valid);
  });

  it("键、形状、来源不对时拒绝", () => {
    const broken = [
      [{ dev: null, beta: null }, "heads 文件的键应恰好是 dev、beta、stable"],
      [{ ...valid, extra: null }, "heads 文件的键应恰好是 dev、beta、stable"],
      [{ ...valid, dev: { version: "1.0.0-dev.57" } }, "heads 文件里 dev 应为 null 或恰好带 version、source 的对象"],
      [{ ...valid, beta: head("1.0.0-dev.57", "hk") }, 'heads 文件里 beta 的版本 "1.0.0-dev.57" 不是测试版的形状'],
      [{ ...valid, stable: head("0.1.5", "hk") }, 'heads 文件里 stable 的版本 "0.1.5" 不是正式版的形状'],
      [{ ...valid, beta: head("1.0.0-beta.3", "release:v1.0.0-beta.2") }, 'heads 文件里 beta 的来源 "release:v1.0.0-beta.2" 应为 hk 或 release:v1.0.0-beta.3'],
      [{ ...valid, dev: head("1.0.0-dev.57", "release:v1.0.0-dev.57") }, 'heads 文件里 dev 的来源 "release:v1.0.0-dev.57" 应为 hk 或 dev-build'],
    ];
    for (const [heads, message] of broken) assert.throws(() => parseHeads(JSON.stringify(heads)), { message });
    assert.throws(() => parseHeads("[]"), { message: "heads 文件的键应恰好是 dev、beta、stable" });
  });
});

const heads = ({ dev = null, beta = null, stable = null }) => ({
  dev: dev === null ? null : head(dev, "hk"),
  beta: beta === null ? null : head(beta, `release:v${beta}`),
  stable: stable === null ? null : head(stable, "hk"),
});

const BASE_FAILURE = (base) => `基础号 ${base} 应形如 X.Y.0、主版本至少为 1：补丁段留给正式版补丁，主版本 0 低于现行的所有版本`;
const SPAN_FAILURE = (core, highest, successors) =>
  `本包核心号 ${core} 应等于各通道已发布的最高核心号 ${highest}，或者是它的后继 ${successors}：基础号一次只能抬一格`;

describe("gate dev：预览版的版本先后", () => {
  const run = randomInt(42, 100_000);

  it("基础号形如 X.Y.0、主版本至少为 1 时通过", () => {
    assert.deepEqual(devGate(`1.0.0-dev.${run}`, heads({ dev: "1.0.0-dev.41", beta: "1.0.0-beta.3" })), { failures: [], notices: [] });
  });

  it("基础号补丁段不为 0、主版本为 0 时拒绝", () => {
    assert.deepEqual(devGate(`1.0.1-dev.${run}`, heads({ beta: "1.0.0-beta.3" })).failures, [
      BASE_FAILURE("1.0.1"),
      SPAN_FAILURE("1.0.1", "1.0.0", "1.1.0、2.0.0"),
    ]);
    assert.deepEqual(devGate(`0.2.0-dev.${run}`, heads({ dev: "0.1.0-dev.41" })).failures, [BASE_FAILURE("0.2.0")]);
  });

  it("高于已发布的测试版与正式版时通过，不高于任一个时拒绝；为 null 的不比", () => {
    assert.deepEqual(devGate("1.1.0-dev.1", heads({ beta: "1.1.0-beta.1", stable: "1.0.1" })).failures, []);
    assert.deepEqual(devGate(`1.0.0-dev.${run}`, heads({ stable: "1.0.0" })).failures, [
      "本包 " + `1.0.0-dev.${run}` + " 不高于已发布的正式版 1.0.0（来源 hk）：预览版必须高于测试版与正式版",
    ]);
    assert.deepEqual(devGate("1.0.0-dev.70", heads({ dev: "1.0.0-dev.60", beta: "1.1.0-beta.1" })).failures, [
      "本包 1.0.0-dev.70 不高于已发布的测试版 1.1.0-beta.1（来源 release:v1.1.0-beta.1）：预览版必须高于测试版与正式版",
      SPAN_FAILURE("1.0.0", "1.1.0", "1.2.0、2.0.0"),
    ]);
    assert.deepEqual(devGate("1.0.0-dev.1", heads({})).failures, []);
  });

  it("核心号等于最高核心号或它的两种后继时通过", () => {
    const published = heads({ dev: "1.0.0-dev.60", beta: "1.0.0-beta.3" });
    for (const version of ["1.0.0-dev.61", "1.1.0-dev.61", "2.0.0-dev.61"]) assert.deepEqual(devGate(version, published).failures, [], version);
  });

  it("基础号多抬一格或手误成 1.10.0 时拒绝", () => {
    const published = heads({ dev: "1.0.0-dev.60", beta: "1.0.0-beta.3" });
    for (const core of ["1.10.0", "1.2.0", "3.0.0"]) {
      assert.deepEqual(devGate(`${core}-dev.61`, published).failures, [SPAN_FAILURE(core, "1.0.0", "1.1.0、2.0.0")], core);
    }
  });

  it("最高核心号取三个通道里最大的，含正式版补丁", () => {
    const published = heads({ dev: "1.1.0-dev.60", beta: "1.1.0-beta.1", stable: "1.0.1" });
    assert.deepEqual(devGate("1.1.0-dev.61", published).failures, []);
    assert.deepEqual(devGate("1.0.0-dev.61", published).failures, [
      "本包 1.0.0-dev.61 不高于已发布的测试版 1.1.0-beta.1（来源 release:v1.1.0-beta.1）：预览版必须高于测试版与正式版",
      "本包 1.0.0-dev.61 不高于已发布的正式版 1.0.1（来源 hk）：预览版必须高于测试版与正式版",
      SPAN_FAILURE("1.0.0", "1.1.0", "1.2.0、2.0.0"),
    ]);
  });

  it("从 0.1.0-dev.41 换到 1.0.0-dev.N 放行", () => {
    assert.deepEqual(devGate(`1.0.0-dev.${run}`, heads({ dev: "0.1.0-dev.41", beta: "1.0.0-beta.2" })), { failures: [], notices: [] });
    assert.deepEqual(devGate(`1.0.0-dev.${run}`, heads({ dev: "0.1.0-dev.41" })), { failures: [], notices: [] });
  });

  it("三个通道都没有发布过时不查跨度，打 notice", () => {
    assert.deepEqual(devGate("7.3.0-dev.1", heads({})), { failures: [], notices: ["三个通道都还没有发布过，不查基础号的跨度"] });
  });

  it("本包版本不是预览版的形状时是用法错误", () => {
    for (const version of ["1.0.0-beta.1", "1.0.0", "1.0.0-dev.01", "v1.0.0-dev.1"]) {
      assert.throws(() => devGate(version, heads({})), { message: `本包版本 ${JSON.stringify(version)} 不是预览版的形状 X.Y.Z-dev.N` });
    }
  });
});

describe("gate beta：测试版的版本先后", () => {
  it("低于预览版、核心号高于正式版、基础号形如 X.Y.0 时通过", () => {
    assert.deepEqual(betaGate("1.0.0-beta.4", heads({ dev: "1.0.0-dev.60", beta: "1.0.0-beta.3" })), { failures: [], notices: [] });
    assert.deepEqual(betaGate("1.1.0-beta.1", heads({ dev: "1.1.0-dev.61", stable: "1.0.1" })), { failures: [], notices: [] });
  });

  it("不低于已发布的预览版时拒绝", () => {
    assert.deepEqual(betaGate("1.1.0-beta.1", heads({ dev: "1.0.0-dev.60" })).failures, [
      "本包 1.1.0-beta.1 不低于已发布的预览版 1.0.0-dev.60（来源 hk）：测试版必须低于预览版",
    ]);
  });

  it("预览版没有验得过的发布时不比，打 notice", () => {
    assert.deepEqual(betaGate("1.0.0-beta.4", heads({})), { failures: [], notices: ["预览版还没有验得过的发布，不比本包是否低于预览版"] });
  });

  it("核心号不高于已发布的正式版时拒绝", () => {
    for (const stable of ["1.0.0", "1.0.1", "1.1.0"]) {
      assert.deepEqual(betaGate("1.0.0-beta.5", heads({ dev: "1.1.0-dev.3", stable })).failures, [
        `本包核心号 1.0.0 不高于已发布的正式版 ${stable}（来源 hk）：这个基础号已经出过正式版`,
      ]);
    }
  });

  it("基础号补丁段不为 0、主版本为 0 时拒绝，1.10.0 照样放行", () => {
    assert.deepEqual(betaGate("1.0.1-beta.1", heads({ dev: "1.1.0-dev.5" })).failures, [BASE_FAILURE("1.0.1")]);
    assert.deepEqual(betaGate("0.2.0-beta.1", heads({ dev: "1.0.0-dev.60" })).failures, [BASE_FAILURE("0.2.0")]);
    assert.deepEqual(betaGate("1.10.0-beta.1", heads({ dev: "1.10.0-dev.2", stable: "1.9.0" })).failures, []);
  });

  it("本包版本不是测试版的形状时是用法错误", () => {
    assert.throws(() => betaGate("1.0.0-dev.1", heads({})), { message: '本包版本 "1.0.0-dev.1" 不是测试版的形状 X.Y.Z-beta.N' });
  });
});

describe("gate 命令行", () => {
  function headsFile(value) {
    const path = tempPath("heads.json");
    writeFileSync(path, formatHeads(value));
    return path;
  }

  it("检查不过时逐条打 ::error:: 并以 1 退出", async () => {
    const harness = makeDeps();
    assert.equal(await main(["gate", "beta", "release", "1.1.0-beta.1", headsFile(heads({ dev: "1.0.0-dev.60", stable: "1.1.0" }))], harness.deps), 1);
    assert.deepEqual(harness.err, [
      "::error::本包 1.1.0-beta.1 不低于已发布的预览版 1.0.0-dev.60（来源 hk）：测试版必须低于预览版",
      "::error::本包核心号 1.1.0 不高于已发布的正式版 1.1.0（来源 hk）：这个基础号已经出过正式版",
    ]);
  });

  it("演练里检查不过只打 notice，以 0 退出", async () => {
    // 演练时 dev 还停在 0.1.0-dev.41，1.0.0-beta.0 必然不低于它
    const harness = makeDeps();
    assert.equal(await main(["gate", "beta", "rehearsal", "1.0.0-beta.0", headsFile(heads({ dev: "0.1.0-dev.41", beta: "1.0.0-beta.2" }))], harness.deps), 0);
    assert.deepEqual(harness.err, ["::notice::演练，不挡构建：本包 1.0.0-beta.0 不低于已发布的预览版 0.1.0-dev.41（来源 hk）：测试版必须低于预览版"]);
    assert.deepEqual(harness.out, []);
  });

  it("通过时以 0 退出，notice 照打", async () => {
    const harness = makeDeps();
    assert.equal(await main(["gate", "beta", "release", "1.0.0-beta.4", headsFile(heads({}))], harness.deps), 0);
    assert.deepEqual(harness.err, ["::notice::预览版还没有验得过的发布，不比本包是否低于预览版"]);
    assert.deepEqual(harness.out, ["版本先后检查通过：1.0.0-beta.4"]);
    const dev = makeDeps();
    assert.equal(await main(["gate", "dev", "release", "1.0.0-dev.58", headsFile(heads({ dev: "1.0.0-dev.57" }))], dev.deps), 0);
    assert.deepEqual(dev.err, []);
  });

  it("dev 没有演练模式，版本形状不对、参数个数不对都是用法错误，以 2 退出", async () => {
    const path = headsFile(heads({}));
    const cases = [
      [["gate", "dev", "rehearsal", "1.0.0-dev.1", path], "::error::dev 没有演练模式，只能传 release"],
      [["gate", "stable", "release", "1.0.0", path], '::error::通道只能是 dev 或 beta："stable"'],
      [["gate", "beta", "dry-run", "1.0.0-beta.1", path], '::error::模式只能是 release 或 rehearsal："dry-run"'],
      [["gate", "dev", "release", "1.0.0-beta.1", path], '::error::本包版本 "1.0.0-beta.1" 不是预览版的形状 X.Y.Z-dev.N'],
      [["gate", "dev", "release", "1.0.0-dev.1"], "::error::参数应为 4 个非空值，实际 3 个"],
    ];
    for (const [argv, message] of cases) {
      const harness = makeDeps();
      assert.equal(await main(argv, harness.deps), 2, argv.join(" "));
      assert.equal(harness.err[0], message);
      assert.match(harness.err[1], /^用法：/);
    }
  });

  it("heads 文件读不懂时以 1 退出", async () => {
    const path = tempPath("heads.json");
    writeFileSync(path, '{"dev":null}');
    const harness = makeDeps();
    assert.equal(await main(["gate", "dev", "release", "1.0.0-dev.1", path], harness.deps), 1);
    assert.deepEqual(harness.err, ["::error::heads 文件的键应恰好是 dev、beta、stable"]);
  });
});

describe("payload：核对安装包的载荷头", () => {
  const source = readFileSync(DATA_FORMAT_FILE, "utf8");
  const current = parseDataFormat(source, DATA_FORMAT_PATH);
  const version = `1.0.0-dev.${randomInt(42, 100_000)}`;
  const good = { version, magic: "PFSETUP2", headerVersion: version, dataFormat: String(current), caps: "1" };

  it("DATA_FORMAT 的正则在现有源码里恰好命中一行", () => {
    const hits = source.split(/\r?\n/).filter((line) => DATA_FORMAT_LINE.test(line));
    assert.equal(hits.length, 1);
    assert.equal(hits[0], `pub const DATA_FORMAT: u32 = ${current};`);
    assert.ok(Number.isSafeInteger(current) && current >= 1);
  });

  it("正则没命中、命中两行、写法变了都报错，不悄悄跳过", () => {
    const what = "样例";
    for (const [text, hits] of [
      ["", 0],
      ["pub const DATA_FORMAT: u32 = 0;\n", 0],
      ["pub const DATA_FORMAT: u64 = 2;\n", 0],
      ["    pub const DATA_FORMAT: u32 = 2;\n", 0],
      ["// pub const DATA_FORMAT: u32 = 2;\n", 0],
      ["pub const DATA_FORMAT: u32 = 2;\npub const DATA_FORMAT: u32 = 3;\n", 2],
    ]) {
      assert.throws(() => parseDataFormat(text, what), { message: `样例 里应恰好有一行 pub const DATA_FORMAT: u32 = <正整数>;，实际 ${hits} 行` }, JSON.stringify(text));
    }
    assert.equal(parseDataFormat("//! 说明\r\npub const DATA_FORMAT: u32 = 12;\r\n", what), 12);
    assert.throws(() => parseDataFormat("pub const DATA_FORMAT: u32 = 4294967296;\n", what), { message: "样例 里的 DATA_FORMAT 4294967296 超出 u32" });
  });

  it("四项都对时通过，caps 其他位不影响", () => {
    for (const caps of ["1", "3", "4294967295"]) assert.deepEqual(payloadFailures({ ...good, caps }, current), []);
  });

  it("四项各错一项都失败", () => {
    const cases = [
      [{ magic: "PFSETUP1" }, ["载荷头的 magic 是 PFSETUP1，应为 PFSETUP2"]],
      [{ headerVersion: "1.0.0-dev.41" }, [`载荷头里的版本是 1.0.0-dev.41，本包是 ${version}`]],
      [{ dataFormat: String(current + 1) }, [`载荷头的 data_format 是 ${current + 1}，源码里的 DATA_FORMAT 是 ${current}`]],
      [{ dataFormat: "0" }, [`载荷头的 data_format 是 0，源码里的 DATA_FORMAT 是 ${current}`]],
      [{ dataFormat: `0${current}` }, [`载荷头的 data_format 应是 u32 的十进制写法："0${current}"`]],
      [{ dataFormat: "4294967296" }, ['载荷头的 data_format 应是 u32 的十进制写法："4294967296"']],
      [{ caps: "0" }, ["载荷头的 caps 是 0，第 0 位不是 1：引导程序不认得换通道安装"]],
      [{ caps: "2" }, ["载荷头的 caps 是 2，第 0 位不是 1：引导程序不认得换通道安装"]],
      [{ caps: "0x1" }, ['载荷头的 caps 应是 u32 的十进制写法："0x1"']],
    ];
    for (const [change, failures] of cases) assert.deepEqual(payloadFailures({ ...good, ...change }, current), failures, JSON.stringify(change));
  });

  it("命令行按源码里的常量核对，失败逐条打 ::error:: 并以 1 退出", async () => {
    const passing = makeDeps();
    assert.equal(await main(["payload", version, "PFSETUP2", version, String(current), "1"], passing.deps), 0);
    assert.deepEqual(passing.out, [`载荷头核对通过：PFSETUP2\t${version}\t${current}\t1`]);
    assert.deepEqual(passing.err, []);
    // 旧引导程序读出来就是这样：PFSETUP1、包号 0、没有能力位
    const legacy = makeDeps();
    assert.equal(await main(["payload", version, "PFSETUP1", version, "0", "0"], legacy.deps), 1);
    assert.deepEqual(legacy.err, [
      "::error::载荷头的 magic 是 PFSETUP1，应为 PFSETUP2",
      `::error::载荷头的 data_format 是 0，源码里的 DATA_FORMAT 是 ${current}`,
      "::error::载荷头的 caps 是 0，第 0 位不是 1：引导程序不认得换通道安装",
    ]);
  });

  it("作为脚本运行时退出码照样传出去；没实现的子命令按不认识报错", () => {
    const pass = spawnSync(process.execPath, [SCRIPT, "payload", version, "PFSETUP2", version, String(current), "1"], { encoding: "utf8" });
    assert.equal(pass.status, 0, pass.stderr);
    const fail = spawnSync(process.execPath, [SCRIPT, "payload", version, "PFSETUP2", version, String(current), "2"], { encoding: "utf8" });
    assert.equal(fail.status, 1);
    assert.equal(fail.stderr, "::error::载荷头的 caps 是 2，第 0 位不是 1：引导程序不认得换通道安装\n");
    for (const command of ["floors", "picks", "verify"]) {
      const usage = spawnSync(process.execPath, [SCRIPT, command, "dev", "x"], { encoding: "utf8" });
      assert.equal(usage.status, 2, command);
      assert.match(usage.stderr, new RegExp(`^::error::不认识的子命令："${command}"\n用法：`));
    }
  });
});

// 测试用的 git 不读全局与系统配置：签名提交、钩子、默认分支名这些本机设置都不该影响结果
const GIT_CONFIG_EMPTY = join(root, "empty-gitconfig");
writeFileSync(GIT_CONFIG_EMPTY, "");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: GIT_CONFIG_EMPTY, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

function gitRunner(cwd) {
  return (args) => {
    const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
    if (result.error !== undefined) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
}

function git(cwd, ...args) {
  const result = gitRunner(cwd)(args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 以 ${result.status} 退出：${result.stderr}`);
  return result.stdout.trim();
}

const dataFormatSource = (value) => `//! 数据格式号。\n\n/// 做了旧版本读不了的落盘改动就把它加一。\npub const DATA_FORMAT: u32 = ${value};\n`;

describe("data-format：数据格式号不倒退与测试版的祖先判据（临时 git 仓库）", () => {
  const origin = join(root, "origin");
  const originUrl = pathToFileURL(origin).href;
  const commits = {};
  let nextClone = 0;

  function commit(message, files) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(origin, path)), { recursive: true });
      writeFileSync(join(origin, path), content);
      git(origin, "add", "--", path);
    }
    git(origin, "commit", "--quiet", "-m", message);
    return git(origin, "rev-parse", "HEAD");
  }

  before(() => {
    mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=dev");
    git(origin, "config", "user.name", "Release Heads Test");
    git(origin, "config", "user.email", "release-heads-test@example.invalid");
    // 按提交号浅取，GitHub 上是允许的
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");

    commits.d0 = commit("这套机制之前的提交", { "README.md": "落樱\n" });
    commits.d1 = commit("加入数据格式号", { [DATA_FORMAT_PATH]: dataFormatSource(1) });
    commits.d2 = commit("无关改动", { "README.md": "落樱 2\n" });
    git(origin, "checkout", "--quiet", "-b", "feature", commits.d2);
    commits.f1 = commit("数据格式号加一", { [DATA_FORMAT_PATH]: dataFormatSource(2) });
    git(origin, "checkout", "--quiet", "dev");
    git(origin, "merge", "--quiet", "--no-ff", "-m", "合并加号的特性分支", "feature");
    commits.d3 = git(origin, "rev-parse", "HEAD");
    commits.d4 = commit("dev 上的后续改动", { "README.md": "落樱 3\n" });

    // 晋级：beta 从上一个测试版的提交出发，把 dev 合并进来
    git(origin, "checkout", "--quiet", "-b", "beta-merge", commits.d2);
    git(origin, "merge", "--quiet", "--no-ff", "-m", "晋级", "dev");
    commits.promoted = git(origin, "rev-parse", "HEAD");
    // 把 dev 上的加号提交单独摘进 beta
    git(origin, "checkout", "--quiet", "-b", "beta-pick", commits.d2);
    git(origin, "cherry-pick", "-x", commits.f1);
    commits.picked = git(origin, "rev-parse", "HEAD");
    // beta 上自己加了一个 dev 上从没有过的号
    git(origin, "checkout", "--quiet", "-b", "beta-unknown", commits.d2);
    commits.unknown = commit("beta 上自己加号", { [DATA_FORMAT_PATH]: dataFormatSource(3) });
    // 晋级之后把号退回去
    git(origin, "checkout", "--quiet", "-b", "beta-revert", commits.promoted);
    commits.betaReverted = commit("退回数据格式号", { [DATA_FORMAT_PATH]: dataFormatSource(1) });
    git(origin, "checkout", "--quiet", "-b", "dev-revert", commits.d4);
    commits.devReverted = commit("退回数据格式号", { [DATA_FORMAT_PATH]: dataFormatSource(1) });
    git(origin, "checkout", "--quiet", "dev");

    // 附注 tag：ls-remote 要剥到它所指的提交
    git(origin, "tag", "-a", "-m", "测试版 0", "v1.0.0-beta.0", commits.d0);
    git(origin, "tag", "v1.0.0-beta.1", commits.d2);
    git(origin, "tag", "v1.0.0-beta.2", commits.promoted);
  });

  function setDevBuild(commit) {
    git(origin, "tag", "--force", DEV_RELEASE_TAG, commit);
  }

  function dropDevBuild() {
    if (git(origin, "tag", "--list", DEV_RELEASE_TAG) !== "") git(origin, "tag", "--delete", DEV_RELEASE_TAG);
  }

  // CI 里 checkout 是深度 1 的浅仓库，这里照样浅克隆
  function cloneAt(branch) {
    const dir = join(root, `clone-${nextClone++}`);
    git(root, "clone", "--quiet", "--depth=1", "--branch", branch, originUrl, dir);
    assert.equal(git(dir, "rev-parse", "--is-shallow-repository"), "true");
    return dir;
  }

  async function dataFormat(branch, channel, beta, mode = "release") {
    const clone = cloneAt(branch);
    const headsPath = tempPath("heads.json");
    writeFileSync(headsPath, formatHeads(heads({ dev: "1.0.0-dev.57", beta })));
    const outputPath = tempPath("github-output");
    writeFileSync(outputPath, "");
    const remote = (repo) => {
      assert.equal(repo, REPO);
      return originUrl;
    };
    const harness = makeDeps({ git: gitRunner(clone), remote, env: { GITHUB_OUTPUT: outputPath } });
    const code = await main(["data-format", channel, mode, headsPath, REPO], harness.deps);
    return { code, err: harness.err, output: readFileSync(outputPath, "utf8"), clone };
  }

  const backwards = (current, previous) =>
    `本提交的数据格式号 ${current} 小于上一次发布的 ${previous}：号只能随加号的提交往上走，回退掉加号的提交会让旧数据被当成新格式读`;

  it("dev：不小于 dev-build 所指提交里的号时通过", async () => {
    setDevBuild(commits.d3);
    const { code, err, output } = await dataFormat("dev", "dev");
    assert.deepEqual({ code, err, output }, { code: 0, err: [], output: "data-format=2\nprevious-data-format=2\n" });
  });

  it("dev：小于 dev-build 所指提交里的号时失败", async () => {
    setDevBuild(commits.d4);
    const { code, err, output } = await dataFormat("dev-revert", "dev");
    assert.deepEqual({ code, err, output }, { code: 1, err: [`::error::${backwards(1, 2)}`], output: "data-format=1\nprevious-data-format=2\n" });
  });

  it("dev：dev-build 不存在、或所指提交里还没有 data_format.rs 时跳过并打 notice", async () => {
    dropDevBuild();
    const missing = await dataFormat("dev-revert", "dev");
    assert.deepEqual(
      { code: missing.code, err: missing.err, output: missing.output },
      { code: 0, err: [`::notice::远端没有 tag ${DEV_RELEASE_TAG}，不查数据格式号是否倒退`], output: "data-format=1\nprevious-data-format=skipped\n" },
    );
    setDevBuild(commits.d0);
    const early = await dataFormat("dev-revert", "dev");
    assert.deepEqual(
      { code: early.code, err: early.err, output: early.output },
      {
        code: 0,
        err: [`::notice::tag ${DEV_RELEASE_TAG} 所指的提交 ${commits.d0} 里还没有 ${DATA_FORMAT_PATH}，不查数据格式号是否倒退`],
        output: "data-format=1\nprevious-data-format=skipped\n",
      },
    );
  });

  it("beta：经晋级合并带进来的号通过，浅仓库被补全", async () => {
    const { code, err, output, clone } = await dataFormat("beta-merge", "beta", "1.0.0-beta.1");
    assert.deepEqual({ code, err, output }, { code: 0, err: [], output: "data-format=2\nprevious-data-format=1\n" });
    assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "false");
  });

  it("beta：dev 上的加号提交被单独摘进来时失败，指出 dev 第一父链上加号的那个合并提交", async () => {
    const { code, err, output } = await dataFormat("beta-pick", "beta", "1.0.0-beta.1");
    assert.deepEqual(
      { code, err, output },
      {
        code: 1,
        err: [`::error::dev 上把数据格式号改成 2 的提交 ${commits.d3} 不是 HEAD 的祖先：加号的提交只能随晋级合并进入测试版，不能单独摘进来`],
        output: "data-format=2\nprevious-data-format=1\n",
      },
    );
  });

  it("beta：dev 上找不到把号改成这个值的提交时失败", async () => {
    const { code, err } = await dataFormat("beta-unknown", "beta", "1.0.0-beta.1");
    assert.deepEqual({ code, err }, { code: 1, err: ["::error::dev 的第一父链上没有哪个提交把数据格式号改成 3：测试版只能拿 dev 上已有的号"] });
  });

  it("beta：小于上一个测试版所指提交里的号时失败", async () => {
    const { code, err, output } = await dataFormat("beta-revert", "beta", "1.0.0-beta.2");
    assert.deepEqual({ code, err, output }, { code: 1, err: [`::error::${backwards(1, 2)}`], output: "data-format=1\nprevious-data-format=2\n" });
  });

  it("beta：上一个测试版的 tag 不存在、所指提交里还没有 data_format.rs、或还没有测试版时跳过并打 notice", async () => {
    const early = await dataFormat("beta-merge", "beta", "1.0.0-beta.0");
    assert.deepEqual(
      { code: early.code, err: early.err, output: early.output },
      {
        code: 0,
        err: [`::notice::tag v1.0.0-beta.0 所指的提交 ${commits.d0} 里还没有 ${DATA_FORMAT_PATH}，不查数据格式号是否倒退`],
        output: "data-format=2\nprevious-data-format=skipped\n",
      },
    );
    const missing = await dataFormat("beta-merge", "beta", "1.0.0-beta.7");
    assert.deepEqual(missing.err, ["::notice::远端没有 tag v1.0.0-beta.7，不查数据格式号是否倒退"]);
    assert.equal(missing.code, 0);
    const none = await dataFormat("beta-merge", "beta", null);
    assert.deepEqual(
      { code: none.code, err: none.err, output: none.output },
      { code: 0, err: ["::notice::测试版还没有验得过的发布，不查数据格式号是否倒退"], output: "data-format=2\nprevious-data-format=skipped\n" },
    );
  });

  it("演练里两条检查不过都只打 notice，以 0 退出", async () => {
    const picked = await dataFormat("beta-pick", "beta", "1.0.0-beta.1", "rehearsal");
    assert.deepEqual(
      { code: picked.code, err: picked.err },
      {
        code: 0,
        err: [`::notice::演练，不挡构建：dev 上把数据格式号改成 2 的提交 ${commits.d3} 不是 HEAD 的祖先：加号的提交只能随晋级合并进入测试版，不能单独摘进来`],
      },
    );
    const reverted = await dataFormat("beta-revert", "beta", "1.0.0-beta.2", "rehearsal");
    assert.deepEqual({ code: reverted.code, err: reverted.err }, { code: 0, err: [`::notice::演练，不挡构建：${backwards(1, 2)}`] });
  });

  it("取不到提交是读取出错，演练里照样失败", async () => {
    const clone = cloneAt("beta-merge");
    const headsPath = tempPath("heads.json");
    writeFileSync(headsPath, formatHeads(heads({ beta: "1.0.0-beta.1" })));
    const harness = makeDeps({ git: gitRunner(clone), remote: () => pathToFileURL(join(root, "no-such-origin")).href });
    assert.equal(await main(["data-format", "beta", "rehearsal", headsPath, REPO], harness.deps), 1);
    assert.equal(harness.err.length, 1);
    assert.match(harness.err[0], /^::error::git ls-remote --tags file:\/\/.*no-such-origin 以 128 退出：/);
  });
});

// 下面几条约定横跨启动器的 Rust 源码与两条流水线。两侧的测试各自只看得到自己那一边：Rust 的测试只在本地跑，
// 工作流的契约测试不读 Rust。两边各改各的时每一侧的测试都照样通过，坏在发出去的包上，所以在这里对拍。
// 读 Rust 源码一律按常量名、函数名找定义，不依赖行号与周围的代码。
const KEY_TABLE_RS = "app/src-tauri/src/commands/update_channels.rs";
const UPDATER_RS = "app/src-tauri/src/commands/updater.rs";
const BRAND_RS = "crates/petalfall-base/src/brand.rs";
const TAURI_CONF = "app/src-tauri/tauri.conf.json";
const PIPELINES = { dev: ".github/workflows/dev-build.yml", beta: ".github/workflows/beta-release.yml" };
const CHANNEL_LABELS = { dev: "预览版", beta: "测试版", stable: "正式版" };
const ENDPOINT_CONSTS = { dev: "DEV_ENDPOINT", beta: "BETA_ENDPOINT", stable: "PRIMARY_ENDPOINT" };

const readRepoText = (path) => readFileSync(join(REPO_ROOT, path), "utf8").replace(/\r\n/g, "\n");

// 测试模块里也会写同样的常量与字面量，编进包里的只有它之前的那一段
function nonTestSource(path) {
  const text = readRepoText(path);
  const tests = /^#\[cfg\(test\)\]\n(?:pub(?:\([^)]*\))? )?mod \w+ \{/m.exec(text);
  return tests === null ? text : text.slice(0, tests.index);
}

const STR_CONST = (name) => new RegExp(`^[ \\t]*(?:pub(?:\\([^)]*\\))?[ \\t]+)?const[ \\t]+${name}[ \\t]*:[ \\t]*&(?:'static[ \\t]+)?str[ \\t]*=[ \\t]*([\\s\\S]*?);[ \\t]*$`, "gm");

function constDefinition(path, name) {
  const found = [...nonTestSource(path).matchAll(STR_CONST(name))];
  assert.equal(found.length, 1, `${path} 的非测试代码里应恰好有一处 const ${name}: &str = …;，实际 ${found.length} 处`);
  return found[0][1].trim();
}

function rustLiteral(token, where) {
  const match = /^"([^"\\]*)"$/.exec(token);
  assert.notEqual(match, null, `${where} 里的 ${token} 不是不带转义的字符串字面量，这里还原不了它的值`);
  return match[1];
}

// brand.rs 里 app_slug! 宏展开成的那个字面量
function appSlug() {
  const found = [...readRepoText(BRAND_RS).matchAll(/macro_rules!\s*app_slug\s*\{\s*\(\)\s*=>\s*\{\s*("[^"]*")\s*;?\s*\}\s*;?\s*\}/g)];
  assert.equal(found.length, 1, `${BRAND_RS} 里应恰好有一个只展开成字符串字面量的 app_slug! 宏，实际 ${found.length} 个`);
  return rustLiteral(found[0][1], BRAND_RS);
}

// 把 const X: &str = concat!(…) 或直接写的字面量还原成编译后的整串；concat! 只认字符串字面量与 app_slug!()
function rustStr(path, name) {
  const expression = constDefinition(path, name);
  const concat = /^concat!\(([\s\S]*)\)$/.exec(expression);
  if (concat === null) return rustLiteral(expression, `${path} 的 ${name}`);
  return concat[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => (/^(?:(?:::)?petalfall_base::)?app_slug!\(\)$/.test(part) ? appSlug() : rustLiteral(part, `${path} 的 ${name}`)))
    .join("");
}

// 钥表：每个通道编进的是仓库里的哪个文件（仓库相对路径）。include_str! 的相对路径按源文件所在目录解析。
function keyTable() {
  const source = nonTestSource(KEY_TABLE_RS);
  const includes = [...source.matchAll(/include_str!\("([^"]*)"\)/g)].map((match) => match[1]);
  const resolved = includes.map((path) => posix.normalize(posix.join(posix.dirname(KEY_TABLE_RS), path)));
  const expected = [".github/dev-updater.pub", ".github/release-updater.pub"];
  assert.deepEqual(
    [...resolved].sort(),
    expected,
    `${KEY_TABLE_RS} 的非测试代码里应恰好有两行 include_str!，各编进 ${expected.join(" 与 ")} 一次，实际是 ${JSON.stringify(includes)}`,
  );
  const files = new Map();
  for (const path of includes) {
    const owners = [...source.matchAll(STR_CONST("(\\w+)"))].filter((match) => match[2].trim() === `include_str!("${path}")`);
    assert.equal(owners.length, 1, `${KEY_TABLE_RS} 里 include_str!("${path}") 应恰好是一个 const 的值`);
    files.set(owners[0][1], posix.normalize(posix.join(posix.dirname(KEY_TABLE_RS), path)));
  }
  const body = /fn channel_pubkey\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
  assert.notEqual(body, null, `${KEY_TABLE_RS} 里找不到 fn channel_pubkey`);
  const table = {};
  for (const [, variants, constant] of body[1].matchAll(/((?:Channel::\w+\s*\|\s*)*Channel::\w+)\s*=>\s*(\w+)/g)) {
    assert.ok(files.has(constant), `channel_pubkey 的分支 ${variants} 用的 ${constant} 不是钥表里 include_str! 编进的常量`);
    for (const [, variant] of variants.matchAll(/Channel::(\w+)/g)) table[variant.toLowerCase()] = files.get(constant);
  }
  return table;
}

// 工作流里真正执行的、注入插件配置的那一行，与它读的公钥文件（按那一步的 working-directory 解析成仓库相对路径）。
// 写法是否解析得了由两份契约测试把关，这里只借解析结果切出执行的行与步骤，所以不传 flow 白名单、不看 problems。
function injection(path) {
  const lines = parseWorkflow(readRepoText(path), []).lines;
  const owners = jobNames(lines).filter((name) => job(lines, name).some((line) => line.includes("conf.plugins")));
  assert.equal(owners.length, 1, `${path} 里应恰好有一个作业注入插件配置，实际 ${JSON.stringify(owners)}`);
  const found = steps(lines, owners[0]).flatMap((step) => codeOf(step).filter((line) => line.includes("conf.plugins")).map((line) => ({ step, line })));
  assert.equal(found.length, 1, `${path} 里注入插件配置的行应恰好一处，实际 ${found.length} 处`);
  const { step, line } = found[0];
  const reads = [...line.matchAll(/readFileSync\('([^']*)'/g)].map((match) => match[1]);
  assert.equal(reads.length, 1, `${path} 的注入行应恰好读一个公钥文件：${line}`);
  const workdir = stepKeys(step)
    .map((key) => /^working-directory:\s*(\S+)$/.exec(key))
    .find((match) => match !== null);
  const base = workdir === undefined ? "" : workdir[1];
  return { line, file: posix.normalize(posix.join(base, reads[0])), code: codeOf(lines) };
}

describe("启动器与流水线两侧对拍", () => {
  it("钥表两行 include_str! 编进的正是仓库里的两个 .pub：预览版用 dev 钥，测试版与正式版用发布钥", () => {
    const table = keyTable();
    assert.deepEqual(
      table,
      { dev: ".github/dev-updater.pub", beta: ".github/release-updater.pub", stable: ".github/release-updater.pub" },
      `钥表给各通道的公钥文件是 ${JSON.stringify(table)}：预览版要用 dev 钥，测试版与正式版共用发布钥，拿错一把验跟随来的包就全对不上`,
    );
  });

  it("两条流水线注入插件配置的公钥文件，就是钥表给本包通道的那一个", () => {
    const table = keyTable();
    for (const [channel, path] of Object.entries(PIPELINES)) {
      const { file } = injection(path);
      assert.equal(
        file,
        table[channel],
        `${path} 给${CHANNEL_LABELS[channel]}包注入的公钥是 ${file}，钥表给${CHANNEL_LABELS[channel]}的是 ${table[channel]}：` +
          "判定能不能自更新要求注入的那把等于钥表里本包通道的那一把，两处不一致时官方包会被判成不支持自更新",
      );
    }
  });

  it("release-heads 验各通道清单用的公钥文件与钥表一致", () => {
    const table = keyTable();
    for (const channel of Object.keys(CHANNEL_LABELS)) {
      assert.equal(
        PUBKEY_FILES[channel],
        table[channel],
        `release-heads 验${CHANNEL_LABELS[channel]}清单用的是 ${PUBKEY_FILES[channel]}，钥表给${CHANNEL_LABELS[channel]}的是 ${table[channel]}：` +
          "流水线采信的版本必须是客户端用同一把钥验得过的版本，否则版本闸比的不是用户能收到的那些",
      );
    }
  });

  it("tauri.conf.json 与两条流水线的注入行都不含 installerArgs", () => {
    // 更新插件构造每个检查器时都把 installerArgs 从配置抄进去：配置里一旦有它，自动检查的检查器也会带着它拉起安装程序，
    // 只该由换通道安装带上的参数就混进了普通更新
    assert.ok(!readRepoText(TAURI_CONF).includes("installerArgs"), `${TAURI_CONF} 里出现了 installerArgs，普通更新也会带着它拉起安装程序`);
    for (const path of Object.values(PIPELINES)) {
      const { line, code } = injection(path);
      assert.ok(!line.includes("installerArgs"), `${path} 的注入行写进了 installerArgs，普通更新也会带着它拉起安装程序：${line}`);
      const executed = code.filter((text) => text.includes("installerArgs"));
      assert.deepEqual(executed, [], `${path} 里有真正执行的行提到 installerArgs，可能另外往插件配置里写了它`);
    }
  });

  it("release-heads 读的三份香港清单地址就是启动器编译进去的那三个", () => {
    assert.deepEqual(Object.keys(HK_MANIFEST_URLS).sort(), Object.keys(ENDPOINT_CONSTS).sort());
    for (const [channel, name] of Object.entries(ENDPOINT_CONSTS)) {
      const client = rustStr(UPDATER_RS, name);
      assert.equal(
        HK_MANIFEST_URLS[channel],
        client,
        `release-heads 读的${CHANNEL_LABELS[channel]}香港清单是 ${HK_MANIFEST_URLS[channel]}，${UPDATER_RS} 的 ${name} 是 ${client}：` +
          "流水线核对的必须是客户端正在读的那一份，否则验过的版本不是用户看到的版本",
      );
    }
  });

  it("release-heads 读的滚动预发布 tag 就是启动器的 DEV_RELEASE_TAG", () => {
    const client = rustStr(UPDATER_RS, "DEV_RELEASE_TAG");
    assert.equal(
      DEV_RELEASE_TAG,
      client,
      `release-heads 读的滚动预发布 tag 是 ${DEV_RELEASE_TAG}，${UPDATER_RS} 的 DEV_RELEASE_TAG 是 ${client}：` +
        "客户端在 GitHub 上找的 dev 清单就挂在这个 tag 下，读别的 tag 会漏看客户端拿得到的版本",
    );
  });
});
