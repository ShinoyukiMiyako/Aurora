// 分发链路里三个 shell 脚本的离线用例。真正的上传与 ssh 推送要连云和香港机，由「分发试跑」工作流验证；
// 这里把假的 aws、ssh 放到 PATH 最前面，记下脚本怎么调它们，脚本出错时也绝不会连到真实的桶或香港机。
// 读回用 file:// 地址代替公网。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const KNOWN_HOSTS = fileURLToPath(new URL("../petalfall-hk.known_hosts", import.meta.url));
const HK_HOST = "8.210.200.215";
const root = mkdtempSync(join(tmpdir(), "distribution-scripts-"));
after(() => rmSync(root, { recursive: true, force: true }));

let nextCase = 0;
function caseDir() {
  const dir = join(root, String(nextCase++));
  mkdirSync(dir);
  return dir;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// 假程序把参数一行一个追加到 $FAKE_LOG，每次调用以 --- 结尾
const FAKE_AWS = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "$FAKE_AWS_VERSION"
  exit 0
fi
{
  echo "AWS_PROFILE=$AWS_PROFILE"
  echo "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID"
  echo "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY"
  printf '%s\\n' "$@"
  echo ---
} >> "$FAKE_LOG"
cp "$AWS_CONFIG_FILE" "$FAKE_LOG.config"
for arg in "$@"; do
  if [ -n "\${FAKE_AWS_FAIL_ENDPOINT:-}" ] && [ "$arg" = "$FAKE_AWS_FAIL_ENDPOINT" ]; then
    echo "An error occurred (FileAlreadyExists) when calling the PutObject operation: object already exists" >&2
    exit 254
  fi
done
echo '{"ETag": "fake"}'
`;

// 只认 check-download.sh 用到的形状：--output <文件>，最后一个参数是地址。把 https://<主机>/<路径> 映射到
// $FAKE_CURL_ROOT/<主机>/<路径>，没有这个文件就按 404 失败；每次调用的地址记进 $FAKE_LOG.curl
const FAKE_CURL = `#!/usr/bin/env bash
output=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--output" ]; then output="$arg"; fi
  previous="$arg"
done
url="\${@: -1}"
echo "$url" >> "$FAKE_LOG.curl"
served="$FAKE_CURL_ROOT/\${url#https://}"
if [ ! -f "$served" ]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
cp "$served" "$output"
echo "1048576 0.5"
`;

const FAKE_SSH = `#!/usr/bin/env bash
{
  printf '%s\\n' "$@"
  echo ---
} >> "$FAKE_LOG"
previous=""
for arg in "$@"; do
  case "$arg" in
    UserKnownHostsFile=*) cp "\${arg#UserKnownHostsFile=}" "$FAKE_LOG.known_hosts" ;;
  esac
  if [ "$previous" = "-i" ]; then
    cp "$arg" "$FAKE_LOG.key"
    stat -c %a "$arg" > "$FAKE_LOG.mode"
  fi
  previous="$arg"
done
cat > "$FAKE_LOG.stdin"
case "$FAKE_SSH_REPLY" in
  echo) sha256sum < "$FAKE_LOG.stdin" | cut -d' ' -f1 ;;
  noisy) echo "welcome"; sha256sum < "$FAKE_LOG.stdin" | cut -d' ' -f1 ;;
  reject) echo "put-manifest: 拒收" >&2; exit 3 ;;
  *) echo "$FAKE_SSH_REPLY" ;;
