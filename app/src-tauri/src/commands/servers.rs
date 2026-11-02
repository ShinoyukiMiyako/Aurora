//! 主页固定的服务器：固定列表（含「加入」时记住的实例）、游戏多人列表与状态查询。

use petalfall_core::{KnownServer, PinnedServer, ServerMonitor, ServerStatus};
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
    /// 「加入」时记住的实例 id；没记住为 null。入参缺省按没记住处理，出参总是带上这一项。
    #[serde(default)]
    pub instance: Option<String>,
}

fn pinned_dto(server: &PinnedServer) -> PinnedServerDto {
    PinnedServerDto {
        name: server.name.clone(),
        address: server.address.clone(),
        instance: server.instance.clone(),
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

/// 整体替换固定列表并落盘，返回整理后的列表（同地址去重、空名字用地址，记住的实例原样保留）。
/// 有一个地址写法不合法就整体拒绝（invalid_argument，detail.address）；记住的实例 id 不安全时同样拒绝
/// （invalid_argument，detail.field = "id"）。实例是否存在不检查。
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
            instance: dto.instance,
        })
        .collect();
    facade
        .update(|petalfall| {
            petalfall.set_pinned_servers(servers)?;
            Ok(petalfall.pinned_servers().iter().map(pinned_dto).collect())
        })
        .await
}

/// 记住或清掉一台固定服务器「加入」时用的实例并落盘，返回整份固定列表。按地址的身份找（主机不分大小写，
/// 没写端口等于 25565）：不在固定列表里报 server_not_pinned（detail.address）；实例不存在报
/// version_not_installed（detail.id），id 不安全报 invalid_argument（detail.field = "id"）。只改配置，
/// 不占实例。
#[tauri::command]
pub async fn set_pinned_server_instance(
    address: String,
    instance: Option<String>,
    facade: State<'_, Facade>,
) -> Result<Vec<PinnedServerDto>, CommandError> {
    set_pinned_server_instance_with(&facade, address, instance).await
}

pub(crate) async fn set_pinned_server_instance_with(
    facade: &Facade,
    address: String,
    instance: Option<String>,
) -> Result<Vec<PinnedServerDto>, CommandError> {
    // 存在与否要探盘，在快照上查，不拿着写锁等磁盘。
    if let Some(id) = &instance {
        facade.snapshot().await.existing_instance_dir(id).await?;
    }
    facade
        .update(|petalfall| {
            petalfall.set_pinned_server_instance(&address, instance)?;
            Ok(petalfall.pinned_servers().iter().map(pinned_dto).collect())
        })
        .await
}

