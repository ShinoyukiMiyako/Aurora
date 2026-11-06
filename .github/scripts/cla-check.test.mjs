import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CLA_EFFECTIVE_AT,
  CLA_VERSION,
  COMMENT_MARKER,
  SIGNATURE_BRANCH,
  SIGNATURE_FILE,
  SIGNATURE_PHRASES,
  STATUS_CONTEXT,
  isSignature,
  runClaCheck,
} from './cla-check.mjs';

const OWNER = 'ShinoyukiMiyako';
const REPO = 'Petalfall';
const NUMBER = randomInt(1, 100_000);
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const SIGNED_AT = '2026-12-01T08:00:00Z';
const CLA_URL = `https://github.com/${OWNER}/${REPO}/blob/dev/CLA.md`;

let nextId = randomInt(1_000, 1_000_000);

function person(login, type = 'User') {
  nextId += 1;
  return { id: nextId, login, type };
}

const alice = person('alice');
const bob = person('bob');
const mallory = person('mallory');
const renovate = person('renovate[bot]', 'Bot');
const actionsBot = person('github-actions[bot]', 'Bot');
const maintainer = { id: 132777740, login: OWNER, type: 'User' };

function commitBy(author, overrides = {}) {
  nextId += 1;
  return {
    sha: nextId.toString(16).padStart(40, '0'),
    author,
    commit: { author: { name: author?.login ?? 'someone', email: `${nextId}@example.com` } },
    ...overrides,
  };
}

function unlinkedCommit({ name, email = `${name}@example.com`, author = null, sha }) {
  nextId += 1;
  return {
    sha: sha ?? nextId.toString(16).padStart(40, '0'),
    author,
    commit: { author: { name, email } },
  };
}

