//! CurseForge 上作者不允许启动器直接下载的文件（受限文件）：用户到网页手动下载后，从下载文件夹认领。
//!
//! 认领到的副本放在缓存目录下的暂存位 `<缓存根>/modpacks/claims/curseforge-<文件 id>/<文件名>`，按平台给的
//! sha1 或 fileFingerprint 校验过才算数。暂存位按文件 id 分、不按整合包分，导入后也不删：同一个文件在别的
//! 整合包里、或这个整合包再导入一次时都能直接用，不用让用户再下载一遍。

use std::path::{Path, PathBuf};

use aurora_modplatform::curseforge::file_page_url;
use aurora_modplatform::{
    CurseForgeClient, CurseForgeFile, CurseForgeMod, Platform, curseforge_fingerprint,
};
use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::error::{CoreError, Result};
use crate::facade::Aurora;
use crate::resources::is_safe_file_name;

/// 一个受限文件：要到 CurseForge 网页手动下载，认领时按这里的哈希校验。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlockedFile {
    pub project_id: u32,
    pub file_id: u32,
    pub file_name: String,
    /// 文件在 CurseForge 网站上的页面，用户从这里下载。
    pub web_url: String,
    /// 装进实例后的落点，相对实例目录、正斜杠分隔，如 `mods/foo.jar`。
    pub destination: String,
    pub sha1: Option<String>,
    /// 平台的 fileFingerprint；0 表示平台没给。
    pub fingerprint: u64,
    pub size: Option<u64>,
}

impl BlockedFile {
    pub(crate) fn new(project: &CurseForgeMod, file: &CurseForgeFile, destination: String) -> Self {
        Self {
            project_id: project.id,
            file_id: file.id,
            file_name: file.file_name.clone(),
            web_url: file_page_url(project, file.id),
            destination,
            sha1: file.sha1().map(str::to_owned),
            fingerprint: file.file_fingerprint,
            size: file.file_length,
        }
    }
}

/// 一次认领的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimReport {
    pub claimed: Vec<ClaimedFile>,
    /// 没找到的文件 id，按入参顺序。
    pub missing: Vec<u32>,
}

/// 认领到的一个文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedFile {
    pub file_id: u32,
    /// 认领自哪个文件；暂存位里本来就有校验通过的副本时是暂存路径。
    pub source: PathBuf,
}

/// 一个从暂存位复制到落点的受限文件。暂存副本留着：同一个文件再装时还能用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClaimedCopy {
    pub(crate) staged: PathBuf,
    pub(crate) dest: PathBuf,
}

/// 单个 Mod 或资源受限：多问一次工程拿到网页链接，拼成只有这一项的受限错误。问工程失败就报那次失败，
/// 不拿一个没有网页链接的半成品糊弄过去。
pub(crate) async fn single_blocked(
    client: &CurseForgeClient,
    mod_id: u32,
    build: impl FnOnce(&CurseForgeMod) -> BlockedFile,
) -> CoreError {
    match client.get_mod(mod_id).await {
        Ok(project) => CoreError::FileDistributionBlocked {
            files: vec![build(&project)],
        },
        Err(err) => err.into(),
    }
}

/// 拿一份字节和受限文件的哈希比。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Check {
    Match,
    Mismatch,
    /// 平台既没给 sha1 也没给 fingerprint，无从确认是不是同一个文件。
    Unverifiable,
}

fn check_bytes(file: &BlockedFile, bytes: &[u8]) -> Check {
    if let Some(expected) = &file.sha1 {
        let actual: String = Sha1::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        return if actual.eq_ignore_ascii_case(expected) {
            Check::Match
        } else {
            Check::Mismatch
        };
    }
    if file.fingerprint != 0 {
        return if u64::from(curseforge_fingerprint(bytes)) == file.fingerprint {
            Check::Match
        } else {
            Check::Mismatch
        };
    }
    Check::Unverifiable
}

/// 读整个文件做校验，放在阻塞线程里：Mod 动辄几十 MB，哈希不该占着异步线程。
async fn verify_path(path: &Path, file: &BlockedFile) -> Result<Check> {
    let owned = path.to_path_buf();
    let file = file.clone();
    tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&owned).map_err(|source| aurora_base::Error::Io {
            path: owned.clone(),
            source,
        })?;
        Ok(check_bytes(&file, &bytes))
    })
    .await?
}

fn io_error(path: &Path, source: std::io::Error) -> CoreError {
    aurora_base::Error::Io {
        path: path.to_path_buf(),
        source,
    }
    .into()
}