esac
`;

function fakeBin() {
  const dir = caseDir();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "aws"), FAKE_AWS, { mode: 0o755 });
  writeFileSync(join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
  writeFileSync(join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  return { dir, log: join(dir, "calls.log") };
}

// Windows 上环境变量名不分大小写，process.env 里可能叫 Path；只留一个，免得子进程拿到两份
function envWithFakes(dir, log, extra) {
  const env = {};
  let path = "";
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase() === "PATH") path = value;
    else env[name] = value;
  }
  return { ...env, PATH: `${join(dir, "bin")}${delimiter}${path}`, FAKE_LOG: log, ...extra };
}

const bash = (name, args, env) => spawnSync("bash", [script(name), ...args], { encoding: "utf8", env });
const calls = (log) =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("---\n")
        .filter((call) => call !== "")
        .map((call) => call.split("\n").slice(0, -1))
    : [];

describe("check-download.sh", () => {
  function pair(remoteBytes, localBytes = remoteBytes) {
    const dir = caseDir();
    const remote = join(dir, "remote.bin");
    const local = join(dir, "local.bin");
    writeFileSync(remote, remoteBytes);
    writeFileSync(local, localBytes);
    return { url: pathToFileURL(remote).href, local };
  }

  it("字节相同时退出 0，打印大小和 sha256", () => {
    const bytes = randomBytes(randomInt(1, 256 * 1024));
    const { url, local } = pair(bytes);
    const result = bash("check-download.sh", ["hk", url, local], process.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^hk 读回一致：${bytes.length} 字节，sha256 ${sha256(bytes)}，`));
  });

  it("大小相同、内容不同时退出 1：只比大小挡不住被换掉的包", () => {
    const bytes = randomBytes(randomInt(1, 4096));
    const changed = Buffer.from(bytes);
    changed[randomInt(0, changed.length)] ^= 0xff;
    const { url, local } = pair(changed, bytes);
    const result = bash("check-download.sh", ["cn", url, local], process.env);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr, `::error::cn 读回的 sha256 是 ${sha256(changed)}，本地是 ${sha256(bytes)}：${url}\n`);
  });

  it("大小不同时退出 1", () => {
    const bytes = randomBytes(randomInt(2, 4096));
    const { url, local } = pair(bytes.subarray(1), bytes);
    const result = bash("check-download.sh", ["global", url, local], process.env);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stderr, `::error::global 读回 ${bytes.length - 1} 字节，本地 ${bytes.length} 字节：${url}\n`);
  });

  it("地址取不到时退出非 0，不打印读回一致", () => {
    const dir = caseDir();
    const local = join(dir, "local.bin");
    writeFileSync(local, randomBytes(16));
    const result = bash("check-download.sh", ["github", pathToFileURL(join(dir, "missing.bin")).href, local], process.env);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /读回一致/);
  });

  it("参数不是恰好三个时退出 2 并提示用法", () => {
    const result = bash("check-download.sh", ["hk", "https://example.invalid/x"], process.env);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /用法：check-download\.sh/);
  });
});

