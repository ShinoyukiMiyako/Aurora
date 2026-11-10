// .github/workflows/beta-release.yml 与客户端之间的契约。工作流只能靠真跑验证，下面这几处一旦走样，运行时不会有任何报错：
// 要么所有 beta 客户端拒收更新，要么防降级、凭据隔离和签名前的审批悄悄失效，而发布钥与正式版共用，失效的代价落在正式版上。
// 放在 node 测试里，是因为 dev-build.yml 每次推送、beta-release.yml 的 build 作业在编译之前都跑 node --test，契约在 CI 上生效。
//
// 只看真正执行的行：文件头和步骤上方的注释里也写着这些键和命令，拿全文找子串的话，删掉真正的那一行照样能过。
// 逐行解析与按作业、步骤取行的规则在 workflow-lines.mjs，为什么收紧 YAML 写法也写在那里。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  blockOf,
  codeOf,
  exposedOf,
  job,
  jobBlock,
  jobKeys,
  jobLines,
  jobNames,
  parseWorkflow,
  secretsIn,
  stepKeys,
  stepText,
  steps,
  structure,
  tokenRefs,
} from './workflow-lines.mjs';

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

// 下面三步是挡违规构建的闸，脚本同样逐行钉死（不含 shell 注释），理由与打包那一步相同：前面插一句 exit 0、
// 命令后面接 || true、包进一个从不调用的函数，检查就不再执行，构建却照样成功。
// 读出各通道已发布的版本：三条命令一条不少，模式只由分支定，beta 上是 release，别处的演练是 rehearsal。
const HEADS_SCRIPT = [
  'mode=release',
  'if [ "$GITHUB_REF" != refs/heads/beta ]; then',
  'mode=rehearsal',
  'fi',
  'node .github/scripts/release-heads.mjs read "$GITHUB_REPOSITORY" "$HEADS"',
  'node .github/scripts/release-heads.mjs gate beta "$mode" "$VERSION" "$HEADS"',
  'node .github/scripts/release-heads.mjs data-format beta "$mode" "$HEADS" "$GITHUB_REPOSITORY"',
];

// 核对载荷头：读回的四项交给 release-heads.mjs payload 按源码核对，通过之后才写出给构建信息用的三项。
const PAYLOAD_SCRIPT = [
  'fields="$(cargo run --release --locked -p petalfall-setup-payload --bin inspect-setup -- "$BOOTSTRAP")"',
  "IFS=$'\\t' read -r magic header_version data_format caps <<< \"$fields\"",
  'node .github/scripts/release-heads.mjs payload "$VERSION" "$magic" "$header_version" "$data_format" "$caps"',
  'echo "magic=$magic" >> "$GITHUB_OUTPUT"',
  'echo "data-format=$data_format" >> "$GITHUB_OUTPUT"',
  'echo "caps=$caps" >> "$GITHUB_OUTPUT"',
];

// 核对内嵌的更新公钥：两个 .pub 文件都找，去掉首尾空白的写法与注入那一行相同；空串对 grep -F 处处命中、多行只要一行
// 命中就算，所以先要求是一行 base64。
const PUBKEYS_SCRIPT = [
  'for pub in .github/dev-updater.pub .github/release-updater.pub; do',
  `key="$(node -p "require('fs').readFileSync(process.argv[1], 'utf8').trim()" "$pub")"`,
  'if ! [[ "$key" =~ ^[A-Za-z0-9+/]+=*$ ]]; then',
  'echo "::error::$pub 去掉首尾空白后不是一行 base64"',
  'exit 1',
  'fi',
  `if ! grep -qF -e "$key" -- ${PETALFALL_EXE}; then`,
  'echo "::error::Petalfall.exe 里没有内嵌 $pub 里的更新公钥"',
  'exit 1',
  'fi',
  'done',
];

const LOCKED_CLI_CALL = 'node .github/scripts/locked-cli.mjs app/pnpm-lock.yaml "$CLI_VERSION" > "$RUNNER_TEMP/tauri-cli.tsv"';

