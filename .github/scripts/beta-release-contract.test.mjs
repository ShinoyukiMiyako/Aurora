// .github/workflows/beta-release.yml 与客户端之间的契约。工作流只能靠真跑验证，下面这几处一旦走样，运行时不会有任何报错：
// 要么所有 beta 客户端拒收更新，要么防降级、凭据隔离和签名前的审批悄悄失效，而发布钥与正式版共用，失效的代价落在正式版上。
// 放在 node 测试里，是因为 dev-build.yml 每次推送、beta-release.yml 的 build 作业在编译之前都跑 node --test，契约在 CI 上生效。
//
// 只看真正执行的行：文件头和步骤上方的注释里也写着这些键和命令，拿全文找子串的话，删掉真正的那一行照样能过。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const WORKFLOW = readFileSync(new URL('../workflows/beta-release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UPDATER_RS = readFileSync(new URL('../../app/src-tauri/src/commands/updater.rs', import.meta.url), 'utf8');

// beta 客户端唯一会问的清单地址。客户端那边由 updater.rs 的 endpoints_are_https_on_brand_domains 钉成同一个字面量，
// 下面有一条测试核对那句断言还在，两边改地址都会挂。
const BETA_MANIFEST_URL = 'https://petalfall.org/updates/beta/latest.json';
const BETA_ONLY = "if: github.ref == 'refs/heads/beta'";

const RAW = WORKFLOW.split('\n');
const JOBS_AT = RAW.indexOf('jobs:');

function indentOf(line) {
  const content = line.trimStart();
  return content === '' || content.startsWith('#') ? null : line.length - content.length;
}

const isCode = (line) => line !== '' && !line.startsWith('#');
const codeOf = (lines) => lines.map((line) => line.trim()).filter(isCode);

/** 整个工作流里真正执行的行，去掉首尾空白。 */
const CODE = codeOf(RAW);

/** jobs 下的作业名，按出现顺序。 */
function jobNames() {
  const names = [];
  for (const line of RAW.slice(JOBS_AT + 1)) {
    const indent = indentOf(line);
    if (indent === 0) break;
    if (indent === 2) names.push(line.trim().replace(/:$/, ''));
  }
  return names;
}

/** 作业 name 那一段的原始行（保留缩进）：从 `  name:` 起，到下一个同级作业或顶层键之前。 */
function jobRaw(name) {
  const start = RAW.indexOf(`  ${name}:`, JOBS_AT);
  assert.notEqual(start, -1, `beta-release.yml 里找不到作业 ${name}`);
  const lines = [RAW[start]];
  for (const line of RAW.slice(start + 1)) {
    const indent = indentOf(line);
    if (indent !== null && indent <= 2) break;
    lines.push(line);
  }
  return lines;
}

const job = (name) => codeOf(jobRaw(name));

/** 作业级的键（缩进 4）：if、environment、runs-on 这些必须写在作业上，写进某个步骤里就只管那一步。 */
const jobKeys = (name) => jobRaw(name).filter((line) => indentOf(line) === 4).map((line) => line.trim());

