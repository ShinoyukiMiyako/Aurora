#!/usr/bin/env bash
# 匿名下载一个公网地址，与本地文件比对大小和 sha256。上传成功只说明写进了桶，客户端按清单里的地址
# 能不能拿到同样的字节（公共读、自定义域名、CDN、GitHub 的跳转）要从外面再验一遍。
# 用法：bash check-download.sh <源名> <地址> <本地文件>
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "用法：check-download.sh <源名> <地址> <本地文件>" >&2
  exit 2
fi
source_name="$1"
url="$2"
expected="$3"
test -f "$expected"

downloaded="$(mktemp)"
trap 'rm -f "$downloaded"' EXIT

# --fail 把 4xx、5xx 判为失败；--retry 只重试超时与 408、429、5xx 这类暂时性错误，404 立即失败。
# 22 MB 跨境走得慢，--max-time 按最慢的源放宽。
stats="$(curl --fail --silent --show-error --location --retry 3 --max-time 900 \
  --output "$downloaded" --write-out '%{speed_download} %{time_total}' "$url")"
read -r speed seconds <<< "$stats"

want_size="$(stat -c %s "$expected")"
got_size="$(stat -c %s "$downloaded")"
want_sha="$(sha256sum < "$expected" | cut -d' ' -f1)"
got_sha="$(sha256sum < "$downloaded" | cut -d' ' -f1)"

if [ "$got_size" != "$want_size" ]; then
  echo "::error::$source_name 读回 $got_size 字节，本地 $want_size 字节：$url" >&2
  exit 1
fi
if [ "$got_sha" != "$want_sha" ]; then
  echo "::error::$source_name 读回的 sha256 是 $got_sha，本地是 $want_sha：$url" >&2
  exit 1
fi
echo "$source_name 读回一致：$got_size 字节，sha256 $got_sha，用时 ${seconds} 秒，$(awk -v b="$speed" 'BEGIN { printf "%.2f", b / 1048576 }') MiB/s：$url"
