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

remote_sha="$(ssh -T \
  -o IdentitiesOnly=yes \
  -o IdentityAgent=none \
  -o BatchMode=yes \
  -o ConnectTimeout=30 \
  -o StrictHostKeyChecking=yes \
  -o GlobalKnownHostsFile=/dev/null \
  -o UserKnownHostsFile="$known_hosts" \
  -i "$key_file" \
  petalfall-pub@8.210.200.215 < "$manifest")"
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
