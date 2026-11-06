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

// 晋级 PR（dev 到 beta、beta 到 main）的提交都已在发布分支上：这两个分支只有有写权限的人能推，
// 别人的提交经 PR 合进去，那条 PR 已核对过 CLA。只认本仓库的分支，fork 里同名的分支谁都能推。
function isPromotion(pr, defaultBranch) {
  return pr.head.repo?.id === pr.base.repo.id && [defaultBranch, 'beta'].includes(pr.head.ref);
}

function collectContributors(pr, commits) {
  const required = new Map();
  const unlinkedByEmail = new Map();

  const addSigner = (user) => {
    if (user.type !== 'Bot' && !EXEMPT_USER_IDS.has(user.id)) {
      required.set(user.id, user.login);
    }
  };

  addSigner(pr.user);
  for (const commit of commits) {
    // 邮箱没关联账号时，接口可能给 null，也可能给空对象。
    if (commit.author?.id === undefined) {
      const { email, name } = commit.commit.author;
      if (!unlinkedByEmail.has(email)) {
        unlinkedByEmail.set(email, { sha: commit.sha, name });
      }
    } else {
      addSigner(commit.author);
    }
  }

  return { required, unlinked: [...unlinkedByEmail.values()] };
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

function pendingCommentBody(claUrl, missing, unlinked) {
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
  // 晋级 PR 不逐个核对提交作者，只看开启者：它们常常超过下面接口 250 个提交的上限，逐个核对就永远判不下来。
  const promotion = isPromotion(pr, context.payload.repository.default_branch);
  const commits = promotion
    ? []
    : await github.paginate(github.rest.pulls.listCommits, {
        ...repository,
        pull_number: number,
        per_page: 100,
      });
  // 这个接口最多返回 250 个提交。列不全就确认不了所有作者，不能放行。
  if (!promotion && commits.length < pr.commits) {
    throw new Error(`PR #${number} 有 ${pr.commits} 个提交，只取到 ${commits.length} 个，无法核对全部作者`);
  }
  // 每次都扫整条评论而不是只看触发事件：运行被取消或重跑后，结果仍然一致。
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repository,
    issue_number: number,
    per_page: 100,
  });

  const { required, unlinked } = collectContributors(pr, commits);
  const candidates = signaturesFromComments(comments, required, number);
  const signed = await recordSignatures(github, repository, number, candidates);

  const missing = [...required].filter(([id]) => !signed.has(id)).map(([, login]) => login);
  const passed = missing.length === 0 && unlinked.length === 0;
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

  const body = passed ? signedCommentBody(claUrl) : pendingCommentBody(claUrl, missing, unlinked);
  await syncBotComment(github, repository, number, comments, body, passed);

  // 作者名不进日志：以 :: 开头的内容会被 runner 当成工作流命令。
  core.info(`PR #${number}: ${state}，待签署 ${missing.length} 人，未关联提交 ${unlinked.length} 个`);
  return { state, missing, unlinked };
}
