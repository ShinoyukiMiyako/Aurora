import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEV_RELEASE_TAG,
  FETCH_RETRIES,
  HK_MANIFEST_URLS,
  MAX_MANIFEST_BYTES,
  RETRY_DELAY_MS,
  channelShapeOf,
  compareVersions,
  formatHeads,
  main,
  parseHeads,
  readHeads,
  releaseManifestUrl,
} from "./release-heads.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
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
