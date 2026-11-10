//! 版本先后与发布通道。
//!
//! 先后一律按标准 semver 优先级比，不加任何自定义规则：已经发出去的启动器、更新插件和安装引导程序都按
//! semver 比，这里换一种比法，就会和它们各判各的。

use std::cmp::Ordering;

use semver::Version;
use serde::{Deserialize, Serialize};

/// 两个版本谁先谁后：标准 semver 优先级，构建元数据不参与，只差构建元数据的两个版本算同一版。
///
/// `Version` 自带的 `Ord` 在优先级相同时还会比构建元数据，所以不能直接拿它排先后。
///
/// 同一基础号下恒有 `X.Y.0-beta.M < X.Y.0-dev.N < X.Y.0`：预发布标识按 ASCII 比，beta 排在 dev 前面，
/// 后面的序号再大也没用。
pub fn compare_versions(a: &Version, b: &Version) -> Ordering {
    a.cmp_precedence(b)
}

/// 发布通道。落盘与跨进程一律用小写名 `dev`、`beta`、`stable`，与 [`Channel::as_str`] 相同。
///
/// 不实现 `Ord`：通道之间只有快慢，比快慢用 [`Channel::is_faster_than`] 与 [`Channel::is_slower_than`]，
/// 不靠声明顺序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// 预览版：dev 分支的 CI 构建，版本号形如 `1.0.0-dev.12`。
    Dev,
    /// 测试版：beta 分支的 CI 构建，版本号形如 `1.0.0-beta.3`。
    Beta,
    /// 正式版：不带预发布标识，版本号形如 `1.0.0`。
    Stable,
}

impl Channel {
    /// 由预发布标识判通道。没有预发布标识的是正式版；否则看标识的第一段：`dev`、`beta` 后面只跟数字
    /// （或什么都不跟）的分别是预览版、测试版，大小写不论，与前端 build-info 认这两种标识的规则一致。
    /// semver 的预发布标识只含 ASCII。
    ///
    /// 其余标识（rc、alpha 等）没有自己的清单，返回 `None`、由调用方判为认不出，不落到哪个通道顶上：
    /// 落到正式通道的话，测试包会去问正式版的清单。
    pub fn of(pre_release: &str) -> Option<Self> {
        if pre_release.is_empty() {
            return Some(Channel::Stable);
        }
        let tag = pre_release
            .split_once('.')
            .map_or(pre_release, |(head, _)| head);
        [("dev", Channel::Dev), ("beta", Channel::Beta)]
            .into_iter()
            .find(|(name, _)| names_channel(tag, name))
            .map(|(_, channel)| channel)
    }

    /// 版本所属的通道，规则同 [`Channel::of`]。构建元数据不参与；主版本是 0 的版本不带预发布标识时同样是正式版。
    pub fn of_version(version: &Version) -> Option<Self> {
        Self::of(version.pre.as_str())
    }

    /// 落盘与跨进程用的名字，也是清单路径 `/updates/<通道>/` 里的那一段。
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Dev => "dev",
            Channel::Beta => "beta",
            Channel::Stable => "stable",
        }
    }

    /// 从 [`Channel::as_str`] 的名字认回通道。只认这三个小写名，别的写法（包括大小写不同的）一律 `None`：
    /// 这些名字只由程序写出，认不出说明是更新的版本写了新的通道名，或者被手改过，交给调用方处理，不猜。
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "dev" => Some(Channel::Dev),
            "beta" => Some(Channel::Beta),
            "stable" => Some(Channel::Stable),
            _ => None,
        }
    }

    /// `self` 是否比 `other` 快。快慢次序：预览版最快，测试版其次，正式版最慢；同一个通道不比自己快。
    pub fn is_faster_than(self, other: Self) -> bool {
        self.speed_rank() < other.speed_rank()
    }

    /// `self` 是否比 `other` 慢，与 [`Channel::is_faster_than`] 方向相反；同一个通道不比自己慢。
    pub fn is_slower_than(self, other: Self) -> bool {
        self.speed_rank() > other.speed_rank()
    }

    /// 越快越小。只在这两个比较里用，不公开，免得调用方拿名次做算术。
    fn speed_rank(self) -> u8 {
        match self {
            Channel::Dev => 0,
            Channel::Beta => 1,
            Channel::Stable => 2,
        }
    }
}