function commentBy(user, body, overrides = {}) {
  nextId += 1;
  const createdAt = overrides.created_at ?? SIGNED_AT;
  return {
    id: nextId,
    user,
    body,
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${NUMBER}#issuecomment-${nextId}`,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

function recordOf(user, overrides = {}) {
  return {
    id: user.id,
    login: user.login,
    version: CLA_VERSION,
    pr: 1,
    comment: `https://github.com/${OWNER}/${REPO}/pull/1#issuecomment-1`,
    at: SIGNED_AT,
    ...overrides,
  };
}

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function encode(signatures) {
  // GitHub 返回的 base64 每 60 字符换一行，解码时要容忍。
  const text = `${JSON.stringify(signatures)}\n`;
  return Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
}

function createGitHub({
  opener = alice,
  commits = [],
  comments = [],
  signatures = [],
  fileExists = true,
  branchExists = true,
  prCommitCount,
  compareCommits,
  beforeWrite,
} = {}) {
  const repository = {
    revision: 1,
    sha: fileExists ? 'blob-1' : undefined,
    signatures: fileExists ? [...signatures] : [],
    replace(next) {
      this.revision += 1;
      this.sha = `blob-${this.revision}`;
      this.signatures = next;
    },
  };
  const calls = { writes: [], statuses: [], created: [], updated: [], compared: [] };

  const pageOf = (items, { page = 1, per_page: perPage = 30 }) =>
    items.slice((page - 1) * perPage, page * perPage);

  const github = {
    calls,
    repository,
    comments,
    async paginate(method, params) {
      const items = [];
      for (let page = 1; ; page += 1) {
        const { data } = await method({ ...params, page });
        items.push(...data);
        if (data.length < params.per_page) {
          return items;
        }
      }
    },
    // 比较接口：分页取完，总数在 total_commits。compareCommits 模拟比较结果比 PR 记的提交数少
    async request(route, params) {
      assert.equal(route, 'GET /repos/{owner}/{repo}/compare/{basehead}');
      assert.equal(params.basehead, `${BASE_SHA}...${HEAD_SHA}`);
      calls.compared.push(params.page);
      const listed = compareCommits ?? commits;
      return { data: { total_commits: listed.length, commits: pageOf(listed, params) } };
    },
    rest: {
      pulls: {
        async get() {
          return {
            data: {
              number: NUMBER,
              user: opener,
              head: { sha: HEAD_SHA },
              base: { sha: BASE_SHA },
              commits: prCommitCount ?? commits.length,
            },
          };
        },
        async listCommits(params) {
          return { data: pageOf(commits.slice(0, 250), params) };
        },
      },
      issues: {
        async listComments(params) {
          return { data: pageOf(comments, params) };
        },
        async createComment({ issue_number: issueNumber, body }) {
          nextId += 1;
          const created = commentBy(actionsBot, body, { id: nextId });
          calls.created.push({ issueNumber, body, id: created.id });
          comments.push(created);
          return { data: created };
        },
        async updateComment({ comment_id: id, body }) {
          calls.updated.push({ id, body });
          comments.find((comment) => comment.id === id).body = body;
          return { data: {} };
        },
      },
      repos: {
        async getBranch({ branch }) {
          assert.equal(branch, SIGNATURE_BRANCH);
          if (!branchExists) {
            throw httpError(404);
          }
          return { data: { name: branch } };
        },
        async getContent({ path, ref }) {
          assert.equal(path, SIGNATURE_FILE);
          assert.equal(ref, SIGNATURE_BRANCH);
          if (!branchExists || repository.sha === undefined) {
            throw httpError(404);
          }
          return { data: { sha: repository.sha, content: encode(repository.signatures) } };
        },
        async createOrUpdateFileContents({ branch, path, sha, content, message }) {
          assert.equal(branch, SIGNATURE_BRANCH);
          assert.equal(path, SIGNATURE_FILE);
          calls.writes.push({ sha, message });
          await beforeWrite?.(repository, calls.writes.length);
          if (repository.sha !== sha) {
            throw httpError(409);
          }
          repository.replace(JSON.parse(Buffer.from(content, 'base64').toString('utf8')));
          return { data: {} };
        },
        async createCommitStatus(status) {
          calls.statuses.push(status);
          return { data: {} };
        },
      },
    },
  };
  return github;
}

const core = { info() {} };

function pullRequestContext() {
  return {
    repo: { owner: OWNER, repo: REPO },
    payload: { pull_request: { number: NUMBER }, repository: { default_branch: 'dev' } },
  };
}

function issueCommentContext() {
  return {
    repo: { owner: OWNER, repo: REPO },
    payload: {
      issue: { number: NUMBER, pull_request: { url: 'https://api.github.com/x' } },
      repository: { default_branch: 'dev' },
    },
  };
}

function run(github, context = pullRequestContext()) {
  return runClaCheck({ github, context, core });
}

function lastStatus(github) {
  return github.calls.statuses.at(-1);
}

function botComments(github) {
  return github.comments.filter((comment) => comment.body.startsWith(COMMENT_MARKER));
}

const [ENGLISH_PHRASE, CHINESE_PHRASE] = SIGNATURE_PHRASES;

describe('isSignature', () => {
  for (const body of [
    ENGLISH_PHRASE,
    CHINESE_PHRASE,
    `${ENGLISH_PHRASE}.`,
    `${ENGLISH_PHRASE}。`,
    `${CHINESE_PHRASE}。`,
    `${CHINESE_PHRASE}.`,
    `  \r\n${ENGLISH_PHRASE}.\r\n\t`,
    `　${CHINESE_PHRASE}　`,
    ENGLISH_PHRASE.toUpperCase(),
    '我已阅读并同意 cla',
  ]) {
    it(`接受 ${JSON.stringify(body)}`, () => {
      assert.equal(isSignature(body), true);
    });
  }

  for (const body of [
    '',
    '.',
    'LGTM',
    'I agree',
    'I have read the CLA',
    '我同意',
    '我已阅读并同意CLA',
    `${ENGLISH_PHRASE}..`,
    `${ENGLISH_PHRASE}!`,
    `> ${ENGLISH_PHRASE}`,
    `${ENGLISH_PHRASE}, but not really`,
    `I have not read the CLA and I agree to it`,
    `${ENGLISH_PHRASE}\n${CHINESE_PHRASE}`,
  ]) {
    it(`拒绝 ${JSON.stringify(body)}`, () => {
      assert.equal(isSignature(body), false);
    });
  }
});

describe('需要签署的人', () => {
  it('开启者和提交作者都已签过时通过，不写签名也不发评论', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice), commitBy(bob)],
      signatures: [recordOf(alice), recordOf(bob)],
    });

    const result = await run(github);

    assert.deepEqual(result, { state: 'success', missing: [], unlinked: [] });
    assert.equal(github.calls.statuses.length, 1);
    assert.deepEqual(lastStatus(github), {
      owner: OWNER,
      repo: REPO,
      sha: HEAD_SHA,
      context: STATUS_CONTEXT,
      state: 'success',
      description: 'CLA 已签署 / CLA signed',
      target_url: CLA_URL,
    });
    assert.deepEqual(github.calls.writes, []);
    assert.deepEqual(github.comments, []);
  });

  it('提交作者没签时判失败并点名，已签的人不出现', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice), commitBy(bob)],
      signatures: [recordOf(alice)],
    });

    const result = await run(github);

    assert.equal(result.state, 'failure');
    assert.deepEqual(result.missing, ['bob']);
    assert.equal(lastStatus(github).state, 'failure');
    assert.equal(lastStatus(github).sha, HEAD_SHA);
    const [comment] = botComments(github);
    assert.match(comment.body, /@bob/);
    assert.doesNotMatch(comment.body, /@alice/);
    assert.ok(comment.body.includes(CLA_URL));
    for (const phrase of SIGNATURE_PHRASES) {
      assert.ok(comment.body.includes(phrase));
    }
  });

  it('开启者没写提交也要签', async () => {
    const github = createGitHub({
      opener: bob,
      commits: [commitBy(alice)],
      signatures: [recordOf(alice)],
    });

    const result = await run(github);

    assert.deepEqual(result.missing, ['bob']);
  });

  it('同一作者多个提交只点名一次', async () => {
    const github = createGitHub({ opener: alice, commits: [commitBy(alice), commitBy(alice)] });

    const result = await run(github);

    assert.deepEqual(result.missing, ['alice']);
  });

  it('Bot 和豁免账号不需要签署', async () => {
    const github = createGitHub({
      opener: maintainer,
      commits: [commitBy(maintainer), commitBy(renovate)],
    });

    const result = await run(github);

    assert.deepEqual(result, { state: 'success', missing: [], unlinked: [] });
    assert.deepEqual(github.comments, []);
  });

  it('Bot 开的 PR 里混入真人提交时真人仍要签', async () => {
    const github = createGitHub({ opener: renovate, commits: [commitBy(renovate), commitBy(bob)] });

    const result = await run(github);

    assert.deepEqual(result.missing, ['bob']);
  });

  it('豁免按数字 ID，改名后占用同一登录名的账号不豁免', async () => {
    const squatter = person(OWNER);
    const github = createGitHub({ opener: squatter, commits: [commitBy(squatter)] });

    const result = await run(github);

    assert.deepEqual(result.missing, [OWNER]);
  });

  it('扫到第 101 个提交的作者', async () => {
    const commits = Array.from({ length: 100 }, () => commitBy(alice));
    commits.push(commitBy(bob));
    const github = createGitHub({ opener: alice, commits, signatures: [recordOf(alice)] });

    const result = await run(github);

    assert.deepEqual(result.missing, ['bob']);
  });

  it('超过 250 个提交时改走比较接口，后面的作者照样核对', async () => {
    const commits = Array.from({ length: 300 }, () => commitBy(alice));
    commits.push(commitBy(bob));
    const github = createGitHub({ opener: alice, commits, signatures: [recordOf(alice)] });

    const result = await run(github);

    assert.deepEqual(result.missing, ['bob']);
    assert.deepEqual(github.calls.compared, [1, 2, 3, 4]);
  });

  it('比较接口取到的比 PR 记的少时报错，不写状态', async () => {
    const commits = Array.from({ length: 300 }, () => commitBy(alice));
    const github = createGitHub({
      opener: alice,
      commits,
      compareCommits: commits.slice(0, 280),
      signatures: [recordOf(alice)],
    });

    await assert.rejects(run(github), /300 个提交，只取到 280 个/);
    assert.deepEqual(github.calls.statuses, []);
  });

  it('正好 250 个提交时用列提交接口正常判定', async () => {
    const commits = Array.from({ length: 250 }, () => commitBy(alice));
    const github = createGitHub({ opener: alice, commits, signatures: [recordOf(alice)] });

    const result = await run(github);

    assert.equal(result.state, 'success');
    assert.deepEqual(github.calls.compared, []);
  });
});

