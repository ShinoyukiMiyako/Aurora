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

// 只认 check-download.sh 用到的形状：--output <文件>、--write-out <格式>，最后一个参数是地址。把 https://<主机>/<路径>
// 映射到 $FAKE_CURL_ROOT/<主机>/<路径>，没有这个文件就按 404 失败；每次调用的地址记进 $FAKE_LOG.curl，参数记进
// $FAKE_LOG.curl-args。$FAKE_CURL_PLAN 是空格分开的「退出码/HTTP 状态/耗时秒数」，第 n 项决定第 n 次调用怎么失败：
// 先往输出文件追加一截残片、把模拟时钟拨快这么多秒，再按格式写出 HTTP 状态并以这个退出码退出。
// 成功时也只追加不覆盖：截断输出文件是脚本的责任，假 curl 替它截断就测不出残片混进比对。
const FAKE_CURL = `#!/usr/bin/env bash
output=""
format=""
previous=""
for arg in "$@"; do
  case "$previous" in
    --output) output="$arg" ;;
    --write-out) format="$arg" ;;
  esac
  previous="$arg"
done
url="\${@: -1}"
echo "$url" >> "$FAKE_LOG.curl"
{
  printf '%s\\n' "$@"
  echo ---
} >> "$FAKE_LOG.curl-args"
call="$(wc -l < "$FAKE_LOG.curl")"
read -ra plan <<< "\${FAKE_CURL_PLAN:-}"
report() {
  out=\${format//'%{http_code}'/$1}
  out=\${out//'%{speed_download}'/1048576}
  out=\${out//'%{time_total}'/0.5}
  printf '%s' "$out"
}
if [ "$call" -le "\${#plan[@]}" ]; then
  IFS=/ read -r code http took <<< "\${plan[call - 1]}"
  echo $(( $(cat "$FAKE_CLOCK") + took )) > "$FAKE_CLOCK"
  printf 'partial' >> "$output"
  report "$http"
  echo "curl: ($code) 按计划失败" >&2
  exit "$code"
fi
served="$FAKE_CURL_ROOT/\${url#https://}"
if [ ! -f "$served" ]; then
  report 404
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
cat "$served" >> "$output"
report 200
`;

// $FAKE_SSH_EXITS 是空格分开的退出码，第 n 项让第 n 次调用读完 stdin 后以它退出，用完了再按 $FAKE_SSH_REPLY 回答
const FAKE_SSH = `#!/usr/bin/env bash
{
  printf '%s\\n' "$@"
  echo ---
} >> "$FAKE_LOG"
call="$(grep -c '^---$' "$FAKE_LOG")"
read -ra planned <<< "\${FAKE_SSH_EXITS:-}"
previous=""
for arg in "$@"; do
  case "$arg" in
    UserKnownHostsFile=*) cp "\${arg#UserKnownHostsFile=}" "$FAKE_LOG.known_hosts" ;;
  esac
  if [ "$previous" = "-i" ]; then
    # 真 ssh 读不到 -i 指的私钥时只打警告，接着因为没有可用的身份认证失败，以 255 退出
    if [ ! -f "$arg" ]; then
      echo "Warning: Identity file $arg not accessible: No such file or directory." >&2
      exit 255
    fi
    cp "$arg" "$FAKE_LOG.key"
    stat -c %a "$arg" > "$FAKE_LOG.mode"
  fi
  previous="$arg"
done
cat > "$FAKE_LOG.stdin"
if [ "$call" -le "\${#planned[@]}" ]; then
  echo "假 ssh：第 $call 次按计划以 \${planned[call - 1]} 退出" >&2
  exit "\${planned[call - 1]}"
fi
case "$FAKE_SSH_REPLY" in
  echo) sha256sum < "$FAKE_LOG.stdin" | cut -d' ' -f1 ;;
  noisy) echo "welcome"; sha256sum < "$FAKE_LOG.stdin" | cut -d' ' -f1 ;;
  reject) echo "put-manifest: 拒收：版本没有比现有清单新" >&2; exit 1 ;;
  *) echo "$FAKE_SSH_REPLY" ;;
esac
`;

