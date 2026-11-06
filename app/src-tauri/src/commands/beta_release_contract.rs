//! `.github/workflows/beta-release.yml` 与客户端之间的契约。工作流只能靠真跑验证，下面这几处一旦走样，
//! CI 上不会有任何报错：要么所有 beta 客户端拒收更新，要么防降级、凭据隔离和签名前的审批悄悄失效，
//! 而发布钥与正式版共用，失效的代价落在正式版上。
//!
//! 只看真正执行的行：文件头和步骤上方的注释里也写着这些键和命令，拿全文找子串的话，删掉真正的那一行照样能过。

const WORKFLOW: &str = include_str!("../../../../.github/workflows/beta-release.yml");

/// beta 客户端唯一会问的清单地址，写法与 updater 里的端点常量相同。
const BETA_MANIFEST_URL: &str = concat!(
    "https://",
    petalfall_base::app_slug!(),
    ".org/updates/beta/latest.json"
);

const BETA_ONLY: &str = "if: github.ref == 'refs/heads/beta'";

fn is_code(line: &str) -> bool {
    !line.is_empty() && !line.starts_with('#') && !line.starts_with("//")
}

/// 整个工作流里真正执行的行，去掉首尾空白。Windows 检出的是 CRLF，`lines` 按两种换行都切。
fn code_lines() -> Vec<&'static str> {
    WORKFLOW
        .lines()
        .map(str::trim)
        .filter(|line| is_code(line))
        .collect()
}

/// 缩进与内容；空行与注释行算不上任何层级的边界。
fn indent_of(line: &str) -> Option<usize> {
    let content = line.trim_start();
    (!content.is_empty() && !content.starts_with('#')).then(|| line.len() - content.len())
}

/// `jobs` 下的作业名，按出现顺序。
fn job_names() -> Vec<&'static str> {
    WORKFLOW
        .lines()
        .map(str::trim_end)
        .skip_while(|line| *line != "jobs:")
        .skip(1)
        .take_while(|line| indent_of(line).is_none_or(|indent| indent > 0))
        .filter(|line| indent_of(line) == Some(2))
        .filter_map(|line| line.trim_start().strip_suffix(':'))
        .collect()
}

/// 作业 `name` 那一段里真正执行的行：从 `  name:` 起，到下一个同级作业或顶层键之前。
fn job(name: &str) -> Vec<&'static str> {
    let header = format!("  {name}:");
    let mut lines = WORKFLOW
        .lines()
        .map(str::trim_end)
        .skip_while(|line| *line != "jobs:")
        .skip_while(|line| *line != header);
    let first = lines
        .next()
        .unwrap_or_else(|| panic!("beta-release.yml 里找不到作业 {name}"));
    std::iter::once(first)
        .chain(lines.take_while(|line| indent_of(line).is_none_or(|indent| indent > 2)))
        .map(str::trim)
        .filter(|line| is_code(line))
        .collect()
}

