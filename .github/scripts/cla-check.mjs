// 由 .github/workflows/cla.yml 加载。工作流只从默认分支取这个文件，PR 改不到运行中的版本。

export const CLA_VERSION = 2;
// 和 CLA_VERSION 一起改。整条 PR 的评论都会被扫描，旧评论是对旧文本的同意，不能算进新版本。
export const CLA_EFFECTIVE_AT = '2026-11-05T00:40:00Z';

export const STATUS_CONTEXT = 'cla';
export const SIGNATURE_BRANCH = 'cla-signatures';
export const SIGNATURE_FILE = 'signatures.json';
export const COMMENT_MARKER = '<!-- cla-bot -->';
export const SIGNATURE_PHRASES = ['I have read the CLA and I agree to it', '我已阅读并同意 CLA'];

// 存数字 ID：登录名改掉后能被别人注册走，豁免不能跟着名字走。
const EXEMPT_USER_IDS = new Set([
  132777740, // ShinoyukiMiyako
]);
// GITHUB_TOKEN 发评论时的身份。用户名不能带方括号，这个名字伪造不了。
const COMMENT_AUTHOR = 'github-actions[bot]';
const MAX_WRITE_ATTEMPTS = 5;

function normalizeSignature(text) {
  return text.trim().replace(/[.。]$/u, '').toLowerCase();
}

const ACCEPTED_SIGNATURES = new Set(SIGNATURE_PHRASES.map(normalizeSignature));

export function isSignature(body) {
  return ACCEPTED_SIGNATURES.has(normalizeSignature(body));
}

// 有写权限的人能改别人的评论，REST 又查不到是谁改的，所以编辑过的评论一律不算：
// 否则把贡献者的旧评论改成签署语就等于代签。updated_at 偶尔会因编辑以外的操作变化，
// 这里宁可让人重发一条。已写进签名文件的记录不受影响，事后编辑或删除原评论都不撤销签署。
function isValidSignatureComment(comment) {
  return (
    comment.updated_at === comment.created_at &&
    Date.parse(comment.created_at) >= Date.parse(CLA_EFFECTIVE_AT) &&
    isSignature(comment.body)
  );
}

// 列 PR 提交的接口最多给 250 个。超过时改用比较接口：带 page 参数可以分页取完，每页最多 100 个，
// 总数在 total_commits。三点比较取的是 head 有、与 base 的合并基点之后的提交，和 PR 自己的提交列表一致；
// base.sha 落后时只会多列，不会少列。晋级 PR（dev 到 beta 有几百个提交）就走这条路，照样逐个核对作者。
const LIST_COMMITS_LIMIT = 250;
const PAGE_SIZE = 100;

async function listPullCommits(github, repository, pr) {
  if (pr.commits <= LIST_COMMITS_LIMIT) {
    return github.paginate(github.rest.pulls.listCommits, {
      ...repository,
      pull_number: pr.number,
      per_page: PAGE_SIZE,
    });
  }
  const commits = [];
  for (let page = 1; ; page += 1) {
    const { data } = await github.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
      ...repository,
      basehead: `${pr.base.sha}...${pr.head.sha}`,
      per_page: PAGE_SIZE,
      page,
    });
    commits.push(...data.commits);
    if (data.commits.length < PAGE_SIZE || commits.length >= data.total_commits) {
      return commits;
    }
  }
}

function isExempt(user) {
  return user.type === 'Bot' || EXEMPT_USER_IDS.has(user.id);
}

// 提交作者是按邮箱关联出来的，谁都能把邮箱填成维护者的或 Bot 的。同仓库的分支只有维护者和维护者装的应用能推，
// 照旧认关联结果；fork 的提交要另外证明。fork 删掉后 head.repo 为 null，来源同样确认不了，按 fork 处理。
function isFromFork(pr) {
  return pr.head.repo?.id !== pr.base.repo.id;
}

// GitHub 验证的是提交者的签名，不是作者的：把作者填成维护者、再用自己的密钥签，照样显示已验证。网页上的提交由
// GitHub 代签、提交者是 web-flow，签名只说明提交出自 GitHub，作者记成谁取决于当时的操作（压缩合并记成 PR 的开启者），
// 也证明不了维护者本人经手。所以要提交者就是作者本人、签名也经 GitHub 验证，才认是维护者自己的提交；维护者在网页上
// 给 fork 的 PR 更新分支产生的合并提交因此也会被点名，要改在本地签名后推送。Bot 不在此列：谁都能建 GitHub App
// 装到自己的 fork 上，fork 里的工作流也能以 github-actions[bot] 的身份提交，这些提交的内容都由 fork 的主人决定，
// 签名再真也证明不了出处。
function isProvenExemptCommit(commit) {
  return (
    EXEMPT_USER_IDS.has(commit.author.id) &&
    commit.commit.verification.verified &&
    commit.committer?.id === commit.author.id
  );
}

