//! 读游戏的多人游戏列表 `servers.dat`：未压缩 NBT，根复合标签里一个 `servers` 列表，
//! 每项是含 `name`、`ip`（及 `icon`、`acceptTextures` 等）的复合标签。
//!
//! 只实现读取这份文件需要的那部分 NBT：认得全部标签类型以便跳过不关心的字段，
//! 字符串按 Java 的「改良 UTF-8」解码（补充平面字符是两个代理项各编 3 字节）。

/// 列表里的一台服务器。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedServer {
    pub name: String,
    pub address: String,
}

/// 解析失败的原因。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NbtError {
    #[error("数据在第 {0} 字节处提前结束")]
    Truncated(usize),
    #[error("第 {offset} 字节处出现未知标签类型 {tag}")]
    UnknownTag { offset: usize, tag: u8 },
    #[error("根标签不是复合标签")]
    RootNotCompound,
    #[error("嵌套层数超过上限")]
    TooDeep,
}

const TAG_END: u8 = 0;
const TAG_LIST: u8 = 9;
const TAG_COMPOUND: u8 = 10;
const TAG_STRING: u8 = 8;
/// 嵌套上限：正常的 servers.dat 只有三层，异常数据不该把栈打穿。
const MAX_DEPTH: usize = 64;

/// 解析 `servers.dat` 的字节内容，返回列表顺序的服务器；缺 `ip` 的条目跳过。
pub fn parse_servers_dat(bytes: &[u8]) -> Result<Vec<ListedServer>, NbtError> {
    let mut reader = Reader { bytes, pos: 0 };
    if reader.u8()? != TAG_COMPOUND {
        return Err(NbtError::RootNotCompound);
    }
    reader.string()?;
    let mut servers = Vec::new();
    loop {
        let tag = reader.u8()?;
        if tag == TAG_END {
            break;
        }
        let name = reader.string()?;
        if tag == TAG_LIST && name == "servers" {
            let element = reader.u8()?;
            let count = reader.i32()?.max(0);
            for _ in 0..count {
                if element == TAG_COMPOUND {
                    if let Some(server) = read_server(&mut reader)? {
                        servers.push(server);
                    }
                } else {
                    reader.skip(element, 1)?;
                }
            }
        } else {
            reader.skip(tag, 1)?;
        }
    }
    Ok(servers)
}