// dev 到 beta 的晋级 PR 有几百个提交，同样逐个核对作者：维护者在本地拣进没签的外部提交时，这里要拦得住。
describe('晋级 PR', () => {
  it('全是维护者和 Bot 的提交时通过，不发评论', async () => {
    const commits = Array.from({ length: 320 }, (_, index) => commitBy(index % 40 === 0 ? renovate : maintainer));
    const github = createGitHub({ opener: maintainer, commits });

    const result = await run(github);

    assert.deepEqual(result, { state: 'success', missing: [], unlinked: [] });
    assert.equal(lastStatus(github).state, 'success');
    assert.equal(lastStatus(github).sha, HEAD_SHA);
    assert.deepEqual(github.comments, []);
  });

  it('混着没签的外部提交和没关联的邮箱时照样点名，开启者是维护者也不放行', async () => {
    const commits = Array.from({ length: 300 }, () => commitBy(maintainer));
    commits.splice(270, 0, commitBy(bob));
    commits.push(unlinkedCommit({ name: 'Old Email' }));
    const github = createGitHub({ opener: maintainer, commits });

    const result = await run(github);

    assert.deepEqual(result.missing, ['bob']);
    assert.equal(result.unlinked.length, 1);
    assert.equal(lastStatus(github).state, 'failure');
  });
});