function collectContributors(pr, commits) {
  const required = new Map();
  const unlinkedByEmail = new Map();
  const unverified = [];
  const fromFork = isFromFork(pr);

  const addSigner = (user) => {
    if (!isExempt(user)) {
      required.set(user.id, user.login);
    }
  };

  // 开启者是建 PR 的登录账号，冒用不了，fork 的 PR 也照旧豁免。
  addSigner(pr.user);
  for (const commit of commits) {
    // 邮箱没关联账号时，接口可能给 null，也可能给空对象。
    if (commit.author?.id === undefined) {
      const { email, name } = commit.commit.author;
      if (!unlinkedByEmail.has(email)) {
        unlinkedByEmail.set(email, { sha: commit.sha, name });
      }
    } else if (fromFork && isExempt(commit.author) && !isProvenExemptCommit(commit)) {
      // 逐个列出而不按账号去重：要改的是这些提交本身。
      unverified.push({ sha: commit.sha, login: commit.author.login });
    } else {
      addSigner(commit.author);
    }
  }

  return { required, unlinked: [...unlinkedByEmail.values()], unverified };
}

// 记录的 ID 取自评论者本人，别人的评论只会产生别人的记录，代签不会落到被代签者头上。
function signaturesFromComments(comments, required, number) {
  const found = new Map();
  for (const comment of comments) {
    const id = comment.user?.id;
    if (required.has(id) && !found.has(id) && isValidSignatureComment(comment)) {
      found.set(id, {
        id,
        login: comment.user.login,
        version: CLA_VERSION,
        pr: number,
        comment: comment.html_url,
        at: comment.created_at,
      });
    }
  }
  return [...found.values()];
}

function signedIds(signatures) {
  return new Set(
    signatures.filter((signature) => signature.version === CLA_VERSION).map((signature) => signature.id),
  );
}

async function assertSignatureBranchExists(github, repository) {
  try {
    await github.rest.repos.getBranch({ ...repository, branch: SIGNATURE_BRANCH });
  } catch (error) {
    if (error.status === 404) {
      throw new Error(`签名分支 ${SIGNATURE_BRANCH} 不存在，需要先创建这条分支`, { cause: error });
    }
    throw error;
  }
}

async function loadSignatures(github, repository) {
  let file;
  try {
    ({ data: file } = await github.rest.repos.getContent({
      ...repository,
      path: SIGNATURE_FILE,
      ref: SIGNATURE_BRANCH,
    }));
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    // 分支和文件缺失都是 404。文件缺失只是还没人签过，分支缺失则是仓库没配好，不能当成空名单。
    await assertSignatureBranchExists(github, repository);
    return { sha: undefined, signatures: [] };
  }

  const signatures = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  if (!Array.isArray(signatures)) {
    throw new Error(`${SIGNATURE_BRANCH} 分支上的 ${SIGNATURE_FILE} 不是数组`);
  }
  return { sha: file.sha, signatures };
}

async function recordSignatures(github, repository, number, candidates) {
  for (let attempt = 1; ; attempt += 1) {
    const { sha, signatures } = await loadSignatures(github, repository);
    const signed = signedIds(signatures);
    const fresh = candidates.filter((signature) => !signed.has(signature.id));
    if (fresh.length === 0) {
      return signed;
    }

    const next = [...signatures, ...fresh];
    const logins = fresh.map((signature) => signature.login).join(', ');
    try {
      await github.rest.repos.createOrUpdateFileContents({
        ...repository,
        branch: SIGNATURE_BRANCH,
        path: SIGNATURE_FILE,
        sha,
        message: `chore(cla): ${logins} 签署 v${CLA_VERSION} (#${number})`,
        content: Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8').toString('base64'),
      });
      return signedIds(next);
    } catch (error) {
      // 409 说明别的 PR 抢先写了。必须基于最新内容重来，否则会盖掉对方的签署。
      if (error.status !== 409 || attempt === MAX_WRITE_ATTEMPTS) {
        throw error;
      }
    }
  }
}

// 作者名是提交者随便填的，直接进 Markdown 能伪造链接，或者 @ 到无关的人。
function codeSpan(text) {
  return `\`${text.replace(/[`\r\n]/g, ' ')}\``;
}

function signedCommentBody(claUrl) {
  return [
    COMMENT_MARKER,
    '**CLA 已签署 / CLA signed**',
    `本 PR 的贡献者都已签署 [CLA](${claUrl})，谢谢。`,
    `All contributors to this PR have signed the [CLA](${claUrl}). Thank you.`,
  ].join('\n\n');
}