/// 游戏多人游戏列表里的服务器（游戏目录根与各版本目录的 servers.dat 合并去重），带是否已固定。
#[tauri::command]
pub async fn list_known_servers(
    facade: State<'_, Facade>,
) -> Result<Vec<KnownServer>, CommandError> {
    let petalfall = facade.snapshot().await;
    Ok(petalfall.known_servers().await?)
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
    use petalfall_core::{Petalfall, PetalfallConfig};

    fn facade_in(dir: &std::path::Path) -> Facade {
        Facade::new(
            Petalfall::open(
                PetalfallConfig::default(),
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
                    instance: None,
                },
                PinnedServerDto {
                    name: "重复".into(),
                    address: "PLAY.example.cn:25566".into(),
                    instance: None,
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
                instance: None,
            }]
        );
        let on_disk = petalfall_core::ConfigStore::at(dir.path().join("config.json"))
            .load()
            .await
            .unwrap();
        assert_eq!(on_disk.pinned_servers.len(), 1);

        let err = set_pinned_servers_with(
            &facade,
            vec![PinnedServerDto {
                name: "x".into(),
                address: "x:99999".into(),
                instance: None,
            }],
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(err.detail.unwrap()["address"], "x:99999");
        assert_eq!(facade.read().await.pinned_servers().len(), 1);
    }

    fn dto(name: &str, address: &str, instance: Option<&str>) -> PinnedServerDto {
        PinnedServerDto {
            name: name.into(),
            address: address.into(),
            instance: instance.map(str::to_owned),
        }
    }

    async fn pinned_on_disk(dir: &std::path::Path) -> Vec<petalfall_core::PinnedServer> {
        petalfall_core::ConfigStore::at(dir.join("config.json"))
            .load()
            .await
            .unwrap()
            .pinned_servers
    }

    /// 入参不带 instance 的旧形状照收；出参总是带 instance（null 或 id）。不认识的字段直接拒绝。
    #[test]
    fn pinned_dto_defaults_instance_and_always_serializes_it() {
        let old: PinnedServerDto =
            serde_json::from_value(serde_json::json!({ "name": "a", "address": "a.example" }))
                .unwrap();
        assert_eq!(old, dto("a", "a.example", None));
        assert_eq!(
            serde_json::to_value(&old).unwrap(),
            serde_json::json!({ "name": "a", "address": "a.example", "instance": null })
        );
        let bound: PinnedServerDto = serde_json::from_value(
            serde_json::json!({ "name": "a", "address": "a.example", "instance": "生存" }),
        )
        .unwrap();
        assert_eq!(bound.instance.as_deref(), Some("生存"));
        assert!(
            serde_json::from_value::<PinnedServerDto>(serde_json::json!({
                "name": "a", "address": "a.example", "instanceId": "生存"
            }))
            .is_err()
        );
    }

    #[tokio::test]
    async fn pinned_servers_carry_the_remembered_instance_in_and_out() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        let saved = set_pinned_servers_with(
            &facade,
            vec![
                dto("家", "10.0.0.2", Some("生存")),
                dto("小游戏", "mini.example:25570", None),
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            saved,
            vec![
                dto("家", "10.0.0.2", Some("生存")),
                dto("小游戏", "mini.example:25570", None),
            ]
        );
        let on_disk = pinned_on_disk(dir.path()).await;
        assert_eq!(on_disk[0].instance.as_deref(), Some("生存"));
        assert_eq!(on_disk[1].instance, None);
        let listed: Vec<PinnedServerDto> = facade
            .read()
            .await
            .pinned_servers()
            .iter()
            .map(pinned_dto)
            .collect();
        assert_eq!(listed, saved);

        let err = set_pinned_servers_with(&facade, vec![dto("坏", "b.example", Some("../x"))])
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        let detail = err.detail.unwrap();
        assert_eq!(detail["field"], "id");
        assert_eq!(detail["reason"], "unsafe_id");
        assert_eq!(pinned_on_disk(dir.path()).await.len(), 2);
    }

    #[tokio::test]
    async fn set_pinned_server_instance_checks_the_instance_then_persists() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path());
        std::fs::create_dir_all(dir.path().join(".minecraft").join("versions").join("生存"))
            .unwrap();
        set_pinned_servers_with(
            &facade,
            vec![
                dto("示例", "play.example.cn", None),
                dto("另一台", "other.example", None),
            ],
        )
        .await
        .unwrap();

        let list = set_pinned_server_instance_with(
            &facade,
            "PLAY.example.cn:25565".into(),
            Some("生存".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            list,
            vec![
                dto("示例", "play.example.cn", Some("生存")),
                dto("另一台", "other.example", None),
            ]
        );
        assert_eq!(
            pinned_on_disk(dir.path()).await[0].instance.as_deref(),
            Some("生存")
        );

        let missing =
            set_pinned_server_instance_with(&facade, "play.example.cn".into(), Some("幽灵".into()))
                .await
                .unwrap_err();
        assert_eq!(missing.code, code::VERSION_NOT_INSTALLED);
        assert_eq!(missing.detail.unwrap()["id"], "幽灵");

        let unsafe_id =
            set_pinned_server_instance_with(&facade, "play.example.cn".into(), Some("..".into()))
                .await
                .unwrap_err();
        assert_eq!(unsafe_id.code, code::INVALID_ARGUMENT);
        assert_eq!(unsafe_id.detail.unwrap()["field"], "id");

        let not_pinned = set_pinned_server_instance_with(&facade, "nowhere.example".into(), None)
            .await
            .unwrap_err();
        assert_eq!(not_pinned.code, code::SERVER_NOT_PINNED);
        assert_eq!(not_pinned.detail.unwrap()["address"], "nowhere.example");
        // 失败的几次都没动配置。
        assert_eq!(
            pinned_on_disk(dir.path()).await[0].instance.as_deref(),
            Some("生存")
        );

        // 清掉：实例不存在也能清，不探盘。
        let cleared = set_pinned_server_instance_with(&facade, "play.example.cn".into(), None)
            .await
            .unwrap();
        assert_eq!(cleared[0].instance, None);
        assert_eq!(pinned_on_disk(dir.path()).await[0].instance, None);
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
                instance: None,
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