describe('邮箱未关联账号', () => {
  it('其余人都签了也判失败，并点名提交和作者', async () => {
    const sha = `deadbeef${'0'.repeat(32)}`;
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice), unlinkedCommit({ name: 'Ghost Writer', sha })],
      signatures: [recordOf(alice)],
    });

    const result = await run(github);

    assert.equal(result.state, 'failure');
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unlinked, [{ sha, name: 'Ghost Writer' }]);
    assert.equal(lastStatus(github).state, 'failure');
    const [comment] = botComments(github);
    assert.ok(comment.body.includes('`deadbeef` `Ghost Writer`'));
    assert.doesNotMatch(comment.body, /Waiting for/);
  });

  it('接口返回空对象的作者同样算未关联', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [unlinkedCommit({ name: 'Empty Author', author: {} })],
      signatures: [recordOf(alice)],
    });

    const result = await run(github);

    assert.equal(result.state, 'failure');
    assert.deepEqual(result.missing, []);
    assert.equal(result.unlinked[0].name, 'Empty Author');
  });

  it('同一邮箱多个提交只列一次', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [
        unlinkedCommit({ name: 'Same', email: 'same@example.com' }),
        unlinkedCommit({ name: 'Same', email: 'same@example.com' }),
      ],
      signatures: [recordOf(alice)],
    });

    const result = await run(github);

    assert.equal(result.unlinked.length, 1);
  });

  it('作者名里的 Markdown 不会逃出代码块，也不泄露邮箱', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [
        unlinkedCommit({
          name: '`@everyone`\n[x](https://evil.example)',
          email: 'private@example.com',
        }),
      ],
      signatures: [recordOf(alice)],
    });

    await run(github);

    const [comment] = botComments(github);
    assert.ok(comment.body.includes('` @everyone  [x](https://evil.example)`'));
    assert.doesNotMatch(comment.body, /`@everyone`/);
    assert.doesNotMatch(comment.body, /private@example\.com/);
  });
});