function pendingCommentBody(claUrl, missing, unlinked, unverified) {
  const sections = [COMMENT_MARKER, '**CLA 尚未完成 / CLA not complete**'];

  if (missing.length > 0) {
    sections.push(
      `待签署 / Waiting for: ${missing.map((login) => `@${login}`).join(' ')}`,
      `合并前需要签署 [CLA](${claUrl})。读完后，把下面任意一句作为新评论发到本 PR。编辑旧评论不算，必须本人发。`,
      `Please read the [CLA](${claUrl}), then post either sentence below as a new comment on this PR. Editing an earlier comment does not count, and each person must post their own.`,
      ...SIGNATURE_PHRASES.map((phrase) => `\`\`\`text\n${phrase}\n\`\`\``),
    );
  }

  if (unlinked.length > 0) {
    const commits = unlinked.map(({ sha, name }) => `- ${codeSpan(sha.slice(0, 8))} ${codeSpan(name)}`);
    sections.push(
      '下列提交的邮箱没有关联 GitHub 账号，无法确认作者。请把邮箱关联到账号后再发一条评论重新检查，或者改用已关联的邮箱重新提交。',
      'The email on these commits is not linked to a GitHub account, so the author cannot be identified. Link the email to an account and comment here to re-check, or recommit with a linked email.',
      commits.join('\n'),
    );
  }

  if (unverified.length > 0) {
    // 登录名也进代码块：直接写会 @ 到维护者或 Bot。
    const commits = unverified.map(({ sha, login }) => `- ${codeSpan(sha.slice(0, 8))} ${codeSpan(login)}`);
    sections.push(
      '下列提交来自 fork，作者显示为维护者或机器人账号，但没有该账号本人经 GitHub 验证的签名，无法确认作者。请改用你自己的账号作为作者重新提交这些改动，推送后会自动重新检查。',
      "These commits come from a fork and are attributed to the maintainer or a bot account, but they lack a signature that GitHub verified as that account's own, so the author cannot be confirmed. Please recommit these changes with your own account as the author; the check reruns when you push.",
      commits.join('\n'),
    );
  }

  return sections.join('\n\n');
}

function isBotComment(comment) {
  return comment.user?.login === COMMENT_AUTHOR && comment.body.startsWith(COMMENT_MARKER);
}

// 全部通过且还没有评论时不发：老贡献者和豁免账号的 PR 不需要这条提示。
async function syncBotComment(github, repository, number, comments, body, passed) {
  const existing = comments.find(isBotComment);
  if (existing !== undefined) {
    if (existing.body !== body) {
      await github.rest.issues.updateComment({ ...repository, comment_id: existing.id, body });
    }
  } else if (!passed) {
    await github.rest.issues.createComment({ ...repository, issue_number: number, body });
  }
}

export async function runClaCheck({ github, context, core }) {
  const repository = context.repo;
  const number = context.payload.pull_request?.number ?? context.payload.issue.number;
  const { owner, repo } = repository;
  const claUrl = `https://github.com/${owner}/${repo}/blob/${context.payload.repository.default_branch}/CLA.md`;

  const { data: pr } = await github.rest.pulls.get({ ...repository, pull_number: number });
  const commits = await listPullCommits(github, repository, pr);
  // 列不全就确认不了所有作者，不能放行。
  if (commits.length < pr.commits) {
    throw new Error(`PR #${number} 有 ${pr.commits} 个提交，只取到 ${commits.length} 个，无法核对全部作者`);
  }
  // 每次都扫整条评论而不是只看触发事件：运行被取消或重跑后，结果仍然一致。
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repository,
    issue_number: number,
    per_page: 100,
  });

  const { required, unlinked, unverified } = collectContributors(pr, commits);
  const candidates = signaturesFromComments(comments, required, number);
  const signed = await recordSignatures(github, repository, number, candidates);

  const missing = [...required].filter(([id]) => !signed.has(id)).map(([, login]) => login);
  const passed = missing.length === 0 && unlinked.length === 0 && unverified.length === 0;
  const state = passed ? 'success' : 'failure';

  // 未签署不让作业失败：结果全在提交状态上，签署后不会残留红色的失败运行，也就不需要重跑权限。
  await github.rest.repos.createCommitStatus({
    ...repository,
    sha: pr.head.sha,
    context: STATUS_CONTEXT,
    state,
    description: passed ? 'CLA 已签署 / CLA signed' : 'CLA 尚未完成，见 PR 评论 / See the PR comment',
    target_url: claUrl,
  });

  const body = passed ? signedCommentBody(claUrl) : pendingCommentBody(claUrl, missing, unlinked, unverified);
  await syncBotComment(github, repository, number, comments, body, passed);

  // 作者名不进日志：以 :: 开头的内容会被 runner 当成工作流命令。
  core.info(
    `PR #${number}: ${state}，待签署 ${missing.length} 人，未关联提交 ${unlinked.length} 个，作者无法确认的 fork 提交 ${unverified.length} 个`,
  );
  return { state, missing, unlinked, unverified };
}