fn read_server(reader: &mut Reader<'_>) -> Result<Option<ListedServer>, NbtError> {
    let mut name = None;
    let mut ip = None;
    loop {
        let tag = reader.u8()?;
        if tag == TAG_END {
            break;
        }
        let key = reader.string()?;
        match (tag, key.as_str()) {
            (TAG_STRING, "name") => name = Some(reader.string()?),
            (TAG_STRING, "ip") => ip = Some(reader.string()?),
            _ => reader.skip(tag, 2)?,
        }
    }
    Ok(ip
        .map(|address| address.trim().to_owned())
        .filter(|address| !address.is_empty())
        .map(|address| ListedServer {
            name: name.unwrap_or_else(|| address.clone()),
            address,
        }))
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], NbtError> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|&end| end <= self.bytes.len())
            .ok_or(NbtError::Truncated(self.pos))?;
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, NbtError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, NbtError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn i32(&mut self) -> Result<i32, NbtError> {
        let b = self.take(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn string(&mut self) -> Result<String, NbtError> {
        let len = usize::from(self.u16()?);
        Ok(decode_modified_utf8(self.take(len)?))
    }

    /// 跳过一个负载（不含标签类型与名字）。
    fn skip(&mut self, tag: u8, depth: usize) -> Result<(), NbtError> {
        if depth > MAX_DEPTH {
            return Err(NbtError::TooDeep);
        }
        let fixed = |width: usize, count: i32| width * usize::try_from(count.max(0)).unwrap_or(0);
        match tag {
            1 => self.take(1).map(drop),
            2 => self.take(2).map(drop),
            3 | 5 => self.take(4).map(drop),
            4 | 6 => self.take(8).map(drop),
            7 => {
                let count = self.i32()?;
                self.take(fixed(1, count)).map(drop)
            }
            TAG_STRING => self.string().map(drop),
            TAG_LIST => {
                let element = self.u8()?;
                let count = self.i32()?.max(0);
                for _ in 0..count {
                    self.skip(element, depth + 1)?;
                }
                Ok(())
            }
            TAG_COMPOUND => loop {
                let inner = self.u8()?;
                if inner == TAG_END {
                    return Ok(());
                }
                self.string()?;
                self.skip(inner, depth + 1)?;
            },
            11 => {
                let count = self.i32()?;
                self.take(fixed(4, count)).map(drop)
            }
            12 => {
                let count = self.i32()?;
                self.take(fixed(8, count)).map(drop)
            }
            other => Err(NbtError::UnknownTag {
                offset: self.pos,
                tag: other,
            }),
        }
    }
}

/// Java 改良 UTF-8 → String。先解出 UTF-16 码元再合并代理对；不合法的字节记为替换符，
/// 一个坏名字不该让整份服务器列表读不出来。
fn decode_modified_utf8(bytes: &[u8]) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        let cont = |k: usize| bytes.get(i + k).copied().filter(|b| b & 0xC0 == 0x80);
        if b0 & 0x80 == 0 {
            units.push(u16::from(b0));
            i += 1;
        } else if b0 & 0xE0 == 0xC0 {
            match cont(1) {
                Some(b1) => {
                    units.push((u16::from(b0 & 0x1F) << 6) | u16::from(b1 & 0x3F));
                    i += 2;
                }
                None => {
                    units.push(0xFFFD);
                    i += 1;
                }
            }
        } else if b0 & 0xF0 == 0xE0 {
            match (cont(1), cont(2)) {
                (Some(b1), Some(b2)) => {
                    units.push(
                        (u16::from(b0 & 0x0F) << 12)
                            | (u16::from(b1 & 0x3F) << 6)
                            | u16::from(b2 & 0x3F),
                    );
                    i += 3;
                }
                _ => {
                    units.push(0xFFFD);
                    i += 1;
                }
            }
        } else {
            units.push(0xFFFD);
            i += 1;
        }
    }
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 测试用的最小 NBT 写入器：只写 servers.dat 用得到的标签。
    pub(crate) fn servers_dat(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut out = vec![TAG_COMPOUND];
        put_string(&mut out, "");
        out.push(TAG_LIST);
        put_string(&mut out, "servers");
        out.push(TAG_COMPOUND);
        out.extend_from_slice(&(entries.len() as i32).to_be_bytes());
        for (name, ip) in entries {
            // 前面放一个要跳过的字节标签与图标字符串，验证跳过逻辑。
            out.push(1);
            put_string(&mut out, "acceptTextures");
            out.push(1);
            out.push(TAG_STRING);
            put_string(&mut out, "icon");
            put_string(&mut out, "iVBORw0KGgo=");
            out.push(TAG_STRING);
            put_string(&mut out, "name");
            put_string(&mut out, name);
            out.push(TAG_STRING);
            put_string(&mut out, "ip");
            put_string(&mut out, ip);
            out.push(TAG_END);
        }
        out.push(TAG_END);
        out
    }

    fn put_string(out: &mut Vec<u8>, text: &str) {
        let encoded = encode_modified_utf8(text);
        out.extend_from_slice(&(encoded.len() as u16).to_be_bytes());
        out.extend_from_slice(&encoded);
    }

    fn encode_modified_utf8(text: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for unit in text.encode_utf16() {
            match unit {
                0x0001..=0x007F => out.push(unit as u8),
                0x0000 | 0x0080..=0x07FF => {
                    out.push(0xC0 | (unit >> 6) as u8);
                    out.push(0x80 | (unit & 0x3F) as u8);
                }
                _ => {
                    out.push(0xE0 | (unit >> 12) as u8);
                    out.push(0x80 | ((unit >> 6) & 0x3F) as u8);
                    out.push(0x80 | (unit & 0x3F) as u8);
                }
            }
        }
        out
    }

    #[test]
    fn parses_names_and_addresses_in_order() {
        let bytes = servers_dat(&[
            ("Hypixel", "mc.hypixel.net"),
            ("家里的服", "192.168.1.8:25566"),
        ]);
        assert_eq!(
            parse_servers_dat(&bytes).unwrap(),
            vec![
                ListedServer {
                    name: "Hypixel".to_owned(),
                    address: "mc.hypixel.net".to_owned()
                },
                ListedServer {
                    name: "家里的服".to_owned(),
                    address: "192.168.1.8:25566".to_owned()
                },
            ]
        );
    }

    #[test]
    fn decodes_supplementary_characters_from_surrogate_pairs() {
        // U+1F338 在改良 UTF-8 里是两个代理项各占 3 字节，共 6 字节。
        let name = "樱\u{1F338}";
        assert_eq!(encode_modified_utf8(name).len(), 3 + 6);
        let bytes = servers_dat(&[(name, "a.example")]);
        assert_eq!(parse_servers_dat(&bytes).unwrap()[0].name, name);
    }

    #[test]
    fn empty_address_entries_are_skipped_and_empty_list_is_fine() {
        let bytes = servers_dat(&[("空", "  "), ("ok", "b.example")]);
        let parsed = parse_servers_dat(&bytes).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].address, "b.example");
        assert!(parse_servers_dat(&servers_dat(&[])).unwrap().is_empty());
    }

    #[test]
    fn truncated_or_foreign_data_is_an_error() {
        let bytes = servers_dat(&[("Hypixel", "mc.hypixel.net")]);
        assert!(matches!(
            parse_servers_dat(&bytes[..bytes.len() - 3]),
            Err(NbtError::Truncated(_))
        ));
        assert_eq!(
            parse_servers_dat(&[TAG_LIST, 0, 0]),
            Err(NbtError::RootNotCompound)
        );
        assert!(parse_servers_dat(&[]).is_err());
    }
}
