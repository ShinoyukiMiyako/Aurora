//! 读存档的 `level.dat`：存档名、游戏模式、上次游玩时刻。
//!
//! `level.dat` 是 gzip 压缩的 NBT。这里只实现读取所需的最小子集：顺序扫描根复合标签下的 `Data`，
//! 取出几个标量字段，其余标签按长度跳过，不建完整的树。字符串是 Java 的修改版 UTF-8（补充平面字符
//! 编成两个三字节的代理项），按它的规则解码，存档名里的 emoji 才不会读成乱码。

use std::io::Read;

/// 解压后的大小上限。正常的 level.dat 在几 KB 到几百 KB；上限挡住损坏或恶意文件把内存撑爆。
const MAX_DECOMPRESSED: u64 = 32 * 1024 * 1024;
/// 嵌套深度上限，与游戏自己的 NBT 读取上限相同。
const MAX_DEPTH: usize = 512;

const TAG_END: u8 = 0;
const TAG_BYTE: u8 = 1;
const TAG_SHORT: u8 = 2;
const TAG_INT: u8 = 3;
const TAG_LONG: u8 = 4;
const TAG_FLOAT: u8 = 5;
const TAG_DOUBLE: u8 = 6;
const TAG_BYTE_ARRAY: u8 = 7;
const TAG_STRING: u8 = 8;
const TAG_LIST: u8 = 9;
const TAG_COMPOUND: u8 = 10;
const TAG_INT_ARRAY: u8 = 11;
const TAG_LONG_ARRAY: u8 = 12;

/// 存档的游戏模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameMode {
    Survival,
    Creative,
    Adventure,
    Spectator,
    /// 极限模式：`hardcore` 标志为真时，无论 `GameType` 是什么都按极限展示。
    Hardcore,
}

impl GameMode {
    pub fn as_str(self) -> &'static str {
        match self {
            GameMode::Survival => "survival",
            GameMode::Creative => "creative",
            GameMode::Adventure => "adventure",
            GameMode::Spectator => "spectator",
            GameMode::Hardcore => "hardcore",
        }
    }
}

/// `level.dat` 里界面要用的字段；文件里没有的字段为 `None`。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LevelSummary {
    /// 玩家起的存档名（`LevelName`），与文件夹名不一定相同。
    pub name: Option<String>,
    pub mode: Option<GameMode>,
    /// 上次游玩时刻（`LastPlayed`，Unix 毫秒）。
    pub last_played: Option<i64>,
}

/// 解析失败的原因（说明文字，原样给用户看）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LevelDatError(pub String);

impl std::fmt::Display for LevelDatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 解析 gzip 压缩的 `level.dat` 字节。
pub fn parse_level_dat(compressed: &[u8]) -> Result<LevelSummary, LevelDatError> {
    if compressed.len() < 2 || compressed[..2] != [0x1f, 0x8b] {
        return Err(LevelDatError("不是 gzip 压缩的 NBT 文件".into()));
    }
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(compressed)
        .take(MAX_DECOMPRESSED + 1)
        .read_to_end(&mut raw)
        .map_err(|err| LevelDatError(format!("解压失败：{err}")))?;
    if raw.len() as u64 > MAX_DECOMPRESSED {
        return Err(LevelDatError(
            "解压后超过 32 MB，不像正常的 level.dat".into(),
        ));
    }
    parse_nbt(&raw)
}

fn parse_nbt(raw: &[u8]) -> Result<LevelSummary, LevelDatError> {
    let mut r = Reader { buf: raw, pos: 0 };
    if r.u8()? != TAG_COMPOUND {
        return Err(LevelDatError("根标签不是复合标签".into()));
    }
    r.string()?;
    let mut summary = None;
    r.compound(0, |r, tag, name| {
        if tag == TAG_COMPOUND && name == "Data" {
            summary = Some(read_data(r)?);
            Ok(true)
        } else {
            Ok(false)
        }
    })?;
    summary.ok_or_else(|| LevelDatError("缺少 Data 复合标签".into()))
}