/** 允许的 flow 集合，整行比对。flow 集合能跨行、能嵌套，逐行看不出折成了什么，只放行现有的这几处。 */
const FLOW_ALLOWED = ['branches: [beta]', 'permissions: {}', 'needs: [build, sign]', 'needs: [build, stage]'];

const PARSED = parseWorkflow(WORKFLOW, FLOW_ALLOWED);
const LINES = PARSED.lines;
const CODE = codeOf(LINES);

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
    assert.deepEqual(jobNames(LINES), ['build', 'sign', 'stage', 'publish-hk']);
    for (const [name, environment] of [
      ['sign', 'release-signing'],
      ['stage', 'updates-beta'],
      ['publish-hk', 'updates-beta'],
    ]) {
      const keys = jobKeys(LINES, name);
      assert.ok(keys.includes(`environment: ${environment}`), `${name} 应在作业级挂环境 ${environment}`);
      // 写进某一步的 if 只跳过那一步，作业照样启动、照样申请环境。条件只许是单独一行的 BETA_ONLY：
      // 块纯量和续行都会被 YAML 折成一个更宽的条件，而首行看着没变。
      const lines = jobLines(LINES, name);
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
    const inJobs = new Set(['build', 'sign', 'stage', 'publish-hk'].flatMap((name) => jobLines(LINES, name)));
    const outside = LINES.filter((line) => !inJobs.has(line));
    assert.deepEqual(secretsIn(exposedOf(outside)), { names: [], other: [] });
  });

  it('build 在一次性托管机上跑、不挂环境，只拿要编进包里的 CurseForge key', () => {
    const keys = jobKeys(LINES, 'build');
    assert.ok(!keys.some((line) => line.startsWith('environment:')), 'build 作业不该声明环境');
    assert.ok(keys.includes('runs-on: ubuntu-24.04'), 'build 作业不再跑在一次性托管机上');
    assert.deepEqual(secretsIn(exposedOf(jobLines(LINES, 'build'))), { names: ['PETALFALL_CURSEFORGE_API_KEY'], other: [] });
    assert.deepEqual(jobBlock(LINES, 'build', 'permissions'), ['contents: read', 'pull-requests: read']);
  });

  // 换成 dev 的公钥，所有 beta 客户端拒收发布钥签的包；漏了开关，detect_support 判为不支持，beta 包收不到任何更新。
  // 整行比对，多带一项（比如 allowDowngrades）也要挂。注入必须紧挨着打包、无条件执行，打包那一步在 pnpm tauri build
  // 之前也不做别的：中间多一步或多一行（比如把 tauri.conf.json 还原回去），打出的包同样不带公钥。
  it('build 紧挨着打包无条件注入发布公钥并打开 requireSignedVersion', () => {
    assert.deepEqual(CODE.filter((line) => line.includes('conf.plugins')), [PUBKEY_LINE]);
    const buildSteps = steps(LINES, 'build');
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
    const bundle = steps(LINES, 'build').find((step) => codeOf(step).includes(BUILD_COMMAND));
    assert.notEqual(bundle, undefined, `build 作业里找不到打包启动器的那一步：${BUILD_COMMAND}`);
    assert.deepEqual(stepKeys(bundle), ['name: 构建 Windows 安装包', 'id: bundle', 'working-directory: app', 'env:', 'run: |']);
    assert.deepEqual(blockOf(bundle, 8, 'env'), ['VERSION: ${{ steps.version.outputs.version }}', `BETA_MANIFEST_URL: ${BETA_MANIFEST_URL}`]);
    assert.deepEqual(
      codeOf(bundle.filter((line) => line.kind === 'content')),
      BUNDLE_SCRIPT,
      '打包那一步的脚本变了，exe 里的核对可能不再执行',
    );
  });

  // 同一基础号下 beta < dev < 正式版，测试版低于预览版、核心号高于已发布的正式版都不会自然成立，靠这一步挡。
  // 它要拿确定版本号定出的版本去比，又要在编译之前做完：排到注入公钥之后，挡下的版本已经白编了一遍。
  // 这一步多一个 if、continue-on-error，或脚本里少一条命令，不低于预览版、基础号已出过正式版、数据格式号倒退
  // 或单独摘进来的测试版照样签名发布。
  it('确定版本号之后、注入公钥之前读出各通道已发布的版本，跑 read、gate beta、data-format beta', () => {
    const buildSteps = steps(LINES, 'build');
    const version = buildSteps.findIndex((step) => stepKeys(step).includes('id: version'));
    const heads = buildSteps.findIndex((step) => stepKeys(step).includes('id: heads'));
    const inject = buildSteps.findIndex((step) => codeOf(step).includes(PUBKEY_LINE));
    assert.notEqual(version, -1, 'build 作业里找不到确定版本号那一步（id: version）');
    assert.notEqual(heads, -1, 'build 作业里找不到读出各通道已发布的版本那一步（id: heads）');
    assert.notEqual(inject, -1, '更新插件的配置不再写在 build 作业里');
    assert.ok(version < heads, '读出各通道已发布的版本排到了确定版本号之前，拿不到要检查的本包版本');
    assert.ok(heads < inject, '读出各通道已发布的版本排到了注入公钥之后：版本先后要在编译之前查完');
    const step = buildSteps[heads];
    assert.deepEqual(
      stepKeys(step),
      ['name: 读出各通道已发布的版本', 'id: heads', 'env:', 'run: |'],
      '读出各通道已发布的版本那一步多了键（if、continue-on-error、shell 之类），检查可能不执行，或不过也不挡构建',
    );
    assert.deepEqual(
      blockOf(step, 8, 'env'),
      ['VERSION: ${{ steps.version.outputs.version }}', 'HEADS: ${{ runner.temp }}/release-heads.json'],
      '读出各通道已发布的版本查的不再是确定版本号定出的本包版本，或 heads 文件换了地方、写构建信息读不到',
    );
    assert.deepEqual(
      codeOf(step.filter((line) => line.kind === 'content')),
      HEADS_SCRIPT,
      '读出各通道已发布的版本的脚本变了：read、gate beta、data-format beta 少了一条，模式不再只由分支定，或插了让检查不执行的命令',
    );
  });

  // 正式版那一条改由 gate beta 按验过签的结果查。未验签的清单谁改得了香港机上的文件、谁能在半路改写响应，
  // 谁就能让它显示任意版本，按它比，测试版能不能发就由伪造的人说了算；地址变量留着，迟早又被拿去读。
  it('不再读未验签的正式版清单，也不再声明它的地址', () => {
    assert.ok(!WORKFLOW.includes('STABLE_MANIFEST_URL'), '工作流里又出现了 STABLE_MANIFEST_URL，正式版清单只能经 release-heads.mjs 验签后采信');
    assert.deepEqual(
      CODE.filter((line) => line.includes('/updates/stable/')),
      [],
      '工作流又直接读正式版清单：版本先后只能按 release-heads.mjs 验过签的结果比',
    );
  });

  // 构建首装引导程序之后才有要核对的引导程序与 exe；两步排在写构建信息之前，审批摘要里的载荷头就是核对过的值。
  // 载荷头写错、漏编一把公钥，编译与打包都不报错，坏在用户那头，所以两步都不许带 if、continue-on-error，
  // 作业级的 continue-on-error 同样会让核对失败的作业不再判这次运行失败，一并不许。
  it('构建首装引导程序之后依次核对载荷头与内嵌的更新公钥，两步都无条件执行', () => {
    const buildSteps = steps(LINES, 'build');
    const at = (key) => buildSteps.findIndex((step) => stepKeys(step).includes(key));
    const order = [
      ['构建首装引导程序（id: bootstrap）', at('id: bootstrap')],
      ['核对载荷头（id: payload）', at('id: payload')],
      ['核对内嵌的更新公钥', at('name: 核对内嵌的更新公钥')],
      ['写构建信息（id: info）', at('id: info')],
    ];
    for (const [what, index] of order) assert.notEqual(index, -1, `build 作业里找不到 ${what} 那一步`);
    const indexes = order.map(([, index]) => index);
    assert.deepEqual(
      [...indexes].sort((a, b) => a - b),
      indexes,
      `顺序应为 ${order.map(([what]) => what).join('、')}，实际排在第 ${indexes.join('、')} 步`,
    );
    const [payload, pubkeys] = [buildSteps[indexes[1]], buildSteps[indexes[2]]];
    for (const step of [payload, pubkeys]) {
      const keys = stepKeys(step);
      assert.deepEqual(
        keys.filter((key) => /^(?:if|continue-on-error)\s*:/i.test(key)),
        [],
        `${keys[0]} 带了 if 或 continue-on-error：核对可能不执行，或失败了也不挡构建`,
      );
    }
    assert.ok(
      !jobKeys(LINES, 'build').some((key) => /^continue-on-error\s*:/i.test(key)),
      'build 作业级带了 continue-on-error：核对失败的作业不再判这次运行失败',
    );

    assert.deepEqual(stepKeys(payload), ['name: 核对载荷头', 'id: payload', 'env:', 'run: |'], '核对载荷头那一步多了键，核对可能不执行');
    assert.deepEqual(
      blockOf(payload, 8, 'env'),
      ['VERSION: ${{ steps.version.outputs.version }}', 'BOOTSTRAP: ${{ steps.bootstrap.outputs.bootstrap }}'],
      '核对载荷头比的不再是本包版本，或读的不再是构建出的那份引导程序',
    );
    assert.deepEqual(
      codeOf(payload.filter((line) => line.kind === 'content')),
      PAYLOAD_SCRIPT,
      '核对载荷头的脚本变了：读回的四项可能不再全部交给 release-heads.mjs payload 核对',
    );
    assert.deepEqual(stepKeys(pubkeys), ['name: 核对内嵌的更新公钥', 'run: |'], '核对内嵌的更新公钥那一步多了键，核对可能不执行');
    assert.deepEqual(
      codeOf(pubkeys.filter((line) => line.kind === 'content')),
      PUBKEYS_SCRIPT,
      '核对内嵌的更新公钥的脚本变了：两个 .pub 文件可能不再都在 Petalfall.exe 里找',
    );
  });

  // CI 上不跑启动器的 Rust 测试，版本序、数据格式号与安装判定这些共用规则，只能靠这一行随每次构建在托管机上跑到。
  it('跑 Rust 测试的那一行带上 petalfall-release', () => {
    assert.deepEqual(
      job(LINES, 'build').filter((line) => /\bcargo\s+test\b/.test(line)),
      ['cargo test --release --locked -p petalfall-setup-payload -p petalfall-release'],
      'build 作业里跑 Rust 测试的那一行变了：共用包 petalfall-release 的规则测试要和载荷格式的测试一起跑',
    );
  });

  // 换钥时 CI 里打包、签名、验签都对得上，坏在已装旧版的用户那头：他们只认编进旧包的公钥，换钥之后发的更新全被拒收。
  // 所以把密钥号钉死，换钥必须连这里一起改；顺带挡住把开发版公钥误当发布公钥提交。密钥号写成验签脚本输出的样子
  // （小写十六进制，和 minisign 注释里那串字节序相反）。公钥文件是 minisign 公钥框整个再做一次 base64，
  // 框的第二行解出 42 字节：算法 Ed、8 字节密钥号、32 字节 Ed25519 公钥。
  const keyNumber = (name) => {
    const box = Buffer.from(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').trim(), 'base64').toString('utf8').split('\n');
    const key = Buffer.from(box[1].trim(), 'base64');
    assert.equal(key.length, 42, `${name} 解出的公钥不是 42 字节`);
    assert.equal(key.subarray(0, 2).toString(), 'Ed', `${name} 的算法不是 Ed`);
    return key.subarray(2, 10).toString('hex');
  };

  it('发布公钥是记录在案的那把，不是开发版的', () => {
    assert.equal(keyNumber('release-updater.pub'), 'aeeab33bdc36d624');
    assert.notEqual(keyNumber('release-updater.pub'), keyNumber('dev-updater.pub'));
  });

  // 启动器把开发版公钥也编进每个包，偏好为预览版时拿它验 dev 的清单与包，已装预览版的用户同样只认编进旧包的那把。
  // 钉住它，换钥必须连这里一起改；在一次性分支上换成测试钥做的夹具，到了正式流水线编译之前就在这里挂掉，混不进发出去的包。
  it('开发版公钥也是记录在案的那把', () => {
    assert.equal(keyNumber('dev-updater.pub'), 'a85c28a4343f0962', '开发版公钥换了，或提交进来的是测试钥');
  });

  // 客户端开了 requireSignedVersion，签名时不把版本号写进可信注释，插件拒收每一个 beta 包。
  // 签完按仓库里的发布公钥验签、核对签名里的版本，私钥配错或漏传版本在这里挡下，不等用户拒收。
  it('sign 把版本号写进可信注释，签完按发布公钥验签', () => {
    const sign = job(LINES, 'sign');
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
    const sign = job(LINES, 'sign');
    for (const prefix of ['OSS_', 'R2_', 'HK_']) {
      assert.deepEqual(sign.filter((line) => line.toUpperCase().includes(prefix)), [], `sign 作业里出现了 ${prefix} 开头的凭据`);
    }
    assert.deepEqual(secretsIn(exposedOf(jobLines(LINES, 'sign'))), { names: ['RELEASE_UPDATER_PRIVATE_KEY'], other: [] });
    assert.deepEqual(tokenRefs(exposedOf(jobLines(LINES, 'sign'))), [], 'sign 作业不该拿仓库令牌');
    assert.deepEqual(jobBlock(LINES, 'sign', 'permissions'), ['contents: read']);
  });

  // 持钥的作业里不跑包管理器：npm exec、pnpm install 按 registry 当下给的元数据取包，还会跑安装脚本，拿到的不一定是
  // 锁文件里那一份。签名 CLI 只按锁文件记的 integrity 取，读锁文件只经 locked-cli.mjs 这一份带测试的解析，
  // 两条流水线不各写一套。sparse 名单逐项钉住：持钥的机器上只放用得到的这几个文件。
  it('sign 经 locked-cli.mjs 按锁文件取签名 CLI，不再内联解析锁文件', () => {
    const signLines = jobLines(LINES, 'sign');
    const sparseAt = signLines.findIndex((line) => line.kind === 'structure' && line.key === 'sparse-checkout');
    assert.notEqual(sparseAt, -1, 'sign 作业的 checkout 不再用 sparse-checkout，持钥的机器上会多出整个仓库');
    assert.equal(signLines[sparseAt].valueKind, 'block', 'sign 作业的 sparse-checkout 不再是逐行列文件的块');
    const sparse = [];
    for (const line of signLines.slice(sparseAt + 1)) {
      if (line.kind !== 'content') break;
      if (line.raw.trim() !== '') sparse.push(line.raw.trim());
    }
    assert.deepEqual(
      sparse,
      ['/.github/release-updater.pub', '/.github/scripts/locked-cli.mjs', '/.github/scripts/verify-update-signature.mjs', '/app/pnpm-lock.yaml'],
      'sign 作业取出的文件变了：持钥的机器上只放公钥、locked-cli.mjs、验签脚本和锁文件',
    );
    const sign = job(LINES, 'sign');
    assert.ok(sign.includes('sparse-checkout-cone-mode: false'), 'sign 的 sparse-checkout 不再是非 cone 模式，按文件列的名单会放宽成整个目录');

    const cli = steps(LINES, 'sign').find((step) => stepKeys(step).includes('id: cli'));
    assert.notEqual(cli, undefined, 'sign 作业里找不到按锁文件取签名 CLI 那一步（id: cli）');
    const script = codeOf(cli.filter((line) => line.kind === 'content'));
    assert.equal(script[0], LOCKED_CLI_CALL, '取签名 CLI 的第一件事不再是用 locked-cli.mjs 从锁文件读出 integrity');
    assert.ok(script.includes('done < "$RUNNER_TEMP/tauri-cli.tsv"'), '下载、核对 integrity 的循环不再读 locked-cli.mjs 写出的名单');
    assert.deepEqual(
      sign.filter((line) => line.includes('pnpm-lock.yaml')),
      ['/app/pnpm-lock.yaml', LOCKED_CLI_CALL],
      'sign 作业里又有别处读锁文件：锁文件只许经 locked-cli.mjs 解析',
    );
    assert.deepEqual(sign.filter((line) => /\bnode\s+-(?:\s|$)/.test(line)), [], 'sign 作业里又有从标准输入读进来的内联 node 脚本');
    assert.deepEqual(sign.filter((line) => /\b(?:npm|npx|pnpm|yarn)\s/.test(line)), [], 'sign 作业里跑了包管理器');
  });

  it('桶凭据只进 stage，香港推送钥只进 publish-hk', () => {
    assert.deepEqual(secretsIn(exposedOf(jobLines(LINES, 'stage'))), {
      names: ['OSS_CI_ACCESS_KEY_ID', 'OSS_CI_ACCESS_KEY_SECRET', 'R2_CI_ACCESS_KEY_ID', 'R2_CI_SECRET_ACCESS_KEY'],
      other: [],
    });
    assert.deepEqual(secretsIn(exposedOf(jobLines(LINES, 'publish-hk'))), { names: ['HK_MANIFEST_SSH_KEY'], other: [] });
    assert.deepEqual(jobBlock(LINES, 'publish-hk', 'permissions'), ['contents: read']);
  });

  // 桶上同一个键只能写一次。传完包才失败的运行不建 tag，下一次运行算出同一个 beta.N，只带运行次数的话又从 1 起，
  // 键就撞上上次留下、覆盖不了的对象；dev-distribution.mjs 认的运行标识是 <运行号>-<运行次数>。
  it('stage 按运行标识算对象键、生成和校验清单', () => {
    const calls = job(LINES, 'stage').filter((line) => /dev-distribution\.mjs (?:key|build|validate) /.test(line));
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

    const publishHk = job(LINES, 'publish-hk');
    assert.ok(jobBlock(LINES, 'publish-hk', 'env').includes(expected), 'publish-hk 不再在作业级声明 beta 清单地址');
    assert.ok(publishHk.includes('run: bash .github/scripts/push-hk-manifest.sh "$MANIFEST"'), 'publish-hk 不再推送香港清单');
    assert.ok(
      publishHk.some((line) => readsHkManifest(line) && line.includes("--write-out '%{content_type}'")),
      'publish-hk 推送之后不再经公网回读香港清单、核对 Content-Type',
    );
    assert.ok(jobBlock(LINES, 'stage', 'env').includes(expected), 'stage 不再在作业级声明 beta 清单地址');
    assert.ok(job(LINES, 'stage').some(readsHkManifest), 'stage 不再读香港清单检查版本号有没有倒退');
    const bundle = steps(LINES, 'build').find((step) => codeOf(step).includes(BUILD_COMMAND));
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
  const whyOf = (text) => parseWorkflow(text, FLOW_ALLOWED).problems.map((problem) => problem.replace(/^第 \d+ 行/, '').replace(/：[\s\S]*$/, ''));

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
    const { lines, problems } = parseWorkflow(['a:', '  run: |', '    echo *.mjs && b 2>&1 | c', '    "x": &y', '', '    # 注释', '  if: always()'].join('\n'), FLOW_ALLOWED);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      lines.map((line) => line.kind),
      ['structure', 'structure', 'content', 'content', 'content', 'content', 'structure'],
    );
  });

  it('脚本里 shell 注释中的机密照样算引用，YAML 注释里的不算', () => {
    const { lines } = parseWorkflow(['a:', '  # ${{ secrets.YAML_COMMENT }}', '  run: |', '    # ${{ secrets.SHELL_COMMENT }}', '    echo'].join('\n'), FLOW_ALLOWED);
    assert.deepEqual(secretsIn(exposedOf(lines)), { names: ['SHELL_COMMENT'], other: [] });
  });

  it('步骤自己的键不含 run 脚本里的行', () => {
    const { lines } = parseWorkflow(['      - name: 写入', '        if: always()', '        run: |', '          if: not-a-key', '          echo'].join('\n'), FLOW_ALLOWED);
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
