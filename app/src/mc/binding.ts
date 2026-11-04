// 把后端的材质状态接进前端：启动时查一次，之后每次收到「材质变化」事件或别处请求重查时再查一次；材质源就绪后接着
// 载入方块目录，并把目录载没载入报出去（下载原版材质的部件靠它结束「正在载入」）。
// 命令与事件的类型化封装属于 IPC 层，这里只接收函数，由外壳在应用根注入。

import { artStatusFromDto, artUrl, setArtStatus, type ArtStatusDto } from "./art";
import { catalogFromDto, setBlockCatalog, type BlockCatalogDto } from "./catalog";
import { PRESET_FACE_PATHS } from "./whitelist";
import { preloadArt } from "./useArt";

export interface ArtStatusBinding {
  /** 查询当前材质状态（后端 art_status）。 */
  load: () => Promise<ArtStatusDto>;
  /** 查询当前材质源的方块目录（后端 art_blocks）；没有材质源时为 null。 */
  loadCatalog: () => Promise<BlockCatalogDto | null>;
  /** 订阅材质变化事件；负载不使用，收到即重新查询。返回取消订阅。 */
  listenChanged: (handler: () => void) => Promise<() => void>;
  /** 事件触发的重新查询、方块目录载入失败时的去处：交给应用最外层的统一错误处理。 */
  onError: (error: unknown) => void;
  /**
   * 每次查询的结果是否载入了方块目录：载入了为 true；没有材质源、状态查询失败、目录查询失败或校验被拒为 false。
   * 被更新的查询作废的结果不报。
   */
  onCatalog: (loaded: boolean) => void;
  /**
   * 登记一个「立刻重查」的入口，返回注销。下载原版材质完成后用它重查：后端在下载命令返回之前就推了变化事件，
   * 那次查询可能早于下载部件开始等待就已结束。
   */
  reloadRequests: (reload: () => void) => () => void;
}

/** 封面预设全部方块的材质地址：新建实例与整合包导入默认取预设，侧栏固定实例也多半是它们。 */
function coverArtUrls(): string[] {
  const urls: string[] = [];
  for (const path of PRESET_FACE_PATHS) {
    const url = artUrl(path);
    if (url !== null) urls.push(url);
  }
  return urls;
}

/**
 * 先订阅再首查，首查与订阅之间发生的变化不会漏掉。首查失败时撤销订阅并抛出。
 * 材质源就绪后预加载全部封面方块，打开新建实例、侧栏时不再等图；再载入方块目录，材质源变为 null 时清空目录。
 * 目录载入失败不影响材质状态，交给 onError，旧目录保留到下次变化事件。返回解除绑定的函数。
 */
export async function bindArtStatus({ load, loadCatalog, listenChanged, onError, onCatalog, reloadRequests }: ArtStatusBinding): Promise<() => void> {
  let disposed = false;
  let latest = 0;
  // 连续两次变化时只认最后一次查询的结果；目录查询跟着它所属的那次状态查询作废
  const stale = (ticket: number) => disposed || ticket !== latest;

  const refreshCatalog = async (ticket: number, versionId: string) => {
    const dto = await loadCatalog();
    if (stale(ticket)) return;
    const next = dto === null ? null : catalogFromDto(dto);
    // 两次查询之间后端换了材质源：随后的变化事件会再查一遍，这里先照实放进去并留下记录
    if (next?.versionId !== versionId) console.warn(`[art] 方块目录出自 ${next?.versionId ?? "（无）"}，与材质源 ${versionId} 不一致`);
    setBlockCatalog(next);
    onCatalog(next !== null);
  };

  // 失败的查询只在它仍是最新的那次时才算「没载入」；错误本身照常交出去
  const notLoaded = (ticket: number) => {
    if (!stale(ticket)) onCatalog(false);
  };

  const refresh = async () => {
    const ticket = ++latest;
    try {
      const dto = await load();
      if (stale(ticket)) return;
      const next = artStatusFromDto(dto);
      setArtStatus(next);
      if (next.source === null) {
        setBlockCatalog(null);
        onCatalog(false);
        return;
      }
      preloadArt(coverArtUrls());
      refreshCatalog(ticket, next.source.versionId).catch((error: unknown) => {
        notLoaded(ticket);
        onError(error);
      });
    } catch (error) {
      notLoaded(ticket);
      throw error;
    }
  };

  const requery = () => {
    refresh().catch(onError);
  };
  const unlisten = await listenChanged(requery);
  const unregister = reloadRequests(requery);
  try {
    await refresh();
  } catch (error) {
    unregister();
    unlisten();
    throw error;
  }
  return () => {
    disposed = true;
    unregister();
    unlisten();
  };
}