describe('评论签署', () => {
  it('本人评论后写入签名并转为通过，字段只有约定的六个', async () => {
    const signature = commentBy(alice, `  ${CHINESE_PHRASE}。\n`);
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [signature],
    });

    const result = await run(github, issueCommentContext());

    assert.equal(result.state, 'success');
    assert.deepEqual(github.repository.signatures, [
      {
        id: alice.id,
        login: 'alice',
        version: CLA_VERSION,
        pr: NUMBER,
        comment: signature.html_url,
        at: SIGNED_AT,
      },
    ]);
    assert.equal(github.calls.writes[0].message, `chore(cla): alice 签署 v${CLA_VERSION} (#${NUMBER})`);
    assert.equal(lastStatus(github).state, 'success');
  });

  it('保留已有记录，非 ASCII 内容不被破坏', async () => {
    const existing = recordOf(bob, { login: '小明' });
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE)],
      signatures: [existing],
    });

    await run(github);

    assert.deepEqual(github.repository.signatures[0], existing);
    assert.equal(github.repository.signatures.length, 2);
  });

  it('错误的签署语不算', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [
        commentBy(alice, 'I agree'),
        commentBy(alice, `> ${ENGLISH_PHRASE}`),
        commentBy(alice, `Sure. ${ENGLISH_PHRASE}`),
      ],
    });

    const result = await run(github);

    assert.deepEqual(result.missing, ['alice']);
    assert.deepEqual(github.calls.writes, []);
  });

  it('他人代签不算，代签者也不留下记录', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(mallory, ENGLISH_PHRASE), commentBy(maintainer, ENGLISH_PHRASE)],
    });

    const result = await run(github);

    assert.deepEqual(result.missing, ['alice']);
    assert.deepEqual(github.repository.signatures, []);
    assert.deepEqual(github.calls.writes, []);
  });

  it('两个需要签署的人，一人的评论只算他自己', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice), commitBy(bob)],
      comments: [commentBy(bob, ENGLISH_PHRASE)],
    });

    const result = await run(github);

    assert.deepEqual(result.missing, ['alice']);
    assert.deepEqual(github.repository.signatures.map((record) => record.id), [bob.id]);
  });

  it('编辑过的评论不算，新发一条才算', async () => {
    const edited = commentBy(alice, ENGLISH_PHRASE, { updated_at: '2026-12-02T08:00:00Z' });
    const github = createGitHub({ opener: alice, commits: [commitBy(alice)], comments: [edited] });

    const before = await run(github);

    assert.deepEqual(before.missing, ['alice']);
    assert.deepEqual(github.calls.writes, []);

    const fresh = commentBy(alice, ENGLISH_PHRASE);
    github.comments.push(fresh);
    const after = await run(github);

    assert.equal(after.state, 'success');
    assert.equal(github.repository.signatures[0].comment, fresh.html_url);
  });

  it('签署后再编辑原评论不撤销已写入的记录', async () => {
    const signature = commentBy(alice, ENGLISH_PHRASE);
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [signature],
    });

    await run(github);
    signature.body = 'changed my mind';
    signature.updated_at = '2026-12-03T08:00:00Z';
    const result = await run(github);

    assert.equal(result.state, 'success');
    assert.equal(github.repository.signatures.length, 1);
  });

  it('多条签署评论只记最早一条', async () => {
    const first = commentBy(alice, ENGLISH_PHRASE);
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [first, commentBy(alice, CHINESE_PHRASE)],
    });

    await run(github);

    assert.deepEqual(github.repository.signatures.map((record) => record.comment), [first.html_url]);
  });

  it('扫描整条 PR：第 101 条评论也能读到，重跑不重复写入', async () => {
    const comments = Array.from({ length: 100 }, () => commentBy(mallory, 'noise'));
    comments.push(commentBy(alice, ENGLISH_PHRASE));
    const github = createGitHub({ opener: alice, commits: [commitBy(alice)], comments });

    const first = await run(github);
    const second = await run(github);

    assert.equal(first.state, 'success');
    assert.equal(second.state, 'success');
    assert.equal(github.repository.signatures.length, 1);
    assert.equal(github.calls.writes.length, 1);
  });

  it('作者已注销的评论不影响其他人', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(null, ENGLISH_PHRASE), commentBy(alice, ENGLISH_PHRASE)],
    });

    const result = await run(github);

    assert.equal(result.state, 'success');
  });
});

