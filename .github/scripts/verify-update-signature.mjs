// 发布前按仓库里的公钥把更新包签名完整验一遍，和启动器里更新插件验的是同一件事。
// 用法：node verify-update-signature.mjs <公钥文件> <更新包> <签名文件>
// 公钥文件与签名文件都是 tauri 的格式：base64 包着 minisign 的文本。
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [pubkeyPath, filePath, signaturePath] = process.argv.slice(2);
if (signaturePath === undefined) throw new Error("用法：verify-update-signature.mjs <公钥文件> <更新包> <签名文件>");

const unwrap = (path) => Buffer.from(readFileSync(path, "utf8").trim(), "base64").toString("utf8").split("\n");

// 公钥：算法 Ed（2 字节）+ 密钥号（8 字节）+ Ed25519 公钥（32 字节）
const pubkey = Buffer.from(unwrap(pubkeyPath)[1].trim(), "base64");
if (pubkey.length !== 42 || pubkey.subarray(0, 2).toString() !== "Ed") throw new Error(`公钥格式不对：${pubkey.length} 字节`);
const keyNumber = pubkey.subarray(2, 10);
const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pubkey.subarray(10).toString("base64url") }, format: "jwk" });

// 签名：算法（ED 为先做 BLAKE2b-512 摘要）+ 密钥号 + 64 字节签名；第三、四行是可信注释和对它的全局签名
const lines = unwrap(signaturePath);
const signature = Buffer.from(lines[1].trim(), "base64");
const algorithm = signature.subarray(0, 2).toString();
if (signature.length !== 74 || (algorithm !== "ED" && algorithm !== "Ed")) throw new Error(`签名格式不对：${signature.length} 字节，算法 ${algorithm}`);
if (!signature.subarray(2, 10).equals(keyNumber)) {
  throw new Error(`签名用的密钥号 ${signature.subarray(2, 10).toString("hex")} 和公钥的 ${keyNumber.toString("hex")} 不是一对：私钥配错了`);
}

const data = readFileSync(filePath);
const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
if (!verify(null, message, key, signature.subarray(10))) throw new Error("更新包签名验证失败");

const trusted = lines[2].replace(/^trusted comment: /, "");
const globalSignature = Buffer.from(lines[3].trim(), "base64");
if (!verify(null, Buffer.concat([signature.subarray(10), Buffer.from(trusted, "utf8")]), key, globalSignature)) {
  throw new Error("可信注释的签名验证失败");
}

console.log(`签名有效：密钥号 ${keyNumber.toString("hex")}，${trusted}`);
