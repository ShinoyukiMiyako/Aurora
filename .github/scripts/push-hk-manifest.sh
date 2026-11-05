#!/usr/bin/env bash
# 把一份更新清单从 stdin 送给香港机上的强制命令 /usr/local/lib/petalfall/put-manifest，核对它回显的 sha256。
# 写哪个通道由香港机 authorized_keys 里这把公钥那一行绑定，这边不传远程命令：强制命令会忽略客户端请求的命令。
# 脚本校验通过后原子替换清单，在 stdout 只打新文件的 sha256；字节相同的清单视为无变化，照样成功并回显。
# 主机公钥钉在仓库的 .github/petalfall-hk.known_hosts，不信任首次连接，也不读机器上全局的 known_hosts。
# 用法：bash push-hk-manifest.sh <清单文件>；私钥从环境变量 HK_MANIFEST_SSH_KEY 来，写到 $RUNNER_TEMP，用完即删。
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "用法：push-hk-manifest.sh <清单文件>" >&2
  exit 2
fi
manifest="$1"
test -s "$manifest"
known_hosts="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/petalfall-hk.known_hosts"
test -f "$known_hosts"

if [ -z "${HK_MANIFEST_SSH_KEY:-}" ]; then
  echo "::error::环境 updates-dev 里没有配置 HK_MANIFEST_SSH_KEY" >&2
  exit 1
fi

key_file="${RUNNER_TEMP:?}/hk-manifest-key"
trap 'rm -f "$key_file"' EXIT
# 在 Windows 上复制进机密的私钥可能带 CRLF，OpenSSH 读到 \r 会判格式无效；粘贴时结尾的换行也可有可无，
# 统一成 LF、结尾恰好一个换行（命令替换会去掉末尾所有换行）
private_key="${HK_MANIFEST_SSH_KEY//$'\r'/}"
private_key="$(printf '%s' "$private_key")"
(umask 077 && printf '%s\n' "$private_key" > "$key_file")
unset private_key
chmod 600 "$key_file"

# 跨境连香港机时一次丢包或重置会让 ssh 自身以 255 退出，只对它重试（认证失败、主机公钥对不上也是 255，
# 多试两次只多花十几秒）；put-manifest 拒收（1）和参数错误（2）是确定的结论，重推也一样，立即失败。
# 重推是安全的：上一次其实已经写入、只是回显丢在路上时，put-manifest 收到字节相同的清单视为无变化，照样回显 sha256。
# ConnectTimeout 管不到连上之后的会话；ServerAlive 让中途断掉的会话约一分钟内以 255 报错，而不是挂到作业时限。
# 每次都从清单文件重新接 stdin，私钥留到最后一次尝试之后再删。
max_attempts=3
retry_delay=5
attempt=1
while :; do
  status=0
  remote_sha="$(ssh -T \
    -o IdentitiesOnly=yes \
    -o IdentityAgent=none \
    -o BatchMode=yes \
    -o ConnectTimeout=30 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=4 \
    -o StrictHostKeyChecking=yes \
    -o GlobalKnownHostsFile=/dev/null \
    -o UserKnownHostsFile="$known_hosts" \
    -i "$key_file" \
    petalfall-pub@8.210.200.215 < "$manifest")" || status=$?
  if [ "$status" -eq 0 ]; then
    break
  fi
  if [ "$status" -ne 255 ]; then
    echo "::error::香港机上的 put-manifest 以 $status 退出，没有收下这份清单，见上面它的报错" >&2
    exit "$status"
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "::error::ssh 连了 $attempt 次都以 255 退出（连接或认证出错），香港清单没有推上去" >&2
    exit "$status"
  fi
  echo "::warning::ssh 第 $attempt 次以 255 退出（连接或认证出错），${retry_delay} 秒后重试" >&2
  sleep "$retry_delay"
  attempt=$(( attempt + 1 ))
done
rm -f "$key_file"

local_sha="$(sha256sum < "$manifest" | cut -d' ' -f1)"
if ! [[ "$remote_sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::put-manifest 的输出应只有一行 sha256，实际是：$remote_sha" >&2
  exit 1
fi
if [ "$remote_sha" != "$local_sha" ]; then
  echo "::error::香港机回显的 sha256 是 $remote_sha，本地清单是 $local_sha" >&2
  exit 1
fi
echo "香港清单已写入：sha256 $remote_sha"