describe('按数字 ID 判定', () => {
  it('改名后旧签署仍然有效', async () => {
    const renamed = { ...alice, login: 'alice-renamed' };
    const github = createGitHub({
      opener: renamed,
      commits: [commitBy(renamed)],
      signatures: [recordOf(alice)],
    });

    const result = await run(github);

    assert.equal(result.state, 'success');
  });

  it('占用已签署者旧登录名的新账号不算已签', async () => {
    const impostor = person('alice');
    const github = createGitHub({
      opener: impostor,
      commits: [commitBy(impostor)],
      signatures: [recordOf(alice)],
    });

    const result = await run(github);

    assert.deepEqual(result.missing, ['alice']);
  });
});

describe('CLA 版本', () => {
  const beforeEffective = new Date(Date.parse(CLA_EFFECTIVE_AT) - 1000).toISOString().replace('.000', '');

  it('旧版本的记录失效，保留在文件里，重新签署后追加新记录', async () => {
    const old = recordOf(alice, { version: CLA_VERSION - 1 });
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      signatures: [old],
    });

    const before = await run(github);

    assert.deepEqual(before.missing, ['alice']);

    github.comments.push(commentBy(alice, ENGLISH_PHRASE));
    const after = await run(github);

    assert.equal(after.state, 'success');
    assert.deepEqual(github.repository.signatures[0], old);
    assert.equal(github.repository.signatures[1].version, CLA_VERSION);
  });

  it('当前版本生效前的评论不算，生效时刻的评论算', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE, { created_at: beforeEffective })],
    });

    const before = await run(github);

    assert.deepEqual(before.missing, ['alice']);
    assert.deepEqual(github.calls.writes, []);

    github.comments.push(commentBy(alice, ENGLISH_PHRASE, { created_at: CLA_EFFECTIVE_AT }));
    const after = await run(github);

    assert.equal(after.state, 'success');
    assert.equal(github.repository.signatures[0].at, CLA_EFFECTIVE_AT);
  });
});

describe('写入冲突', () => {
  it('409 时重新读取再写，不丢别的 PR 抢先写入的记录', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE)],
      beforeWrite(repository, attempt) {
        if (attempt === 1) {
          repository.replace([recordOf(bob)]);
        }
      },
    });

    const result = await run(github);

    assert.equal(result.state, 'success');
    assert.deepEqual(github.calls.writes.map((write) => write.sha), ['blob-1', 'blob-2']);
    assert.deepEqual(github.repository.signatures.map((record) => record.id), [bob.id, alice.id]);
  });

  it('重试时发现同一人已被另一次运行写入就不再写', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE)],
      beforeWrite(repository) {
        repository.replace([recordOf(alice)]);
      },
    });

    const result = await run(github);

    assert.equal(result.state, 'success');
    assert.equal(github.calls.writes.length, 1);
    assert.equal(github.repository.signatures.length, 1);
  });

  it('一直冲突时报错，不写状态', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE)],
      beforeWrite(repository) {
        repository.replace([]);
      },
    });

    await assert.rejects(run(github), { status: 409 });
    assert.equal(github.calls.writes.length, 5);
    assert.deepEqual(github.calls.statuses, []);
  });

  it('其他写入错误不重试', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE)],
      beforeWrite() {
        throw httpError(403);
      },
    });

    await assert.rejects(run(github), { status: 403 });
    assert.equal(github.calls.writes.length, 1);
  });
});

