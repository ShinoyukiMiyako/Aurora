//! 定位引导程序自身文件尾部的载荷。启动时就读头：下载被截断要在用户点安装之前发现。

use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use petalfall_release::data_format::DATA_FORMAT;
use petalfall_setup_payload::{Error, Header, SHIPPED_CAPS, locate};

#[cfg(debug_assertions)]
use crate::runner::fake::Fake;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overlay {
    image: PathBuf,
    header: Header,
    payload_offset: u64,
}

impl Overlay {
    pub fn open(image: &Path) -> Result<Self, Error> {
        let located = locate(&mut File::open(image)?)?;
        Ok(Self {
            image: image.to_owned(),
            header: located.header,
            payload_offset: located.payload_offset,
        })
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    /// 只读载荷这一段：外层签名补在后面的零和证书表不能混进解开的文件。
    pub fn payload(&self) -> io::Result<io::Take<File>> {
        let mut image = File::open(&self.image)?;
        image.seek(SeekFrom::Start(self.payload_offset))?;
        Ok(image.take(self.header.payload_len))
    }
}

/// 安装用的载荷来源。debug 构建没拼过载荷时走假载荷，开发和界面联调不需要真实的 NSIS 包。
pub enum Source {
    Packed(Overlay),
    #[cfg(debug_assertions)]
    Fake(Fake),
}

impl Source {
    pub fn header(&self) -> &Header {
        match self {
            Source::Packed(overlay) => overlay.header(),
            #[cfg(debug_assertions)]
            Source::Fake(fake) => fake.header(),
        }
    }

    pub fn payload(&self) -> io::Result<Box<dyn Read + Send>> {
        match self {
            Source::Packed(overlay) => Ok(Box::new(overlay.payload()?)),
            #[cfg(debug_assertions)]
            Source::Fake(fake) => Ok(Box::new(io::Cursor::new(fake.payload().to_vec()))),
        }
    }
}

/// 载荷头与编进壳里的常量对不上的地方。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mismatch {
    /// 头是 `PFSETUP1`，没有数据格式号与能力位。
    NotV2,
    DataFormat {
        found: u32,
    },
    Caps {
        found: u32,
    },
}

impl fmt::Display for Mismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Mismatch::NotV2 => write!(f, "载荷头不是 PFSETUP2，没有数据格式号与能力位"),
            Mismatch::DataFormat { found } => {
                write!(f, "载荷头的数据格式号是 {found}，本版本是 {DATA_FORMAT}")
            }
            Mismatch::Caps { found } => write!(
                f,
                "载荷头的能力位是 {found:#x}，本版本出厂的是 {SHIPPED_CAPS:#x}"
            ),
        }
    }
}

/// [`load`] 失败的原因，哪一种都说明这个安装包不能用。
#[derive(Debug)]
pub enum LoadError {
    /// 没有载荷、头读不出或载荷被截断。
    Payload(Error),
    /// 头读得出，但不是本次构建打进去的样子。
    Mismatch(Mismatch),
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LoadError::Payload(err) => write!(f, "{err}"),
            LoadError::Mismatch(mismatch) => write!(f, "{mismatch}"),
        }
    }
}

impl std::error::Error for LoadError {
    // 说明已经原样转进了 Display，这里只往下交里层的来源，免得同一句话在错误链里出现两次
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LoadError::Payload(err) => std::error::Error::source(err),
            LoadError::Mismatch(_) => None,
        }
    }
}

/// 壳与载荷总是出自同一次构建，头里的格式、数据格式号与能力位都该与编进壳里的一模一样。
/// 认旧头、忽略不认得的能力位是给检查别的版本的包用的；自己的头有一项对不上，只能是打包出错或拼错了包。
fn check_own_header(header: &Header) -> Result<(), Mismatch> {
    let (Some(data_format), Some(caps)) = (header.data_format, header.caps) else {
        return Err(Mismatch::NotV2);
    };
    if data_format != DATA_FORMAT {
        return Err(Mismatch::DataFormat { found: data_format });
    }
    if caps != SHIPPED_CAPS {
        return Err(Mismatch::Caps { found: caps });
    }
    Ok(())
}

