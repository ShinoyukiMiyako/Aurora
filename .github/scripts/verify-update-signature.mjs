// 发布前按仓库里的公钥把更新包签名完整验一遍，和启动器里更新插件验的是同一件事；
// 另外核对可信注释里签的版本和文件名。CLI 漏传 --app-version 只打警告照样签，这里是唯一的硬闸。
// 用法：node verify-update-signature.mjs <公钥文件> <更新包> <签名文件> <期望版本>
// 公钥文件与签名文件都是 tauri 的格式：base64 包着 minisign 的文本。
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = "用法：verify-update-signature.mjs <公钥文件> <更新包> <签名文件> <期望版本>";
const TRUSTED_PREFIX = "trusted comment: ";

// 按 \r?\n 切，和插件解码时用的 str::lines 一致
const unwrap = (path) => Buffer.from(readFileSync(path, "utf8").trim(), "base64").toString("utf8").split(/\r?\n/);

function lineAt(lines, index, what) {
  const line = lines[index];
  if (line === undefined) throw new Error(`${what}缺第 ${index + 1} 行，只有 ${lines.length} 行`);
  return line;
}

// 可信注释是 tab 分隔的 key:value。插件遇到重复的键只认第一个，这里要求恰好一个，免得两边读出不同的值。
function requireField(trusted, key, expected) {
  const prefix = `${key}:`;
  const values = trusted
    .split("\t")
    .filter((field) => field.startsWith(prefix))
    .map((field) => field.slice(prefix.length));
  if (values.length !== 1) throw new Error(`可信注释里应有恰好一个 ${key} 字段，实际 ${values.length} 个：${trusted}`);
  if (values[0] !== expected) throw new Error(`签名里的 ${key} 是 ${values[0]}，应为 ${expected}`);
}

export function verifyUpdateSignature(pubkeyPath, filePath, signaturePath, expectedVersion) {
  for (const arg of [pubkeyPath, filePath, signaturePath, expectedVersion]) {
    if (typeof arg !== "string" || arg === "") throw new Error(USAGE);
  }

  // 公钥：算法 Ed（2 字节）+ 密钥号（8 字节）+ Ed25519 公钥（32 字节）
  const pubkey = Buffer.from(lineAt(unwrap(pubkeyPath), 1, "公钥").trim(), "base64");
  if (pubkey.length !== 42 || pubkey.subarray(0, 2).toString() !== "Ed") throw new Error(`公钥格式不对：${pubkey.length} 字节`);
  const keyNumber = pubkey.subarray(2, 10);
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pubkey.subarray(10).toString("base64url") }, format: "jwk" });

  // 签名：算法（ED 为先做 BLAKE2b-512 摘要）+ 密钥号 + 64 字节签名；第三、四行是可信注释和对它的全局签名
  const lines = unwrap(signaturePath);
  const signature = Buffer.from(lineAt(lines, 1, "签名").trim(), "base64");
  const algorithm = signature.subarray(0, 2).toString();
  if (signature.length !== 74 || (algorithm !== "ED" && algorithm !== "Ed")) throw new Error(`签名格式不对：${signature.length} 字节，算法 ${algorithm}`);
  if (!signature.subarray(2, 10).equals(keyNumber)) {
    throw new Error(`签名用的密钥号 ${signature.subarray(2, 10).toString("hex")} 和公钥的 ${keyNumber.toString("hex")} 不是一对：私钥配错了`);
  }

  const data = readFileSync(filePath);
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, key, signature.subarray(10))) throw new Error("更新包签名验证失败");

  // 插件缺这个前缀直接判签名无效，这里同样拒绝，不把整行当注释去验
  const trustedLine = lineAt(lines, 2, "签名");
  if (!trustedLine.startsWith(TRUSTED_PREFIX)) throw new Error(`签名第 3 行不是可信注释：${trustedLine}`);
  const trusted = trustedLine.slice(TRUSTED_PREFIX.length);
  const globalSignature = Buffer.from(lineAt(lines, 3, "签名").trim(), "base64");
  if (!verify(null, Buffer.concat([signature.subarray(10), Buffer.from(trusted, "utf8")]), key, globalSignature)) {
    throw new Error("可信注释的签名验证失败");
  }

  // 全局签名验过之后可信注释才可信，版本和文件名只能在这之后读
  requireField(trusted, "version", expectedVersion);
  requireField(trusted, "file", basename(filePath));

  return { keyNumber: keyNumber.toString("hex"), trusted };
}

// 按 node 定位入口的同一套解析（realpath 后转 URL）比较：判不出是入口时脚本什么都不做却退出 0，硬闸就成了摆设。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4) throw new Error(USAGE);
  const { keyNumber, trusted } = verifyUpdateSignature(...args);
  console.log(`签名有效：密钥号 ${keyNumber}，${trusted}`);
}