fn ensure_safe_name(file: &BlockedFile) -> Result<()> {
    if is_safe_file_name(&file.file_name) {
        Ok(())
    } else {
        Err(CoreError::UnsafeFileName {
            platform: Platform::CurseForge.display_name(),
            file_name: file.file_name.clone(),
        })
    }
}

/// 下载文件夹顶层的一个普通文件。
struct Candidate {
    path: PathBuf,
    name: String,
    len: u64,
}

impl Aurora {
    /// 下载缓存的根：配置了缓存目录就用它，否则是数据目录下的 cache/。
    pub(crate) fn cache_root(&self) -> PathBuf {
        self.config()
            .cache_directory
            .clone()
            .unwrap_or_else(|| self.data_dir().join("cache"))
    }

    /// 手动下载的受限文件认领后放在这里。
    pub fn blocked_claims_dir(&self) -> PathBuf {
        self.cache_root().join("modpacks").join("claims")
    }

    fn claim_slot(&self, file: &BlockedFile) -> PathBuf {
        self.blocked_claims_dir()
            .join(format!("curseforge-{}", file.file_id))
            .join(&file.file_name)
    }

    /// 暂存位里有校验通过的副本时返回它的路径。校验不过的副本不删：下一次认领会用新找到的文件盖掉它。
    pub(crate) async fn claimed_copy(&self, file: &BlockedFile) -> Result<Option<PathBuf>> {
        ensure_safe_name(file)?;
        let slot = self.claim_slot(file);
        match tokio::fs::metadata(&slot).await {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Ok(None),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(io_error(&slot, source)),
        }
        match verify_path(&slot, file).await? {
            Check::Match => Ok(Some(slot)),
            Check::Mismatch | Check::Unverifiable => {
                tracing::warn!(slot = %slot.display(), file_id = file.file_id, "暂存位里的副本与平台给的哈希对不上，不算认领");
                Ok(None)
            }
        }
    }

    /// 单个文件受限时看它认领过没有：认领过就交回文件与暂存副本，单装的 Mod、资源与整合包本体重试时不用再报
    /// 受限；没认领过、或者这根本不是受限错误，原样报。
    pub(crate) async fn claimed_instead_of(
        &self,
        err: CoreError,
    ) -> Result<(BlockedFile, PathBuf)> {
        match err {
            CoreError::FileDistributionBlocked { mut files } => {
                if files.len() == 1
                    && let Some(staged) = self.claimed_copy(&files[0]).await?
                {
                    return Ok((files.remove(0), staged));
                }
                Err(CoreError::FileDistributionBlocked { files })
            }
            other => Err(other),
        }
    }

    /// 从用户选的文件夹里认领手动下载好的受限文件，复制进暂存位。
    ///
    /// 只看文件夹顶层的普通文件：文件名（不分大小写）相同，或平台给了大小且大小正好相同的才算候选，
    /// 浏览器把重名下载改成「foo (1).jar」也认得出来；候选按 sha1、没有 sha1 时按 fingerprint 校验。
    /// 用户文件夹里的原文件不动；不联网，不占实例。
    pub async fn claim_blocked_files(
        &self,
        folder: &Path,
        files: &[BlockedFile],
    ) -> Result<ClaimReport> {
        let invalid = |reason: String| CoreError::ClaimFolderInvalid {
            path: folder.to_path_buf(),
            reason,
        };
        match tokio::fs::metadata(folder).await {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(invalid("选的不是文件夹".to_owned())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(invalid("选的文件夹不存在".to_owned()));
            }
            Err(err) => return Err(invalid(format!("读不了选的文件夹：{err}"))),
        }
        for file in files {
            ensure_safe_name(file)?;
        }

        let entries = list_top_level_files(folder)
            .await
            .map_err(|err| invalid(format!("读不了选的文件夹：{err}")))?;
        let mut claimed = Vec::new();
        let mut missing = Vec::new();
        for file in files {
            if let Some(slot) = self.claimed_copy(file).await? {
                claimed.push(ClaimedFile {
                    file_id: file.file_id,
                    source: slot,
                });
                continue;
            }
            if file.sha1.is_none() && file.fingerprint == 0 {
                tracing::warn!(file_id = file.file_id, name = %file.file_name, "平台没给受限文件的哈希，无从确认，算没找到");
                missing.push(file.file_id);
                continue;
            }
            let wanted = file.file_name.to_lowercase();
            let mut candidates: Vec<&Candidate> = entries
                .iter()
                .filter(|c| c.name.to_lowercase() == wanted || file.size == Some(c.len))
                .collect();
            // 同名的先验：它最可能就是要找的那个，命中了就不用再读改过名的大文件。
            candidates.sort_by_key(|c| c.name.to_lowercase() != wanted);
            let mut found = None;
            for candidate in candidates {
                if verify_path(&candidate.path, file).await? == Check::Match {
                    found = Some(candidate.path.clone());
                    break;
                }
            }
            match found {
                Some(source) => {
                    self.store_claim(&source, file).await?;
                    claimed.push(ClaimedFile {
                        file_id: file.file_id,
                        source,
                    });
                }
                None => missing.push(file.file_id),
            }
        }
        Ok(ClaimReport { claimed, missing })
    }

