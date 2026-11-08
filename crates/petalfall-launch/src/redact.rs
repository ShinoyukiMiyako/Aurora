//! 访问令牌遮挡：启动器给玩家看、让玩家复制或分享的文字里不能出现账户的访问令牌。
//!
//! 令牌只能经命令行交给游戏（微软与外置登录都是 `--accessToken <值>`），而命令行会被原样写出来：JVM 崩溃时
//! 写的 hs_err 在开头摘要（JDK 9 起才有）的 `Command Line:` 与后面进程段的 `java_command:` 两行记着整条启动参数；1.7、1.8
//! 这一代原版启动时在输出里打 `(Session ID is token:<令牌>:<uuid>)`，1.6 及更早的版本也是以这个形状接收令牌。
//!
//! 按形状认，不按值认：读回的旧会话日志、旧崩溃报告与 JVM 写下的文件里是哪一份令牌，启动器已经无从得知。

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::{Captures, Regex};

/// 令牌换成的标记。
pub const REDACTED: &str = "<已隐藏>";

/// 两种形状，各自只换令牌本身：
/// - `--accessToken` 后接值：分隔可以是空格、`=`，或列表打印出来的 `, `，参数名与值各自可能带引号；值到空白、
///   引号、逗号或右括号为止。分隔只认同一行里的空白：文本按整段遮时，行尾的参数名不能吞掉下一行开头。
/// - 会话 id `token:<令牌>:<uuid>`：uuid 带不带连字符都认，原样保留。
static ACCESS_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"(?P<flag>--accessToken["']?(?:=|[ \t]*,[ \t]*|[ \t]+)["']?)[^\s"',\])]+"#,
        r"|\btoken:[^\s:]+(?P<uuid>:[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})",
    ))
    .expect("内置正则必须可编译")
});

