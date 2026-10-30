//! Server List Ping：Java 版 1.7 起的服务器状态查询（握手 + 状态请求 + ping）。
//!
//! 报文格式：每个包是「VarInt 长度 + VarInt 包 id + 负载」。客户端先发握手（协议号、地址、端口、
//! 下一状态 1），再发空的状态请求，服务器回一段 JSON；随后发带 8 字节随机数的 ping，服务器原样回送。
//! 延迟取 ping 往返；有些服务器回完状态就断开，这时退而用状态请求的往返。

use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::ServerAddress;

/// 握手里的协议号。查询状态时客户端还不知道该用哪个版本，惯例填 -1。
const STATUS_PROTOCOL: i32 = -1;

/// 状态响应包的长度上限。带大图标的服务器也就几十 KB；超过它的视为异常数据，不再读下去。
const MAX_PACKET_BYTES: usize = 2 * 1024 * 1024;

/// 一次成功的状态查询。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PingResponse {
    /// 往返延迟（毫秒）。
    pub latency_ms: u32,
    /// 版本名（服务器自报，如 `Paper 1.21.4`）。
    pub version_name: Option<String>,
    /// 在线人数。
    pub online: Option<u32>,
    /// 人数上限。
    pub max: Option<u32>,
    /// MOTD 纯文本（已去掉颜色与格式代码）。
    pub motd: Option<String>,
    /// 服务器图标，只收 `data:image/` 开头的内嵌图。
    pub favicon: Option<String>,
}