describe('签名文件', () => {
  it('分支不存在时明确报错，不写状态也不发评论', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE)],
      branchExists: false,
    });

    await assert.rejects(run(github), /签名分支 cla-signatures 不存在/);
    assert.deepEqual(github.calls.statuses, []);
    assert.deepEqual(github.calls.writes, []);
    assert.deepEqual(botComments(github), []);
  });

  it('分支在、文件不在时按空名单处理，首次签署创建文件', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE)],
      fileExists: false,
    });

    const result = await run(github);

    assert.equal(result.state, 'success');
    assert.equal(github.calls.writes[0].sha, undefined);
    assert.deepEqual(github.repository.signatures.map((record) => record.id), [alice.id]);
  });

  it('读文件的其他错误原样抛出，不当成空名单', async () => {
    const github = createGitHub({ opener: alice, commits: [commitBy(alice)] });
    github.rest.repos.getContent = async () => {
      throw httpError(500);
    };

    await assert.rejects(run(github), { status: 500 });
    assert.deepEqual(github.calls.statuses, []);
  });

  it('文件内容损坏时报错，不覆盖', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE)],
      signatures: [recordOf(bob)],
    });
    github.rest.repos.getContent = async () => ({
      data: { sha: 'blob-1', content: Buffer.from('{"oops":true}').toString('base64') },
    });

    await assert.rejects(run(github), /不是数组/);
    assert.deepEqual(github.calls.writes, []);
  });
});

describe('机器人评论', () => {
  it('只改不重发，全部通过后改成已签署', async () => {
    const github = createGitHub({ opener: alice, commits: [commitBy(alice)] });

    await run(github);
    assert.equal(github.calls.created.length, 1);
    const [first] = botComments(github);
    assert.equal(first.user.login, actionsBot.login);
    assert.ok(first.body.startsWith(COMMENT_MARKER));
    assert.equal(github.calls.created[0].issueNumber, NUMBER);

    github.comments.push(commentBy(alice, ENGLISH_PHRASE));
    await run(github, issueCommentContext());

    assert.equal(github.calls.created.length, 1);
    assert.equal(github.calls.updated.length, 1);
    assert.equal(github.calls.updated[0].id, first.id);
    assert.equal(botComments(github).length, 1);
    assert.match(first.body, /已签署/);
    assert.doesNotMatch(first.body, /@alice/);
  });

  it('全部通过且没有旧评论时不发评论', async () => {
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE)],
    });

    await run(github);

    assert.deepEqual(botComments(github), []);
  });

  it('已签署后又来了未签署的提交者时，改回待签署', async () => {
    const commits = [commitBy(alice)];
    const github = createGitHub({ opener: alice, commits });
    await run(github);
    github.comments.push(commentBy(alice, ENGLISH_PHRASE));
    await run(github);
    assert.match(botComments(github)[0].body, /已签署/);

    commits.push(commitBy(bob));
    await run(github);

    assert.equal(botComments(github).length, 1);
    assert.equal(github.calls.created.length, 1);
    assert.equal(github.calls.updated.length, 2);
    assert.match(botComments(github)[0].body, /@bob/);
    assert.doesNotMatch(botComments(github)[0].body, /已签署/);
  });

  it('状态没变时不调用更新', async () => {
    const github = createGitHub({ opener: alice, commits: [commitBy(alice)] });

    await run(github);
    await run(github);

    assert.equal(github.calls.created.length, 1);
    assert.deepEqual(github.calls.updated, []);
  });

  it('别人伪造标记的评论不会被当成机器人评论', async () => {
    const forged = commentBy(mallory, `${COMMENT_MARKER}\nforged`);
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [forged],
    });

    await run(github);

    assert.equal(forged.body, `${COMMENT_MARKER}\nforged`);
    assert.deepEqual(github.calls.updated, []);
    assert.equal(github.calls.created.length, 1);
  });

  it('机器人评论里的签署语不算任何人的签署', async () => {
    const github = createGitHub({
      opener: actionsBot,
      commits: [commitBy(alice)],
      comments: [commentBy(actionsBot, ENGLISH_PHRASE)],
    });

    const result = await run(github);

    assert.deepEqual(result.missing, ['alice']);
    assert.deepEqual(github.calls.writes, []);
  });
});

