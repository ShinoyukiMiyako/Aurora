import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomInt, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { verifyUpdateSignature } from "./verify-update-signature.mjs";

const SCRIPT = fileURLToPath(new URL("./verify-update-signature.mjs", import.meta.url));
const RUN = randomInt(2, 100_000);
const VERSION = `0.${randomInt(0, 50)}.${randomInt(0, 50)}-dev.${RUN}`;
// 降级攻击真正会用的组合：上一个合法包的签名，配上这次的版本号
const PREVIOUS_VERSION = VERSION.replace(/\d+$/, String(RUN - 1));
const FILE_NAME = `Petalfall-Installer-${VERSION}-x64.exe`;

const root = mkdtempSync(join(tmpdir(), "verify-update-signature-"));
after(() => rmSync(root, { recursive: true, force: true }));

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { keyId: randomBytes(8), raw: Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"), privateKey };
}

const key = keypair();

function otherKeyId() {
  for (;;) {
    const id = randomBytes(8);
    if (!id.equals(key.keyId)) return id;
  }
}

const wrap = (text) => Buffer.from(text, "utf8").toString("base64");

// 与 tauri signer generate 写出的 .pub 同构：base64 包着两行 minisign 公钥文本
function pubkeyText(keyId, raw) {
  const bin = Buffer.concat([Buffer.from("Ed"), keyId, raw]);
  return wrap(`untrusted comment: minisign public key: ${keyId.toString("hex").toUpperCase()}\n${bin.toString("base64")}\n`);
}

// 与 tauri signer sign 写出的 .sig 同构：ED 先对文件做 BLAKE2b-512 预哈希，
// 全局签名覆盖「64 字节文件签名 + 可信注释」。trustedLine 用来模拟签完之后被改写的第三行。
function signatureText(data, trusted, { signer = key, keyId = signer.keyId, trustedLine = `trusted comment: ${trusted}` } = {}) {
  const fileSignature = sign(null, createHash("blake2b512").update(data).digest(), signer.privateKey);
  const globalSignature = sign(null, Buffer.concat([fileSignature, Buffer.from(trusted, "utf8")]), signer.privateKey);
  const bin = Buffer.concat([Buffer.from("ED"), keyId, fileSignature]);
  return wrap(`untrusted comment: signature from tauri secret key\n${bin.toString("base64")}\n${trustedLine}\n${globalSignature.toString("base64")}\n`);
}

const comment = (...fields) => [`timestamp:${randomInt(1_700_000_000, 2_000_000_000)}`, ...fields].join("\t");

let nextCase = 0;

// 每个用例一个目录：file 字段比的是 basename，更新包必须叫 FILE_NAME
function fixture({ trusted, signed = randomBytes(randomInt(1, 4096)), shipped = signed, ...options }) {
  const dir = join(root, String(nextCase++));
  mkdirSync(dir);
  const paths = { pub: join(dir, "dev-updater.pub"), file: join(dir, FILE_NAME), sig: join(dir, `${FILE_NAME}.sig`) };
  writeFileSync(paths.pub, pubkeyText(key.keyId, key.raw));
  writeFileSync(paths.file, shipped);
  writeFileSync(paths.sig, signatureText(signed, trusted, options));
  return paths;
}

const check = ({ pub, file, sig }, version = VERSION) => verifyUpdateSignature(pub, file, sig, version);

