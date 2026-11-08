// 从晋级或修复 PR 的正文里取出「## 更新说明」一节，作为 beta 清单的 notes：启动器更新面板显示的就是这段文字。
// 用法：node release-notes.mjs <PR 正文文件> <输出文件>
// 拒收条件不能比香港机 put-manifest 对 notes 的校验宽：那边拒收时包已经签名、传完镜像、建好 Release，发布卡在最后一步。
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const USAGE = "用法：release-notes.mjs <PR 正文文件> <输出文件>";

export const HEADING = "## 更新说明";
// 与 put-manifest 的 MAX_NOTES_CHARS 相同。那边用 Python 的 len 计数，数的是码位，不是 UTF-16 单元也不是字节。
export const MAX_NOTES_CODE_POINTS = 4000;
const NEXT_SECTION = "## ";
// 只用来给出更准的拒收原因：标题行必须逐字相等，差一点的也不认，免得猜错了把别的段落当成说明发出去。
const NEAR_HEADING = /^\s*##\s*更新说明\s*$/;

const hex = (codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

// 控制字符在审批时看的 job summary 和日志里不可见，或被当成终端转义执行：批准时看到的会和发出去的不一样。
// 正常的说明里只会有换行和制表符。
function isForbiddenControl(codePoint) {
  return codePoint !== 0x09 && codePoint !== 0x0a && (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f));
}

function checkNotes(notes) {
  let codePoints = 0;
  let line = 1;
  for (const char of notes) {
    const codePoint = char.codePointAt(0);
    codePoints += 1;
    if (codePoint === 0x0a) line += 1;
    // 配对的代理项在 for...of 里合成一个码位，落到这里的只会是孤立的：put-manifest 拒收，插件解析清单时也会报错。
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new Error(`更新说明第 ${line} 行有孤立的 UTF-16 代理项 ${hex(codePoint)}`);
    if (isForbiddenControl(codePoint)) throw new Error(`更新说明第 ${line} 行有控制字符 ${hex(codePoint)}，只允许换行和制表符`);
  }
  if (codePoints > MAX_NOTES_CODE_POINTS) {
    throw new Error(`更新说明有 ${codePoints} 个字符（按码位计），超过香港机 put-manifest 的上限 ${MAX_NOTES_CODE_POINTS}`);
  }
  // 启动器渲染时丢掉 HTML 注释，job summary 渲染后也看不见：只剩注释的一节在面板上显示为「没有附更新说明」，
  // 带注释的则会把审批时看不到的文字发出去。多半是模板里的提示没删。
  if (notes.includes("<!--")) throw new Error("更新说明里有 HTML 注释（<!--）：启动器不显示注释，请删掉后再发布");
}

export function extractReleaseNotes(body) {
  // GitHub 网页编辑框提交的正文是 CRLF；不先统一，标题行末尾带着 \r 就对不上。
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    if (line === HEADING) {
      starts.push(index);
    } else if (NEAR_HEADING.test(line)) {
      throw new Error(`第 ${index + 1} 行 ${JSON.stringify(line)} 像是更新说明的标题，但标题行必须恰为「${HEADING}」，前后不能有空白`);
    }
  });
  if (starts.length === 0) throw new Error(`PR 正文里没有「${HEADING}」一节：标题要单独占一行，前后不带空白`);
  // 同名标题出现两次时取哪一节都是猜，取错了就把半份说明或别的段落签名发出去。
  if (starts.length > 1) {
    throw new Error(`PR 正文里「${HEADING}」出现了 ${starts.length} 次（第 ${starts.map((index) => index + 1).join("、")} 行），只能有一节`);
  }

  const from = starts[0] + 1;
  const end = lines.findIndex((line, index) => index >= from && line.startsWith(NEXT_SECTION));
  const notes = lines
    .slice(from, end === -1 ? lines.length : end)
    .join("\n")
    .trim();
  if (notes === "") throw new Error(`「${HEADING}」一节是空的`);
  checkNotes(notes);
  return notes;
}

export function runCommand(args) {
  if (args.length !== 2 || args.some((arg) => typeof arg !== "string" || arg === "")) throw new Error(USAGE);
  const [bodyPath, outPath] = args;
  const bytes = readFileSync(bodyPath);
  let body;
  try {
    // 宽松解码会把坏字节悄悄换成 U+FFFD，乱码就跟着签名一起发出去了。开头的 BOM 由 TextDecoder 去掉。
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error.code === "ERR_ENCODING_INVALID_ENCODED_DATA") throw new Error(`PR 正文 ${bodyPath} 不是合法的 UTF-8`, { cause: error });
    throw error;
  }
  const notes = extractReleaseNotes(body);
  // 不补结尾换行：文件内容逐字就是 notes，读的一方 trim 不 trim 结果都一样。
  writeFileSync(outPath, notes, "utf8");
  return `更新说明 ${[...notes].length} 个字符，已写入 ${outPath}\n`;
}

// 按 node 定位入口的同一套解析（realpath 后转 URL）比较：判不出是入口时脚本什么都不做却退出 0，校验就成了摆设。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.stdout.write(runCommand(process.argv.slice(2)));
}
