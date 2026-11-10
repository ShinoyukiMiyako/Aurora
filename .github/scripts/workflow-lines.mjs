// 逐行解析 GitHub Actions 工作流，给按行核对工作流的契约测试共用。
//
// 只看真正执行的行：文件头和步骤上方的注释里也写着这些键和命令，拿全文找子串的话，删掉真正的那一行照样能过。
// .github/scripts 下的脚本只用 node 自带的模块，没有自己的依赖，用不了 YAML 解析器，于是反过来收紧写法：先把每一行分成
// 结构行和块纯量正文（run: | 下面的脚本），结构行只许用工作流现在用到的几种写法。锚点、别名、合并键能把一个作业的
// 凭据原样搬进另一个作业，带引号的键、多行纯量、flow 集合逐行看不出 YAML 最后把它折成了什么，按行比对的检查都会被
// 绕过去，所以这些写法一律判失败；真要用，先把这里的解析补上。
//
// 调用方读好工作流文本传给 parseWorkflow；按作业取行的函数接收它返回的 lines（整份工作流的行）。

import assert from 'node:assert/strict';

const PLAIN_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?=\s|$)(.*)$/s;
const QUOTED = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/;
const BLOCK_HEADER = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/;

/**
 * 把工作流逐行分成 blank、comment、structure（YAML 结构行）和 content（块纯量正文）。块纯量的正文是比它的键更深的行
 * 和其间的空行，正文里的 &&、2>&1、*.mjs 都是 shell，不当 YAML 看。结构行只认 `键: 值`、`- 键: 值`、`- 值` 三种，
 * 键只认不带引号的普通键；认不出、或用了 problems 里那些写法的，逐条记下行号。
 *
 * 单行纯量下面跟着更深的结构行就是续行：YAML 把它折进上一行的值，`if:` 下面多一行 `|| true` 就放宽了条件，
 * 而按行看那一行 if 还是原样。注释行之后再出现更深的行，YAML 会直接报错，所以找下一行时跳过注释与空行，
 * 比它深一律判失败，不必分辨是哪一种。
 *
 * flowAllowed 是允许的 flow 集合，整行比对。flow 集合能跨行、能嵌套，逐行看不出折成了什么，只放行各工作流现有的
 * 那几处；每份工作流的那几处不同，所以由调用方给出，不设缺省。
 */
