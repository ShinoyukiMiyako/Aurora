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

# curl 自己的 --retry 只认超时和 408、429、500、502、503、504、522、524，跨境链路上更常见的是传到一半被重置（56）、
# 握手被重置（35）、对端提前断开（18）、一个字节都没回（52）、HTTP/2 流被对端复位（92），所以重试放在这里统一做，
# HTTP 状态沿用 --retry 那张表；--fail 下 404 这类状态说明地址或公共读配错了，立即失败。
# 整次调用共用 10 分钟的时限，单次调用压在 publish-hk 的作业时限以内：--max-time 每次重试都重新计时，所以每次
# 按剩下的时间给，剩得不够一次像样的尝试就不再试。每秒不到 1 KiB 持续 60 秒也按超时（28）收场，换一条连接重来，
# 不把时限耗在一条死连接上。
budget=600
max_attempts=4
retry_delay=5
min_attempt=60
deadline=$(( $(date +%s) + budget ))
attempt=1
while :; do
  # 不依赖 curl 何时建、何时截断输出文件：上一次失败留下的残片不能混进这一次的比对
  : > "$downloaded"
  remaining=$(( deadline - $(date +%s) ))
  status=0
  stats="$(curl --fail --silent --show-error --location \
    --connect-timeout 30 --max-time "$remaining" --speed-limit 1024 --speed-time 60 \
    --output "$downloaded" --write-out '%{http_code} %{speed_download} %{time_total}' "$url")" || status=$?
  read -r http_code speed seconds <<< "$stats"
  if [ "$status" -eq 0 ]; then
    break
  fi
  case "$status" in
    18 | 28 | 35 | 52 | 56 | 92) transient=yes ;;
    22)
      case "$http_code" in
        408 | 429 | 500 | 502 | 503 | 504 | 522 | 524) transient=yes ;;
        *) transient=no ;;
      esac
      ;;
    *) transient=no ;;
  esac
  failure="curl 退出 $status，HTTP $http_code"
  if [ "$transient" = no ]; then
    echo "::error::$source_name 读回失败（$failure），不是暂时性错误，不重试：$url" >&2
    exit "$status"
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "::error::$source_name 读回 $attempt 次都失败（最后一次 $failure）：$url" >&2
    exit "$status"
  fi
  left=$(( deadline - $(date +%s) - retry_delay ))
  if [ "$left" -lt "$min_attempt" ]; then
    echo "::error::$source_name 读回失败（$failure），${budget} 秒的时限等完重试间隔只剩 ${left} 秒，不再重试：$url" >&2
    exit "$status"
  fi
  echo "::warning::$source_name 第 $attempt 次读回失败（$failure），${retry_delay} 秒后重试：$url" >&2
  sleep "$retry_delay"
  attempt=$(( attempt + 1 ))
done

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