/** 作业级 `key:` 块下一层的行，去掉行尾注释。 */
function jobBlock(name, key) {
  const lines = jobRaw(name);
  const at = lines.indexOf(`    ${key}:`);
  assert.notEqual(at, -1, `作业 ${name} 没有 ${key}`);
  const block = [];
  for (const line of lines.slice(at + 1)) {
    const indent = indentOf(line);
    if (indent === null) continue;
    if (indent <= 4) break;
    block.push(line.trim().replace(/\s+#.*$/, ''));
  }
  return block;
}

/** 作业的步骤，每步是它的原始行：从缩进 6 的 `- ` 起，到下一步之前。 */
function steps(name) {
  const lines = jobRaw(name);
  const result = [];
  let current = null;
  for (const line of lines.slice(lines.indexOf('    steps:') + 1)) {
    if (indentOf(line) === 6 && line.trimStart().startsWith('- ')) {
      current = [line];
      result.push(current);
    } else if (current !== null) {
      current.push(line);
    }
  }
  return result;
}

/** 步骤自己的键：`- ` 那一行去掉前缀，加上缩进 8 的行。 */
const stepKeys = (step) => [step[0].trim().slice(2), ...step.slice(1).filter((line) => indentOf(line) === 8).map((line) => line.trim())];

/**
 * 这些行里引用的机密。只认 `secrets.<名字>` 的写法；`toJSON(secrets)`、`secrets['X']` 这类一次拿走一批或绕开名字的写法
 * 记进 other，测试一律不放行，不然按名字核对就形同虚设。
 */
function secretsIn(lines) {
  const names = new Set();
  const other = [];
  for (const line of lines) {
    for (const match of line.matchAll(/\bsecrets\b(\.([A-Za-z0-9_]+))?/g)) {
      if (match[2] === undefined) other.push(line);
      else names.add(match[2]);
    }
  }
  return { names: [...names].sort(), other };
}

describe('beta 发布工作流的契约', () => {
  it('作业只有这四个，挂了环境的都在作业级限定只在 beta 上跑', () => {
    assert.deepEqual(jobNames(), ['build', 'sign', 'stage', 'publish-hk']);
    for (const [name, environment] of [
      ['sign', 'release-signing'],
      ['stage', 'updates-beta'],
      ['publish-hk', 'updates-beta'],
    ]) {
      const keys = jobKeys(name);
      assert.ok(keys.includes(`environment: ${environment}`), `${name} 应在作业级挂环境 ${environment}`);
      // 写进某一步的 if 只跳过那一步，作业照样启动、照样申请环境
      assert.ok(keys.includes(BETA_ONLY), `${name} 挂了环境却没在作业级限定在 beta 上跑`);
    }
  });

  it('只认 beta 的推送和手动演练，同一分支串行、不取消', () => {
    const on = CODE.indexOf('on:');
    assert.notEqual(on, -1, '工作流里没有 on:');
    assert.deepEqual(CODE.slice(on, on + 4), ['on:', 'push:', 'branches: [beta]', 'workflow_dispatch:']);
    assert.equal(CODE[on + 4], 'concurrency:', '触发条件不止 beta 的推送和手动演练');
    assert.deepEqual(CODE.slice(on + 5, on + 7), ['group: beta-release-${{ github.ref_name }}', 'cancel-in-progress: false']);
    assert.ok(CODE.includes('permissions: {}'), '顶层不该给任何权限');
  });

  it('build 在一次性托管机上跑、不挂环境，只拿要编进包里的 CurseForge key', () => {
    const keys = jobKeys('build');
    assert.ok(!keys.some((line) => line.startsWith('environment:')), 'build 作业不该声明环境');
    assert.ok(keys.includes('runs-on: ubuntu-24.04'), 'build 作业不再跑在一次性托管机上');
    assert.deepEqual(secretsIn(job('build')), { names: ['PETALFALL_CURSEFORGE_API_KEY'], other: [] });
    assert.deepEqual(jobBlock('build', 'permissions'), ['contents: read', 'pull-requests: read']);
  });

  // 换成 dev 的公钥，所有 beta 客户端拒收发布钥签的包；漏了开关，detect_support 判为不支持，beta 包收不到任何更新。
  // 整行比对，多带一项（比如 allowDowngrades）也要挂；这一步必须在打包之前、无条件执行，否则打出的包不带公钥。
  it('build 在打包之前无条件注入发布公钥并打开 requireSignedVersion', () => {
    const expected =
      "conf.plugins = { ...conf.plugins, updater: { pubkey: fs.readFileSync('../.github/release-updater.pub', 'utf8').trim(), requireSignedVersion: true } };";
    assert.deepEqual(CODE.filter((line) => line.includes('conf.plugins')), [expected]);
    const buildSteps = steps('build');
    const inject = buildSteps.findIndex((step) => codeOf(step).includes(expected));
    assert.notEqual(inject, -1, '更新插件的配置不再写在 build 作业里');
    const bundle = buildSteps.findIndex((step) => codeOf(step).some((line) => line.startsWith('pnpm tauri build --runner cargo-xwin')));
    assert.notEqual(bundle, -1, 'build 作业里找不到打包启动器的那一步');
    assert.ok(inject < bundle, '注入公钥排到了打包之后');
    const keys = stepKeys(buildSteps[inject]);
    assert.ok(!keys.some((key) => key.startsWith('if:') || key.startsWith('continue-on-error:')), `注入公钥那一步带了执行条件：${keys}`);
  });

  // 客户端开了 requireSignedVersion，签名时不把版本号写进可信注释，插件拒收每一个 beta 包。
  // 签完按仓库里的发布公钥验签、核对签名里的版本，私钥配错或漏传版本在这里挡下，不等用户拒收。
  it('sign 把版本号写进可信注释，签完按发布公钥验签', () => {
    const sign = job('sign');
    const signing = sign.filter((line) => line.includes('signer sign'));
    assert.equal(signing.length, 1, `sign 作业里应恰有一条签名命令：${signing}`);
    assert.ok(signing[0].includes('signer sign --app-version "$VERSION" '), `签名不再把版本号写进可信注释：${signing[0]}`);
    assert.ok(
      sign.includes('run: node .github/scripts/verify-update-signature.mjs .github/release-updater.pub "$BOOTSTRAP" "$BOOTSTRAP.sig" "$VERSION"'),
      '签完不再按发布公钥验签、核对签名里的版本',
    );
  });

  // 持私钥的作业拿不到任何发布渠道：桶凭据、香港推送钥、能写仓库的令牌都不在这里，借道 sign 签出来的包自己发不出去。
  it('sign 只拿发布私钥和口令，没有任何写权限', () => {
    const sign = job('sign');
    for (const prefix of ['OSS_', 'R2_', 'HK_']) {
      assert.deepEqual(sign.filter((line) => line.includes(prefix)), [], `sign 作业里出现了 ${prefix} 开头的凭据`);
    }
    assert.deepEqual(secretsIn(sign), { names: ['RELEASE_UPDATER_KEY_PASSWORD', 'RELEASE_UPDATER_PRIVATE_KEY'], other: [] });
    assert.ok(!sign.some((line) => line.includes('github.token')), 'sign 作业不该拿仓库令牌');
    assert.deepEqual(jobBlock('sign', 'permissions'), ['contents: read']);
  });

  it('桶凭据只进 stage，香港推送钥只进 publish-hk', () => {
    assert.deepEqual(secretsIn(job('stage')), {
      names: ['OSS_CI_ACCESS_KEY_ID', 'OSS_CI_ACCESS_KEY_SECRET', 'R2_CI_ACCESS_KEY_ID', 'R2_CI_SECRET_ACCESS_KEY'],
      other: [],
    });
    assert.deepEqual(secretsIn(job('publish-hk')), { names: ['HK_MANIFEST_SSH_KEY'], other: [] });
    assert.deepEqual(jobBlock('publish-hk', 'permissions'), ['contents: read']);
  });

  // beta 客户端只问这一个地址：推送后回读、发布前比版本，读的都得是它，否则推上去了也核对不到客户端看到的那份。
  it('香港清单地址就是客户端的 BETA_ENDPOINT', () => {
    const expected = `HK_MANIFEST_URL: ${BETA_MANIFEST_URL}`;
    const declared = CODE.filter((line) => line.startsWith('HK_MANIFEST_URL:'));
    assert.ok(declared.length > 0, '工作流里不再声明 HK_MANIFEST_URL');
    for (const line of declared) assert.equal(line, expected);
    const readsHkManifest = (line) => line.includes('curl ') && line.includes('"$HK_MANIFEST_URL"');

    const publishHk = job('publish-hk');
    assert.ok(publishHk.includes(expected), 'publish-hk 不再声明 beta 清单地址');
    assert.ok(publishHk.includes('run: bash .github/scripts/push-hk-manifest.sh "$MANIFEST"'), 'publish-hk 不再推送香港清单');
    assert.ok(
      publishHk.some((line) => readsHkManifest(line) && line.includes("--write-out '%{content_type}'")),
      'publish-hk 推送之后不再经公网回读香港清单、核对 Content-Type',
    );
    const stage = job('stage');
    assert.ok(stage.includes(expected), 'stage 不再声明 beta 清单地址');
    assert.ok(stage.some(readsHkManifest), 'stage 不再读香港清单检查版本号有没有倒退');

    // rustfmt 会把断言拆成几行，去掉空白再比
    assert.ok(
      UPDATER_RS.replace(/\s+/g, '').includes(`assert_eq!(BETA_ENDPOINT,"${BETA_MANIFEST_URL}"`),
      'updater.rs 不再把 BETA_ENDPOINT 钉成同一个地址，两边要一起改',
    );
  });
});

describe('契约用到的解析', () => {
  it('认得出各种机密写法', () => {
    assert.deepEqual(secretsIn(['A: ${{ secrets.X_1 }}', 'B: ${{ secrets.Y }} ${{ secrets.X_1 }}']), { names: ['X_1', 'Y'], other: [] });
    assert.deepEqual(secretsIn(['ALL: ${{ toJSON(secrets) }}']).other, ['ALL: ${{ toJSON(secrets) }}']);
    assert.deepEqual(secretsIn(["K: ${{ secrets['X'] }}"]).other, ["K: ${{ secrets['X'] }}"]);
  });

  it('步骤自己的键不含 run 脚本里的行', () => {
    const step = ['      - name: 写入', '        if: always()', '        run: |', '          if: not-a-key', '          echo'];
    assert.deepEqual(stepKeys(step), ['name: 写入', 'if: always()', 'run: |']);
  });
});