export function parseWorkflow(text, flowAllowed) {
  if (!Array.isArray(flowAllowed)) throw new TypeError('parseWorkflow 要传入允许的 flow 集合清单（字符串数组）');
  const lines = [];
  const problems = [];
  let blockParent = null;
  let scalarColumn = null;
  for (const [index, raw] of text.split('\n').entries()) {
    // libyaml 一系的解析器把单独的 CR、NEL、U+2028、U+2029 也当换行，按 \n 切行会把它们后面藏着的结构当成同一行
    if (/[\r\u0085\u{2028}\u{2029}]/u.test(raw)) problems.push(`第 ${index + 1} 行含有 YAML 会当成换行的字符`);
    const indent = raw.length - raw.replace(/^ +/, '').length;
    const body = raw.slice(indent);
    if (blockParent !== null && (body.trim() === '' || indent > blockParent)) {
      lines.push({ no: index + 1, raw, kind: 'content', indent });
      continue;
    }
    blockParent = null;
    if (body.trim() === '' || body.startsWith('#')) {
      lines.push({ no: index + 1, raw, kind: body.trim() === '' ? 'blank' : 'comment', indent });
      continue;
    }

    const line = { no: index + 1, raw, kind: 'structure', indent, column: indent, item: false, key: null, valueKind: null };
    lines.push(line);
    const fail = (why) => problems.push(`第 ${line.no} 行${why}：${raw.trim()}`);
    if (scalarColumn !== null && indent > scalarColumn) fail('比上一行的纯量更深，YAML 会把它折进那个值');
    scalarColumn = null;

    let rest = body;
    const dash = /^-(?: +|$)/.exec(rest);
    if (dash !== null) {
      line.item = true;
      line.column += dash[0].length;
      rest = rest.slice(dash[0].length);
    }
    const quotedKey = QUOTED.exec(rest);
    if (quotedKey !== null && /^\s*:(?:\s|$)/.test(rest.slice(quotedKey[0].length))) {
      fail('用了带引号的键');
      continue;
    }
    if (rest.startsWith('<<')) {
      fail('用了合并键');
      continue;
    }
    if (/^\?(?:\s|$)/.test(rest)) {
      fail('用了显式键');
      continue;
    }

    const key = PLAIN_KEY.exec(rest);
    let value;
    // 续行和块纯量正文都要比这一列深：键值对是键所在的列，序列里的纯量是 `-` 所在的列
    let column;
    if (key !== null) {
      line.key = key[1];
      value = key[2].trimStart();
      column = line.column;
    } else if (line.item) {
      // `- run : x` 在 YAML 里也是映射，只是键后面多了空格；当成序列里的纯量放过去，这一步的键就漏看了
      if (/^[^"'[{|>#&*!][^#]*?:(?:\s|$)/.test(rest)) {
        fail('的序列项里有认不出的键');
        continue;
      }
      value = rest;
      column = line.indent;
    } else {
      fail('认不出是什么结构');
      continue;
    }

    if (value === '' || value.startsWith('#')) {
      line.valueKind = 'empty';
    } else if (value.startsWith('&')) {
      fail('用了锚点');
    } else if (value.startsWith('*')) {
      fail('用了别名');
    } else if (value.startsWith('!')) {
      fail('用了标签');
    } else if (/^[|>]/.test(value)) {
      line.valueKind = 'block';
      if (!BLOCK_HEADER.test(value)) fail('的块纯量头认不出');
      blockParent = column;
    } else if (/^[[{]/.test(value)) {
      line.valueKind = 'flow';
      if (!flowAllowed.includes(raw.trim())) fail('用了白名单以外的 flow 集合');
      scalarColumn = column;
    } else if (/^["']/.test(value)) {
      line.valueKind = 'quoted';
      const closed = QUOTED.exec(value);
      if (closed === null) fail('的引号纯量没在本行闭合');
      else if (!/^(?:\s*|\s+#.*)$/.test(value.slice(closed[0].length))) fail('的引号纯量后面还跟着别的内容');
      // 双引号里的转义由 YAML 先解码：写成 \x73ecrets.X 的那一行，GitHub 看到的是 secrets.X，按原文找机密和令牌就找不到
      else if (closed[0].startsWith('"') && closed[0].includes('\\')) fail('的双引号纯量里有转义');
      scalarColumn = column;
    } else if (/^(?:[-?:](?:\s|$)|[,%@`])/.test(value)) {
      fail('的值以 YAML 指示符开头');
    } else {
      line.valueKind = 'plain';
      scalarColumn = column;
    }
  }
  return { lines, problems };
}

export const structure = (lines) => lines.filter((line) => line.kind === 'structure');

/** 真正执行的行，去掉首尾空白：结构行加块纯量正文，不含注释，也不含脚本里的 shell 注释。 */
export const codeOf = (lines) =>
  lines
    .filter((line) => line.kind === 'structure' || line.kind === 'content')
    .map((line) => line.raw.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

/** 机密会落到的行：比 codeOf 多出脚本里的 shell 注释，注释里的 ${{ }} 照样被换成机密的值写进脚本。 */
export const exposedOf = (lines) => lines.filter((line) => line.kind === 'structure' || line.kind === 'content').map((line) => line.raw.trim());

const jobsAt = (lines) => lines.findIndex((line) => line.kind === 'structure' && line.indent === 0 && line.key === 'jobs');

/** jobs 下的作业名，按出现顺序。lines 是 parseWorkflow 返回的整份工作流的 lines。 */
export function jobNames(lines) {
  const names = [];
  for (const line of structure(lines.slice(jobsAt(lines) + 1))) {
    if (line.indent === 0) break;
    if (line.indent === 2) names.push(line.raw.trim().replace(/:$/, ''));
  }
  return names;
}

/** 作业 name 那一段的行：从 `  name:` 起，到下一个同级作业或顶层键之前。lines 是整份工作流的 lines。 */
export function jobLines(lines, name) {
  const jobsIndex = jobsAt(lines);
  const start = lines.findIndex((line, index) => index > jobsIndex && line.kind === 'structure' && line.raw === `  ${name}:`);
  assert.notEqual(start, -1, `工作流里找不到作业 ${name}`);
  const end = lines.findIndex((line, index) => index > start && line.kind === 'structure' && line.indent <= 2);
  return lines.slice(start, end === -1 ? lines.length : end);
}

export const job = (lines, name) => codeOf(jobLines(lines, name));

/** 作业级的键（缩进 4）：if、environment、runs-on 这些必须写在作业上，写进某个步骤里就只管那一步。 */
export const jobKeys = (lines, name) => structure(jobLines(lines, name)).filter((line) => line.indent === 4).map((line) => line.raw.trim());

/** lines 里位于 column 列、值为空的 `key:` 下一层的结构行，去掉行尾注释。 */
export function blockOf(lines, column, key) {
  const at = lines.findIndex((line) => line.kind === 'structure' && line.column === column && line.key === key && line.valueKind === 'empty');
  assert.notEqual(at, -1, `第 ${column} 列上没有 ${key}:`);
  const block = [];
  for (const line of structure(lines.slice(at + 1))) {
    if (line.indent <= column) break;
    block.push(line.raw.trim().replace(/\s+#.*$/, ''));
  }
  return block;
}

export const jobBlock = (lines, name, key) => blockOf(jobLines(lines, name), 4, key);

/** 作业的步骤，每步是它的行：从缩进 6 的 `- ` 起，到下一步或下一个作业级的键之前。lines 是整份工作流的 lines。 */
export function steps(lines, name) {
  const own = jobLines(lines, name);
  const at = own.findIndex((line) => line.kind === 'structure' && line.raw === '    steps:');
  assert.notEqual(at, -1, `作业 ${name} 没有 steps`);
  const result = [];
  for (const line of own.slice(at + 1)) {
    if (line.kind === 'structure' && line.indent <= 4) break;
    if (line.kind === 'structure' && line.indent === 6 && line.item) result.push([line]);
    else if (result.length > 0) result[result.length - 1].push(line);
  }
  return result;
}

/** 步骤自己的键：`- ` 那一行去掉前缀，加上缩进 8 的结构行；块纯量正文不算。 */
export const stepKeys = (step) => structure(step).filter((line) => line.column === 8).map((line) => line.raw.slice(8).trim());

/** 步骤里除去注释和空行的原始行（保留缩进），用来整段比对。 */
export const stepText = (step) => step.filter((line) => line.kind !== 'comment' && line.raw.trim() !== '').map((line) => line.raw);

const SECRET = /\bsecrets\b(?:\s*\.\s*([A-Za-z0-9_-]+)|\s*\[\s*(?:'([^']*)'|"([^"]*)")\s*\])?/gi;

/**
 * 这些行里引用的机密，名字转成大写：表达式里的上下文名和机密名都不分大小写，SECRETS.X、Secrets['x'] 拿到的是同一个。
 * 点名的写法（secrets.X、secrets['X']、secrets["X"]）记名字；toJSON(secrets)、secrets[format(...)]、secrets: inherit
 * 这类一次拿走一批或绕开名字的写法记进 other，测试一律不放行，不然按名字核对就形同虚设。
 */
export function secretsIn(lines) {
  const names = new Set();
  const other = [];
  for (const line of lines) {
    for (const match of line.matchAll(SECRET)) {
      const name = match.slice(1).find((group) => group !== undefined);
      if (name === undefined) other.push(line);
      else names.add(name.toUpperCase());
    }
  }
  return { names: [...names].sort(), other };
}

/** 表达式里取到仓库令牌的写法：github.token，或不点名属性、一次拿走整个上下文（toJSON(github)、github['token']）。不分大小写。 */
export function tokenRefs(lines) {
  const refs = [];
  for (const [expression, inner] of lines.join('\n').matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const match of inner.matchAll(/\bgithub\b(?:\s*\.\s*([A-Za-z0-9_-]+))?/gi)) {
      if (match[1] === undefined || match[1].toLowerCase() === 'token') refs.push(expression);
    }
  }
  return refs;
}