fn read_data(r: &mut Reader<'_>) -> Result<LevelSummary, LevelDatError> {
    let mut summary = LevelSummary::default();
    let mut game_type = None;
    let mut hardcore = false;
    r.compound(1, |r, tag, name| {
        match (name, tag) {
            ("LevelName", TAG_STRING) => summary.name = Some(r.string()?),
            ("GameType", TAG_INT) => game_type = Some(r.i32()?),
            ("LastPlayed", TAG_LONG) => summary.last_played = Some(r.i64()?),
            ("hardcore", TAG_BYTE) => hardcore = r.u8()? != 0,
            // 新版本把难度相关的设置收进了 difficulty_settings。
            ("difficulty_settings", TAG_COMPOUND) => r.compound(2, |r, tag, name| {
                if name == "hardcore" && tag == TAG_BYTE {
                    hardcore = r.u8()? != 0;
                    Ok(true)
                } else {
                    Ok(false)
                }
            })?,
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    summary.mode = if hardcore {
        Some(GameMode::Hardcore)
    } else {
        match game_type {
            Some(0) => Some(GameMode::Survival),
            Some(1) => Some(GameMode::Creative),
            Some(2) => Some(GameMode::Adventure),
            Some(3) => Some(GameMode::Spectator),
            _ => None,
        }
    };
    Ok(summary)
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], LevelDatError> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|end| *end <= self.buf.len())
            .ok_or_else(|| LevelDatError("文件在标签中途结束".into()))?;
        let slice = &self.buf[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, LevelDatError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, LevelDatError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn i32(&mut self) -> Result<i32, LevelDatError> {
        let b = self.take(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn i64(&mut self) -> Result<i64, LevelDatError> {
        let b = self.take(8)?;
        let mut arr = [0u8; 8];
        arr.copy_from_slice(b);
        Ok(i64::from_be_bytes(arr))
    }

    fn array_len(&mut self) -> Result<usize, LevelDatError> {
        let n = self.i32()?;
        usize::try_from(n).map_err(|_| LevelDatError(format!("长度为负数：{n}")))
    }

    fn string(&mut self) -> Result<String, LevelDatError> {
        let n = self.u16()? as usize;
        decode_modified_utf8(self.take(n)?)
    }

    /// 逐个读复合标签里的子标签。`visit` 返回 `true` 表示它已读掉这个子标签的负载，否则在这里跳过。
    fn compound(
        &mut self,
        depth: usize,
        mut visit: impl FnMut(&mut Self, u8, &str) -> Result<bool, LevelDatError>,
    ) -> Result<(), LevelDatError> {
        if depth > MAX_DEPTH {
            return Err(LevelDatError("标签嵌套过深".into()));
        }
        loop {
            let tag = self.u8()?;
            if tag == TAG_END {
                return Ok(());
            }
            let name = self.string()?;
            if !visit(self, tag, &name)? {
                self.skip(tag, depth + 1)?;
            }
        }
    }

    fn skip(&mut self, tag: u8, depth: usize) -> Result<(), LevelDatError> {
        if depth > MAX_DEPTH {
            return Err(LevelDatError("标签嵌套过深".into()));
        }
        match tag {
            TAG_BYTE => self.take(1).map(drop),
            TAG_SHORT => self.take(2).map(drop),
            TAG_INT | TAG_FLOAT => self.take(4).map(drop),
            TAG_LONG | TAG_DOUBLE => self.take(8).map(drop),
            TAG_BYTE_ARRAY => {
                let n = self.array_len()?;
                self.take(n).map(drop)
            }
            TAG_STRING => {
                let n = self.u16()? as usize;
                self.take(n).map(drop)
            }
            TAG_INT_ARRAY => {
                let n = self.array_len()?;
                self.take(n.checked_mul(4).ok_or_else(overflow)?).map(drop)
            }
            TAG_LONG_ARRAY => {
                let n = self.array_len()?;
                self.take(n.checked_mul(8).ok_or_else(overflow)?).map(drop)
            }
            TAG_LIST => {
                let item = self.u8()?;
                let n = self.array_len()?;
                if item == TAG_END && n > 0 {
                    return Err(LevelDatError("列表元素类型为空却有元素".into()));
                }
                for _ in 0..n {
                    self.skip(item, depth + 1)?;
                }
                Ok(())
            }
            TAG_COMPOUND => self.compound(depth, |_, _, _| Ok(false)),
            other => Err(LevelDatError(format!("未知的标签类型 {other}"))),
        }
    }
}

fn overflow() -> LevelDatError {
    LevelDatError("数组长度溢出".into())
}

/// Java 的修改版 UTF-8：NUL 编成 `C0 80`，补充平面字符编成两个三字节代理项；只有一到三字节的序列。
fn decode_modified_utf8(bytes: &[u8]) -> Result<String, LevelDatError> {
    let bad = || LevelDatError("字符串不是合法的修改版 UTF-8".into());
    let mut units = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        let cont = |k: usize| -> Result<u16, LevelDatError> {
            match bytes.get(i + k) {
                Some(b) if b & 0xC0 == 0x80 => Ok(u16::from(b & 0x3F)),
                _ => Err(bad()),
            }
        };
        if b0 & 0x80 == 0 {
            units.push(u16::from(b0));
            i += 1;
        } else if b0 & 0xE0 == 0xC0 {
            units.push((u16::from(b0 & 0x1F) << 6) | cont(1)?);
            i += 2;
        } else if b0 & 0xF0 == 0xE0 {
            units.push((u16::from(b0 & 0x0F) << 12) | (cont(1)? << 6) | cont(2)?);
            i += 3;
        } else {
            return Err(bad());
        }
    }
    String::from_utf16(&units).map_err(|_| bad())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// 测试用的 NBT 写入器：只写 level.dat 需要的几种标签。
    #[derive(Default)]
    pub(crate) struct NbtWriter(pub Vec<u8>);

    impl NbtWriter {
        fn name(&mut self, tag: u8, name: &str) {
            self.0.push(tag);
            self.0.extend((name.len() as u16).to_be_bytes());
            self.0.extend(name.as_bytes());
        }
        pub fn open(&mut self, name: &str) -> &mut Self {
            self.name(TAG_COMPOUND, name);
            self
        }
        pub fn close(&mut self) -> &mut Self {
            self.0.push(TAG_END);
            self
        }
        pub fn string(&mut self, name: &str, value: &[u8]) -> &mut Self {
            self.name(TAG_STRING, name);
            self.0.extend((value.len() as u16).to_be_bytes());
            self.0.extend(value);
            self
        }
        pub fn int(&mut self, name: &str, value: i32) -> &mut Self {
            self.name(TAG_INT, name);
            self.0.extend(value.to_be_bytes());
            self
        }
        pub fn long(&mut self, name: &str, value: i64) -> &mut Self {
            self.name(TAG_LONG, name);
            self.0.extend(value.to_be_bytes());
            self
        }
        pub fn byte(&mut self, name: &str, value: u8) -> &mut Self {
            self.name(TAG_BYTE, name);
            self.0.push(value);
            self
        }
        /// 一个元素为复合标签的列表（每个元素只含一个 int），用来覆盖跳过逻辑。
        pub fn list_of_compounds(&mut self, name: &str, count: i32) -> &mut Self {
            self.name(TAG_LIST, name);
            self.0.push(TAG_COMPOUND);
            self.0.extend(count.to_be_bytes());
            for i in 0..count {
                self.int("x", i);
                self.0.push(TAG_END);
            }
            self
        }
        pub fn long_array(&mut self, name: &str, values: &[i64]) -> &mut Self {
            self.name(TAG_LONG_ARRAY, name);
            self.0.extend((values.len() as i32).to_be_bytes());
            for v in values {
                self.0.extend(v.to_be_bytes());
            }
            self
        }
        pub fn gzip(&self) -> Vec<u8> {
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(&self.0).unwrap();
            enc.finish().unwrap()
        }
    }

    /// 一份典型的 level.dat：Data 前后都有要跳过的标签。
    pub(crate) fn level_dat(
        name: &str,
        game_type: i32,
        hardcore: bool,
        last_played: i64,
    ) -> Vec<u8> {
        let mut w = NbtWriter::default();
        w.open("")
            .open("Data")
            .list_of_compounds("Players", 2)
            .string("LevelName", name.as_bytes())
            .long_array("Seeds", &[1, 2, 3])
            .int("GameType", game_type)
            .byte("hardcore", u8::from(hardcore))
            .long("LastPlayed", last_played)
            .close()
            .close();
        w.gzip()
    }

    #[test]
    fn reads_name_mode_and_last_played_skipping_other_tags() {
        let summary = parse_level_dat(&level_dat("我的世界", 1, false, 1_717_000_000_123)).unwrap();
        assert_eq!(summary.name.as_deref(), Some("我的世界"));
        assert_eq!(summary.mode, Some(GameMode::Creative));
        assert_eq!(summary.last_played, Some(1_717_000_000_123));
    }

    #[test]
    fn game_type_maps_to_modes_and_hardcore_overrides() {
        for (gt, mode) in [
            (0, GameMode::Survival),
            (1, GameMode::Creative),
            (2, GameMode::Adventure),
            (3, GameMode::Spectator),
        ] {
            assert_eq!(
                parse_level_dat(&level_dat("w", gt, false, 0)).unwrap().mode,
                Some(mode)
            );
        }
        assert_eq!(
            parse_level_dat(&level_dat("w", 0, true, 0)).unwrap().mode,
            Some(GameMode::Hardcore)
        );
        // 不认识的 GameType 不猜。
        assert_eq!(
            parse_level_dat(&level_dat("w", 7, false, 0)).unwrap().mode,
            None
        );
    }

    #[test]
    fn hardcore_inside_difficulty_settings_is_recognised() {
        let mut w = NbtWriter::default();
        w.open("")
            .open("Data")
            .int("GameType", 0)
            .open("difficulty_settings")
            .byte("hardcore", 1)
            .close()
            .close()
            .close();
        assert_eq!(
            parse_level_dat(&w.gzip()).unwrap().mode,
            Some(GameMode::Hardcore)
        );
    }

    #[test]
    fn missing_fields_are_none() {
        let mut w = NbtWriter::default();
        w.open("").open("Data").close().close();
        assert_eq!(parse_level_dat(&w.gzip()).unwrap(), LevelSummary::default());
    }

    #[test]
    fn supplementary_characters_in_modified_utf8_are_decoded() {
        // U+1F338（樱花）在修改版 UTF-8 里是代理对 D83C DF38 各编三字节。
        let name = [b'A', 0xED, 0xA0, 0xBC, 0xED, 0xBC, 0xB8, 0xC0, 0x80, b'B'];
        let mut w = NbtWriter::default();
        w.open("")
            .open("Data")
            .string("LevelName", &name)
            .close()
            .close();
        assert_eq!(
            parse_level_dat(&w.gzip()).unwrap().name.as_deref(),
            Some("A\u{1F338}\u{0}B")
        );
    }

    #[test]
    fn corrupt_inputs_are_reported() {
        assert!(parse_level_dat(b"not gzip").unwrap_err().0.contains("gzip"));
        // 截断：标签读到一半文件结束。
        let mut w = NbtWriter::default();
        w.open("").open("Data").int("GameType", 1);
        let mut truncated = w.0.clone();
        truncated.truncate(truncated.len() - 2);
        let gz = NbtWriter(truncated).gzip();
        assert!(parse_level_dat(&gz).unwrap_err().0.contains("中途结束"));
        // 根不是复合标签。
        let gz = NbtWriter(vec![TAG_INT, 0, 0, 0, 0, 0, 1]).gzip();
        assert!(parse_level_dat(&gz).unwrap_err().0.contains("根标签"));
        // 没有 Data。
        let mut w = NbtWriter::default();
        w.open("").int("x", 1).close();
        assert!(parse_level_dat(&w.gzip()).unwrap_err().0.contains("Data"));
        // 孤立的代理项不是合法字符串。
        let mut w = NbtWriter::default();
        w.open("")
            .open("Data")
            .string("LevelName", &[0xED, 0xA0, 0xBC])
            .close()
            .close();
        assert!(parse_level_dat(&w.gzip()).unwrap_err().0.contains("UTF-8"));
    }
}