    async fn store_claim(&self, source: &Path, file: &BlockedFile) -> Result<()> {
        copy_whole(source, &self.claim_slot(file)).await
    }
}

/// 认领到的受限文件从暂存位复制到落点。
pub(crate) async fn place_claimed(claimed: &[ClaimedCopy]) -> Result<()> {
    for copy in claimed {
        copy_whole(&copy.staged, &copy.dest).await?;
    }
    Ok(())
}

/// 先复制成同目录下的 `.part`，再改名成正式文件名：复制到一半失败或进程退出时，落点不会留下一个看起来完整的
/// 半截文件。父目录不在时建上。
async fn copy_whole(source: &Path, dest: &Path) -> Result<()> {
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|err| io_error(dir, err))?;
    }
    let mut part = dest.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    let copied = async {
        tokio::fs::copy(source, &part)
            .await
            .map_err(|err| io_error(&part, err))?;
        tokio::fs::rename(&part, dest)
            .await
            .map_err(|err| io_error(dest, err))
    }
    .await;
    if copied.is_err()
        && let Err(cleanup) = tokio::fs::remove_file(&part).await
        && cleanup.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(part = %part.display(), error = %cleanup, "受限文件复制失败后临时文件未能删除");
    }
    copied
}

async fn list_top_level_files(folder: &Path) -> std::io::Result<Vec<Candidate>> {
    let mut entries = tokio::fs::read_dir(folder).await?;
    let mut files = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_file() {
            continue;
        }
        files.push(Candidate {
            path: entry.path(),
            name: entry.file_name().to_string_lossy().into_owned(),
            len: entry.metadata().await?.len(),
        });
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;

    fn sha1_hex(bytes: &[u8]) -> String {
        Sha1::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn blocked(file_id: u32, name: &str, bytes: &[u8]) -> BlockedFile {
        BlockedFile {
            project_id: 900_000 + file_id,
            file_id,
            file_name: name.to_owned(),
            web_url: format!("https://www.curseforge.com/minecraft/mc-mods/x/files/{file_id}"),
            destination: format!("mods/{name}"),
            sha1: Some(sha1_hex(bytes)),
            fingerprint: 0,
            size: Some(bytes.len() as u64),
        }
    }

    fn aurora(root: &Path) -> Aurora {
        Aurora::for_test(AuroraConfig::default(), root.join("data"), root.join("mc"))
    }

    /// sha1 命中、fingerprint 命中、被浏览器改了名靠大小加哈希命中、大小相同但哈希不符算没找到；命中的复制进
    /// 暂存位、内容相同，下载文件夹里的原文件原样留着；missing 按入参顺序。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn claims_match_by_hash_name_or_size_and_copy_into_the_slot() {
        let tmp = tempfile::tempdir().unwrap();
        let downloads = tmp.path().join("Downloads");
        std::fs::create_dir_all(downloads.join("sub")).unwrap();
        let a = b"jar-a-contents".to_vec();
        let b = b"jar-b fingerprint only".to_vec();
        let c = b"jar-c renamed by browser".to_vec();
        let d = b"jar-d expected".to_vec();
        std::fs::write(downloads.join("Blocked-A.JAR"), &a).unwrap();
        std::fs::write(downloads.join("blocked-b.jar"), &b).unwrap();
        std::fs::write(downloads.join("blocked-c (1).jar"), &c).unwrap();
        // 与 d 一样长、内容不同：只凭大小不能认领。
        let mut wrong = d.clone();
        wrong[0] ^= 0xff;
        std::fs::write(downloads.join("blocked-d (2).jar"), &wrong).unwrap();
        // 子目录里的同名文件不看。
        let e = b"jar-e in a sub folder".to_vec();
        std::fs::write(downloads.join("sub").join("blocked-e.jar"), &e).unwrap();

        let mut fp = blocked(2, "blocked-b.jar", &b);
        fp.sha1 = None;
        fp.fingerprint = u64::from(curseforge_fingerprint(&b));
        let files = vec![
            blocked(1, "blocked-a.jar", &a),
            fp,
            blocked(3, "blocked-c.jar", &c),
            blocked(4, "blocked-d.jar", &d),
            blocked(5, "blocked-e.jar", &e),
        ];
        let aurora = aurora(tmp.path());

        let report = aurora
            .claim_blocked_files(&downloads, &files)
            .await
            .unwrap();
        assert_eq!(
            report
                .claimed
                .iter()
                .map(|c| (c.file_id, c.source.clone()))
                .collect::<Vec<_>>(),
            vec![
                (1, downloads.join("Blocked-A.JAR")),
                (2, downloads.join("blocked-b.jar")),
                (3, downloads.join("blocked-c (1).jar")),
            ]
        );
        assert_eq!(report.missing, vec![4, 5]);
        let claims = tmp
            .path()
            .join("data")
            .join("cache")
            .join("modpacks")
            .join("claims");
        assert_eq!(
            std::fs::read(claims.join("curseforge-1").join("blocked-a.jar")).unwrap(),
            a
        );
        assert_eq!(
            std::fs::read(claims.join("curseforge-2").join("blocked-b.jar")).unwrap(),
            b
        );
        assert_eq!(
            std::fs::read(claims.join("curseforge-3").join("blocked-c.jar")).unwrap(),
            c
        );
        assert!(!claims.join("curseforge-4").exists());
        assert!(
            !claims
                .join("curseforge-3")
                .join("blocked-c.jar.part")
                .exists()
        );
        assert_eq!(
            std::fs::read(downloads.join("blocked-c (1).jar")).unwrap(),
            c,
            "原文件不动"
        );

        // 再认领一次：暂存位里已有的直接算，来源给暂存路径；没找到的仍按顺序列出。
        std::fs::remove_file(downloads.join("Blocked-A.JAR")).unwrap();
        let again = aurora
            .claim_blocked_files(&downloads, &files[..1])
            .await
            .unwrap();
        assert_eq!(
            again.claimed,
            vec![ClaimedFile {
                file_id: 1,
                source: claims.join("curseforge-1").join("blocked-a.jar"),
            }]
        );
        assert!(again.missing.is_empty());
    }

    /// 平台没给任何哈希的文件无从确认，同名也算没找到；文件夹不存在或不是文件夹报 ClaimFolderInvalid；
    /// 带路径成分的文件名直接拒收。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unverifiable_files_and_bad_folders_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora(tmp.path());
        let folder = tmp.path().join("dl");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("nohash.jar"), b"x").unwrap();
        let mut unknown = blocked(7, "nohash.jar", b"x");
        unknown.sha1 = None;
        let report = aurora
            .claim_blocked_files(&folder, std::slice::from_ref(&unknown))
            .await
            .unwrap();
        assert!(report.claimed.is_empty());
        assert_eq!(report.missing, vec![7]);

        let gone = tmp.path().join("不存在");
        let err = aurora
            .claim_blocked_files(&gone, std::slice::from_ref(&unknown))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::ClaimFolderInvalid { path, reason } if path == &gone && reason == "选的文件夹不存在"),
            "{err:?}"
        );
        let err = aurora
            .claim_blocked_files(&folder.join("nohash.jar"), std::slice::from_ref(&unknown))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, CoreError::ClaimFolderInvalid { reason, .. } if reason == "选的不是文件夹"),
            "{err:?}"
        );

        let evil = blocked(8, "../evil.jar", b"x");
        let err = aurora
            .claim_blocked_files(&folder, &[evil])
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::UnsafeFileName { .. }), "{err:?}");
    }

    /// 暂存位里的副本被改过、对不上哈希时不算认领。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tampered_slot_copy_is_not_a_claim() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora(tmp.path());
        let file = blocked(9, "x.jar", b"good");
        let slot = aurora.claim_slot(&file);
        std::fs::create_dir_all(slot.parent().unwrap()).unwrap();
        std::fs::write(&slot, b"evil").unwrap();
        assert_eq!(aurora.claimed_copy(&file).await.unwrap(), None);
        std::fs::write(&slot, b"good").unwrap();
        assert_eq!(aurora.claimed_copy(&file).await.unwrap(), Some(slot));
    }

    /// 缓存目录配置了就放在它下面。
    #[test]
    fn claims_dir_follows_the_cache_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let mut aurora = aurora(tmp.path());
        assert_eq!(
            aurora.blocked_claims_dir(),
            tmp.path()
                .join("data")
                .join("cache")
                .join("modpacks")
                .join("claims")
        );
        aurora.set_cache_directory(Some(tmp.path().join("别处")));
        assert_eq!(
            aurora.blocked_claims_dir(),
            tmp.path().join("别处").join("modpacks").join("claims")
        );
    }
}