/// 把文本里的访问令牌换成 [`REDACTED`]，其余原样；没有可遮的不重新分配。
pub fn redact_access_tokens(text: &mut String) {
    let redacted = match ACCESS_TOKEN.replace_all(text.as_str(), |caps: &Captures<'_>| {
        match caps.name("flag") {
            Some(flag) => format!("{}{REDACTED}", flag.as_str()),
            None => format!("token:{REDACTED}{}", &caps["uuid"]),
        }
    }) {
        Cow::Borrowed(_) => return,
        Cow::Owned(redacted) => redacted,
    };
    *text = redacted;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 形状与真实的微软 Minecraft 令牌一样的假令牌：三段 base64url，以点分隔，几百个字符。每次运行随机生成，
    /// 种子写进失败信息。
    fn fake_jwt() -> (String, u64) {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
            | 1;
        let mut state = seed;
        let mut next = move |bound: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % bound as u64) as usize
        };
        let mut segment = |len: usize| -> String {
            (0..len)
                .map(|_| char::from(ALPHABET[next(ALPHABET.len())]))
                .collect()
        };
        let header = segment(36);
        let payload = segment(300);
        let signature = segment(342);
        (format!("eyJ{header}.eyJ{payload}.{signature}"), seed)
    }

    fn redacted(text: &str) -> String {
        let mut text = text.to_owned();
        redact_access_tokens(&mut text);
        text
    }

    const UUID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn access_token_argument_is_hidden_and_the_rest_of_the_command_stays() {
        let (token, seed) = fake_jwt();
        let line = format!(
            "net.minecraft.client.main.Main --username Steve --version 1.20.1 --uuid {UUID} --accessToken {token} --userType msa"
        );
        assert_eq!(
            redacted(&line),
            format!(
                "net.minecraft.client.main.Main --username Steve --version 1.20.1 --uuid {UUID} --accessToken <已隐藏> --userType msa"
            ),
            "seed {seed}"
        );
        // 令牌在行尾。
        assert_eq!(
            redacted(&format!("--uuid {UUID} --accessToken {token}")),
            format!("--uuid {UUID} --accessToken <已隐藏>"),
            "seed {seed}"
        );
    }

    #[test]
    fn equals_form_is_hidden() {
        let (token, seed) = fake_jwt();
        assert_eq!(
            redacted(&format!(
                "--username=Steve --accessToken={token} --uuid={UUID}"
            )),
            format!("--username=Steve --accessToken=<已隐藏> --uuid={UUID}"),
            "seed {seed}"
        );
    }

    /// 外置登录的令牌常是 32 位十六进制或带连字符的 uuid，同样经 `--accessToken` 传入。
    #[test]
    fn authlib_injector_tokens_are_hidden_too() {
        for token in [
            "9f86d081884c7d659a2feaa0c55ad015",
            "3f2b1c4e-8d9a-4e7b-9c1d-2a3b4c5d6e7f",
        ] {
            assert_eq!(
                redacted(&format!(
                    "--uuid {UUID} --accessToken {token} --userType msa"
                )),
                format!("--uuid {UUID} --accessToken <已隐藏> --userType msa")
            );
        }
    }

    /// hs_err 开头摘要的 `Command Line:` 与进程段的 `java_command:` 都记着整条参数，形状取自 JDK 26 实际写下的文件。
    #[test]
    fn hs_err_command_lines_are_hidden_and_the_rest_of_the_file_stays() {
        let (token, seed) = fake_jwt();
        let hs_err = format!(
            "#  fatal error: OutOfMemory encountered: Java heap space\n\
             \n\
             ---------------  S U M M A R Y ------------\n\
             \n\
             Command Line: -Xmx4096m -Djava.library.path=D:\\mc\\natives net.minecraft.client.main.Main --username Steve --uuid {UUID} --accessToken {token} --userType msa\n\
             \n\
             Host: AMD Ryzen 9, 32 cores, 93G,  Windows 11 , 64 bit Build 26100\n\
             ---------------  P R O C E S S  ---------------\n\
             jvm_args: -Xmx4096m -Djava.library.path=D:\\mc\\natives\n\
             java_command: net.minecraft.client.main.Main --username Steve --uuid {UUID} --accessToken {token} --userType msa\n\
             java_class_path (initial): D:\\mc\\libraries\\a.jar\n"
        );
        assert_eq!(
            redacted(&hs_err),
            format!(
                "#  fatal error: OutOfMemory encountered: Java heap space\n\
                 \n\
                 ---------------  S U M M A R Y ------------\n\
                 \n\
                 Command Line: -Xmx4096m -Djava.library.path=D:\\mc\\natives net.minecraft.client.main.Main --username Steve --uuid {UUID} --accessToken <已隐藏> --userType msa\n\
                 \n\
                 Host: AMD Ryzen 9, 32 cores, 93G,  Windows 11 , 64 bit Build 26100\n\
                 ---------------  P R O C E S S  ---------------\n\
                 jvm_args: -Xmx4096m -Djava.library.path=D:\\mc\\natives\n\
                 java_command: net.minecraft.client.main.Main --username Steve --uuid {UUID} --accessToken <已隐藏> --userType msa\n\
                 java_class_path (initial): D:\\mc\\libraries\\a.jar\n"
            ),
            "seed {seed}"
        );
    }

    /// 参数数组按列表打印出来时以 `, ` 分隔，带不带引号都有。
    #[test]
    fn printed_argument_lists_are_hidden() {
        let (token, seed) = fake_jwt();
        assert_eq!(
            redacted(&format!(
                "args: [--username, Steve, --accessToken, {token}, --userType, msa]"
            )),
            "args: [--username, Steve, --accessToken, <已隐藏>, --userType, msa]",
            "seed {seed}"
        );
        assert_eq!(
            redacted(&format!(
                r#"["--accessToken", "{token}", "--uuid", "{UUID}"]"#
            )),
            format!(r#"["--accessToken", "<已隐藏>", "--uuid", "{UUID}"]"#),
            "seed {seed}"
        );
        assert_eq!(
            redacted(&format!("[--accessToken, {token}]")),
            "[--accessToken, <已隐藏>]",
            "seed {seed}"
        );
    }

    /// 1.7、1.8 原版启动时打的会话 id，以及 1.6 及更早版本接收令牌的写法；uuid 原样保留。
    #[test]
    fn session_ids_keep_the_uuid() {
        let (token, seed) = fake_jwt();
        assert_eq!(
            redacted(&format!(
                "[Client thread/INFO]: (Session ID is token:{token}:{UUID})"
            )),
            format!("[Client thread/INFO]: (Session ID is token:<已隐藏>:{UUID})"),
            "seed {seed}"
        );
        let dashed = "01234567-89ab-cdef-0123-456789abcdef";
        assert_eq!(
            redacted(&format!(
                "net.minecraft.launchwrapper.Launch Steve token:{token}:{dashed} --gameDir D:\\mc"
            )),
            format!(
                "net.minecraft.launchwrapper.Launch Steve token:<已隐藏>:{dashed} --gameDir D:\\mc"
            ),
            "seed {seed}"
        );
        assert_eq!(
            redacted(&format!(
                "--username Steve --session token:{token}:{UUID} --version 1.6.4"
            )),
            format!("--username Steve --session token:<已隐藏>:{UUID} --version 1.6.4"),
            "seed {seed}"
        );
    }

    #[test]
    fn unrelated_text_is_left_alone() {
        for text in [
            "",
            "[main/INFO]: Setting user: Steve",
            "--username Steve --uuid 0123456789abcdef0123456789abcdef --userType msa --versionType release",
            // 名字只是以它开头的别的参数。
            "--accessTokenFile D:\\token.txt",
            // 不是 token:<令牌>:<uuid> 的形状。
            "Invalid token: expired",
            "token:abc:not-a-uuid",
            "accesstoken:abc:0123456789abcdef0123456789abcdef",
            // 参数名在行尾：下一行开头不是它的值。
            "--accessToken\n--userType msa",
        ] {
            assert_eq!(redacted(text), text);
        }
    }

    /// 遮过的再遮一遍不变：读回的日志写入时已经遮过，读的时候还会再过一遍。
    #[test]
    fn redacting_twice_changes_nothing() {
        let (token, seed) = fake_jwt();
        let once = redacted(&format!(
            "--accessToken {token} --accessToken={token} (Session ID is token:{token}:{UUID})"
        ));
        assert_eq!(
            once,
            format!(
                "--accessToken <已隐藏> --accessToken=<已隐藏> (Session ID is token:<已隐藏>:{UUID})"
            ),
            "seed {seed}"
        );
        assert_eq!(redacted(&once), once);
    }
}
