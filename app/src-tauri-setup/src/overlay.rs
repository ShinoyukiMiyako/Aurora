//! 定位引导程序自身文件尾部的载荷。启动时就读头：下载被截断要在用户点安装之前发现。

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use petalfall_setup_payload::{Error, Header, locate};

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

/// 读当前进程文件里的载荷。任何 `Err` 都等于安装包不完整，调用方要在开窗前报给用户。
pub fn load() -> Result<Source, Error> {
    let image = std::env::current_exe()?;
    match Overlay::open(&image) {
        Ok(overlay) => Ok(Source::Packed(overlay)),
        #[cfg(debug_assertions)]
        Err(Error::NoOverlay) => Ok(Source::Fake(Fake::from_env())),
        Err(err) => Err(err),
    }
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
        let mut image = stub_image();
        image.extend_from_slice(&header.to_bytes().unwrap());
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

    use super::test_support::{packed_image, random_bytes, stub_image};
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
        assert!(matches!(load(), Err(Error::NoOverlay)));
    }
}