// 重试间隔不真等：记下秒数，把模拟时钟拨快这么多
const FAKE_SLEEP = `#!/usr/bin/env bash
if [ "$#" -ne 1 ] || ! [[ "$1" =~ ^[0-9]+$ ]]; then
  echo "假 sleep 只认一个整数秒数，收到：$*" >&2
  exit 2
fi
echo "$1" >> "$FAKE_LOG.sleep"
echo $(( $(cat "$FAKE_CLOCK") + $1 )) > "$FAKE_CLOCK"
`;

// 脚本按 date +%s 算时限，这里读模拟时钟；别的用法说明脚本改了取时间的方式，用例要跟着改
const FAKE_DATE = `#!/usr/bin/env bash
if [ "$#" -ne 1 ] || [ "$1" != "+%s" ]; then
  echo "假 date 只认 +%s，收到：$*" >&2
  exit 2
fi
cat "$FAKE_CLOCK"
`;

function fakeBin() {
  const dir = caseDir();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "aws"), FAKE_AWS, { mode: 0o755 });
  writeFileSync(join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
  writeFileSync(join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  writeFileSync(join(bin, "sleep"), FAKE_SLEEP, { mode: 0o755 });
  writeFileSync(join(bin, "date"), FAKE_DATE, { mode: 0o755 });
  writeFileSync(join(dir, "clock"), `${1_700_000_000 + randomInt(0, 100_000_000)}\n`);
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
  return { ...env, PATH: `${join(dir, "bin")}${delimiter}${path}`, FAKE_LOG: log, FAKE_CLOCK: join(dir, "clock"), ...extra };
}

const bash = (name, args, env) => spawnSync("bash", [script(name), ...args], { encoding: "utf8", env });
const calls = (log) =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("---\n")
        .filter((call) => call !== "")
        .map((call) => call.split("\n").slice(0, -1))
    : [];
const sleeps = (log) => (existsSync(`${log}.sleep`) ? readFileSync(`${log}.sleep`, "utf8").split("\n").slice(0, -1) : []);
const option = (args, name) => {
  const at = args.indexOf(name);
  assert.notEqual(at, -1, `参数里没有 ${name}：${args.join(" ")}`);
  return args[at + 1];
};

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

  // 下面几条走假 curl：它按 plan 先失败几次，之后从 https://dl.petalfall.org/<路径> 给出和本地相同的字节
  function flaky(plan) {
    const { dir, log } = fakeBin();
    const bytes = randomBytes(randomInt(1, 64 * 1024));
    const path = `dev/0.1.0-dev.${randomInt(1, 100_000)}-${randomInt(1, 2 ** 40)}-${randomInt(1, 5)}/Petalfall-Installer.exe`;
    const served = join(dir, "public", "dl.petalfall.org", ...path.split("/"));
    mkdirSync(join(served, ".."), { recursive: true });
    writeFileSync(served, bytes);
    const local = join(dir, "local.bin");
    writeFileSync(local, bytes);
    const env = envWithFakes(dir, log, { FAKE_CURL_ROOT: join(dir, "public"), FAKE_CURL_PLAN: plan.join(" ") });
    return { url: `https://dl.petalfall.org/${path}`, local, log, env, bytes, served };
  }
  const curlCalls = (log) => calls(`${log}.curl-args`);
  const maxTimes = (log) => curlCalls(log).map((args) => option(args, "--max-time"));

  it("传到一半被重置（56）两次、第三次成功时退出 0：每次从空文件重来，--max-time 按 600 秒总时限剩下的给", () => {
    const { url, local, log, env, bytes } = flaky(["56/200/40", "56/200/40"]);
    const result = bash("check-download.sh", ["cn", url, local], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^cn 读回一致：${bytes.length} 字节，sha256 ${sha256(bytes)}，用时 0\\.5 秒，1\\.00 MiB/s：`));
    const attempts = curlCalls(log);
    assert.equal(attempts.length, 3);
    // 600；600 - 40 - 5；600 - 2 × (40 + 5)
    assert.deepEqual(maxTimes(log), ["600", "555", "510"]);
    for (const args of attempts) {
      assert.equal(option(args, "--connect-timeout"), "30");
      assert.equal(option(args, "--speed-limit"), "1024");
      assert.equal(option(args, "--speed-time"), "60");
      // curl 自己再重试会让每次的 --max-time 重新计时，总时限就压不住了
      assert.equal(args.includes("--retry"), false, args.join(" "));
      assert.equal(args.at(-1), url);
    }
    assert.deepEqual(sleeps(log), ["5", "5"]);
    assert.equal(result.stderr.match(/::warning::cn 第 [12] 次读回失败（curl 退出 56，HTTP 200），5 秒后重试：/g).length, 2);
  });

  it("18、28、35、52、56、92 和 curl --retry 认的那几个 HTTP 状态都按暂时性错误重试", () => {
    const plans = [
      ...[18, 28, 35, 52, 56, 92].map((code) => `${code}/000/0`),
      ...[408, 429, 500, 502, 503, 504, 522, 524].map((http) => `22/${http}/0`),
    ];
    for (const plan of plans) {
      const { url, local, log, env } = flaky([plan]);
      const result = bash("check-download.sh", ["hk", url, local], env);
      assert.equal(result.status, 0, `${plan}：${result.stderr}`);
      assert.equal(curlCalls(log).length, 2, plan);
      assert.deepEqual(sleeps(log), ["5"], plan);
    }
  });

  it("404（--fail 下退出 22）、别的 4xx、501 和解析不了主机名都立即失败：只调一次 curl，不等待", () => {
    const missing = flaky([]);
    rmSync(missing.served);
    const cases = [
      { ...missing, code: 22, http: "404" },
      { ...flaky(["22/403/0"]), code: 22, http: "403" },
      { ...flaky(["22/501/0"]), code: 22, http: "501" },
      { ...flaky(["6/000/0"]), code: 6, http: "000" },
    ];
    for (const { url, local, log, env, code, http } of cases) {
      const result = bash("check-download.sh", ["global", url, local], env);
      assert.equal(result.status, code, `${http}：${result.stderr}`);
      assert.equal(curlCalls(log).length, 1, http);
      assert.deepEqual(sleeps(log), [], http);
      assert.match(result.stderr, new RegExp(`::error::global 读回失败（curl 退出 ${code}，HTTP ${http}），不是暂时性错误，不重试：`));
      assert.doesNotMatch(result.stdout, /读回一致/);
    }
  });

  it("一直是暂时性错误时试满 4 次就退出，退出码是最后一次的", () => {
    const { url, local, log, env } = flaky(["35/000/0", "18/200/0", "52/000/0", "56/200/0"]);
    const result = bash("check-download.sh", ["cn", url, local], env);
    assert.equal(result.status, 56, result.stderr);
    assert.deepEqual(maxTimes(log), ["600", "595", "590", "585"]);
    assert.deepEqual(sleeps(log), ["5", "5", "5"]);
    assert.match(result.stderr, /::error::cn 读回 4 次都失败（最后一次 curl 退出 56，HTTP 200）：/);
    assert.doesNotMatch(result.stdout, /读回一致/);
  });

  it("剩下的时间不够一次像样的尝试就不再重试，次数没用完也一样：单次调用压在 publish-hk 的作业时限以内", () => {
    const { url, local, log, env } = flaky(["56/200/300", "56/200/250"]);
    const result = bash("check-download.sh", ["github", url, local], env);
    assert.equal(result.status, 56, result.stderr);
    // 第二次只给 600 - 300 - 5；它失败时已过 555 秒，等完间隔只剩 40 秒，不到 60 秒就不试第三次
    assert.deepEqual(maxTimes(log), ["600", "295"]);
    assert.deepEqual(sleeps(log), ["5"]);
    assert.match(result.stderr, /::error::github 读回失败（curl 退出 56，HTTP 200），600 秒的时限等完重试间隔只剩 40 秒，不再重试：/);
  });

  it("等完间隔恰好剩 60 秒时还试一次、--max-time 给 60，剩 59 秒就不试", () => {
    const enough = flaky(["28/000/535"]);
    const retried = bash("check-download.sh", ["cn", enough.url, enough.local], enough.env);
    assert.equal(retried.status, 0, retried.stderr);
    assert.deepEqual(maxTimes(enough.log), ["600", "60"]);

    const short = flaky(["28/000/536"]);
    const given = bash("check-download.sh", ["cn", short.url, short.local], short.env);
    assert.equal(given.status, 28, given.stderr);
    assert.deepEqual(maxTimes(short.log), ["600"]);
    assert.deepEqual(sleeps(short.log), []);
    assert.match(given.stderr, /600 秒的时限等完重试间隔只剩 59 秒，不再重试：/);
  });
});

describe("upload-to-mirrors.sh", () => {
  const VARS = ["OSS_CI_ACCESS_KEY_ID", "OSS_CI_ACCESS_KEY_SECRET", "R2_CI_ACCESS_KEY_ID", "R2_CI_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID"];
  const KEY = `dev/0.1.0-dev.${randomInt(1, 100_000)}-${randomInt(1, 2 ** 40)}-${randomInt(1, 5)}/sample.bin`;

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

  // 只出在某一个桶上的回归（公网主机查表、读回地址对不上）要每次都抓到，三个桶逐个测，不随机挑
  const BUCKETS = ["cn", "hk", "global"];

  for (const [index, name] of BUCKETS.entries()) it(`put-object 报错但公网上已是同样的字节时照样算传上，接着传后面的桶：响应丢了、aws-cli 重发撞上禁止覆盖写（${name}）`, () => {
    const { log, file, bytes, credentials: c, env, publicRoot } = setup();
    const failing = targets(c.R2_ACCOUNT_ID)[index];
    assert.equal(failing.name, name);
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

  for (const [index, name] of BUCKETS.entries()) it(`put-object 报错、公网上的字节和本地不同时退出 1，后面的桶不再传（${name}）`, () => {
    const { log, file, bytes, credentials: c, env, publicRoot } = setup();
    const failing = targets(c.R2_ACCOUNT_ID)[index];
    assert.equal(failing.name, name);
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

  for (const [index, name] of BUCKETS.entries()) it(`put-object 报错、公网上没有这个对象时退出 1，后面的桶不再传（${name}）`, () => {
    const { log, file, credentials: c, env } = setup();
    const failing = targets(c.R2_ACCOUNT_ID)[index];
    assert.equal(failing.name, name);
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
        assert.equal(result.stderr, `::error::作业所在的环境里没有配置 ${missing}\n`);
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

  it("beta/ 下的对象键同样按原样传进三个桶", () => {
    const { log, file, env } = setup();
    const key = `beta/1.${randomInt(0, 50)}.${randomInt(0, 50)}-beta.${randomInt(1, 100_000)}-${randomInt(1, 2 ** 40)}-${randomInt(1, 5)}/sample.bin`;
    const result = bash("upload-to-mirrors.sh", [key, file], env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      calls(log).map((call) => call[call.indexOf("--key") + 1]),
      [key, key, key],
    );
  });

  it("对象键不在 dev/ 或 beta/ 下时退出非 0，一个桶都不传：R2 的凭据能写整个桶，写偏了没有任何桶规则兜底", () => {
    for (const key of ["stable/0.1.0/sample.bin", "Beta/1.0.0-beta.1-1/sample.bin", "betas/1.0.0-beta.1-1/sample.bin", "sample.bin", "dev/../sample.bin", "beta/../sample.bin", `/${KEY}`]) {
      const { log, file, env } = setup();
      const result = bash("upload-to-mirrors.sh", [key, file], env);
      assert.notEqual(result.status, 0, key);
      assert.match(result.stderr, /对象键应为 <通道>\/<目录>\/<文件名>，通道只能是 dev、beta/);
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
      "ServerAliveInterval=15",
      "ServerAliveCountMax=4",
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

  it("香港机拒收时退出 1，不重试，私钥照样删掉", () => {
    const { log, runnerTemp, manifest, env } = setup("reject");
    const result = bash("push-hk-manifest.sh", [manifest], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /put-manifest: 拒收/);
    assert.doesNotMatch(result.stdout, /香港清单已写入/);
    assert.equal(calls(log).length, 1);
    assert.deepEqual(sleeps(log), []);
    assert.deepEqual(readdirSync(runnerTemp), []);
  });

  it("ssh 自身出错（255）一次后重试成功：同样的参数，清单从头再送一遍，私钥留到最后一次之后才删", () => {
    const { log, runnerTemp, manifest, bytes, env } = setup("echo");
    env.FAKE_SSH_EXITS = "255";
    const result = bash("push-hk-manifest.sh", [manifest], env);
    assert.equal(result.status, 0, result.stderr);
    // stdout 仍然只有最后这一行，重试的提示走 stderr
    assert.equal(result.stdout, `香港清单已写入：sha256 ${sha256(bytes)}\n`);
    assert.match(result.stderr, /::warning::ssh 第 1 次以 255 退出（连接或认证出错），5 秒后重试\n/);
    const [first, second, ...rest] = calls(log);
    assert.deepEqual(rest, []);
    assert.deepEqual(second, first);
    // 假 ssh 每次重写 .stdin：第二次也收到完整清单，说明 stdin 每次从文件重接。私钥要是在重试前删了，
    // 假 ssh 后面几次都以 255 退出，上面的退出 0 就不成立
    assert.deepEqual(readFileSync(`${log}.stdin`), bytes);
    assert.equal(readFileSync(`${log}.key`, "utf8"), `${KEY_TEXT.join("\n")}\n`);
    assert.deepEqual(sleeps(log), ["5"]);
    assert.deepEqual(readdirSync(runnerTemp), []);
  });

  it("ssh 一直以 255 退出时试满 3 次后退出 255，私钥照样删掉", () => {
    const { log, runnerTemp, manifest, env } = setup("echo");
    env.FAKE_SSH_EXITS = "255 255 255";
    const result = bash("push-hk-manifest.sh", [manifest], env);
    assert.equal(result.status, 255, result.stderr);
    assert.match(result.stderr, /::error::ssh 连了 3 次都以 255 退出（连接或认证出错），香港清单没有推上去\n$/);
    assert.doesNotMatch(result.stdout, /香港清单已写入/);
    assert.equal(calls(log).length, 3);
    assert.deepEqual(sleeps(log), ["5", "5"]);
    assert.deepEqual(readdirSync(runnerTemp), []);
  });

  it("put-manifest 拒收（1）或参数错误（2）时立即失败，只连一次", () => {
    for (const code of [1, 2]) {
      const { log, runnerTemp, manifest, env } = setup("echo");
      env.FAKE_SSH_EXITS = String(code);
      const result = bash("push-hk-manifest.sh", [manifest], env);
      assert.equal(result.status, code, result.stderr);
      assert.match(result.stderr, new RegExp(`::error::香港机上的 put-manifest 以 ${code} 退出，没有收下这份清单，见上面它的报错\n$`));
      assert.doesNotMatch(result.stdout, /香港清单已写入/);
      assert.equal(calls(log).length, 1, String(code));
      assert.deepEqual(sleeps(log), [], String(code));
      assert.deepEqual(readdirSync(runnerTemp), []);
    }
  });

  it("没有推送私钥时退出 1，不连香港机，也不留下私钥文件", () => {
    for (const value of [undefined, ""]) {
      const { log, runnerTemp, manifest, env } = setup("echo");
      if (value === undefined) delete env.HK_MANIFEST_SSH_KEY;
      else env.HK_MANIFEST_SSH_KEY = value;
      const result = bash("push-hk-manifest.sh", [manifest], env);
      assert.equal(result.status, 1, String(value));
      assert.equal(result.stderr, "::error::作业所在的环境里没有配置 HK_MANIFEST_SSH_KEY\n");
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