/// 这些行里引用到的 `secrets.<名字>`，去重后按字母排。
fn secret_names(lines: &[&str]) -> Vec<String> {
    let mut names: Vec<String> = lines
        .iter()
        .flat_map(|line| {
            line.match_indices("secrets.")
                .map(move |(at, _)| &line[at + 8..])
        })
        .map(|rest| {
            rest.chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect()
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// 注入的必须是发布钥的公钥、并打开 requireSignedVersion：换成 dev 的公钥，所有 beta 客户端拒收发布钥签的包；
/// 漏了开关，detect_support 判为不支持，beta 包收不到任何更新。整行比对，写进别的层级、或多带一项
/// （比如 allowDowngrades）都要挂；只能注入一次，而且在不持任何发布凭据的 build 里。
#[test]
fn build_injects_the_release_pubkey_with_signed_version() {
    let expected = "conf.plugins = { ...conf.plugins, updater: { pubkey: \
                    fs.readFileSync('../.github/release-updater.pub', 'utf8').trim(), \
                    requireSignedVersion: true } };";
    let injected: Vec<&str> = code_lines()
        .into_iter()
        .filter(|line| line.contains("conf.plugins"))
        .collect();
    assert_eq!(injected, [expected]);
    assert!(
        job("build").contains(&expected),
        "更新插件的配置不再写在 build 作业里"
    );
}

/// 客户端开了 requireSignedVersion，签名时不把这次的版本号写进可信注释，插件拒收每一个 beta 包。
/// 签完按仓库里的发布公钥验签、核对签名里的版本，私钥配错或漏传版本在这里挡下，不等用户拒收。
#[test]
fn sign_writes_the_version_into_the_trusted_comment() {
    let sign = job("sign");
    let signing: Vec<&&str> = sign
        .iter()
        .filter(|line| line.contains("signer sign"))
        .collect();
    assert_eq!(
        signing.len(),
        1,
        "sign 作业里应恰有一条签名命令：{signing:?}"
    );
    assert!(
        signing[0].contains("signer sign --app-version \"$VERSION\" "),
        "签名不再把版本号写进可信注释：{}",
        signing[0]
    );
    assert!(
        sign.contains(
            &"run: node .github/scripts/verify-update-signature.mjs .github/release-updater.pub \
              \"$BOOTSTRAP\" \"$BOOTSTRAP.sig\" \"$VERSION\""
        ),
        "签完不再按发布公钥验签、核对签名里的版本"
    );
}

/// beta 客户端只问这一个地址：推送后回读、发布前比版本，读的都得是它，否则推上去了也核对不到客户端看到的那份，
/// 版本检查也比错了清单。
#[test]
fn hk_manifest_url_is_the_beta_endpoint() {
    let expected = format!("HK_MANIFEST_URL: {BETA_MANIFEST_URL}");
    let declared: Vec<&str> = code_lines()
        .into_iter()
        .filter(|line| line.starts_with("HK_MANIFEST_URL:"))
        .collect();
    assert!(!declared.is_empty(), "工作流里不再声明 HK_MANIFEST_URL");
    for line in &declared {
        assert_eq!(*line, expected);
    }
    let reads_hk_manifest =
        |line: &&str| line.contains("curl ") && line.contains("\"$HK_MANIFEST_URL\"");

    let publish_hk = job("publish-hk");
    assert!(
        publish_hk.contains(&expected.as_str()),
        "publish-hk 不再声明 beta 清单地址"
    );
    assert!(
        publish_hk.contains(&"run: bash .github/scripts/push-hk-manifest.sh \"$MANIFEST\""),
        "publish-hk 不再推送香港清单"
    );
    assert!(
        publish_hk
            .iter()
            .any(|line| reads_hk_manifest(line) && line.contains("--write-out '%{content_type}'")),
        "publish-hk 推送之后不再经公网回读香港清单、核对 Content-Type"
    );

    let stage = job("stage");
    assert!(
        stage.contains(&expected.as_str()),
        "stage 不再声明 beta 清单地址"
    );
    assert!(
        stage.iter().any(reads_hk_manifest),
        "stage 不再读香港清单检查版本号有没有倒退"
    );
}

/// 持私钥的作业拿不到任何发布渠道：桶凭据、香港推送钥、能写仓库的令牌都不在这里，借道 sign 签出来的包
/// 自己发不出去。它引用的机密只能是发布私钥和口令两项。
#[test]
fn sign_holds_no_distribution_credentials() {
    let sign = job("sign");
    for prefix in ["OSS_", "R2_", "HK_"] {
        let leaked: Vec<&&str> = sign.iter().filter(|line| line.contains(prefix)).collect();
        assert!(
            leaked.is_empty(),
            "sign 作业里出现了 {prefix} 开头的凭据：{leaked:?}"
        );
    }
    assert_eq!(
        secret_names(&sign),
        [
            "RELEASE_UPDATER_KEY_PASSWORD",
            "RELEASE_UPDATER_PRIVATE_KEY"
        ]
    );
    assert!(sign.contains(&"environment: release-signing"));
    assert!(
        !sign.iter().any(|line| line.contains("github.token")),
        "sign 作业不该拿仓库令牌"
    );
    assert!(sign.contains(&"contents: read"));
    assert!(
        !sign.iter().any(|line| line.ends_with(": write")),
        "sign 作业不该有任何写权限"
    );
}

/// build 在一次性托管机上跑、不挂环境，拿不到发布私钥、桶凭据和推送钥；它要的机密只有内嵌进包里的
/// CurseForge key。挂了环境，构建步骤（含依赖的安装脚本）就能读到环境里的机密。
#[test]
fn build_declares_no_environment() {
    let build = job("build");
    assert!(
        !build.iter().any(|line| line.starts_with("environment:")),
        "build 作业不该声明环境"
    );
    assert_eq!(secret_names(&build), ["PETALFALL_CURSEFORGE_API_KEY"]);
    assert!(
        build.contains(&"runs-on: ubuntu-24.04"),
        "build 作业不再跑在一次性托管机上"
    );
}

/// 环境自带的分支限制之外再兜一层：演练（workflow_dispatch 在 dev 上）只跑 build，挂环境的作业一律跳过。
/// 作业集合也钉住：新加的作业要先想清楚它挂哪个环境、该不该只在 beta 上跑。
#[test]
fn jobs_with_an_environment_only_run_on_beta() {
    assert_eq!(job_names(), ["build", "sign", "stage", "publish-hk"]);
    for (name, environment) in [
        ("sign", "release-signing"),
        ("stage", "updates-beta"),
        ("publish-hk", "updates-beta"),
    ] {
        let lines = job(name);
        assert!(
            lines.contains(&format!("environment: {environment}").as_str()),
            "{name} 应挂环境 {environment}"
        );
        assert!(
            lines.contains(&BETA_ONLY),
            "{name} 挂了环境却没限定在 beta 上跑"
        );
    }
}

/// 只认 beta 的推送和手动演练：pull_request 会让 fork 的代码跑进来，tag 触发时工作流取自被打 tag 的任意提交。
/// 同一分支串行、不取消：beta 序号按已发布的 tag 加 1，并行的两个运行会算出同一个号，掐在半路会留下半成品。
#[test]
fn runs_are_beta_pushes_serialized_per_branch() {
    let lines = code_lines();
    let on = lines
        .iter()
        .position(|line| *line == "on:")
        .expect("工作流里没有 on:");
    assert_eq!(
        lines[on..on + 4],
        ["on:", "push:", "branches: [beta]", "workflow_dispatch:"]
    );
    assert_eq!(
        lines[on + 4],
        "concurrency:",
        "触发条件不止 beta 的推送和手动演练"
    );
    assert_eq!(
        lines[on + 5..on + 7],
        [
            "group: beta-release-${{ github.ref_name }}",
            "cancel-in-progress: false"
        ]
    );
}
