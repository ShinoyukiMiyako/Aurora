//! Windows 注册表里登记的 Java 安装根。
//!
//! 各发行版的安装器把安装根写在不同的键、值名与嵌套层数下（以各家安装器源码与安装文档为准）：
//! - Oracle 与 JavaSoft 兼容键：`JavaSoft\JDK\<版本>` 下的字符串值 `JavaHome`；
//! - Temurin、Microsoft、Semeru 共用的 MSI 安装器：`<厂商>\JDK\<版本>\hotspot\MSI`（Semeru 是 `openj9`）
//!   下的 `Path`。同一个键里也有名为 `JavaHome` 的值，但那是「是否设置了 JAVA_HOME」的 DWORD 标志，
//!   所以只认字符串值，类型不对就接着试下一个值名；
//! - Zulu、Liberica：`<厂商>\<产品>\<版本>` 下的 `InstallationPath`。
//!
//! Temurin、Microsoft、Zulu 都支持按用户安装，此时同一套键写进 HKCU 而不是 HKLM。层数因厂商而异，
//! 所以不硬编码路径后缀，而是在每个登记键下递归 [`MAX_KEY_DEPTH`] 层，逐个子键按
//! [`HOME_VALUE_NAMES`] 的顺序取第一个非空字符串值。

use std::path::PathBuf;

/// 读取注册表里登记的 Java 安装根。抽成 trait 是为了让探测在测试里注入替身，不读真实注册表。
pub trait RegistryReader: Send + Sync + std::fmt::Debug {
    /// `<hive>\<key>` 之下递归（最多 3 层子键）收集登记的安装根：
    /// 每个子键依次取字符串值 JavaHome、InstallationPath、Path，取到第一个即算。键不存在返回空。
    fn homes_under(&self, hive: RegistryHive, key: &str) -> Vec<PathBuf>;
}

/// 注册表根。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryHive {
    /// `HKEY_LOCAL_MACHINE`：为所有用户安装。
    LocalMachine,
    /// `HKEY_CURRENT_USER`：按当前用户安装。
    CurrentUser,
}

/// 各发行版登记安装根的键。HKLM 与 HKCU 用同一张表。
pub(crate) const VENDOR_KEYS: &[&str] = &[
    "SOFTWARE\\JavaSoft\\Java Runtime Environment",
    "SOFTWARE\\JavaSoft\\Java Development Kit",
    "SOFTWARE\\JavaSoft\\JRE",
    "SOFTWARE\\JavaSoft\\JDK",
    "SOFTWARE\\Eclipse Adoptium\\JDK",
    "SOFTWARE\\Eclipse Adoptium\\JRE",
    "SOFTWARE\\Eclipse Foundation\\JDK",
    "SOFTWARE\\AdoptOpenJDK\\JDK",
    "SOFTWARE\\AdoptOpenJDK\\JRE",
    "SOFTWARE\\Semeru\\JDK",
    "SOFTWARE\\Semeru\\JRE",
    "SOFTWARE\\Microsoft\\JDK",
    "SOFTWARE\\Azul Systems\\Zulu",
    // Zulu 的 32 位安装登记在单独的产品键下，不是同名键的 32 位视图。
    "SOFTWARE\\Azul Systems\\Zulu 32-bit",
    "SOFTWARE\\BellSoft\\Liberica",
    "SOFTWARE\\Amazon Corretto",
];

/// 登记键之下最多递归的子键层数：覆盖 MSI 安装器的 `<版本>\hotspot\MSI` 三层布局。
pub(crate) const MAX_KEY_DEPTH: usize = 3;

/// 子键里表示安装根的字符串值名，按顺序取第一个。
pub(crate) const HOME_VALUE_NAMES: [&str; 3] = ["JavaHome", "InstallationPath", "Path"];

/// 注册表树的最小抽象：递归规则只依赖它，单测用内存树验证层数与值名顺序。
trait RegNode: Sized {
    fn children(&self) -> Vec<Self>;
    /// 取字符串值；值不存在或不是字符串类型都返回 `None`。
    fn string_value(&self, name: &str) -> Option<String>;
}

fn collect_homes<N: RegNode>(node: &N, depth_left: usize, out: &mut Vec<PathBuf>) {
    if depth_left == 0 {
        return;
    }
    for child in node.children() {
        if let Some(home) = first_home(&child) {
            out.push(home);
        }
        collect_homes(&child, depth_left - 1, out);
    }
}

fn first_home<N: RegNode>(node: &N) -> Option<PathBuf> {
    HOME_VALUE_NAMES.iter().find_map(|name| {
        let value = node.string_value(name)?;
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
    })
}

/// 生产实现：64 位与 32 位两个视图都读；非 Windows 返回空。
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowsRegistry;

impl RegistryReader for WindowsRegistry {
    #[cfg(windows)]
    fn homes_under(&self, hive: RegistryHive, key: &str) -> Vec<PathBuf> {
        windows_impl::homes_under(hive, key)
    }

    #[cfg(not(windows))]
    fn homes_under(&self, _hive: RegistryHive, _key: &str) -> Vec<PathBuf> {
        Vec::new()
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::io;
    use std::path::PathBuf;

    use winreg::RegKey;
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };

    use super::{MAX_KEY_DEPTH, RegNode, RegistryHive, collect_homes};

    /// 打开时带着视图标志的键：子键也必须按同一视图打开，否则 32 位视图下会读回 64 位的子键。
    struct ViewKey {
        key: RegKey,
        view: u32,
    }