/// 预发布标识的第一段 `tag` 是不是 `name` 后面只跟数字（或什么都不跟），`name` 不分大小写。
fn names_channel(tag: &str, name: &str) -> bool {
    tag.get(..name.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(name))
        && tag[name.len()..].bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::Value;

    /// Rust 与几个 node 脚本共读的同一份向量：任何一处的比较或认通道与它不符，那一处的测试就挂。
    const VECTORS: &str = include_str!("../testdata/version-order.json");

    /// 2^53 + 1：JS 的 Number 从这里起分不清相邻的整数，序号比较必须按大整数比。
    const TWO_POW_53_PLUS_1: u128 = (1 << 53) + 1;

    /// 序号的边界：0、1、一位数与两位数的分界、2^53 前后、u64 的上限。
    const BOUNDARY_SEQS: [u128; 7] = [0, 1, 9, 10, 1 << 53, TWO_POW_53_PLUS_1, u64::MAX as u128];

    #[derive(Deserialize)]
    struct Vectors {
        order: Vec<OrderCase>,
        channel: Vec<ChannelCase>,
    }

    #[derive(Deserialize)]
    struct OrderCase {
        a: String,
        b: String,
        cmp: i8,
    }

    #[derive(Deserialize)]
    struct ChannelCase {
        version: String,
        channel: Option<String>,
    }

    fn parse(text: &str) -> Version {
        Version::parse(text).unwrap_or_else(|err| panic!("{text} 不是合法版本号：{err}"))
    }

    fn sorted_keys(value: &Value) -> Vec<&str> {
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap_or_else(|| panic!("{value} 不是对象"))
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        keys
    }

    /// 先按原始 JSON 核对每一层的键恰好是约定的那几个，再按类型读：node 脚本按键名直接取值，
    /// 少一个键在那边是 undefined 而不是 null，多一个键也没人读。
    fn vectors() -> Vectors {
        let raw: Value = serde_json::from_str(VECTORS).expect("version-order.json 不是 JSON");
        assert_eq!(sorted_keys(&raw), ["channel", "order"]);
        for entry in raw["order"].as_array().expect("order 不是数组") {
            assert_eq!(sorted_keys(entry), ["a", "b", "cmp"], "{entry}");
        }
        for entry in raw["channel"].as_array().expect("channel 不是数组") {
            assert_eq!(sorted_keys(entry), ["channel", "version"], "{entry}");
        }
        serde_json::from_value(raw).expect("version-order.json 的值类型不对")
    }

    fn expected_ordering(cmp: i8) -> Ordering {
        match cmp {
            -1 => Ordering::Less,
            0 => Ordering::Equal,
            1 => Ordering::Greater,
            other => panic!("cmp 只能是 -1、0、1，实际是 {other}"),
        }
    }

    #[test]
    fn shared_vectors_hold() {
        let vectors = vectors();
        for case in &vectors.order {
            let (a, b) = (parse(&case.a), parse(&case.b));
            let expected = expected_ordering(case.cmp);
            assert_eq!(
                compare_versions(&a, &b),
                expected,
                "{} 对 {}",
                case.a,
                case.b
            );
            assert_eq!(
                compare_versions(&b, &a),
                expected.reverse(),
                "{} 对 {}",
                case.b,
                case.a
            );
        }
        for case in &vectors.channel {
            let expected = case.channel.as_deref().map(|name| {
                Channel::from_name(name).unwrap_or_else(|| panic!("向量里的通道名 {name} 认不出"))
            });
            assert_eq!(
                Channel::of_version(&parse(&case.version)),
                expected,
                "{}",
                case.version
            );
        }
    }

    /// 向量只放各处都按同一规则处理的标准形状：规范写法、小写标识加数字序号、不带构建元数据、不超过 48 字节
    /// （载荷头版本字段的宽度）；通道条目里的正式版主版本至少为 1（CI 认的正式版形状）。大小写、不带序号、
    /// 构建元数据这些写法各处处理得不一样，只进 Rust 自己的用例。
    #[test]
    fn shared_vectors_hold_only_standard_shapes() {
        let vectors = vectors();
        let texts = vectors
            .order
            .iter()
            .flat_map(|case| [&case.a, &case.b])
            .chain(vectors.channel.iter().map(|case| &case.version));
        for text in texts {
            let version = parse(text);
            assert_eq!(&version.to_string(), text, "不是规范写法");
            assert!(version.build.is_empty(), "{text} 带了构建元数据");
            assert!(text.len() <= 48, "{text} 超过 48 字节");
            let pre = version.pre.as_str();
            if !pre.is_empty() {
                let (tag, seq) = pre
                    .split_once('.')
                    .unwrap_or_else(|| panic!("{text} 的预发布段不是「标识.序号」"));
                assert!(tag.bytes().all(|byte| byte.is_ascii_lowercase()), "{text}");
                assert!(
                    !seq.is_empty() && seq.bytes().all(|byte| byte.is_ascii_digit()),
                    "{text}"
                );
            }
        }
        for case in &vectors.channel {
            if case.channel.as_deref() == Some("stable") {
                assert_ne!(parse(&case.version).major, 0, "{}", case.version);
            }
        }
    }

    /// 换基础号、三条线并存时最容易被改坏的几条先后，以及每种通道的代表：向量里必须一直有。
    #[test]
    fn shared_vectors_keep_the_required_entries() {
        let vectors = vectors();
        let chains: [&[&str]; 4] = [
            &["1.0.0-beta.999", "1.0.0-dev.1", "1.0.0"],
            &["0.1.0-dev.41", "1.0.0-beta.2", "1.0.0-dev.42"],
            &["1.0.0", "1.0.1", "1.1.0-beta.1", "1.1.0-dev.1", "1.1.0"],
            &["1.0.0-dev.9007199254740992", "1.0.0-dev.9007199254740993"],
        ];
        for chain in chains {
            for pair in chain.windows(2) {
                assert!(
                    vectors
                        .order
                        .iter()
                        .any(|case| case.a == pair[0] && case.b == pair[1] && case.cmp == -1),
                    "向量里缺 {} < {}",
                    pair[0],
                    pair[1]
                );
            }
        }
        let channels = [
            ("1.0.0-dev.42", Some("dev")),
            ("1.0.0-beta.3", Some("beta")),
            ("1.0.0", Some("stable")),
            ("1.0.0-rc.1", None),
        ];
        for (version, channel) in channels {
            assert!(
                vectors
                    .channel
                    .iter()
                    .any(|case| case.version == version && case.channel.as_deref() == channel),
                "向量里缺 {version} 属于 {channel:?}"
            );
        }
    }

    /// 随机版本连同它在模型里的排序键 (主, 次, 补丁, 线, 序号)。线按 semver 的结果写死：同一核心号下
    /// beta 在 dev 前面，正式版最高。模型是元组的字典序，本身就是全序，比较结果与它一致才算对。
    #[derive(Clone)]
    struct Sample {
        text: String,
        key: (u64, u64, u64, u8, u128),
    }

    fn pre_release_sample(
        rng: &mut fastrand::Rng,
        major: u64,
        minor: u64,
        tag: &str,
        line: u8,
    ) -> Sample {
        let prefix = format!("{major}.{minor}.0-{tag}.");
        let seq = match rng.u8(0..4) {
            0 => BOUNDARY_SEQS[rng.usize(..BOUNDARY_SEQS.len())],
            // 序号补到整个版本串正好 48 字节，载荷头装得下的最长版本。
            1 => {
                let digits = 48 - prefix.len() as u32;
                let lowest = 10u128.pow(digits - 1);
                lowest + rng.u128(..9 * lowest)
            }
            _ => rng.u128(..1000),
        };
        let text = format!("{prefix}{seq}");
        Sample {
            text,
            key: (major, minor, 0, line, seq),
        }
    }

    fn sample(rng: &mut fastrand::Rng) -> Sample {
        let (major, minor) = (rng.u64(..4), rng.u64(..4));
        match rng.u8(..3) {
            0 => pre_release_sample(rng, major, minor, "beta", 0),
            1 => pre_release_sample(rng, major, minor, "dev", 1),
            _ => {
                let patch = rng.u64(..3);
                Sample {
                    text: format!("{major}.{minor}.{patch}"),
                    key: (major, minor, patch, 2, 0),
                }
            }
        }
    }

    fn build_metadata(rng: &mut fastrand::Rng) -> String {
        (0..rng.usize(1..4))
            .map(|_| {
                (0..rng.usize(1..9))
                    .map(|_| rng.alphanumeric())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join(".")
    }

    #[test]
    fn random_versions_of_the_three_lines_form_a_total_order() {
        let mut rng = fastrand::Rng::with_seed(0x0de7_2026);
        let pairs: Vec<(Sample, Sample)> = (0..2000)
            .map(|_| {
                let a = sample(&mut rng);
                let b = if rng.u8(..10) == 0 {
                    a.clone()
                } else {
                    sample(&mut rng)
                };
                (a, b)
            })
            .collect();

        for (index, (a, b)) in pairs.iter().enumerate() {
            let (va, vb) = (parse(&a.text), parse(&b.text));
            assert_eq!(
                compare_versions(&va, &vb),
                a.key.cmp(&b.key),
                "{} 对 {}",
                a.text,
                b.text
            );
            assert_eq!(compare_versions(&va, &va), Ordering::Equal, "{}", a.text);
            assert_eq!(
                compare_versions(&vb, &va),
                compare_versions(&va, &vb).reverse(),
                "{} 对 {}",
                a.text,
                b.text
            );

            let c = &pairs[(index + 1) % pairs.len()].0;
            let vc = parse(&c.text);
            let trio = [(&a.text, &va), (&b.text, &vb), (&c.text, &vc)];
            for [i, j, k] in [
                [0, 1, 2],
                [0, 2, 1],
                [1, 0, 2],
                [1, 2, 0],
                [2, 0, 1],
                [2, 1, 0],
            ] {
                let ((xt, x), (yt, y), (zt, z)) = (trio[i], trio[j], trio[k]);
                let (xy, yz, xz) = (
                    compare_versions(x, y),
                    compare_versions(y, z),
                    compare_versions(x, z),
                );
                if xy != Ordering::Greater && yz != Ordering::Greater {
                    assert_ne!(xz, Ordering::Greater, "{xt} <= {yt} <= {zt}");
                }
                if xy == Ordering::Less && yz == Ordering::Less {
                    assert_eq!(xz, Ordering::Less, "{xt} < {yt} < {zt}");
                }
                if xy == Ordering::Equal && yz == Ordering::Equal {
                    assert_eq!(xz, Ordering::Equal, "{xt} = {yt} = {zt}");
                }
            }
        }

        let drawn = || pairs.iter().flat_map(|(a, b)| [a, b]);
        for seq in [0, 1, TWO_POW_53_PLUS_1] {
            assert!(
                drawn().any(|one| one.key.3 < 2 && one.key.4 == seq),
                "没抽到序号 {seq}"
            );
        }
        assert!(
            drawn().any(|one| one.text.len() == 48),
            "没抽到 48 字节的版本串"
        );
        assert!(drawn().any(|one| one.key.3 == 2), "没抽到正式版");
    }

    #[test]
    fn within_one_base_beta_comes_before_dev_before_the_release() {
        for base in ["0.1.0", "1.0.0", "1.1.0", "2.0.0"] {
            let release = parse(base);
            for m in BOUNDARY_SEQS {
                let beta = parse(&format!("{base}-beta.{m}"));
                assert_eq!(compare_versions(&beta, &release), Ordering::Less, "{beta}");
                for n in BOUNDARY_SEQS {
                    let dev = parse(&format!("{base}-dev.{n}"));
                    assert_eq!(
                        compare_versions(&beta, &dev),
                        Ordering::Less,
                        "{beta} 对 {dev}"
                    );
                    assert_eq!(compare_versions(&dev, &release), Ordering::Less, "{dev}");
                }
            }
        }
    }

    /// 抬基础号只能抬到 X.(Y+1).0 或 (X+1).0.0；抬完之后新基础号的每个版本都高于旧基础号的每个版本，
    /// 包括旧基础号上的正式版补丁。1.9.0 到 1.10.0 防按字符串比。
    #[test]
    fn every_version_of_a_raised_base_outranks_every_version_of_the_old_one() {
        let lines = |base: &str| -> Vec<String> {
            BOUNDARY_SEQS
                .iter()
                .flat_map(|seq| [format!("{base}-beta.{seq}"), format!("{base}-dev.{seq}")])
                .chain([base.to_owned()])
                .collect()
        };
        for (old, new) in [
            ("0.1.0", "1.0.0"),
            ("1.0.0", "1.1.0"),
            ("1.1.0", "2.0.0"),
            ("1.9.0", "1.10.0"),
        ] {
            let core = old.strip_suffix(".0").expect("基础号的补丁段是 0");
            let olds: Vec<String> = lines(old)
                .into_iter()
                .chain([format!("{core}.1"), format!("{core}.2")])
                .collect();
            for older in &olds {
                for newer in lines(new) {
                    assert_eq!(
                        compare_versions(&parse(older), &parse(&newer)),
                        Ordering::Less,
                        "{older} 对 {newer}"
                    );
                }
            }
        }
    }

    #[test]
    fn build_metadata_never_changes_the_order() {
        assert_eq!(
            compare_versions(&parse("0.2.0+b"), &parse("0.2.0+a")),
            Ordering::Equal
        );
        assert_eq!(
            compare_versions(&parse("1.0.0-beta.1+abc"), &parse("1.0.0-beta.1")),
            Ordering::Equal
        );
        assert_eq!(
            compare_versions(&parse("1.0.0-beta.1+zzz"), &parse("1.0.0-dev.1+aaa")),
            Ordering::Less
        );

        let mut rng = fastrand::Rng::with_seed(0xb017_d0a7);
        for _ in 0..500 {
            let (a, b) = (sample(&mut rng), sample(&mut rng));
            let plain = compare_versions(&parse(&a.text), &parse(&b.text));
            let a_meta = format!("{}+{}", a.text, build_metadata(&mut rng));
            let b_meta = format!("{}+{}", b.text, build_metadata(&mut rng));
            assert_eq!(
                compare_versions(&parse(&a_meta), &parse(&b.text)),
                plain,
                "{a_meta} 对 {}",
                b.text
            );
            assert_eq!(
                compare_versions(&parse(&a_meta), &parse(&b_meta)),
                plain,
                "{a_meta} 对 {b_meta}"
            );
            assert_eq!(
                compare_versions(&parse(&a_meta), &parse(&a.text)),
                Ordering::Equal,
                "{a_meta}"
            );
        }
    }

    #[test]
    fn channel_follows_the_first_pre_release_identifier() {
        assert_eq!(Channel::of(""), Some(Channel::Stable));
        for dev in ["dev.12", "dev", "dev3", "DEV.1", "Dev.7.rc"] {
            assert_eq!(Channel::of(dev), Some(Channel::Dev), "{dev}");
        }
        for beta in ["beta.1", "beta", "beta3", "BETA.2", "Beta.4.dev"] {
            assert_eq!(Channel::of(beta), Some(Channel::Beta), "{beta}");
        }
        for unknown in [
            "rc.1",
            "rc.2",
            "alpha.1",
            "preview.3",
            "nightly",
            "devx.1",
            "dev-1",
            "de",
            "alpha.dev",
            "betax.1",
            "beta-1",
            "bet",
            "alpha.beta",
            ".1",
        ] {
            assert_eq!(Channel::of(unknown), None, "{unknown}");
        }
    }

    /// 通道名的大小写怎么混、后面跟多少数字，判定都不变；通道名与数字之后只要多一个别的字符就认不出。
    /// 固定种子，挂了能复现。
    #[test]
    fn channel_names_ignore_case_and_take_only_digits_after_them() {
        let mut rng = fastrand::Rng::with_seed(0x5eed_be7a);
        for _ in 0..300 {
            for (name, channel) in [("dev", Channel::Dev), ("beta", Channel::Beta)] {
                let cased: String = name
                    .chars()
                    .map(|c| {
                        if rng.bool() {
                            c.to_ascii_uppercase()
                        } else {
                            c
                        }
                    })
                    .collect();
                let digits = if rng.bool() {
                    String::new()
                } else {
                    rng.u64(..).to_string()
                };
                let rest = if rng.bool() {
                    String::new()
                } else {
                    format!(".{}", rng.u32(..))
                };
                let tagged = format!("{cased}{digits}{rest}");
                assert_eq!(Channel::of(&tagged), Some(channel), "{tagged}");

                let stray = if rng.bool() { rng.alphabetic() } else { '-' };
                let polluted = format!("{cased}{digits}{stray}{rest}");
                assert_eq!(Channel::of(&polluted), None, "{polluted}");
            }
        }
    }

    /// 整个版本号上的判定：只看预发布段，构建元数据里写什么都不算；主版本是 0 的也照常判。
    #[test]
    fn channel_of_a_version_reads_only_its_pre_release() {
        let cases = [
            ("1.0.0-dev.42", Some(Channel::Dev)),
            ("1.0.0-beta.3", Some(Channel::Beta)),
            ("1.0.0", Some(Channel::Stable)),
            ("0.1.0", Some(Channel::Stable)),
            ("1.0.1", Some(Channel::Stable)),
            ("1.0.0-dev.0", Some(Channel::Dev)),
            ("1.0.0-dev.1", Some(Channel::Dev)),
            ("1.0.0-dev.9007199254740993", Some(Channel::Dev)),
            ("1.0.0-beta.0", Some(Channel::Beta)),
            ("1.0.0-beta.1", Some(Channel::Beta)),
            ("1.0.0-beta.9007199254740993", Some(Channel::Beta)),
            ("1.0.0-beta", Some(Channel::Beta)),
            ("0.1.0-dev", Some(Channel::Dev)),
            ("1.0.0-BETA.2", Some(Channel::Beta)),
            ("0.1.0-Dev.3", Some(Channel::Dev)),
            ("1.0.0-beta2.1", Some(Channel::Beta)),
            ("0.1.0-dev7", Some(Channel::Dev)),
            ("1.0.0-beta.1+abc", Some(Channel::Beta)),
            ("0.1.0-dev.40+x.y", Some(Channel::Dev)),
            ("1.0.0+build.5", Some(Channel::Stable)),
            ("0.1.0+dev.1", Some(Channel::Stable)),
            ("1.0.0-rc.1", None),
            ("1.0.0-alpha.1", None),
            ("1.0.0-dev-1", None),
            ("1.0.0-beta-1", None),
            ("1.0.0-betax.1", None),
            ("0.1.0-devel.40", None),
        ];
        for (text, expected) in cases {
            assert_eq!(Channel::of_version(&parse(text)), expected, "{text}");
        }
    }

    #[test]
    fn channel_names_round_trip_and_match_the_serde_form() {
        for (channel, name) in [
            (Channel::Dev, "dev"),
            (Channel::Beta, "beta"),
            (Channel::Stable, "stable"),
        ] {
            assert_eq!(channel.as_str(), name);
            assert_eq!(Channel::from_name(name), Some(channel));
            assert_eq!(
                serde_json::to_string(&channel).unwrap(),
                format!("\"{name}\"")
            );
            assert_eq!(
                serde_json::from_str::<Channel>(&format!("\"{name}\"")).unwrap(),
                channel
            );
        }
        for unknown in [
            "", "DEV", "Dev", "Beta", "STABLE", " dev", "dev ", "dev.1", "preview", "release",
            "nightly", "local", "rc",
        ] {
            assert_eq!(Channel::from_name(unknown), None, "{unknown:?}");
            let quoted = serde_json::to_string(unknown).unwrap();
            assert!(
                serde_json::from_str::<Channel>(&quoted).is_err(),
                "serde 不该认 {quoted}"
            );
        }
    }

    #[test]
    fn dev_is_fastest_and_stable_is_slowest() {
        assert!(Channel::Dev.is_faster_than(Channel::Beta));
        assert!(Channel::Beta.is_faster_than(Channel::Stable));
        assert!(Channel::Stable.is_slower_than(Channel::Beta));
        assert!(Channel::Beta.is_slower_than(Channel::Dev));

        let fastest_first = [Channel::Dev, Channel::Beta, Channel::Stable];
        for (i, a) in fastest_first.into_iter().enumerate() {
            for (j, b) in fastest_first.into_iter().enumerate() {
                assert_eq!(a.is_faster_than(b), i < j, "{a:?} 快于 {b:?}");
                assert_eq!(a.is_slower_than(b), i > j, "{a:?} 慢于 {b:?}");
            }
        }
    }
}
