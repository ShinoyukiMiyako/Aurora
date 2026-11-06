// .github/workflows/beta-release.yml 与客户端之间的契约。工作流只能靠真跑验证，下面这几处一旦走样，运行时不会有任何报错：
// 要么所有 beta 客户端拒收更新，要么防降级、凭据隔离和签名前的审批悄悄失效，而发布钥与正式版共用，失效的代价落在正式版上。
// 放在 node 测试里，是因为 dev-build.yml 每次推送、beta-release.yml 的 build 作业在编译之前都跑 node --test，契约在 CI 上生效。
//
// 只看真正执行的行：文件头和步骤上方的注释里也写着这些键和命令，拿全文找子串的话，删掉真正的那一行照样能过。
// .github/scripts 下的脚本只用 node 自带的模块，没有自己的依赖，用不了 YAML 解析器，于是反过来收紧写法：先把每一行分成
// 结构行和块纯量正文（run: | 下面的脚本），结构行只许用这份文件现在用到的几种写法。锚点、别名、合并键能把一个作业的
// 凭据原样搬进另一个作业，带引号的键、多行纯量、flow 集合逐行看不出 YAML 最后把它折成了什么，按行比对的检查都会被
// 绕过去，所以这些写法一律判失败；真要用，先把这里的解析补上。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const WORKFLOW = readFileSync(new URL('../workflows/beta-release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UPDATER_RS = readFileSync(new URL('../../app/src-tauri/src/commands/updater.rs', import.meta.url), 'utf8');

// beta 客户端唯一会问的清单地址。客户端的 BETA_ENDPOINT 是编译期 concat! 出的整串，build 打包后直接在 Petalfall.exe 里
// 找它（bundle 那一步的 BETA_MANIFEST_URL），stage、publish-hk 读写香港清单用的 HK_MANIFEST_URL 也得是它。
// 这里把三处钉成同一个字面量、核对那段查找还在：改工作流里的地址在这里挂，只改客户端的地址在 CI 打包时挂。
// updater.rs 里把 BETA_ENDPOINT 钉成这个字面量的断言只有本地 cargo test 才跑，下面也核对那句断言还在。
const BETA_MANIFEST_URL = 'https://petalfall.org/updates/beta/latest.json';
const BETA_ONLY = "if: github.ref == 'refs/heads/beta'";
const PETALFALL_EXE = '"$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/Petalfall.exe"';
const BUILD_COMMAND = 'pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis';
const PUBKEY_LINE =
  "conf.plugins = { ...conf.plugins, updater: { pubkey: fs.readFileSync('../.github/release-updater.pub', 'utf8').trim(), requireSignedVersion: true } };";

// 注入公钥那一步的全文。只拦 if、continue-on-error 拦不住同类写法：shell: "true {0}" 把脚本当参数交给 true，
// 脚本开头一句 exit 0、命令后面接 || true，注入都不执行，打出的包不带公钥，用户收不到后续更新。所以键和脚本逐行钉死。
const INJECT_STEP = [
  '      - name: 写入发布更新公钥',
  '        working-directory: app',
  '        run: |',
  '          node -e "',
  "            const fs = require('fs');",
  "            const path = 'src-tauri/tauri.conf.json';",
  "            const conf = JSON.parse(fs.readFileSync(path, 'utf8'));",
  `            ${PUBKEY_LINE}`,
  '            fs.writeFileSync(path, JSON.stringify(conf, null, 2));',
  '          "',
];

// 打包那一步的脚本全文（不含 shell 注释）。只找那几行 grep 拦不住同类写法：把它包进一个从不调用的函数，或在前面
// 插一句 exit 0，exe 里的地址就不再核对，只改客户端地址的情况照样打包成功。和注入那一步一样逐行钉死。
const BUNDLE_SCRIPT = [
  'bundle_dir="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle"',
  BUILD_COMMAND,
  `if ! grep -qF -e "$PETALFALL_MSA_CLIENT_ID" -- ${PETALFALL_EXE}; then`,
  'echo "::error::Petalfall.exe 里没有内嵌微软登录 client_id"',
  'exit 1',
  'fi',
  `if ! grep -qF -e "$PETALFALL_CURSEFORGE_API_KEY" -- ${PETALFALL_EXE}; then`,
  'echo "::error::Petalfall.exe 里没有内嵌 CurseForge API key"',
  'exit 1',
  'fi',
  `if ! grep -qF -e "$BETA_MANIFEST_URL" -- ${PETALFALL_EXE}; then`,
  'echo "::error::Petalfall.exe 里没有测试版的更新清单地址 $BETA_MANIFEST_URL"',
  'exit 1',
  'fi',
  'installer="$bundle_dir/nsis/Petalfall_${VERSION}_x64-setup.exe"',
  'test -f "$installer"',
  'echo "installer=$installer" >> "$GITHUB_OUTPUT"',
  'echo "installer-name=$(basename "$installer")" >> "$GITHUB_OUTPUT"',
];