/// 查询失败的原因，进 DTO 的 `error` 字段供排查，不对界面分支。
#[derive(Debug, thiserror::Error)]
pub enum PingError {
    #[error("连接或读写失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("{0} 内没有响应")]
    Timeout(String),
    #[error("服务器回了不认识的数据：{0}")]
    Protocol(&'static str),
    #[error("状态 JSON 解析失败：{0}")]
    Json(#[from] serde_json::Error),
}

/// 在 `timeout` 内完成一次完整查询（含解析域名与建连）。
pub async fn ping(address: &ServerAddress, timeout: Duration) -> Result<PingResponse, PingError> {
    match tokio::time::timeout(timeout, ping_inner(address)).await {
        Ok(result) => result,
        Err(_) => Err(PingError::Timeout(format!("{} ms", timeout.as_millis()))),
    }
}

async fn ping_inner(address: &ServerAddress) -> Result<PingResponse, PingError> {
    let mut stream = TcpStream::connect((address.host.as_str(), address.port)).await?;
    stream.set_nodelay(true)?;

    let mut handshake = Vec::new();
    write_varint(&mut handshake, 0x00);
    write_varint(&mut handshake, STATUS_PROTOCOL);
    write_string(&mut handshake, &address.host);
    handshake.extend_from_slice(&address.port.to_be_bytes());
    write_varint(&mut handshake, 1);
    send_packet(&mut stream, &handshake).await?;

    let status_sent = Instant::now();
    send_packet(&mut stream, &[0x00]).await?;
    let body = read_packet(&mut stream).await?;
    let status_rtt = status_sent.elapsed();
    let mut cursor = body.as_slice();
    if read_varint_from(&mut cursor)? != 0x00 {
        return Err(PingError::Protocol("状态响应的包 id 不是 0"));
    }
    let json_len = usize::try_from(read_varint_from(&mut cursor)?)
        .map_err(|_| PingError::Protocol("状态 JSON 长度为负"))?;
    if json_len > cursor.len() {
        return Err(PingError::Protocol("状态 JSON 长度超出包体"));
    }
    let status: Value = serde_json::from_slice(&cursor[..json_len])?;

    let latency = match measure_ping(&mut stream).await {
        Ok(rtt) => rtt,
        Err(err) => {
            tracing::debug!(host = %address.host, error = %err, "ping 包没有回应，延迟改用状态请求往返");
            status_rtt
        }
    };
    Ok(parse_status(&status, latency))
}

async fn measure_ping(stream: &mut TcpStream) -> Result<Duration, PingError> {
    let payload = fastrand::i64(..);
    let mut packet = Vec::with_capacity(9);
    write_varint(&mut packet, 0x01);
    packet.extend_from_slice(&payload.to_be_bytes());
    let sent = Instant::now();
    send_packet(stream, &packet).await?;
    let body = read_packet(stream).await?;
    let rtt = sent.elapsed();
    let mut cursor = body.as_slice();
    if read_varint_from(&mut cursor)? != 0x01 || cursor.len() < 8 {
        return Err(PingError::Protocol("pong 包格式不对"));
    }
    let mut echoed = [0u8; 8];
    echoed.copy_from_slice(&cursor[..8]);
    if i64::from_be_bytes(echoed) != payload {
        return Err(PingError::Protocol("pong 回送的数值不一致"));
    }
    Ok(rtt)
}

/// 把状态 JSON 摊成响应。字段缺失或类型不对的一律记为 `None`，不拿默认值冒充。
pub fn parse_status(status: &Value, latency: Duration) -> PingResponse {
    let players = status.get("players");
    let count = |key: &str| {
        players
            .and_then(|p| p.get(key))
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    };
    let motd = status
        .get("description")
        .map(component_to_plain)
        .filter(|text| !text.is_empty());
    let favicon = status
        .get("favicon")
        .and_then(Value::as_str)
        .filter(|uri| uri.starts_with("data:image/"))
        .map(str::to_owned);
    PingResponse {
        latency_ms: u32::try_from(latency.as_millis()).unwrap_or(u32::MAX),
        version_name: status
            .get("version")
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str)
            .map(strip_formatting),
        online: count("online"),
        max: count("max"),
        motd,
        favicon,
    }
}

/// 聊天组件（字符串、对象或数组）转纯文本：拼接 `text` 与 `extra`，去掉 `§` 格式代码，逐行去首尾空白。
///
/// `translate` 组件没有语言文件可查，有 `fallback` 用 `fallback`，否则只能原样给出翻译键。
pub fn component_to_plain(component: &Value) -> String {
    let mut raw = String::new();
    collect_text(component, &mut raw);
    strip_formatting(&raw)
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn collect_text(component: &Value, out: &mut String) {
    match component {
        Value::String(text) => out.push_str(text),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Array(parts) => parts.iter().for_each(|part| collect_text(part, out)),
        Value::Object(map) => {
            if let Some(text) = map.get("text") {
                collect_text(text, out);
            } else if let Some(fallback) = map.get("fallback") {
                collect_text(fallback, out);
            } else if let Some(key) = map.get("translate") {
                collect_text(key, out);
            }
            if let Some(extra) = map.get("extra") {
                collect_text(extra, out);
            }
        }
        Value::Null => {}
    }
}

/// 去掉 `§` 及其后一个字符（颜色、粗体等旧式格式代码）。
fn strip_formatting(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '§' {
            chars.next();
        } else {
            out.push(c);
        }
    }
    out
}

async fn send_packet(stream: &mut TcpStream, body: &[u8]) -> std::io::Result<()> {
    let mut framed = Vec::with_capacity(body.len() + 5);
    write_varint(&mut framed, i32::try_from(body.len()).unwrap_or(i32::MAX));
    framed.extend_from_slice(body);
    stream.write_all(&framed).await
}

async fn read_packet(stream: &mut TcpStream) -> Result<Vec<u8>, PingError> {
    let len = read_varint_stream(stream).await?;
    let len = usize::try_from(len).map_err(|_| PingError::Protocol("包长度为负"))?;
    if len > MAX_PACKET_BYTES {
        return Err(PingError::Protocol("包长度超出上限"));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    Ok(body)
}

fn write_varint(out: &mut Vec<u8>, value: i32) {
    // VarInt 按无符号 32 位编码：负数固定占 5 字节。
    let mut value = value as u32;
    loop {
        let byte = (value & 0x7F) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn write_string(out: &mut Vec<u8>, text: &str) {
    write_varint(out, i32::try_from(text.len()).unwrap_or(i32::MAX));
    out.extend_from_slice(text.as_bytes());
}

fn read_varint_from(cursor: &mut &[u8]) -> Result<i32, PingError> {
    let mut value: u32 = 0;
    for shift in 0..5 {
        let (&byte, rest) = cursor
            .split_first()
            .ok_or(PingError::Protocol("VarInt 不完整"))?;
        *cursor = rest;
        value |= u32::from(byte & 0x7F) << (7 * shift);
        if byte & 0x80 == 0 {
            return Ok(value as i32);
        }
    }
    Err(PingError::Protocol("VarInt 超过 5 字节"))
}

async fn read_varint_stream(stream: &mut TcpStream) -> Result<i32, PingError> {
    let mut value: u32 = 0;
    for shift in 0..5 {
        let byte = stream.read_u8().await?;
        value |= u32::from(byte & 0x7F) << (7 * shift);
        if byte & 0x80 == 0 {
            return Ok(value as i32);
        }
    }
    Err(PingError::Protocol("VarInt 超过 5 字节"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use tokio::net::TcpListener;

    /// 本地假服务器：读握手与状态请求后回 `status`，`answer_ping` 为真时再回 pong。
    /// 返回监听地址；连上来的次数记在 `connections` 里，供缓存测试断言。
    pub(crate) async fn fake_server(
        status: Value,
        answer_ping: bool,
        connections: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                connections.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let status = status.clone();
                tokio::spawn(async move {
                    let handshake = read_test_packet(&mut socket).await;
                    let mut cursor = handshake.as_slice();
                    assert_eq!(read_varint_from(&mut cursor).unwrap(), 0x00);
                    assert_eq!(read_varint_from(&mut cursor).unwrap(), STATUS_PROTOCOL);
                    let request = read_test_packet(&mut socket).await;
                    assert_eq!(request, vec![0x00]);

                    let text = status.to_string();
                    let mut body = Vec::new();
                    write_varint(&mut body, 0x00);
                    write_string(&mut body, &text);
                    send_packet_raw(&mut socket, &body).await;
                    if answer_ping {
                        let ping = read_test_packet(&mut socket).await;
                        send_packet_raw(&mut socket, &ping).await;
                    }
                });
            }
        });
        addr
    }

    async fn read_test_packet(socket: &mut TcpStream) -> Vec<u8> {
        let len = read_varint_stream(socket).await.unwrap() as usize;
        let mut body = vec![0u8; len];
        socket.read_exact(&mut body).await.unwrap();
        body
    }

    async fn send_packet_raw(socket: &mut TcpStream, body: &[u8]) {
        let mut framed = Vec::new();
        write_varint(&mut framed, body.len() as i32);
        framed.extend_from_slice(body);
        socket.write_all(&framed).await.unwrap();
    }

    fn local(addr: std::net::SocketAddr) -> ServerAddress {
        ServerAddress {
            host: addr.ip().to_string(),
            port: addr.port(),
        }
    }

    #[test]
    fn varint_roundtrips_edge_values() {
        for value in [
            0,
            1,
            127,
            128,
            255,
            25565,
            2_097_151,
            i32::MAX,
            -1,
            i32::MIN,
        ] {
            let mut buf = Vec::new();
            write_varint(&mut buf, value);
            let mut cursor = buf.as_slice();
            assert_eq!(read_varint_from(&mut cursor).unwrap(), value);
            assert!(cursor.is_empty());
        }
        let mut minus_one = Vec::new();
        write_varint(&mut minus_one, -1);
        assert_eq!(minus_one, vec![0xFF, 0xFF, 0xFF, 0xFF, 0x0F]);
        let mut too_long: &[u8] = &[0x80, 0x80, 0x80, 0x80, 0x80, 0x01];
        assert!(read_varint_from(&mut too_long).is_err());
    }

    #[test]
    fn string_description_strips_formatting_codes() {
        let status = json!({
            "version": {"name": "§aPaper 1.21.4", "protocol": 769},
            "players": {"max": 200000, "online": 25000},
            "description": "§6§lHypixel Network §c[1.8-1.21]\n  §bSKYBLOCK UPDATE  ",
            "favicon": "data:image/png;base64,iVBORw0KGgo="
        });
        let parsed = parse_status(&status, Duration::from_millis(186));
        assert_eq!(parsed.latency_ms, 186);
        assert_eq!(parsed.version_name.as_deref(), Some("Paper 1.21.4"));
        assert_eq!(parsed.online, Some(25000));
        assert_eq!(parsed.max, Some(200000));
        assert_eq!(
            parsed.motd.as_deref(),
            Some("Hypixel Network [1.8-1.21]\nSKYBLOCK UPDATE")
        );
        assert_eq!(
            parsed.favicon.as_deref(),
            Some("data:image/png;base64,iVBORw0KGgo=")
        );
    }

    #[test]
    fn chat_component_description_flattens_text_and_extra() {
        let status = json!({
            "description": {
                "text": "Hello ",
                "color": "gold",
                "extra": [
                    {"text": "World", "bold": true},
                    {"translate": "multiplayer.status.unknown", "fallback": "?"},
                    ["!", {"text": 1}],
                    {"translate": "menu.online"}
                ]
            }
        });
        let parsed = parse_status(&status, Duration::from_millis(5));
        assert_eq!(parsed.motd.as_deref(), Some("Hello World?!1menu.online"));
    }

    #[test]
    fn missing_or_malformed_fields_stay_none() {
        let status = json!({
            "players": {"max": -1, "online": "many"},
            "description": "",
            "favicon": "https://tracker.example/icon.png"
        });
        let parsed = parse_status(&status, Duration::ZERO);
        assert_eq!(parsed.online, None);
        assert_eq!(parsed.max, None);
        assert_eq!(parsed.motd, None, "空 MOTD 记为 None");
        assert_eq!(parsed.favicon, None, "只收内嵌图，不让服务器塞外链");
        assert_eq!(parsed.version_name, None);
    }

    #[tokio::test]
    async fn ping_reads_status_and_measures_latency() {
        let connections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let addr = fake_server(
            json!({"version": {"name": "1.21.4"}, "players": {"max": 20, "online": 3}, "description": {"text": "A §cfake§r server"}}),
            true,
            connections,
        )
        .await;
        let parsed = ping(&local(addr), Duration::from_millis(3000))
            .await
            .unwrap();
        assert_eq!(parsed.online, Some(3));
        assert_eq!(parsed.max, Some(20));
        assert_eq!(parsed.motd.as_deref(), Some("A fake server"));
        assert!(parsed.latency_ms < 3000);
    }

    #[tokio::test]
    async fn server_without_pong_still_reports_status() {
        let connections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let addr = fake_server(json!({"description": "no pong"}), false, connections).await;
        let parsed = ping(&local(addr), Duration::from_millis(3000))
            .await
            .unwrap();
        assert_eq!(parsed.motd.as_deref(), Some("no pong"));
    }

    #[tokio::test]
    async fn silent_server_times_out() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            // 接受连接后一言不发，模拟卡死的服务器。
            let held = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(held);
        });
        let started = Instant::now();
        let err = ping(&local(addr), Duration::from_millis(200))
            .await
            .unwrap_err();
        assert!(matches!(err, PingError::Timeout(_)), "实际：{err:?}");
        assert!(started.elapsed() < Duration::from_millis(1000));
    }
}
