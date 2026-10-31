//! 主页固定的服务器：固定列表、游戏多人列表与状态查询。

use aurora_core::{KnownServer, PinnedServer, ServerMonitor, ServerStatus};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::CommandError;
use crate::facade::Facade;

/// 一台固定的服务器。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinnedServerDto {
    pub name: String,
    pub address: String,
}

fn pinned_dto(server: &PinnedServer) -> PinnedServerDto {
    PinnedServerDto {
        name: server.name.clone(),
        address: server.address.clone(),
    }
}

/// 固定的服务器，按固定的先后。
#[tauri::command]
pub async fn list_pinned_servers(
    facade: State<'_, Facade>,
) -> Result<Vec<PinnedServerDto>, CommandError> {
    Ok(facade
        .read()
        .await
        .pinned_servers()
        .iter()
        .map(pinned_dto)
        .collect())
}

/// 整体替换固定列表并落盘，返回整理后的列表（同地址去重、空名字用地址）。
/// 有一个地址写法不合法就整体拒绝（invalid_argument，detail.address）。
#[tauri::command]
pub async fn set_pinned_servers(
    servers: Vec<PinnedServerDto>,
    facade: State<'_, Facade>,
) -> Result<Vec<PinnedServerDto>, CommandError> {
    set_pinned_servers_with(&facade, servers).await
}

pub(crate) async fn set_pinned_servers_with(
    facade: &Facade,
    servers: Vec<PinnedServerDto>,
) -> Result<Vec<PinnedServerDto>, CommandError> {
    let servers = servers
        .into_iter()
        .map(|dto| PinnedServer {
            name: dto.name,
            address: dto.address,
        })
        .collect();
    let mut aurora = facade.write().await;
    aurora.set_pinned_servers(servers)?;
    aurora.save_config().await?;
    Ok(aurora.pinned_servers().iter().map(pinned_dto).collect())
}

/// 游戏多人游戏列表里的服务器（游戏目录根与各版本目录的 servers.dat 合并去重），带是否已固定。
#[tauri::command]
pub async fn list_known_servers(
    facade: State<'_, Facade>,
) -> Result<Vec<KnownServer>, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.known_servers().await?)
}

/// 查询服务器状态，结果与入参顺序一致；不给 `addresses` 时查全部固定的服务器。
/// 单台限时 3000 ms，结果缓存 60 s；连不上不是错误，记为 `reachable: false`。
#[tauri::command]
pub async fn ping_servers(
    addresses: Option<Vec<String>>,
    facade: State<'_, Facade>,
    monitor: State<'_, ServerMonitor>,
) -> Result<Vec<ServerStatus>, CommandError> {
    ping_servers_with(&facade, &monitor, addresses).await
}

pub(crate) async fn ping_servers_with(
    facade: &Facade,
    monitor: &ServerMonitor,
    addresses: Option<Vec<String>>,
) -> Result<Vec<ServerStatus>, CommandError> {
    let addresses = match addresses {
        Some(list) => list,
        None => facade
            .read()
            .await
            .pinned_servers()
            .iter()
            .map(|server| server.address.clone())
            .collect(),
    };
    Ok(monitor.ping_all(&addresses).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::error::code;
    use aurora_core::{Aurora, AuroraConfig};

    fn facade_in(dir: &std::path::Path) -> Facade {
        Facade::new(
            Aurora::open(
                AuroraConfig::default(),
                dir.to_path_buf(),
                dir.join("config.json"),
            )
            .unwrap(),
        )
    }

    #[tokio::test]
    async fn pinned_servers_roundtrip_and_reject_bad_address() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let saved = set_pinned_servers_with(
            &facade,
            vec![
                PinnedServerDto {
                    name: "".into(),
                    address: "play.example.cn:25566".into(),
                },
                PinnedServerDto {
                    name: "重复".into(),
                    address: "PLAY.example.cn:25566".into(),
                },
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            saved,
            vec![PinnedServerDto {
                name: "play.example.cn:25566".into(),
                address: "play.example.cn:25566".into(),
            }]
        );
        let on_disk = aurora_core::ConfigStore::at(dir.path().join("config.json"))
            .load()
            .await
            .unwrap();
        assert_eq!(on_disk.pinned_servers.len(), 1);

        let err = set_pinned_servers_with(
            &facade,
            vec![PinnedServerDto {
                name: "x".into(),
                address: "x:99999".into(),
            }],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(err.detail.unwrap()["address"], "x:99999");
        assert_eq!(facade.read().await.pinned_servers().len(), 1);
    }

    /// 不给地址时查固定列表；连不上的记为 reachable=false 而不是报错。
    #[tokio::test]
    async fn ping_defaults_to_pinned_servers() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("127.0.0.1:{}", closed.local_addr().unwrap().port());
        drop(closed);
        set_pinned_servers_with(
            &facade,
            vec![PinnedServerDto {
                name: "本机".into(),
                address: address.clone(),
            }],
        )
        .await
        .unwrap();
        let monitor = ServerMonitor::new(dir.path());

        let statuses = ping_servers_with(&facade, &monitor, None).await.unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].address, address);
        assert!(!statuses[0].reachable);

        let none = ping_servers_with(&facade, &monitor, Some(Vec::new()))
            .await
            .unwrap();
        assert!(none.is_empty());
    }
}