/** 允许的 flow 集合，整行比对。flow 集合能跨行、能嵌套，逐行看不出折成了什么，只放行现有的这几处。 */
const FLOW_ALLOWED = ['branches: [beta]', 'permissions: {}', 'needs: [build, sign]', 'needs: [build, stage]'];

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
 */
function parseWorkflow(text) {
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
      if (!FLOW_ALLOWED.includes(raw.trim())) fail('用了白名单以外的 flow 集合');
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

const PARSED = parseWorkflow(WORKFLOW);
const LINES = PARSED.lines;

const structure = (lines) => lines.filter((line) => line.kind === 'structure');

/** 真正执行的行，去掉首尾空白：结构行加块纯量正文，不含注释，也不含脚本里的 shell 注释。 */
const codeOf = (lines) =>
  lines
    .filter((line) => line.kind === 'structure' || line.kind === 'content')
    .map((line) => line.raw.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

/** 机密会落到的行：比 codeOf 多出脚本里的 shell 注释，注释里的 ${{ }} 照样被换成机密的值写进脚本。 */
const exposedOf = (lines) => lines.filter((line) => line.kind === 'structure' || line.kind === 'content').map((line) => line.raw.trim());

const CODE = codeOf(LINES);
const JOBS_AT = LINES.findIndex((line) => line.kind === 'structure' && line.indent === 0 && line.key === 'jobs');

/** jobs 下的作业名，按出现顺序。 */
function jobNames() {
  const names = [];
  for (const line of structure(LINES.slice(JOBS_AT + 1))) {
    if (line.indent === 0) break;
    if (line.indent === 2) names.push(line.raw.trim().replace(/:$/, ''));
  }
  return names;
}

/** 作业 name 那一段的行：从 `  name:` 起，到下一个同级作业或顶层键之前。 */
function jobLines(name) {
  const start = LINES.findIndex((line, index) => index > JOBS_AT && line.kind === 'structure' && line.raw === `  ${name}:`);
  assert.notEqual(start, -1, `beta-release.yml 里找不到作业 ${name}`);
  const end = LINES.findIndex((line, index) => index > start && line.kind === 'structure' && line.indent <= 2);
  return LINES.slice(start, end === -1 ? LINES.length : end);
}

const job = (name) => codeOf(jobLines(name));

/** 作业级的键（缩进 4）：if、environment、runs-on 这些必须写在作业上，写进某个步骤里就只管那一步。 */
const jobKeys = (name) => structure(jobLines(name)).filter((line) => line.indent === 4).map((line) => line.raw.trim());

/** lines 里位于 column 列、值为空的 `key:` 下一层的结构行，去掉行尾注释。 */
function blockOf(lines, column, key) {
  const at = lines.findIndex((line) => line.kind === 'structure' && line.column === column && line.key === key && line.valueKind === 'empty');
  assert.notEqual(at, -1, `第 ${column} 列上没有 ${key}:`);
  const block = [];
  for (const line of structure(lines.slice(at + 1))) {
    if (line.indent <= column) break;
    block.push(line.raw.trim().replace(/\s+#.*$/, ''));
  }
  return block;
}

const jobBlock = (name, key) => blockOf(jobLines(name), 4, key);

/** 作业的步骤，每步是它的行：从缩进 6 的 `- ` 起，到下一步或下一个作业级的键之前。 */
function steps(name) {
  const lines = jobLines(name);
  const at = lines.findIndex((line) => line.kind === 'structure' && line.raw === '    steps:');
  assert.notEqual(at, -1, `作业 ${name} 没有 steps`);
  const result = [];
  for (const line of lines.slice(at + 1)) {
    if (line.kind === 'structure' && line.indent <= 4) break;
    if (line.kind === 'structure' && line.indent === 6 && line.item) result.push([line]);
    else if (result.length > 0) result[result.length - 1].push(line);
  }
  return result;
}

/** 步骤自己的键：`- ` 那一行去掉前缀，加上缩进 8 的结构行；块纯量正文不算。 */
const stepKeys = (step) => structure(step).filter((line) => line.column === 8).map((line) => line.raw.slice(8).trim());

/** 步骤里除去注释和空行的原始行（保留缩进），用来整段比对。 */
const stepText = (step) => step.filter((line) => line.kind !== 'comment' && line.raw.trim() !== '').map((line) => line.raw);

const SECRET = /\bsecrets\b(?:\s*\.\s*([A-Za-z0-9_-]+)|\s*\[\s*(?:'([^']*)'|"([^"]*)")\s*\])?/gi;

/**
 * 这些行里引用的机密，名字转成大写：表达式里的上下文名和机密名都不分大小写，SECRETS.X、Secrets['x'] 拿到的是同一个。
 * 点名的写法（secrets.X、secrets['X']、secrets["X"]）记名字；toJSON(secrets)、secrets[format(...)]、secrets: inherit
 * 这类一次拿走一批或绕开名字的写法记进 other，测试一律不放行，不然按名字核对就形同虚设。
 */
function secretsIn(lines) {
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
function tokenRefs(lines) {
  const refs = [];
  for (const [expression, inner] of lines.join('\n').matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const match of inner.matchAll(/\bgithub\b(?:\s*\.\s*([A-Za-z0-9_-]+))?/gi)) {
      if (match[1] === undefined || match[1].toLowerCase() === 'token') refs.push(expression);
    }
  }
  return refs;
}

describe('beta 发布工作流的契约', () => {
  it('结构行只用解析得了的写法：没有锚点、别名、合并键、带引号的键、续行和白名单以外的 flow 集合', () => {
    assert.deepEqual(PARSED.problems, []);
  });

  // 工作流级的 env 会进每一个作业，机密或令牌放在那里，按作业核对凭据就落空了；jobs 之后再起一个顶层段同理。
  // shell 能把脚本换成任意程序去跑（"true {0}" 什么也不执行），只许顶层 defaults 里的 bash 一处。
  it('顶层只有这几个键，没有工作流级 env，shell 只在顶层 defaults 里设成 bash', () => {
    assert.deepEqual(
      structure(LINES)
        .filter((line) => line.indent === 0)
        .map((line) => line.key),
      ['name', 'on', 'concurrency', 'permissions', 'defaults', 'jobs'],
    );
    assert.deepEqual(blockOf(LINES, 0, 'defaults'), ['run:', 'shell: bash']);
    assert.deepEqual(
      structure(LINES)
        .filter((line) => line.key !== null && ['shell', 'defaults'].includes(line.key.toLowerCase()))
        .map((line) => line.raw),
      ['defaults:', '    shell: bash'],
    );
  });

  it('作业只有这四个，挂了环境的都在作业级限定只在 beta 上跑', () => {
    assert.deepEqual(jobNames(), ['build', 'sign', 'stage', 'publish-hk']);
    for (const [name, environment] of [
      ['sign', 'release-signing'],
      ['stage', 'updates-beta'],
      ['publish-hk', 'updates-beta'],
    ]) {
      const keys = jobKeys(name);
      assert.ok(keys.includes(`environment: ${environment}`), `${name} 应在作业级挂环境 ${environment}`);
      // 写进某一步的 if 只跳过那一步，作业照样启动、照样申请环境。条件只许是单独一行的 BETA_ONLY：
      // 块纯量和续行都会被 YAML 折成一个更宽的条件，而首行看着没变。
      const lines = jobLines(name);
      const conditions = structure(lines).filter((line) => line.indent === 4 && /^["']?if["']?\s*:/i.test(line.raw.trim()));
      assert.deepEqual(
        conditions.map((line) => line.raw.trim()),
        [BETA_ONLY],
        `${name} 挂了环境却没在作业级限定在 beta 上跑`,
      );
      const following = structure(lines.slice(lines.indexOf(conditions[0]) + 1));
      assert.ok(following.length > 0, `${name} 的作业级 if 之后没有别的键`);
      assert.ok(following[0].indent <= 4, `${name} 的作业级 if 下面还有续行：${following[0].raw.trim()}`);
    }
  });

  it('只认 beta 的推送和手动演练，同一分支串行、不取消', () => {
    const top = structure(LINES).map((line) => line.raw.trim());
    const on = top.indexOf('on:');
    assert.notEqual(on, -1, '工作流里没有 on:');
    assert.deepEqual(top.slice(on, on + 4), ['on:', 'push:', 'branches: [beta]', 'workflow_dispatch:']);
    assert.equal(top[on + 4], 'concurrency:', '触发条件不止 beta 的推送和手动演练');
    assert.deepEqual(top.slice(on + 5, on + 7), ['group: beta-release-${{ github.ref_name }}', 'cancel-in-progress: false']);
    assert.ok(
      structure(LINES).some((line) => line.indent === 0 && line.raw === 'permissions: {}'),
      '顶层不该给任何权限',
    );
  });

  // 只有作业里的机密才按作业核对得到；工作流级 env、concurrency 这些地方引用的机密，不在任何一个作业的核对范围里。
  it('四个作业之外哪里都不引用机密', () => {
    const inJobs = new Set(['build', 'sign', 'stage', 'publish-hk'].flatMap((name) => jobLines(name)));
    const outside = LINES.filter((line) => !inJobs.has(line));
    assert.deepEqual(secretsIn(exposedOf(outside)), { names: [], other: [] });
  });

  it('build 在一次性托管机上跑、不挂环境，只拿要编进包里的 CurseForge key', () => {
    const keys = jobKeys('build');
    assert.ok(!keys.some((line) => line.startsWith('environment:')), 'build 作业不该声明环境');
    assert.ok(keys.includes('runs-on: ubuntu-24.04'), 'build 作业不再跑在一次性托管机上');
    assert.deepEqual(secretsIn(exposedOf(jobLines('build'))), { names: ['PETALFALL_CURSEFORGE_API_KEY'], other: [] });
    assert.deepEqual(jobBlock('build', 'permissions'), ['contents: read', 'pull-requests: read']);
  });

  // 换成 dev 的公钥，所有 beta 客户端拒收发布钥签的包；漏了开关，detect_support 判为不支持，beta 包收不到任何更新。
  // 整行比对，多带一项（比如 allowDowngrades）也要挂。注入必须紧挨着打包、无条件执行，打包那一步在 pnpm tauri build
  // 之前也不做别的：中间多一步或多一行（比如把 tauri.conf.json 还原回去），打出的包同样不带公钥。
  it('build 紧挨着打包无条件注入发布公钥并打开 requireSignedVersion', () => {
    assert.deepEqual(CODE.filter((line) => line.includes('conf.plugins')), [PUBKEY_LINE]);
    const buildSteps = steps('build');
    const inject = buildSteps.findIndex((step) => codeOf(step).includes(PUBKEY_LINE));
    assert.notEqual(inject, -1, '更新插件的配置不再写在 build 作业里');
    assert.deepEqual(stepText(buildSteps[inject]), INJECT_STEP, '注入公钥那一步多了键、改了脚本，注入可能不再执行');
    const bundle = buildSteps.findIndex((step) => codeOf(step).includes(BUILD_COMMAND));
    assert.notEqual(bundle, -1, `build 作业里找不到打包启动器的那一步：${BUILD_COMMAND}`);
    assert.equal(bundle, inject + 1, '注入公钥与打包之间夹了别的步骤，或排到了打包之后');
    const script = codeOf(buildSteps[bundle].filter((line) => line.kind === 'content'));
    assert.deepEqual(script.slice(0, 2), ['bundle_dir="$CARGO_TARGET_DIR/x86_64-pc-windows-msvc/release/bundle"', BUILD_COMMAND]);
  });

  // 地址核对写在打包那一步里，这一步多一个 if 或 continue-on-error 就等于没查；env 也逐项钉住，免得在这里改写配置。
  it('打包后在 Petalfall.exe 里核对测试版清单地址，查不到就失败', () => {
    const bundle = steps('build').find((step) => codeOf(step).includes(BUILD_COMMAND));
    assert.notEqual(bundle, undefined, `build 作业里找不到打包启动器的那一步：${BUILD_COMMAND}`);
    assert.deepEqual(stepKeys(bundle), ['name: 构建 Windows 安装包', 'id: bundle', 'working-directory: app', 'env:', 'run: |']);
    assert.deepEqual(blockOf(bundle, 8, 'env'), ['VERSION: ${{ steps.version.outputs.version }}', `BETA_MANIFEST_URL: ${BETA_MANIFEST_URL}`]);
    assert.deepEqual(
      codeOf(bundle.filter((line) => line.kind === 'content')),
      BUNDLE_SCRIPT,
      '打包那一步的脚本变了，exe 里的核对可能不再执行',
    );
  });

  // 客户端开了 requireSignedVersion，签名时不把版本号写进可信注释，插件拒收每一个 beta 包。
  // 签完按仓库里的发布公钥验签、核对签名里的版本，私钥配错或漏传版本在这里挡下，不等用户拒收。
  it('sign 把版本号写进可信注释，签完按发布公钥验签', () => {
    const sign = job('sign');
    const signing = sign.filter((line) => line.includes('signer sign'));
    assert.equal(signing.length, 1, `sign 作业里应恰有一条签名命令：${signing}`);
    assert.ok(signing[0].includes('signer sign --app-version "$VERSION" '), `签名不再把版本号写进可信注释：${signing[0]}`);
    // 发布钥不设口令，口令一项缺省时 CLI 会等终端输入，托管机上作业挂到超时。
    assert.ok(signing[0].includes(" --password '' "), `签名命令没有显式传空口令：${signing[0]}`);
    assert.ok(
      sign.includes('run: node .github/scripts/verify-update-signature.mjs .github/release-updater.pub "$BOOTSTRAP" "$BOOTSTRAP.sig" "$VERSION"'),
      '签完不再按发布公钥验签、核对签名里的版本',
    );
  });

  // 持私钥的作业拿不到任何发布渠道：桶凭据、香港推送钥、能写仓库的令牌都不在这里，借道 sign 签出来的包自己发不出去。
  it('sign 只拿发布私钥，没有任何写权限', () => {
    const sign = job('sign');
    for (const prefix of ['OSS_', 'R2_', 'HK_']) {
      assert.deepEqual(sign.filter((line) => line.toUpperCase().includes(prefix)), [], `sign 作业里出现了 ${prefix} 开头的凭据`);
    }
    assert.deepEqual(secretsIn(exposedOf(jobLines('sign'))), { names: ['RELEASE_UPDATER_PRIVATE_KEY'], other: [] });
    assert.deepEqual(tokenRefs(exposedOf(jobLines('sign'))), [], 'sign 作业不该拿仓库令牌');
    assert.deepEqual(jobBlock('sign', 'permissions'), ['contents: read']);
  });

  it('桶凭据只进 stage，香港推送钥只进 publish-hk', () => {
    assert.deepEqual(secretsIn(exposedOf(jobLines('stage'))), {
      names: ['OSS_CI_ACCESS_KEY_ID', 'OSS_CI_ACCESS_KEY_SECRET', 'R2_CI_ACCESS_KEY_ID', 'R2_CI_SECRET_ACCESS_KEY'],
      other: [],
    });
    assert.deepEqual(secretsIn(exposedOf(jobLines('publish-hk'))), { names: ['HK_MANIFEST_SSH_KEY'], other: [] });
    assert.deepEqual(jobBlock('publish-hk', 'permissions'), ['contents: read']);
  });

  // 桶上同一个键只能写一次。传完包才失败的运行不建 tag，下一次运行算出同一个 beta.N，只带运行次数的话又从 1 起，
  // 键就撞上上次留下、覆盖不了的对象；dev-distribution.mjs 认的运行标识是 <运行号>-<运行次数>。
  it('stage 按运行标识算对象键、生成和校验清单', () => {
    const calls = job('stage').filter((line) => /dev-distribution\.mjs (?:key|build|validate) /.test(line));
    assert.equal(calls.length, 4, `stage 里调用 key、build、validate 的地方变了：${calls}`);
    for (const call of calls) {
      assert.ok(call.includes('"$VERSION" "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" '), `对象键没带运行标识：${call}`);
    }
  });

  // beta 客户端只问这一个地址：推送后回读、发布前比版本，读的都得是它，否则推上去了也核对不到客户端看到的那份。
  it('stage 与 publish-hk 读写的香港清单、bundle 在 exe 里找的地址，都是客户端的 BETA_ENDPOINT', () => {
    const declared = structure(LINES).filter((line) => line.key === 'HK_MANIFEST_URL' || line.key === 'BETA_MANIFEST_URL');
    assert.ok(declared.length > 0, '工作流里不再声明清单地址');
    for (const line of declared) assert.equal(line.raw.trim(), `${line.key}: ${BETA_MANIFEST_URL}`, `第 ${line.no} 行的清单地址变了`);
    const expected = `HK_MANIFEST_URL: ${BETA_MANIFEST_URL}`;
    const readsHkManifest = (line) => line.includes('curl ') && line.includes('"$HK_MANIFEST_URL"');

    const publishHk = job('publish-hk');
    assert.ok(jobBlock('publish-hk', 'env').includes(expected), 'publish-hk 不再在作业级声明 beta 清单地址');
    assert.ok(publishHk.includes('run: bash .github/scripts/push-hk-manifest.sh "$MANIFEST"'), 'publish-hk 不再推送香港清单');
    assert.ok(
      publishHk.some((line) => readsHkManifest(line) && line.includes("--write-out '%{content_type}'")),
      'publish-hk 推送之后不再经公网回读香港清单、核对 Content-Type',
    );
    assert.ok(jobBlock('stage', 'env').includes(expected), 'stage 不再在作业级声明 beta 清单地址');
    assert.ok(job('stage').some(readsHkManifest), 'stage 不再读香港清单检查版本号有没有倒退');
    const bundle = steps('build').find((step) => codeOf(step).includes(BUILD_COMMAND));
    assert.ok(blockOf(bundle, 8, 'env').includes(`BETA_MANIFEST_URL: ${BETA_MANIFEST_URL}`), 'bundle 不再声明要在 exe 里找的清单地址');

    // rustfmt 会把断言拆成几行，去掉空白再比
    assert.ok(
      UPDATER_RS.replace(/\s+/g, '').includes(`assert_eq!(BETA_ENDPOINT,"${BETA_MANIFEST_URL}"`),
      'updater.rs 不再把 BETA_ENDPOINT 钉成同一个地址，两边要一起改',
    );
  });
});

describe('契约用到的解析', () => {
  /** 只留下每条问题的原因，去掉行号和原文。 */
  const whyOf = (text) => parseWorkflow(text).problems.map((problem) => problem.replace(/^第 \d+ 行/, '').replace(/：[\s\S]*$/, ''));

  it('认得出各种机密写法，名字不分大小写', () => {
    assert.deepEqual(secretsIn(['A: ${{ secrets.X_1 }}', 'B: ${{ SECRETS.y }} ${{ Secrets . X_1 }}']), { names: ['X_1', 'Y'], other: [] });
    assert.deepEqual(secretsIn(["K: ${{ secrets['k'] }}", 'L: ${{ SECRETS[ "L" ] }}']), { names: ['K', 'L'], other: [] });
    const bulk = ['ALL: ${{ toJSON(SECRETS) }}', 'secrets: inherit', "M: ${{ secrets[format('{0}', 'X')] }}"];
    assert.deepEqual(secretsIn(bulk), { names: [], other: bulk });
    assert.deepEqual(secretsIn(['run: echo "$SECRETS_DIR" ${{ secrets_x }}']), { names: [], other: [] });
  });

  it('认得出取仓库令牌的写法，不分大小写', () => {
    const lines = ['T: ${{ GitHub.Token }}', 'C: ${{ toJSON(github) }}', 'W: ${{ github.workspace }}/x', 'P: .github/x ${{ secrets.GITHUB_TOKEN }}'];
    assert.deepEqual(tokenRefs(lines), ['${{ GitHub.Token }}', '${{ toJSON(github) }}']);
  });

  it('块纯量正文不当结构行，脚本里的 &&、2>&1、*.mjs、引号键都不误报', () => {
    const { lines, problems } = parseWorkflow(['a:', '  run: |', '    echo *.mjs && b 2>&1 | c', '    "x": &y', '', '    # 注释', '  if: always()'].join('\n'));
    assert.deepEqual(problems, []);
    assert.deepEqual(
      lines.map((line) => line.kind),
      ['structure', 'structure', 'content', 'content', 'content', 'content', 'structure'],
    );
  });

  it('脚本里 shell 注释中的机密照样算引用，YAML 注释里的不算', () => {
    const { lines } = parseWorkflow(['a:', '  # ${{ secrets.YAML_COMMENT }}', '  run: |', '    # ${{ secrets.SHELL_COMMENT }}', '    echo'].join('\n'));
    assert.deepEqual(secretsIn(exposedOf(lines)), { names: ['SHELL_COMMENT'], other: [] });
  });

  it('步骤自己的键不含 run 脚本里的行', () => {
    const { lines } = parseWorkflow(['      - name: 写入', '        if: always()', '        run: |', '          if: not-a-key', '          echo'].join('\n'));
    assert.deepEqual(stepKeys(lines), ['name: 写入', 'if: always()', 'run: |']);
  });

  it('锚点、别名、合并键、带引号的键、标签和认不出的写法都判失败', () => {
    assert.deepEqual(whyOf('a:\n  env: &creds\n    K: v\nb:\n  env: *creds'), ['用了锚点', '用了别名']);
    assert.deepEqual(whyOf('a:\n  env:\n    <<: *creds'), ['用了合并键']);
    assert.deepEqual(whyOf("a:\n  \"if\": false\n  - 'continue-on-error': true"), ['用了带引号的键', '用了带引号的键']);
    assert.deepEqual(whyOf('a:\n  - &x name: y\n  b: !!str 1'), ['用了锚点', '用了标签']);
    assert.deepEqual(whyOf('? a\n: b'), ['用了显式键', '认不出是什么结构']);
    assert.deepEqual(whyOf('a: - x\nb: @x\nc: |x\nd: |-\n  y'), ['的值以 YAML 指示符开头', '的值以 YAML 指示符开头', '的块纯量头认不出']);
    assert.deepEqual(whyOf('a:\n  - run : echo x\n  - name x: y\n  - beta'), ['的序列项里有认不出的键', '的序列项里有认不出的键']);
  });

  it('双引号纯量里的转义判失败，单引号和不带反斜杠的双引号不算', () => {
    assert.deepEqual(whyOf('a:\n  K: "${{ \\x73ecrets.X }}"\n  T: "${{ \\u0067ithub.token }}"'), ['的双引号纯量里有转义', '的双引号纯量里有转义']);
    assert.deepEqual(whyOf('a:\n  B: "1"\n  C: \'x\\y\''), []);
  });

  it('多行纯量、多行引号纯量和下一行才写的值都判失败', () => {
    const folded = '比上一行的纯量更深，YAML 会把它折进那个值';
    assert.deepEqual(whyOf("a:\n  if: x == 'y'\n    || true"), [folded, '认不出是什么结构']);
    assert.deepEqual(whyOf('a:\n  if: x\n  # 注释\n\n    - y'), [folded]);
    assert.deepEqual(whyOf('a:\n  if: "x\n    || y"'), ['的引号纯量没在本行闭合', folded, '认不出是什么结构']);
    assert.deepEqual(whyOf('a:\n  if:\n    x || y'), ['认不出是什么结构']);
    assert.deepEqual(whyOf('a:\n  if: >-\n    x\n  b: "1" c'), ['的引号纯量后面还跟着别的内容']);
  });

  it('YAML 会当成换行的其它字符判失败，正文里的也算', () => {
    assert.deepEqual(whyOf('a: x\u{2028}  <<: *y\nb: x\rc: y\nd: |\n  e\u0085f\u{2029}'), [
      '含有 YAML 会当成换行的字符',
      '含有 YAML 会当成换行的字符',
      '含有 YAML 会当成换行的字符',
    ]);
  });

  it('flow 集合只放行白名单里的那几行', () => {
    assert.deepEqual(whyOf('permissions: {}\nwith: {a: 1}\nneeds: [build, sign]\nneeds: [build]'), [
      '用了白名单以外的 flow 集合',
      '用了白名单以外的 flow 集合',
    ]);
  });
});