describe("verifyUpdateSignature", () => {
  it("签名有效且版本、文件名都对得上时通过，返回密钥号和可信注释", () => {
    const trusted = comment(`file:${FILE_NAME}`, `version:${VERSION}`);
    assert.deepEqual(check(fixture({ trusted })), { keyNumber: key.keyId.toString("hex"), trusted });
  });

  it("可信注释里没有 version 时拒绝：旧 CLI 或漏传 --app-version 签出来的就是这样", () => {
    const paths = fixture({ trusted: comment(`file:${FILE_NAME}`) });
    assert.throws(() => check(paths), /恰好一个 version 字段，实际 0 个/);
  });

  it("签的版本和期望版本不一致时拒绝", () => {
    for (const signedVersion of [PREVIOUS_VERSION, `${VERSION}0`, `v${VERSION}`, ""]) {
      const paths = fixture({ trusted: comment(`file:${FILE_NAME}`, `version:${signedVersion}`) });
      assert.throws(
        () => check(paths),
        (err) => err.message === `签名里的 version 是 ${signedVersion}，应为 ${VERSION}`,
        `签的是 ${JSON.stringify(signedVersion)}`,
      );
    }
  });

  it("version 字段出现两次时拒绝，哪怕其中一个就是期望版本", () => {
    for (const versions of [
      [VERSION, PREVIOUS_VERSION],
      [PREVIOUS_VERSION, VERSION],
    ]) {
      const paths = fixture({ trusted: comment(`file:${FILE_NAME}`, ...versions.map((v) => `version:${v}`)) });
      assert.throws(() => check(paths), /恰好一个 version 字段，实际 2 个/);
    }
  });

  it("签完之后改写可信注释时全局签名失败，即使改成的版本完全正确", () => {
    const paths = fixture({
      trusted: comment(`file:${FILE_NAME}`, `version:${PREVIOUS_VERSION}`),
      trustedLine: `trusted comment: ${comment(`file:${FILE_NAME}`, `version:${VERSION}`)}`,
    });
    assert.throws(() => check(paths), { message: "可信注释的签名验证失败" });
  });

  it("签名里的密钥号和公钥不一致时拒绝，哪怕签名本身是这把私钥签的", () => {
    const keyId = otherKeyId();
    const paths = fixture({ trusted: comment(`file:${FILE_NAME}`, `version:${VERSION}`), keyId });
    assert.throws(() => check(paths), {
      message: `签名用的密钥号 ${keyId.toString("hex")} 和公钥的 ${key.keyId.toString("hex")} 不是一对：私钥配错了`,
    });
  });

  it("可信注释里的 file 不是被验文件的文件名时拒绝", () => {
    const other = `Petalfall-Installer-${PREVIOUS_VERSION}-x64.exe`;
    const paths = fixture({ trusted: comment(`file:${other}`, `version:${VERSION}`) });
    assert.throws(() => check(paths), { message: `签名里的 file 是 ${other}，应为 ${FILE_NAME}` });
  });

  it("可信注释里没有 file 时拒绝", () => {
    const paths = fixture({ trusted: comment(`version:${VERSION}`) });
    assert.throws(() => check(paths), /恰好一个 file 字段，实际 0 个/);
  });

  it("发出去的字节和签名时的不同时拒绝", () => {
    const signed = randomBytes(randomInt(1, 4096));
    const shipped = Buffer.from(signed);
    shipped[randomInt(0, shipped.length)] ^= 0xff;
    const paths = fixture({ trusted: comment(`file:${FILE_NAME}`, `version:${VERSION}`), signed, shipped });
    assert.throws(() => check(paths), { message: "更新包签名验证失败" });
  });

  it("密钥号对得上但换了一把私钥签时拒绝", () => {
    const impostor = { ...keypair(), keyId: key.keyId };
    const paths = fixture({ trusted: comment(`file:${FILE_NAME}`, `version:${VERSION}`), signer: impostor });
    assert.throws(() => check(paths), { message: "更新包签名验证失败" });
  });

  it("第三行缺 trusted comment 前缀时拒绝，不把整行当可信注释", () => {
    const trusted = comment(`file:${FILE_NAME}`, `version:${VERSION}`);
    const paths = fixture({ trusted, trustedLine: trusted });
    assert.throws(() => check(paths), /签名第 3 行不是可信注释/);
  });

  it("没给期望版本时拒绝", () => {
    const { pub, file, sig } = fixture({ trusted: comment(`file:${FILE_NAME}`, `version:${VERSION}`) });
    for (const version of [undefined, ""]) {
      assert.throws(() => verifyUpdateSignature(pub, file, sig, version), /^Error: 用法：/);
    }
  });
});

describe("命令行入口", () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  it("验过时退出 0 并打印可信注释", () => {
    const trusted = comment(`file:${FILE_NAME}`, `version:${VERSION}`);
    const { pub, file, sig } = fixture({ trusted });
    const result = run(pub, file, sig, VERSION);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `签名有效：密钥号 ${key.keyId.toString("hex")}，${trusted}\n`);
  });

  it("版本不符时退出非 0", () => {
    const { pub, file, sig } = fixture({ trusted: comment(`file:${FILE_NAME}`, `version:${PREVIOUS_VERSION}`) });
    const result = run(pub, file, sig, VERSION);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`签名里的 version 是 ${PREVIOUS_VERSION.replaceAll(".", "\\.")}`));
    assert.equal(result.stdout, "");
  });

  it("参数不是恰好四个时退出非 0 并提示用法：工作流漏传版本号不能被当成验过", () => {
    const { pub, file, sig } = fixture({ trusted: comment(`file:${FILE_NAME}`, `version:${VERSION}`) });
    for (const args of [
      [pub, file, sig],
      [pub, file, sig, VERSION, VERSION],
    ]) {
      const result = run(...args);
      assert.notEqual(result.status, 0, `${args.length} 个参数`);
      assert.match(result.stderr, /用法：/);
      assert.equal(result.stdout, "");
    }
  });
});
