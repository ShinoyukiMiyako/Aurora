//! Maven 坐标到仓库相对路径的转换。
//!
//! 与 aurora-version 的 [`aurora_version::MavenCoordinate`] 不同，本模块要额外吃下 Forge
//! install_profile 里常见的 `@扩展名` 后缀（如 `de.oceanlabs.mcp:mcp_config:1.20.1@zip`、
//! `net.minecraft:client:1.20.1-...:mappings@txt`），因此单独实现一份解析，供库落盘路径与
//! 处理器 `[坐标]` 占位符解析共用。纯字符串运算，不碰文件系统。

/// 把一个 maven 坐标转成相对仓库根的路径（正斜杠分隔）。
///
/// 坐标形如 `group:artifact:version[:classifier][@extension]`。缺失 group/artifact/version
/// 任一段、或存在空段时返回 `None`（交由调用方冒泡成坐标非法错误，不静默兜底）。
/// 扩展名缺省为 `jar`。
pub fn artifact_path(coordinate: &str) -> Option<String> {
    let (coord, extension) = match coordinate.split_once('@') {
        Some((left, ext)) if !ext.is_empty() => (left, ext),
        Some(_) => return None, // `@` 后为空是畸形坐标
        None => (coordinate, "jar"),
    };

    let mut parts = coord.split(':');
    let group = parts.next()?;
    let artifact = parts.next()?;
    let version = parts.next()?;
    let classifier = parts.next();
    // 超过 4 段（classifier 之后仍有冒号）视为畸形。
    if parts.next().is_some() {
        return None;
    }
    if group.is_empty() || artifact.is_empty() || version.is_empty() {
        return None;
    }
    if classifier.is_some_and(str::is_empty) {
        return None;
    }

    let group_path = group.replace('.', "/");
    let file_stem = match classifier {
        Some(cl) => format!("{artifact}-{version}-{cl}"),
        None => format!("{artifact}-{version}"),
    };
    Some(format!(
        "{group_path}/{artifact}/{version}/{file_stem}.{extension}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_three_segment_coordinate() {
        assert_eq!(
            artifact_path("com.google.code.gson:gson:2.10.1").unwrap(),
            "com/google/code/gson/gson/2.10.1/gson-2.10.1.jar"
        );
    }

    #[test]
    fn coordinate_with_classifier() {
        assert_eq!(
            artifact_path("org.lwjgl:lwjgl:3.3.3:natives-windows").unwrap(),
            "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar"
        );
    }

    #[test]
    fn coordinate_with_extension() {
        assert_eq!(
            artifact_path("de.oceanlabs.mcp:mcp_config:1.20.1@zip").unwrap(),
            "de/oceanlabs/mcp/mcp_config/1.20.1/mcp_config-1.20.1.zip"
        );
    }

    #[test]
    fn coordinate_with_classifier_and_extension() {
        // Forge data 表里 MOJMAPS 常见形态。
        assert_eq!(
            artifact_path("net.minecraft:client:1.20.1-20230612.114412:mappings@txt").unwrap(),
            "net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-mappings.txt"
        );
    }

    #[test]
    fn forge_universal_coordinate() {
        assert_eq!(
            artifact_path("net.minecraftforge:forge:1.20.1-47.2.0").unwrap(),
            "net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0.jar"
        );
    }

    #[test]
    fn malformed_coordinates_return_none() {
        assert!(artifact_path("only:two").is_none());
        assert!(artifact_path("a:b:").is_none());
        assert!(artifact_path(":b:1").is_none());
        assert!(artifact_path("a:b:1:c:extra").is_none());
        assert!(artifact_path("a:b:1@").is_none());
        assert!(artifact_path("a:b:1:@txt").is_none());
    }
}