    impl RegNode for ViewKey {
        fn children(&self) -> Vec<Self> {
            self.key
                .enum_keys()
                .filter_map(|name| {
                    let name = name.ok()?;
                    let key = self
                        .key
                        .open_subkey_with_flags(&name, KEY_READ | self.view)
                        .ok()?;
                    Some(ViewKey {
                        key,
                        view: self.view,
                    })
                })
                .collect()
        }

        fn string_value(&self, name: &str) -> Option<String> {
            self.key.get_value::<String, _>(name).ok()
        }
    }

    pub(super) fn homes_under(hive: RegistryHive, key: &str) -> Vec<PathBuf> {
        let root = RegKey::predef(match hive {
            RegistryHive::LocalMachine => HKEY_LOCAL_MACHINE,
            RegistryHive::CurrentUser => HKEY_CURRENT_USER,
        });
        let mut homes = Vec::new();
        // 两个视图都读，兼顾登记在 WOW6432Node 下的 32 位安装。
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            match root.open_subkey_with_flags(key, KEY_READ | view) {
                Ok(base) => collect_homes(&ViewKey { key: base, view }, MAX_KEY_DEPTH, &mut homes),
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => {
                    tracing::debug!(?hive, key, error = %err, "打不开注册表里的 Java 登记键，跳过");
                }
            }
        }
        homes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 内存里的注册表键：值只放字符串类型；`dword` 里的名字模拟同名但非字符串类型的值。
    #[derive(Default)]
    struct Node {
        children: Vec<Node>,
        strings: Vec<(&'static str, &'static str)>,
        dword: Vec<&'static str>,
    }

    impl Node {
        fn with_child(mut self, child: Node) -> Self {
            self.children.push(child);
            self
        }

        fn with_string(mut self, name: &'static str, value: &'static str) -> Self {
            self.strings.push((name, value));
            self
        }

        fn with_dword(mut self, name: &'static str) -> Self {
            self.dword.push(name);
            self
        }
    }

    impl<'a> RegNode for &'a Node {
        fn children(&self) -> Vec<Self> {
            let node: &'a Node = self;
            node.children.iter().collect()
        }

        fn string_value(&self, name: &str) -> Option<String> {
            if self.dword.contains(&name) {
                return None;
            }
            self.strings
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    }

    fn homes(root: &Node) -> Vec<PathBuf> {
        let mut out = Vec::new();
        collect_homes(&root, MAX_KEY_DEPTH, &mut out);
        out
    }

    /// MSI 安装器的布局：`<版本>\hotspot\MSI` 第三层的 `Path`，同键 `JavaHome` 是 DWORD，要跳过它。
    #[test]
    fn msi_layout_three_levels_deep_reads_path_past_dword_java_home() {
        let msi = Node::default().with_dword("JavaHome").with_string(
            "Path",
            r"C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot\",
        );
        let root =
            Node::default().with_child(Node::default().with_child(Node::default().with_child(msi)));
        assert_eq!(
            homes(&root),
            vec![PathBuf::from(
                r"C:\Program Files\Eclipse Adoptium\jdk-21.0.5.11-hotspot\"
            )]
        );
    }

    #[test]
    fn values_deeper_than_three_levels_are_ignored() {
        let level4 = Node::default().with_string("JavaHome", r"C:\too-deep");
        let root = Node::default().with_child(
            Node::default()
                .with_child(Node::default().with_child(Node::default().with_child(level4))),
        );
        assert!(homes(&root).is_empty());
    }

    /// 同一键里几个值名都在时按 JavaHome > InstallationPath > Path 取第一个；空白值不算。
    #[test]
    fn value_names_are_tried_in_order_and_blank_values_skipped() {
        let all = Node::default()
            .with_string("Path", r"C:\path")
            .with_string("InstallationPath", r"C:\installation")
            .with_string("JavaHome", r"C:\home");
        let blank_home = Node::default()
            .with_string("JavaHome", "  ")
            .with_string("InstallationPath", r" C:\zulu-21 ");
        let none = Node::default().with_string("INSTALLDIR", r"C:\not-a-home-value");
        let root = Node::default()
            .with_child(all)
            .with_child(blank_home)
            .with_child(none);
        assert_eq!(
            homes(&root),
            vec![PathBuf::from(r"C:\home"), PathBuf::from(r"C:\zulu-21")]
        );
    }

    /// 每个子键各自算：版本键与其下 MSI 键都登记了路径时两条都收（去重交给探测）。
    #[test]
    fn every_subkey_within_depth_contributes() {
        let root = Node::default()
            .with_child(
                Node::default()
                    .with_string("JavaHome", r"C:\Program Files\Java\jdk-17")
                    .with_child(
                        Node::default().with_string("Path", r"C:\Program Files\Java\jdk-17\"),
                    ),
            )
            .with_child(Node::default().with_string("JavaHome", r"C:\Program Files\Java\jdk-21"));
        let found = homes(&root);
        assert_eq!(found.len(), 3);
        assert_eq!(found[0], Path::new(r"C:\Program Files\Java\jdk-17"));
        assert_eq!(found[2], Path::new(r"C:\Program Files\Java\jdk-21"));
    }

    #[test]
    fn vendor_keys_have_no_duplicates() {
        let mut keys: Vec<String> = VENDOR_KEYS.iter().map(|k| k.to_lowercase()).collect();
        let total = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), total);
    }
}