describe("upload-to-mirrors.sh", () => {
  const VARS = ["OSS_CI_ACCESS_KEY_ID", "OSS_CI_ACCESS_KEY_SECRET", "R2_CI_ACCESS_KEY_ID", "R2_CI_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID"];
  const KEY = `dev/0.1.0-dev.${randomInt(1, 100_000)}-${randomInt(1, 5)}/sample.bin`;

  function setup(versionLine = `aws-cli/2.${randomInt(0, 40)}.${randomInt(0, 40)} Python/3.13.0 Linux/6.8.0 exe/x86_64.ubuntu.24`) {
    const { dir, log } = fakeBin();
    const file = join(dir, "sample.bin");
    const bytes = randomBytes(randomInt(1, 64 * 1024));
    writeFileSync(file, bytes);
    const credentials = {
      OSS_CI_ACCESS_KEY_ID: `LTAI${randomBytes(8).toString("hex")}`,
      OSS_CI_ACCESS_KEY_SECRET: randomBytes(15).toString("hex"),
      R2_CI_ACCESS_KEY_ID: randomBytes(16).toString("hex"),
      R2_CI_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
      R2_ACCOUNT_ID: randomBytes(16).toString("hex"),
    };
    const publicRoot = join(dir, "public");
    const env = envWithFakes(dir, log, { RUNNER_TEMP: dir, FAKE_AWS_VERSION: versionLine, FAKE_CURL_ROOT: publicRoot, ...credentials });
    return { dir, log, file, bytes, credentials, env, publicRoot };
  }

  // 每个桶的 S3 端点（假 aws 按它决定哪一次上传报错）与客户端读回用的公网主机
  const targets = (account) => [
    { name: "cn", endpoint: "https://s3.oss-cn-hangzhou.aliyuncs.com", host: "petalfall-dl-cn.oss-cn-hangzhou.aliyuncs.com" },
    { name: "hk", endpoint: "https://s3.oss-cn-hongkong.aliyuncs.com", host: "petalfall-dl.oss-cn-hongkong.aliyuncs.com" },
    { name: "global", endpoint: `https://${account}.r2.cloudflarestorage.com`, host: "dl.petalfall.org" },
  ];

  // 让假 curl 在 https://<host>/<KEY> 上给出这些字节，相当于对象已经在桶里
  function serve(publicRoot, host, bytes) {
    const path = join(publicRoot, host, ...KEY.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  }

  it("同一个对象键传三个桶：杭州、香港用 OSS 凭据，R2 用 R2 凭据，带内容类型、缓存头、Content-MD5 与超时", () => {
    const { log, file, bytes, credentials: c, env } = setup();
    const result = bash("upload-to-mirrors.sh", [KEY, file], env);
    assert.equal(result.status, 0, result.stderr);
    const md5 = createHash("md5").update(bytes).digest("base64");
    const put = (profile, id, secret, endpoint, region, bucket) => [
      `AWS_PROFILE=${profile}`,
      `AWS_ACCESS_KEY_ID=${id}`,
      `AWS_SECRET_ACCESS_KEY=${secret}`,
      "s3api",
      "put-object",
      "--endpoint-url",
      endpoint,
      "--region",
      region,
      "--bucket",
      bucket,
      "--key",
      KEY,
      "--body",
      file,
      "--content-type",
      "application/octet-stream",
      "--cache-control",
      "public, max-age=31536000, immutable",
      "--content-md5",
      md5,
      "--cli-connect-timeout",
      "30",
      "--cli-read-timeout",
      "120",
      "--no-cli-pager",
    ];
    assert.deepEqual(calls(log), [
      put("oss", c.OSS_CI_ACCESS_KEY_ID, c.OSS_CI_ACCESS_KEY_SECRET, "https://s3.oss-cn-hangzhou.aliyuncs.com", "cn-hangzhou", "petalfall-dl-cn"),
      put("oss", c.OSS_CI_ACCESS_KEY_ID, c.OSS_CI_ACCESS_KEY_SECRET, "https://s3.oss-cn-hongkong.aliyuncs.com", "cn-hongkong", "petalfall-dl"),
      put("r2", c.R2_CI_ACCESS_KEY_ID, c.R2_CI_SECRET_ACCESS_KEY, `https://${c.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, "auto", "petalfall-dl"),
    ]);
    assert.equal(
      readFileSync(`${log}.config`, "utf8"),
      [
        "[profile oss]",
        "request_checksum_calculation = when_required",
        "response_checksum_validation = when_required",
        "retry_mode = standard",
        "max_attempts = 5",
        "s3 =",
        "  addressing_style = virtual",
        "",
        "[profile r2]",
        "request_checksum_calculation = when_required",
        "response_checksum_validation = when_required",
        "retry_mode = standard",
        "max_attempts = 5",
        "",
      ].join("\n"),
    );
    // 配置文件里只有设置，凭据只走每条命令的环境变量
    for (const secret of Object.values(c)) assert.doesNotMatch(readFileSync(`${log}.config`, "utf8"), new RegExp(secret));
    // 上传都成功时不读回：核对交给工作流里下一步的「读回三个存储桶」
    assert.equal(existsSync(`${log}.curl`), false);
  });

  it("put-object 报错但公网上已是同样的字节时照样算传上，接着传后面的桶：响应丢了、aws-cli 重发撞上禁止覆盖写", () => {
    const { log, file, bytes, credentials: c, env, publicRoot } = setup();
    const index = randomInt(0, 3);
    const failing = targets(c.R2_ACCOUNT_ID)[index];
    env.FAKE_AWS_FAIL_ENDPOINT = failing.endpoint;
    serve(publicRoot, failing.host, bytes);
    const result = bash("upload-to-mirrors.sh", [KEY, file], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /FileAlreadyExists/);
    assert.match(result.stdout, new RegExp(`${failing.name}：put-object 报错，但公网读回与本地一致，按已传上处理\n`));
    assert.deepEqual(
      calls(log).map((call) => call[call.indexOf("--endpoint-url") + 1]),
      targets(c.R2_ACCOUNT_ID).map(({ endpoint }) => endpoint),
    );
    assert.equal(readFileSync(`${log}.curl`, "utf8"), `https://${failing.host}/${KEY}\n`);
  });

  it("put-object 报错、公网上的字节和本地不同时退出 1，后面的桶不再传", () => {
    const { log, file, bytes, credentials: c, env, publicRoot } = setup();
    const index = randomInt(0, 3);
    const failing = targets(c.R2_ACCOUNT_ID)[index];
    env.FAKE_AWS_FAIL_ENDPOINT = failing.endpoint;
    const changed = Buffer.from(bytes);
    changed[randomInt(0, changed.length)] ^= 0xff;
    serve(publicRoot, failing.host, changed);
    const result = bash("upload-to-mirrors.sh", [KEY, file], env);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`::error::${failing.name} 读回的 sha256 是 ${sha256(changed)}，本地是 ${sha256(bytes)}`));
    assert.match(result.stderr, new RegExp(`::error::${failing.name}：put-object 失败，按公网地址读回也和本地文件对不上，见上面 aws 的报错\n$`));
    assert.equal(calls(log).length, index + 1);
    assert.doesNotMatch(result.stdout, new RegExp(`${failing.name}：已传到`));
  });

  it("put-object 报错、公网上没有这个对象时退出 1，后面的桶不再传", () => {
    const { log, file, credentials: c, env } = setup();
    const index = randomInt(0, 3);
    const failing = targets(c.R2_ACCOUNT_ID)[index];
    env.FAKE_AWS_FAIL_ENDPOINT = failing.endpoint;
    const result = bash("upload-to-mirrors.sh", [KEY, file], env);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`::error::${failing.name}：put-object 失败，按公网地址读回也和本地文件对不上，见上面 aws 的报错\n$`));
    assert.equal(calls(log).length, index + 1);
    assert.equal(readFileSync(`${log}.curl`, "utf8"), `https://${failing.host}/${KEY}\n`);
  });

  it("aws-cli 不是 2.x 时退出 1，一个桶都不传", () => {
    for (const line of ["aws-cli/1.36.0 Python/3.12.0 Linux/6.8.0 botocore/1.36.0", "aws-cli/20.0.0 Python/3.13.0", ""]) {
      const { log, file, env } = setup(line);
      const result = bash("upload-to-mirrors.sh", [KEY, file], env);
      assert.equal(result.status, 1, line);
      assert.match(result.stderr, /::error::需要 aws-cli 2\.x/);
      assert.deepEqual(calls(log), []);
    }
  });

  it("缺任何一个凭据或账户 ID 时退出 1 并点名缺的是哪个，一个桶都不传", () => {
    for (const missing of VARS) {
      for (const value of [undefined, ""]) {
        const { log, file, env } = setup();
        if (value === undefined) delete env[missing];
        else env[missing] = value;
        const result = bash("upload-to-mirrors.sh", [KEY, file], env);
        assert.equal(result.status, 1, `${missing}=${value}`);
        assert.equal(result.stderr, `::error::环境 updates-dev 里没有配置 ${missing}\n`);
        assert.deepEqual(calls(log), []);
      }
    }
  });

  it("R2 账户 ID 格式不对时退出非 0，一个桶都不传", () => {
    const { log, file, env } = setup();
    env.R2_ACCOUNT_ID = env.R2_ACCOUNT_ID.toUpperCase();
    const result = bash("upload-to-mirrors.sh", [KEY, file], env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /R2 账户 ID 应为 32 位小写十六进制/);
    assert.deepEqual(calls(log), []);
  });

  it("对象键不在 dev/ 下时退出非 0，一个桶都不传：R2 的凭据能写整个桶，写偏了没有生命周期规则兜底", () => {
    for (const key of ["stable/0.1.0/sample.bin", "sample.bin", "dev/../sample.bin", `/${KEY}`]) {
      const { log, file, env } = setup();
      const result = bash("upload-to-mirrors.sh", [key, file], env);
      assert.notEqual(result.status, 0, key);
      assert.match(result.stderr, /对象键应为 dev\/<目录>\/<文件名>/);
      assert.deepEqual(calls(log), []);
    }
  });

  it("参数不是恰好两个时退出 2 并提示用法", () => {
    const { file, env } = setup();
    const result = bash("upload-to-mirrors.sh", [file], env);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /用法：upload-to-mirrors\.sh/);
  });
});