/// 读当前进程文件里的载荷并核对头。任何 `Err` 都等于安装包不完整，调用方要在开窗前报给用户。
pub fn load() -> Result<Source, LoadError> {
    let image = std::env::current_exe().map_err(|err| LoadError::Payload(Error::Io(err)))?;
    load_from(&image)
}

fn load_from(image: &Path) -> Result<Source, LoadError> {
    let source = match Overlay::open(image) {
        Ok(overlay) => Source::Packed(overlay),
        #[cfg(debug_assertions)]
        Err(Error::NoOverlay) => Source::Fake(Fake::from_env()),
        Err(err) => return Err(LoadError::Payload(err)),
    };
    check_own_header(source.header()).map_err(LoadError::Mismatch)?;
    Ok(source)
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::path::{Path, PathBuf};

    use petalfall_setup_payload::Header;

    const DOS_LFANEW_AT: usize = 0x3C;
    const PE_AT: usize = 0x40;
    const COFF_LEN: usize = 20;
    const SECTION_LEN: usize = 40;
    const SECTION_RAW_LEN: usize = 64;

    /// 一个节、没有可选头的最小 PE，文件正好结束在节末端。
    pub fn stub_image() -> Vec<u8> {
        let table = PE_AT + 4 + COFF_LEN;
        let raw_at = table + SECTION_LEN;
        let mut image = vec![0u8; raw_at + SECTION_RAW_LEN];
        image[..2].copy_from_slice(b"MZ");
        image[DOS_LFANEW_AT..DOS_LFANEW_AT + 4].copy_from_slice(&(PE_AT as u32).to_le_bytes());
        image[PE_AT..PE_AT + 4].copy_from_slice(b"PE\0\0");
        image[PE_AT + 6..PE_AT + 8].copy_from_slice(&1u16.to_le_bytes());
        image[table + 16..table + 20].copy_from_slice(&(SECTION_RAW_LEN as u32).to_le_bytes());
        image[table + 20..table + 24].copy_from_slice(&(raw_at as u32).to_le_bytes());
        image
    }

    /// 壳 + 头 + 载荷，再加 `trailer`（模拟签名补上的字节），写到 `dir` 下。
    pub fn packed_image(
        dir: &Path,
        payload: &[u8],
        exe: &[u8],
        version: &str,
        trailer: &[u8],
    ) -> PathBuf {
        let header = Header::new(payload, exe, version).unwrap();
        image_with_header(dir, &header.to_bytes().unwrap(), payload, trailer)
    }

    /// 同 [`packed_image`]，头的字节由调用方给：载荷库只写得出本版本的头，别的头只能拼好字节再放进来。
    pub fn image_with_header(dir: &Path, header: &[u8], payload: &[u8], trailer: &[u8]) -> PathBuf {
        let mut image = stub_image();
        image.extend_from_slice(header);
        image.extend_from_slice(payload);
        image.extend_from_slice(trailer);
        let path = dir.join("petalfall-setup.exe");
        std::fs::write(&path, image).unwrap();
        path
    }

    pub fn random_bytes(len: usize) -> Vec<u8> {
        let mut state = RandomState::new().build_hasher().finish() | 1;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use petalfall_setup_payload::{CAP_CHANNEL_SWITCH, HEADER_LEN_V1, HEADER_LEN_V2, MAGIC_V1};

    use super::test_support::{image_with_header, packed_image, random_bytes, stub_image};
    use super::*;

    #[test]
    fn open_reads_the_header_and_the_exact_payload_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let payload = random_bytes(4099);
        let exe = random_bytes(777);
        let image = packed_image(dir.path(), &payload, &exe, "0.2.0-dev.7", &[]);

        let overlay = Overlay::open(&image).unwrap();

        assert_eq!(overlay.header().version, "0.2.0-dev.7");
        assert_eq!(overlay.header().payload_len, 4099);
        assert_eq!(overlay.header().exe_len, 777);
        assert_eq!(
            overlay.header().payload_sha256,
            petalfall_setup_payload::sha256(&payload)
        );
        assert_eq!(
            overlay.header().exe_sha256,
            petalfall_setup_payload::sha256(&exe)
        );
        let mut read_back = Vec::new();
        overlay
            .payload()
            .unwrap()
            .read_to_end(&mut read_back)
            .unwrap();
        assert_eq!(read_back, payload);
    }

    #[test]
    fn signature_bytes_after_the_payload_stay_out_of_it() {
        let dir = tempfile::tempdir().unwrap();
        let payload = random_bytes(512);
        let image = packed_image(dir.path(), &payload, b"exe", "1.0.0", &[0xAB; 300]);

        let mut read_back = Vec::new();
        Overlay::open(&image)
            .unwrap()
            .payload()
            .unwrap()
            .read_to_end(&mut read_back)
            .unwrap();

        assert_eq!(read_back, payload);
    }

    #[test]
    fn a_stub_without_payload_reports_no_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stub.exe");
        std::fs::write(&path, stub_image()).unwrap();

        assert!(matches!(Overlay::open(&path), Err(Error::NoOverlay)));
    }

    #[test]
    fn a_truncated_download_is_caught_when_the_header_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let image = packed_image(dir.path(), &random_bytes(1000), b"exe", "1.0.0", &[]);
        let full = std::fs::read(&image).unwrap();
        std::fs::write(&image, &full[..full.len() - 1]).unwrap();

        assert!(matches!(
            Overlay::open(&image),
            Err(Error::PayloadTruncated { .. })
        ));
    }

    #[test]
    fn a_missing_image_is_an_io_error() {
        let dir = tempfile::tempdir().unwrap();

        assert!(matches!(
            Overlay::open(&dir.path().join("nope.exe")),
            Err(Error::Io(_))
        ));
    }

    #[test]
    fn packed_source_serves_the_overlay_payload() {
        let dir = tempfile::tempdir().unwrap();
        let payload = random_bytes(2048);
        let source = Source::Packed(
            Overlay::open(&packed_image(dir.path(), &payload, b"exe", "1.0.0", &[])).unwrap(),
        );

        let mut read_back = Vec::new();
        source
            .payload()
            .unwrap()
            .read_to_end(&mut read_back)
            .unwrap();

        assert_eq!(read_back, payload);
        assert_eq!(source.header().version, "1.0.0");
    }

    /// 测试可执行文件本身就是没拼过载荷的 PE，正好覆盖 debug 下的回退。
    #[cfg(debug_assertions)]
    #[test]
    fn debug_builds_fall_back_to_the_fake_payload() {
        assert!(matches!(load(), Ok(Source::Fake(_))));
    }

    /// 同一个场景的 release 行为：不许回退到假载荷。
    #[cfg(not(debug_assertions))]
    #[test]
    fn release_builds_refuse_a_stub_without_payload() {
        assert!(matches!(load(), Err(LoadError::Payload(Error::NoOverlay))));
    }

    fn header_with(data_format: Option<u32>, caps: Option<u32>) -> Header {
        Header {
            data_format,
            caps,
            ..Header::new(b"payload", b"exe", "1.0.0").unwrap()
        }
    }

    /// 本版本没有置上的能力位里最低的一位。
    fn lowest_unshipped_bit() -> u32 {
        1 << SHIPPED_CAPS.trailing_ones()
    }

    /// 本版本的头，号与能力位换成给定值。写出函数不肯写 0 号和未定义的能力位，只能直接改字节。
    fn v2_header_bytes(payload: &[u8], data_format: u32, caps: u32) -> Vec<u8> {
        let header = Header::new(payload, b"exe", "1.0.0").unwrap();
        let mut bytes = header.to_bytes().unwrap().to_vec();
        // 号紧接在旧头的 136 字节之后，能力位再往后 4 字节
        bytes[HEADER_LEN_V1..HEADER_LEN_V1 + 4].copy_from_slice(&data_format.to_le_bytes());
        bytes[HEADER_LEN_V1 + 4..HEADER_LEN_V2].copy_from_slice(&caps.to_le_bytes());
        bytes
    }

    /// 旧包的头：两种头的前 136 字节除 magic 外逐字节相同，载荷库已经写不出旧头。
    fn v1_header_bytes(payload: &[u8]) -> Vec<u8> {
        let header = Header::new(payload, b"exe", "1.0.0").unwrap();
        let mut bytes = header.to_bytes().unwrap()[..HEADER_LEN_V1].to_vec();
        bytes[..MAGIC_V1.len()].copy_from_slice(&MAGIC_V1);
        bytes
    }

    /// 固定种子的 xorshift，失败时可复现。
    fn seeded_u32s(seed: u64, count: usize) -> Vec<u32> {
        let mut state = seed | 1;
        (0..count)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u32
            })
            .collect()
    }

    fn mismatch_of(image: &Path) -> Mismatch {
        match load_from(image) {
            Err(LoadError::Mismatch(mismatch)) => mismatch,
            Err(LoadError::Payload(err)) => panic!("应当是头对不上，实际是：{err}"),
            Ok(_) => panic!("应当被拒"),
        }
    }

    #[test]
    fn a_header_carrying_this_builds_data_format_and_caps_passes() {
        assert_eq!(
            check_own_header(&header_with(Some(DATA_FORMAT), Some(SHIPPED_CAPS))),
            Ok(())
        );
    }

    #[test]
    fn a_v1_header_is_refused() {
        assert_eq!(
            check_own_header(&header_with(None, None)),
            Err(Mismatch::NotV2)
        );
        // 读出来的头两项总是同有同无，手工拼的头缺任一项也不是本版本的头
        assert_eq!(
            check_own_header(&header_with(Some(DATA_FORMAT), None)),
            Err(Mismatch::NotV2)
        );
        assert_eq!(
            check_own_header(&header_with(None, Some(SHIPPED_CAPS))),
            Err(Mismatch::NotV2)
        );
    }

    #[test]
    fn a_data_format_above_or_below_this_versions_is_refused() {
        for found in [DATA_FORMAT + 1, u32::MAX, DATA_FORMAT - 1, 0] {
            assert_eq!(
                check_own_header(&header_with(Some(found), Some(SHIPPED_CAPS))),
                Err(Mismatch::DataFormat { found }),
                "号 {found}"
            );
        }
    }

    #[test]
    fn caps_with_one_bit_more_or_one_bit_less_are_refused() {
        let one_more = SHIPPED_CAPS | lowest_unshipped_bit();
        let one_less = SHIPPED_CAPS & !CAP_CHANNEL_SWITCH;
        assert_eq!(one_more.count_ones(), SHIPPED_CAPS.count_ones() + 1);
        assert_eq!(one_less.count_ones() + 1, SHIPPED_CAPS.count_ones());

        for found in [one_more, one_less, SHIPPED_CAPS | (1 << 31), u32::MAX] {
            assert_eq!(
                check_own_header(&header_with(Some(DATA_FORMAT), Some(found))),
                Err(Mismatch::Caps { found }),
                "能力位 {found:#x}"
            );
        }
    }

    #[test]
    fn only_this_builds_data_format_and_caps_together_pass() {
        let mut formats = vec![
            0,
            1,
            DATA_FORMAT - 1,
            DATA_FORMAT,
            DATA_FORMAT + 1,
            u32::MAX,
        ];
        formats.extend(seeded_u32s(0x5EED, 24));
        let mut caps_values = vec![
            0,
            SHIPPED_CAPS,
            SHIPPED_CAPS | lowest_unshipped_bit(),
            SHIPPED_CAPS & !CAP_CHANNEL_SWITCH,
            1 << 31,
            u32::MAX,
        ];
        caps_values.extend(seeded_u32s(0xCAB5, 24));

        for &data_format in &formats {
            for &caps in &caps_values {
                // 号先于能力位核对
                let expected = if data_format != DATA_FORMAT {
                    Err(Mismatch::DataFormat { found: data_format })
                } else if caps != SHIPPED_CAPS {
                    Err(Mismatch::Caps { found: caps })
                } else {
                    Ok(())
                };
                assert_eq!(
                    check_own_header(&header_with(Some(data_format), Some(caps))),
                    expected,
                    "号 {data_format}，能力位 {caps:#x}"
                );
            }
        }
    }

    #[test]
    fn each_refusal_says_what_was_found_and_what_this_version_expects() {
        assert_eq!(
            LoadError::Mismatch(Mismatch::NotV2).to_string(),
            "载荷头不是 PFSETUP2，没有数据格式号与能力位"
        );
        assert_eq!(
            LoadError::Mismatch(Mismatch::DataFormat { found: 7 }).to_string(),
            format!("载荷头的数据格式号是 7，本版本是 {DATA_FORMAT}")
        );
        assert_eq!(
            LoadError::Mismatch(Mismatch::Caps { found: 3 }).to_string(),
            format!("载荷头的能力位是 0x3，本版本出厂的是 {SHIPPED_CAPS:#x}")
        );
        // 载荷库的错误原样转出，日志里的说法与以前一样
        assert_eq!(
            LoadError::Payload(Error::NoOverlay).to_string(),
            Error::NoOverlay.to_string()
        );
    }

    #[test]
    fn load_accepts_a_packed_header_from_this_build() {
        let dir = tempfile::tempdir().unwrap();
        let payload = random_bytes(256);
        let image = packed_image(dir.path(), &payload, b"exe", "1.0.0", &[]);

        let source = load_from(&image).unwrap();

        assert_eq!(source.header().data_format, Some(DATA_FORMAT));
        assert_eq!(source.header().caps, Some(SHIPPED_CAPS));
        let mut read_back = Vec::new();
        source
            .payload()
            .unwrap()
            .read_to_end(&mut read_back)
            .unwrap();
        assert_eq!(read_back, payload);
    }

    #[test]
    fn load_refuses_a_packed_v1_header() {
        let dir = tempfile::tempdir().unwrap();
        let payload = random_bytes(256);
        let image = image_with_header(dir.path(), &v1_header_bytes(&payload), &payload, &[]);

        // 载荷库照样读得出旧头，拦下它的是载入时的核对
        assert_eq!(Overlay::open(&image).unwrap().header().data_format, None);
        assert_eq!(mismatch_of(&image), Mismatch::NotV2);
    }

    #[test]
    fn load_refuses_a_packed_header_with_another_data_format() {
        let dir = tempfile::tempdir().unwrap();
        let payload = random_bytes(256);
        let image = image_with_header(
            dir.path(),
            &v2_header_bytes(&payload, DATA_FORMAT + 1, SHIPPED_CAPS),
            &payload,
            &[],
        );

        assert_eq!(
            mismatch_of(&image),
            Mismatch::DataFormat {
                found: DATA_FORMAT + 1
            }
        );

        // 最小的号 0 在读头时就被当成损坏拦下
        let image = image_with_header(
            dir.path(),
            &v2_header_bytes(&payload, 0, SHIPPED_CAPS),
            &payload,
            &[],
        );
        assert!(matches!(
            load_from(&image),
            Err(LoadError::Payload(Error::DataFormatZero))
        ));
    }

    #[test]
    fn load_refuses_a_packed_header_with_one_bit_more_or_one_bit_less() {
        let dir = tempfile::tempdir().unwrap();
        let payload = random_bytes(256);
        for caps in [
            SHIPPED_CAPS | lowest_unshipped_bit(),
            SHIPPED_CAPS & !CAP_CHANNEL_SWITCH,
        ] {
            let image = image_with_header(
                dir.path(),
                &v2_header_bytes(&payload, DATA_FORMAT, caps),
                &payload,
                &[],
            );

            assert_eq!(mismatch_of(&image), Mismatch::Caps { found: caps });
        }
    }

    #[test]
    fn load_passes_payload_errors_through() {
        let dir = tempfile::tempdir().unwrap();
        let image = packed_image(dir.path(), &random_bytes(1000), b"exe", "1.0.0", &[]);
        let full = std::fs::read(&image).unwrap();
        std::fs::write(&image, &full[..full.len() - 1]).unwrap();

        assert!(matches!(
            load_from(&image),
            Err(LoadError::Payload(Error::PayloadTruncated { .. }))
        ));
    }
}