describe('工作流', () => {
  const workflow = readFileSync(new URL('../workflows/cla.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const script = workflow.match(/script: \|\n((?: {12}.*\n)+)/)[1];

  it('顶层不给权限，只在作业上给三项写权限', () => {
    assert.match(workflow, /^permissions: \{\}$/m);
    assert.match(
      workflow,
      /^ {4}permissions:\n {6}contents: write\n {6}pull-requests: write\n {6}statuses: write\n {4}steps:$/m,
    );
  });

  it('所有作业都跑在 GitHub 托管机上', () => {
    const runners = [...workflow.matchAll(/^\s*runs-on:\s*(.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(runners, ['ubuntu-latest']);
  });

  it('只 checkout 默认分支，不留凭据，不取 PR 的代码', () => {
    assert.match(
      workflow,
      /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1\n {8}with:\n {10}ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n {10}persist-credentials: false\n/,
    );
    assert.doesNotMatch(workflow, /pull_request\.head|head_ref|refs\/pull|allow-unsafe-pr-checkout/);
    assert.equal([...workflow.matchAll(/uses: actions\/checkout@/g)].length, 1);
  });

  it('脚本里没有表达式插值', () => {
    assert.doesNotMatch(script, /\$\{\{/);
  });

  it('跳过 Dependabot 和普通 issue 的评论', () => {
    assert.match(workflow, /github\.actor != 'dependabot\[bot\]'/);
    assert.match(workflow, /github\.event\.issue\.pull_request\)/);
  });

  it('改目标分支时重查，只改标题、正文时不重查', () => {
    assert.match(workflow, /^ {2}pull_request_target:\n(?: {4}#.*\n)* {4}types: \[opened, synchronize, reopened, edited\]$/m);
    assert.match(workflow, /^ {6}\(github\.event\.action != 'edited' \|\| github\.event\.changes\.base\)$/m);
  });

  it('作业名不和提交状态同名', () => {
    const jobNames = [...workflow.matchAll(/^ {4}name:\s*(.+)$/gm)].map((match) => match[1].trim().toLowerCase());
    const jobIds = [...workflow.matchAll(/^ {2}([a-z-]+):$/gm)].map((match) => match[1]);
    assert.ok(jobNames.length > 0);
    assert.ok(jobIds.length > 0);
    assert.ok(![...jobNames, ...jobIds].includes(STATUS_CONTEXT));
  });

  it('按 github-script 的调用方式跑得通', async () => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const execute = new AsyncFunction('github', 'context', 'core', 'getOctokit', script);
    const github = createGitHub({
      opener: alice,
      commits: [commitBy(alice)],
      comments: [commentBy(alice, ENGLISH_PHRASE)],
    });
    const workspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = new URL('../..', import.meta.url).href.replace(/\/$/, '');

    try {
      await execute(github, pullRequestContext(), core, () => assert.fail('不应使用 getOctokit'));
    } finally {
      if (workspace === undefined) {
        delete process.env.GITHUB_WORKSPACE;
      } else {
        process.env.GITHUB_WORKSPACE = workspace;
      }
    }

    assert.equal(lastStatus(github).state, 'success');
  });
});