describe("push-hk-manifest.sh", () => {
  const KEY_TEXT = ["-----BEGIN OPENSSH PRIVATE KEY-----", randomBytes(48).toString("base64"), "-----END OPENSSH PRIVATE KEY-----"];

  function setup(reply, key = `${KEY_TEXT.join("\n")}\n`) {
    const { dir, log } = fakeBin();
    const runnerTemp = join(dir, "runner-temp");
    mkdirSync(runnerTemp);
    const manifest = join(dir, "latest.json");
    const bytes = Buffer.from(JSON.stringify({ version: `0.1.0-dev.${randomInt(1, 100_000)}`, nonce: randomBytes(8).toString("hex") }, null, 2));
    writeFileSync(manifest, bytes);
    const env = envWithFakes(dir, log, { RUNNER_TEMP: runnerTemp, HK_MANIFEST_SSH_KEY: key, FAKE_SSH_REPLY: reply });
    return { log, runnerTemp, manifest, bytes, env };
  }

  it("按钉死的主机公钥、只用这把私钥、不交互地把清单从 stdin 送过去，回显的 sha256 一致时退出 0", () => {
    const { log, runnerTemp, manifest, bytes, env } = setup("echo");
    const result = bash("push-hk-manifest.sh", [manifest], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `香港清单已写入：sha256 ${sha256(bytes)}\n`);
    const [args, ...rest] = calls(log);
    assert.deepEqual(rest, []);
    assert.equal(args.at(-1), `petalfall-pub@${HK_HOST}`);
    const options = args.flatMap((arg, i) => (args[i - 1] === "-o" ? [arg] : []));
    assert.deepEqual(options.filter((o) => !o.startsWith("UserKnownHostsFile=")), [
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "BatchMode=yes",
      "ConnectTimeout=30",
      "StrictHostKeyChecking=yes",
      "GlobalKnownHostsFile=/dev/null",
    ]);
    assert.equal(options.filter((o) => o.startsWith("UserKnownHostsFile=")).length, 1);
    assert.equal(readFileSync(`${log}.known_hosts`, "utf8"), readFileSync(KNOWN_HOSTS, "utf8"));
    assert.ok(args.includes("-T"));
    assert.equal(args[args.indexOf("-i") + 1].startsWith(runnerTemp), true, args.join(" "));
    assert.deepEqual(readFileSync(`${log}.stdin`), bytes);
    assert.equal(readFileSync(`${log}.key`, "utf8"), `${KEY_TEXT.join("\n")}\n`);
    if (process.platform !== "win32") assert.equal(readFileSync(`${log}.mode`, "utf8"), "600\n");
    // 私钥用完即删
    assert.deepEqual(readdirSync(runnerTemp), []);
  });

  it("机密里的私钥带 CRLF、结尾没换行时，写出的文件是 LF 且以换行结尾", () => {
    const { log, manifest, env } = setup("echo", KEY_TEXT.join("\r\n"));
    const result = bash("push-hk-manifest.sh", [manifest], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(`${log}.key`, "utf8"), `${KEY_TEXT.join("\n")}\n`);
  });

  it("回显的 sha256 和本地不同时退出 1，私钥照样删掉", () => {
    const other = randomBytes(32).toString("hex");
    const { runnerTemp, manifest, bytes, env } = setup(other);
    const result = bash("push-hk-manifest.sh", [manifest], env);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `::error::香港机回显的 sha256 是 ${other}，本地清单是 ${sha256(bytes)}\n`);
    assert.deepEqual(readdirSync(runnerTemp), []);
  });

  it("回显里除了 sha256 还有别的内容时退出 1：认不出脚本的回答就不能当成功", () => {
    const { runnerTemp, manifest, env } = setup("noisy");
    const result = bash("push-hk-manifest.sh", [manifest], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::put-manifest 的输出应只有一行 sha256，实际是：welcome/);
    assert.deepEqual(readdirSync(runnerTemp), []);
  });

  it("香港机拒收时退出非 0，私钥照样删掉", () => {
    const { runnerTemp, manifest, env } = setup("reject");
    const result = bash("push-hk-manifest.sh", [manifest], env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /put-manifest: 拒收/);
    assert.doesNotMatch(result.stdout, /香港清单已写入/);
    assert.deepEqual(readdirSync(runnerTemp), []);
  });

  it("没有推送私钥时退出 1，不连香港机，也不留下私钥文件", () => {
    for (const value of [undefined, ""]) {
      const { log, runnerTemp, manifest, env } = setup("echo");
      if (value === undefined) delete env.HK_MANIFEST_SSH_KEY;
      else env.HK_MANIFEST_SSH_KEY = value;
      const result = bash("push-hk-manifest.sh", [manifest], env);
      assert.equal(result.status, 1, String(value));
      assert.equal(result.stderr, "::error::环境 updates-dev 里没有配置 HK_MANIFEST_SSH_KEY\n");
      assert.deepEqual(calls(log), []);
      assert.deepEqual(readdirSync(runnerTemp), []);
    }
  });

  it("清单文件为空时退出非 0，不连香港机：空文件说明前面生成清单出了错", () => {
    const { log, manifest, env } = setup("echo");
    writeFileSync(manifest, "");
    const result = bash("push-hk-manifest.sh", [manifest], env);
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls(log), []);
  });

  it("参数不是恰好一个时退出 2 并提示用法", () => {
    const { env } = setup("echo");
    const result = bash("push-hk-manifest.sh", [], env);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /用法：push-hk-manifest\.sh/);
  });
});

