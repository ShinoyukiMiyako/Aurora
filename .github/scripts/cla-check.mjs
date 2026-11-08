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

// 状态写在 pulls.get 取到的 head.sha 上，提交却是另一次调用取的。列提交接口只认 PR 号，给的是调用那一刻 PR 上的提交，
// 两次调用之间被强推，列出的就是别的 head 的提交。提交状态按 sha 共享，按别的 head 判出的 success 会落到另一个停在
// head.sha、含未签提交的 PR 上。比较接口按 sha 取，本身对得上，也一并核对。
//
// 不要求 head.sha 排在最后：两个接口都按时间从旧到新排，时间由提交者自己填，排在最后的不一定是 head。新 head 是
// head.sha 的后代时，它的提交包含 head.sha 的全部提交，按它判出的 success 对 head.sha 同样成立（failure 只会偏严），
// 不必让人重跑；不是后代时，列表里没有 head.sha。
//
// 只查包含还不够：列提交接口超过 250 个时丢掉的是最早的，后代多出的提交会把 head.sha 的老提交挤出列表；分页之间被推送，
// 各页也会来自不同的 head。这两种情况 head.sha 都还在。所以再从 head.sha 沿父提交在列表里走：走到的都是 head.sha 自己的
// PR 提交，个数够 pr.commits 才一个不缺。PR 的任一提交与 head.sha 之间只隔着 PR 自己的提交，列全了一定走得到。
function assertCoversHead(pr, commits) {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  if (!bySha.has(pr.head.sha)) {
    throw new Error(`PR #${pr.number} 取到的提交里没有 head ${pr.head.sha}，可能是检查过程中分支被强推，重跑本检查即可`);
  }
  const reached = new Set([pr.head.sha]);
  const pending = [pr.head.sha];
  while (pending.length > 0) {
    for (const parent of bySha.get(pending.pop()).parents) {
      if (bySha.has(parent.sha) && !reached.has(parent.sha)) {
        reached.add(parent.sha);
        pending.push(parent.sha);
      }
    }
  }
  if (reached.size < pr.commits) {
    throw new Error(
      `PR #${pr.number} 有 ${pr.commits} 个提交，取到的提交里从 head ${pr.head.sha} 只走得到 ${reached.size} 个，可能是检查过程中分支又有推送，重跑本检查即可`,
    );
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

// GitHub 网页代签时的提交者账号，ID 由 gh api users/web-flow 查得。它的 type 是 User，按类型认不出来，只能按 ID 认。
const WEB_FLOW_USER_ID = 19864447;

// octokit/openapi 的 Signature verification object 表里，verification.reason 只有这两个说的是 GitHub 的验证服务
// 本身出错：gpgverify_error 是与验证服务通信出错，gpgverify_unavailable 是验证服务暂时不可用。其余原因（expired_key、
// not_signing_key、unsigned、unknown_signature_type、no_user、unverified_email、bad_email、unknown_key、
// malformed_signature、invalid）说的都是签名、密钥或邮箱本身，照旧当作没有有效签名。同一个验证对象在 webhook-status
// 的枚举里还多两个 S/MIME 证书的原因：ocsp_pending 是证书吊销检查还没做完，也会自己恢复；bad_cert 是证书本身有问题。
const TRANSIENT_VERIFICATION_REASONS = new Set(['gpgverify_error', 'gpgverify_unavailable', 'ocsp_pending']);

// fork 里作者显示为维护者或 Bot 的提交，作者是谁证明不了，改由提交者负责：把这个提交放进 fork 的是提交者，变基、拣选
// 别人的提交，或者把作者冒填成维护者再用自己的账号提交，责任都在他，所以要他签署。维护者推到贡献者分支的签名提交，
// 贡献者一变基，提交者就换成贡献者、签名也没了，这样判不会让贡献者把维护者写的代码记到自己名下。
// 下面两类提交者替不了真人担责：网页上的提交由 GitHub 代签、提交者是 web-flow，签名只说明提交出自 GitHub，作者记成谁
// 取决于当时的操作（压缩合并记成 PR 的开启者），维护者在网页上给 fork 的 PR 更新分支产生的合并提交因此会被点名，要改在
// 本地签名后推送；谁都能建 GitHub App 装到自己的 fork 上，fork 里的工作流也能以 github-actions[bot] 的身份提交，这些
// 提交的内容都由 fork 的主人决定，Bot 的签名再真也证明不了出处。
function isAccountableCommitter(user) {
  return user.id !== WEB_FLOW_USER_ID && !isExempt(user);
}

// 提交者是维护者时，要签名经 GitHub 验证才认是维护者本人经手：GitHub 验证的是提交者的签名（no_user、bad_email 都按
// 提交者邮箱判），提交者邮箱同样谁都能填成维护者的。作者是 Bot 也一样认：签名证明了维护者本人把它放进来。
function isProvenExemptCommit(commit) {
  if (!EXEMPT_USER_IDS.has(commit.committer.id)) {
    return false;
  }
  const { verified, reason } = commit.commit.verification;
  // 验证服务出错时维护者的真签名也显示未验证，判成冒用会冤枉人，而没有新的推送或评论就不会再查，所以让作业失败等重跑。
  if (!verified && TRANSIENT_VERIFICATION_REASONS.has(reason)) {
    throw new Error(
      `GitHub 签名验证暂时不可用（verification.reason 为 ${reason}），无法确认提交 ${commit.sha} 是否经维护者本人签名，请稍后重跑本检查`,
    );
  }
  return verified;
}

function collectContributors(pr, commits) {
  const required = new Map();
  const unlinkedByEmail = new Map();
  const unverified = [];
  const fromFork = isFromFork(pr);
  // fork 删掉后确认不了主人。这个状态不会自己恢复，所以判失败而不抛错：抛错只会让之后每次重查都红。
  const forkDeleted = fromFork && pr.head.repo === null;

  const addSigner = (user) => {
    if (!isExempt(user)) {
      required.set(user.id, user.login);
    }
  };
  const addUnlinked = (sha, { email, name }) => {
    if (!unlinkedByEmail.has(email)) {
      unlinkedByEmail.set(email, { sha, name });
    }
  };

  // 开启者是建 PR 的登录账号，冒用不了，fork 的 PR 也照旧豁免。
  addSigner(pr.user);
  // 提交作者按邮箱关联，没签的人在自己的 fork 里把作者邮箱填成已签者的，再请豁免的维护者代开 PR，就没人需要签了。
  // fork 的分支归它的主人控制，这层归属改不了，所以 fork 的主人也要签。取 head.repo.owner 而不取 head.user：
  // 前者是此刻持有分支的仓库的主人；后者在 fork 删掉后仍有值，但接口没写明含义，fork 转手后跟不跟着变也查不到。
  // 组织没法发评论签署，归组织的 fork 不要求签。残留风险：组织 fork 里冒用已签者邮箱的提交，维护者代开时仍能通过。
  if (fromFork && !forkDeleted && pr.head.repo.owner.type !== 'Organization') {
    addSigner(pr.head.repo.owner);
  }
  for (const commit of commits) {
    // 邮箱没关联账号时，接口可能给 null，也可能给空对象。
    if (commit.author?.id === undefined) {
      addUnlinked(commit.sha, commit.commit.author);
    } else if (fromFork && isExempt(commit.author)) {
      if (commit.committer?.id === undefined) {
        // 提交者邮箱没关联账号，就找不到该负责的人，和作者邮箱没关联是一回事，关联邮箱或换已关联的邮箱重新提交都能解决，
        // 所以并进未关联提交，列的是提交者的名字。
        addUnlinked(commit.sha, commit.commit.committer);
      } else if (isAccountableCommitter(commit.committer)) {
        addSigner(commit.committer);
      } else if (!isProvenExemptCommit(commit)) {
        // 逐个列出而不按账号去重：要改的是这些提交本身。
        unverified.push({ sha: commit.sha, login: commit.author.login, committer: commit.committer.login });
      }
    } else {
      addSigner(commit.author);
    }
  }

  return { required, unlinked: [...unlinkedByEmail.values()], unverified, forkDeleted };
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

function pendingCommentBody(claUrl, missing, unlinked, unverified, forkDeleted) {
  const sections = [COMMENT_MARKER, '**CLA 尚未完成 / CLA not complete**'];

  // 放在最前：签了也过不了，先说清出路。
  if (forkDeleted) {
    sections.push(
      '本 PR 来源的 fork 已被删除，无法确认分支归谁所有。来自 fork 的 PR 需要 fork 的主人签署，这个 PR 因此无法通过检查。请从仍然存在的 fork 重新开一个 PR。',
      "The fork this PR comes from has been deleted, so the owner of its branch cannot be confirmed. A PR from a fork needs the fork's owner to sign, so this PR cannot pass the check. Please open a new PR from a fork that still exists.",
    );
  }

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
      '下列提交的邮箱没有关联 GitHub 账号，无法确认该由谁签署。请把邮箱关联到账号后再发一条评论重新检查，或者改用已关联的邮箱重新提交。',
      'The email on these commits is not linked to a GitHub account, so it cannot be determined who needs to sign. Link the email to an account and comment here to re-check, or recommit with a linked email.',
      commits.join('\n'),
    );
  }

  if (unverified.length > 0) {
    // 登录名也进代码块：直接写会 @ 到维护者或 Bot。
    const commits = unverified.map(
      ({ sha, login, committer }) =>
        `- ${codeSpan(sha.slice(0, 8))} ${codeSpan(login)}（提交者 / committer ${codeSpan(committer)}）`,
    );
    sections.push(
      '下列提交来自 fork，作者显示为维护者或机器人账号，提交者却是 GitHub 网页代签的 `web-flow`、机器人账号，或者没有经 GitHub 验证签名的维护者账号，无法确认由谁负责。维护者本人的提交（包括维护者在网页上更新分支产生的合并提交）要由维护者在本地签名后重新推送。其余的请用你自己的账号在本地重写这些提交，例如 `git rebase --force-rebase <PR 的目标分支>` 后强制推送：作者不变，提交者换成你，这些提交改由你签署 CLA 负责。推送后会自动重新检查。',
      "These commits come from a fork and are attributed to the maintainer or a bot account, but their committer is GitHub web signing (`web-flow`), a bot account, or the maintainer account without a signature verified by GitHub, so it cannot be confirmed who is responsible for them. Commits the maintainer made (including merge commits from updating the branch on the web) need to be signed locally and pushed again by the maintainer. For the rest, rewrite these commits locally with your own account, for example `git rebase --force-rebase <PR base branch>` followed by a force-push: the author stays the same, you become the committer, and you sign the CLA for them. The check reruns when you push.",
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

  let pr;
  try {
    ({ data: pr } = await github.rest.pulls.get({ ...repository, pull_number: number }));
  } catch (error) {
    // 取不到 PR 时，pull_request_target 的载荷里还有触发时的 head，照样能把旧结论改成 error；issue_comment 的载荷里
    // 没有 head，只能让作业失败。
    const sha = context.payload.pull_request?.head?.sha;
    if (sha !== undefined) {
      await markErrored({ github, repository, context, sha, error });
    }
    throw error;
  }
  // 关了的 PR 不再重查：已合并的 PR 下有人评论（报回归、致谢）也会触发检查，这时 fork 可能早删了，重判会在进了历史的提交上
  // 写 failure，还在已合并的 PR 下叫人重开；按同一个 head 重开的新 PR 也会被旧 PR 的评论改回 failure。重新打开会再查一次。
  // 代价是在关了的 PR 下发的签署评论不记录，下次开 PR 时再签。
  if (pr.state !== 'open') {
    core.info(`PR #${number} 已关闭，不重查`);
    return { state: 'skipped' };
  }

  // 只有判定途中出错才改成 error。结论写上 head 之后再出错（例如同步机器人评论失败），head 上那份就是这次算出的，
  // 不是过时的，改成 error 反倒挡住合并，所以写状态和评论放在外面。
  let verdict;
  try {
    verdict = await judgePull({ github, repository, pr });
  } catch (error) {
    await markErrored({ github, repository, context, sha: pr.head.sha, error });
    throw error;
  }
  const { comments, missing, unlinked, unverified, forkDeleted, passed } = verdict;
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

  const body = passed
    ? signedCommentBody(claUrl)
    : pendingCommentBody(claUrl, missing, unlinked, unverified, forkDeleted);
  await syncBotComment(github, repository, number, comments, body, passed);

  // 作者名不进日志：以 :: 开头的内容会被 runner 当成工作流命令。
  core.info(
    `PR #${number}: ${state}，待签署 ${missing.length} 人，未关联提交 ${unlinked.length} 个，提交者担不了责的 fork 提交 ${unverified.length} 个${forkDeleted ? '，fork 已删除、无法确认主人' : ''}`,
  );
  return { state, missing, unlinked, unverified, forkDeleted };
}

// 查到一半出错时 head 上可能还留着上一次的结论：改了目标分支后重查，旧基分支下算出的 success 原样留着照样能合并。
// 先把状态改成 error 再让作业失败；写状态也失败时两个错误一起报，不丢原因。
async function markErrored({ github, repository, context, sha, error }) {
  try {
    await github.rest.repos.createCommitStatus({
      ...repository,
      sha,
      context: STATUS_CONTEXT,
      state: 'error',
      description: '检查出错，请重跑 / Check errored, re-run it',
      target_url: `${context.serverUrl}/${repository.owner}/${repository.repo}/actions/runs/${context.runId}`,
    });
  } catch (statusError) {
    throw new AggregateError([error, statusError], `CLA 检查出错，把状态改成 error 也失败了：${statusError.message}`);
  }
}

async function judgePull({ github, repository, pr }) {
  const { number } = pr;
  const commits = await listPullCommits(github, repository, pr);
  // 列不全就确认不了所有作者，不能放行。
  if (commits.length < pr.commits) {
    throw new Error(`PR #${number} 有 ${pr.commits} 个提交，只取到 ${commits.length} 个，无法核对全部作者`);
  }
  assertCoversHead(pr, commits);
  // 每次都扫整条评论而不是只看触发事件：运行被取消或重跑后，结果仍然一致。
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repository,
    issue_number: number,
    per_page: 100,
  });

  const { required, unlinked, unverified, forkDeleted } = collectContributors(pr, commits);
  const candidates = signaturesFromComments(comments, required, number);
  const signed = await recordSignatures(github, repository, number, candidates);

  const missing = [...required].filter(([id]) => !signed.has(id)).map(([, login]) => login);
  const passed = missing.length === 0 && unlinked.length === 0 && unverified.length === 0 && !forkDeleted;
  return { comments, missing, unlinked, unverified, forkDeleted, passed };
}
