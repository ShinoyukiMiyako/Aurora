//! 更新通道的纯判定：按偏好该问哪几个通道、每个通道用哪把公钥验、各通道的结果怎么合成一个结论。

use petalfall_core::release::order::Channel;

/// 预览版的更新公钥：minisign 公钥文本再整体 base64 一层，正是更新插件 `pubkey` 要的格式；与 CI 给预览版注入
/// 插件配置的是同一个文件。
const DEV_UPDATER_PUBKEY: &str = include_str!("../../../../.github/dev-updater.pub");

/// 测试版与正式版共用的发布公钥，格式同 [`DEV_UPDATER_PUBKEY`]；与 CI 给测试版注入插件配置的是同一个文件。
const RELEASE_UPDATER_PUBKEY: &str = include_str!("../../../../.github/release-updater.pub");

/// 通道 `channel` 的清单签名与安装包用哪把公钥验：预览版用预览版的钥，测试版与正式版用发布钥。
///
/// 两把钥无条件编进所有构建，不看构建开关：本机与 fork 构建照样有这张表，只是插件配置里没注入落樱的公钥，
/// 判不成支持自更新。检查器要显式用这里给的钥，不能沿用插件配置里注入的那一把：那一把只属于本包的通道，
/// 跟随别的通道时拿它验必然对不上。
///
/// 文件末尾带换行，CI 注入插件配置前 `trim()` 过；这里同样去掉首尾空白，与注入的公钥才逐字相等。
pub(crate) fn channel_pubkey(channel: Channel) -> &'static str {
    match channel {
        Channel::Dev => DEV_UPDATER_PUBKEY.trim(),
        Channel::Beta | Channel::Stable => RELEASE_UPDATER_PUBKEY.trim(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    /// 预览版钥的密钥号：公钥里第 2 到 9 字节的小写十六进制，与流水线契约测试钉的是同一种写法。
    const DEV_KEY_NUMBER: &str = "a85c28a4343f0962";

    /// 发布钥的密钥号，写法同 [`DEV_KEY_NUMBER`]。
    const RELEASE_KEY_NUMBER: &str = "aeeab33bdc36d624";

    /// 公钥文本的密钥号。外层 base64 解开是 minisign 的公钥文件：第一行是不受信的注释，第二行再 base64 解开是
    /// 两字节算法标记 `Ed`、8 字节密钥号、32 字节 Ed25519 公钥。注释里那串大写十六进制是字节反过来写的，不拿它比。
    fn key_number(pubkey: &str) -> String {
        let text = STANDARD
            .decode(pubkey)
            .unwrap_or_else(|err| panic!("公钥不是 base64：{err}"));
        let text = String::from_utf8(text).expect("公钥解开后不是 UTF-8 文本");
        let line = text.lines().nth(1).expect("公钥文件少于两行");
        let bytes = STANDARD
            .decode(line)
            .unwrap_or_else(|err| panic!("公钥第二行不是 base64：{err}"));
        assert_eq!(bytes.len(), 42, "minisign 公钥是 2 + 8 + 32 字节");
        assert_eq!(&bytes[..2], b"Ed", "算法标记");
        bytes[2..10]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[test]
    fn each_channel_gets_the_key_of_its_own_line() {
        assert_eq!(key_number(channel_pubkey(Channel::Dev)), DEV_KEY_NUMBER);
        assert_eq!(
            key_number(channel_pubkey(Channel::Beta)),
            RELEASE_KEY_NUMBER
        );
        assert_eq!(
            key_number(channel_pubkey(Channel::Stable)),
            RELEASE_KEY_NUMBER
        );
    }

    #[test]
    fn beta_and_stable_share_the_release_key_that_preview_never_uses() {
        assert_eq!(
            channel_pubkey(Channel::Beta),
            channel_pubkey(Channel::Stable)
        );
        assert_ne!(channel_pubkey(Channel::Dev), channel_pubkey(Channel::Beta));
        assert_ne!(
            channel_pubkey(Channel::Dev),
            channel_pubkey(Channel::Stable)
        );
    }

    #[test]
    fn channel_keys_are_trimmed_like_the_injected_ones() {
        for channel in [Channel::Dev, Channel::Beta, Channel::Stable] {
            let key = channel_pubkey(channel);
            assert_eq!(key, key.trim(), "{channel:?}");
        }
    }
}