// 占位行或贴错格式（比如直接贴 ssh_host_ed25519_key.pub 的原文，ssh 会把 ssh-ed25519 当成主机名）时，
// ssh 要到预发布重建之后的推送才报 Host key verification failed；在 build 作业的脚本测试里就挡下。
describe("petalfall-hk.known_hosts", () => {
  it(`恰好一条非注释记录，是 ${HK_HOST} 的完整 ed25519 主机公钥`, () => {
    const records = readFileSync(KNOWN_HOSTS, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
    assert.equal(records.length, 1, `应恰好一条主机公钥记录，实际 ${records.length} 条`);
    const match = new RegExp(`^${HK_HOST.replaceAll(".", "\\.")} ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$`).exec(records[0]);
    assert.notEqual(match, null, `记录应为「${HK_HOST} ssh-ed25519 <base64>」，实际：${records[0]}`);
    // 公钥 blob 是 string("ssh-ed25519") 加 string(32 字节公钥)，各带 4 字节大端长度；截断或多贴的字符在这里露出来
    const blob = Buffer.from(match[1], "base64");
    assert.equal(blob.toString("base64"), match[1]);
    assert.equal(blob.length, 4 + 11 + 4 + 32);
    assert.equal(blob.readUInt32BE(0), 11);
    assert.equal(blob.subarray(4, 15).toString("latin1"), "ssh-ed25519");
    assert.equal(blob.readUInt32BE(15), 32);
  });
});
