#!/usr/bin/env bash
# 把一个文件按同一个对象键传到三个存储桶：杭州 OSS（cn）、香港 OSS（hk）、R2（global）。
# 桶、端点、区域与公网主机都从 dev-distribution.mjs 的同一张表来，读回和清单用的是同一套地址。
# 用法：bash upload-to-mirrors.sh <对象键> <本地文件>
# 凭据只从调用它的那一步的环境变量来，缺任何一个都直接失败：
#   OSS_CI_ACCESS_KEY_ID、OSS_CI_ACCESS_KEY_SECRET（RAM 子用户，只有 oss:PutObject，限两个桶里本通道的前缀，每个通道一个子用户）
#   R2_CI_ACCESS_KEY_ID、R2_CI_SECRET_ACCESS_KEY（R2 的 S3 凭据，只授 petalfall-dl 一个桶）
#   R2_ACCOUNT_ID（拼 R2 的 S3 端点）
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "用法：upload-to-mirrors.sh <对象键> <本地文件>" >&2
  exit 2
fi
key="$1"
file="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for var in OSS_CI_ACCESS_KEY_ID OSS_CI_ACCESS_KEY_SECRET R2_CI_ACCESS_KEY_ID R2_CI_SECRET_ACCESS_KEY R2_ACCOUNT_ID; do
  if [ -z "${!var:-}" ]; then
    echo "::error::作业所在的环境里没有配置 $var" >&2
    exit 1
  fi
done
test -f "$file"
# 对象键必须是 <通道>/<目录>/<文件名>，通道只认 dev、beta：OSS 的 RAM 策略只放行本通道的前缀，R2 的凭据却能写整个桶，
# 写偏了就落在桶的规则之外，dev/ 的 30 天过期、beta/ 的禁止覆盖写与锁都管不到它。
# mirror-urls 用的就是这条校验；它给出的公网地址留给下面 put-object 报错时核对。
public_urls="$(node "$script_dir/dev-distribution.mjs" mirror-urls "$key")"

# 下面的配置项和参数是按 aws-cli v2 的文档写的；托管镜像哪天换成别的大版本，宁可在这里停下
aws_version="$(aws --version 2>&1)"
echo "$aws_version"
if ! [[ "$aws_version" =~ ^aws-cli/2\. ]]; then
  echo "::error::需要 aws-cli 2.x，实际是 $aws_version" >&2
  exit 1
fi

# 新版 CLI 默认给每次上传算 CRC 校验和，用 aws-chunked 分块编码带在尾部发出去，OSS 不支持分块编码，
# 所以只在操作要求时才算校验和，完整性改由 Content-MD5 保证。OSS 的 S3 兼容层要求桶名放在主机名里。
# 跨境上传容易遇到连接重置，标准重试模式最多试 5 次。
export AWS_CONFIG_FILE="${RUNNER_TEMP:?}/aws-config"
cat > "$AWS_CONFIG_FILE" <<'EOF'
[profile oss]
request_checksum_calculation = when_required
response_checksum_validation = when_required
retry_mode = standard
max_attempts = 5
s3 =
  addressing_style = virtual

[profile r2]
request_checksum_calculation = when_required
response_checksum_validation = when_required
retry_mode = standard
max_attempts = 5
EOF

md5="$(openssl md5 -binary "$file" | base64)"
targets="$(node "$script_dir/dev-distribution.mjs" upload-targets "$R2_ACCOUNT_ID")"

while IFS=$'\t' read -r name profile bucket endpoint region; do
  case "$profile" in
    oss)
      key_id="$OSS_CI_ACCESS_KEY_ID"
      secret="$OSS_CI_ACCESS_KEY_SECRET"
      ;;
    r2)
      key_id="$R2_CI_ACCESS_KEY_ID"
      secret="$R2_CI_SECRET_ACCESS_KEY"
      ;;
    *)
      echo "::error::$name 的 profile $profile 没有对应的凭据" >&2
      exit 1
      ;;
  esac
  started=$SECONDS
  # 用 AWS_PROFILE 选配置段、凭据放环境变量：文档写明这种组合下环境变量里的凭据优先于 profile。
  # 对象路径带版本、永不改写，所以缓存一年并标 immutable。stdin 接 /dev/null，免得吃掉循环读的目标表。
  if ! AWS_PROFILE="$profile" AWS_ACCESS_KEY_ID="$key_id" AWS_SECRET_ACCESS_KEY="$secret" \
    aws s3api put-object \
    --endpoint-url "$endpoint" \
    --region "$region" \
    --bucket "$bucket" \
    --key "$key" \
    --body "$file" \
    --content-type application/octet-stream \
    --cache-control 'public, max-age=31536000, immutable' \
    --content-md5 "$md5" \
    --cli-connect-timeout 30 \
    --cli-read-timeout 120 \
    --no-cli-pager < /dev/null; then
    # 服务端已经写成、响应却在跨境路上丢了时，aws-cli 按可重试错误重发同一个键，撞上桶的禁止覆盖写而报错，
    # 对象其实完好。CI 的凭据只能写、查不了对象，所以按客户端用的公网地址匿名读回，大小和 sha256 与本地一致
    # 才算传上；不按错误码分辨，OSS 的 S3 兼容层与 R2 对「已存在」各报什么码这里核实不了，比字节不依赖它。
    url="$(awk -F '\t' -v name="$name" '$1 == name { print $2 }' <<< "$public_urls")"
    test -n "$url"
    if ! bash "$script_dir/check-download.sh" "$name" "$url" "$file" < /dev/null; then
      echo "::error::$name：put-object 失败，按公网地址读回也和本地文件对不上，见上面 aws 的报错" >&2
      exit 1
    fi
    echo "$name：put-object 报错，但公网读回与本地一致，按已传上处理"
  fi
  echo "$name：已传到 $bucket/$key，用时 $((SECONDS - started)) 秒"
done <<< "$targets"
