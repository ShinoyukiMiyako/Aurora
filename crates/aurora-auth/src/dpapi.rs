//! 基于 Windows DPAPI(CurrentUser) 的凭据存储实现。
//!
//! 把整份凭据明文交给 `CryptProtectData` 加密（绑定当前用户），密文经原子写入落到单文件
//! `%LOCALAPPDATA%\Petalfall\credentials.bin`；读回时 `CryptUnprotectData` 还原。加密密钥由 Windows
//! 按当前用户管理，其它用户或拷走文件都无法解密。

use core::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr;

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData,
};
use windows::core::PCWSTR;

use crate::credential::{CredentialStore, write_atomic};
use crate::error::{AuthError, Result};

/// `CRYPTPROTECT_UI_FORBIDDEN`：禁止任何交互式 UI，保证调用绝不阻塞（稳定的 Win32 ABI 常量）。
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

/// 凭据文件名（挂在数据目录下）。
const CREDENTIAL_FILE: &str = "credentials.bin";

/// DPAPI 凭据存储：加密后写单文件。
pub struct DpapiCredentialStore {
    path: PathBuf,
}

impl DpapiCredentialStore {
    /// 默认位置：`%LOCALAPPDATA%\Petalfall\credentials.bin`。
    pub fn new() -> Result<Self> {
        let path = aurora_base::fs::data_dir()?.join(CREDENTIAL_FILE);
        Ok(Self { path })
    }

    /// 指定文件路径（测试注入）。
    pub fn at(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_owned(),
        }
    }

    /// 凭据文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl CredentialStore for DpapiCredentialStore {
    fn load(&self) -> Result<Option<Vec<u8>>> {
        match std::fs::read(&self.path) {
            Ok(cipher) => Ok(Some(unprotect(&cipher)?)),
            // 首次运行凭据文件尚不存在。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(AuthError::Base(aurora_base::Error::Io {
                path: self.path.clone(),
                source,
            })),
        }
    }

    fn save(&self, plaintext: &[u8]) -> Result<()> {
        let cipher = protect(plaintext)?;
        write_atomic(&self.path, &cipher)?;
        Ok(())
    }
}

/// DPAPI 加密。
fn protect(plaintext: &[u8]) -> Result<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(plaintext.len()).map_err(|_| AuthError::Dpapi {
            operation: "加密",
            message: "明文长度超过 DPAPI 上限".into(),
        })?,
        pbData: plaintext.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // SAFETY: input.pbData 指向有效的 plaintext 切片（cbData 与其长度一致，且调用不写入输入）；
    // output 由 DPAPI 通过 LocalAlloc 分配，随后由 take_and_free 整块拷出并 LocalFree。
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| AuthError::Dpapi {
            operation: "加密",
            message: e.to_string(),
        })?;
    }
    Ok(take_and_free(output))
}

/// DPAPI 解密。
fn unprotect(cipher: &[u8]) -> Result<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(cipher.len()).map_err(|_| AuthError::Dpapi {
            operation: "解密",
            message: "密文长度超过 DPAPI 上限".into(),
        })?,
        pbData: cipher.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // SAFETY: 同 protect；解密失败（数据损坏/非本用户加密）返回错误而非 UB。
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| AuthError::Dpapi {
            operation: "解密",
            message: e.to_string(),
        })?;
    }
    Ok(take_and_free(output))
}

/// 从 DPAPI 输出 blob 拷出字节并释放其 LocalAlloc 内存。
fn take_and_free(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if blob.pbData.is_null() || blob.cbData == 0 {
        // DPAPI 成功时输出必非空；此分支仅为防御，避免对空指针构造切片。
        if !blob.pbData.is_null() {
            // SAFETY: 非空即为 DPAPI 的 LocalAlloc 分配，需 LocalFree 归还。
            unsafe {
                let _ = LocalFree(Some(HLOCAL(blob.pbData.cast::<c_void>())));
            }
        }
        return Vec::new();
    }
    // SAFETY: blob.pbData 指向 DPAPI 分配的 cbData 字节，先整块拷出。
    let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() };
    // SAFETY: 拷贝完成后释放 DPAPI 的 LocalAlloc 内存。
    unsafe {
        let _ = LocalFree(Some(HLOCAL(blob.pbData.cast::<c_void>())));
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::{Account, AccountCredentials, AccountManager, MicrosoftCredentials};

    #[test]
    fn protect_unprotect_roundtrip_and_ciphertext_differs() {
        let plain: &[u8] = b"aurora-secret-\x00\x01\x02-payload";
        let cipher = protect(plain).unwrap();
        // 密文不等于明文（确实加密了）。
        assert_ne!(cipher.as_slice(), plain);
        // 解密还原。
        assert_eq!(unprotect(&cipher).unwrap(), plain);
    }

    #[test]
    fn store_saves_ciphertext_and_loads_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CREDENTIAL_FILE);
        let store = DpapiCredentialStore::at(&path);

        // 尚未写入时读回 None。
        assert!(store.load().unwrap().is_none());

        let plain = br#"{"accounts":[],"current":null}"#;
        store.save(plain).unwrap();

        // 落盘内容是 DPAPI 密文，不等于明文。
        let on_disk = std::fs::read(&path).unwrap();
        assert_ne!(on_disk.as_slice(), plain.as_slice());
        // 读回解密还原明文。
        assert_eq!(store.load().unwrap().unwrap(), plain);
    }

    #[test]
    fn account_manager_roundtrips_through_dpapi() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CREDENTIAL_FILE);
        {
            let mut mgr = AccountManager::load(DpapiCredentialStore::at(&path)).unwrap();
            mgr.upsert(Account::new(
                "abc",
                "Neo",
                AccountCredentials::Microsoft(MicrosoftCredentials {
                    refresh_token: "secret-refresh".into(),
                    minecraft_token: None,
                    minecraft_expires_at: None,
                }),
            ))
            .unwrap();
        }
        // 新进程语义：从同一加密文件重载。
        let mgr = AccountManager::load(DpapiCredentialStore::at(&path)).unwrap();
        let acc = mgr.find("abc").unwrap();
        assert_eq!(acc.name, "Neo");
        match &acc.credentials {
            AccountCredentials::Microsoft(c) => assert_eq!(c.refresh_token, "secret-refresh"),
            other => panic!("期望 Microsoft 凭据，得到 {other:?}"),
        }
    }
}
