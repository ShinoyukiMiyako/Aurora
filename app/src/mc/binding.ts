// 把后端的材质状态接进前端：启动时查一次，之后每次收到「材质变化」事件再查一次。
// 命令与事件的类型化封装属于 IPC 层，这里只接收函数，由外壳在应用根注入。

import { artStatusFromDto, artUrl, setArtStatus, type ArtStatusDto } from "./art";
import { COVER_TEXTURES } from "./whitelist";
import { preloadArt } from "./useArt";

export interface ArtStatusBinding {
  /** 查询当前材质状态（后端 art_status）。 */
  load: () => Promise<ArtStatusDto>;
  /** 订阅材质变化事件；负载不使用，收到即重新查询。返回取消订阅。 */
  listenChanged: (handler: () => void) => Promise<() => void>;
  /** 事件触发的重新查询失败时的去处：交给应用最外层的统一错误处理。 */
  onError: (error: unknown) => void;
}

/** 封面预设全部方块的材质地址；实例的封面只能取自预设，所以它也覆盖了侧栏固定实例的封面。 */
function coverArtUrls(): string[] {
  const urls: string[] = [];
  for (const cover of COVER_TEXTURES) {
    for (const path of new Set([cover.side, cover.top])) {
      const url = artUrl(path);
      if (url !== null) urls.push(url);
    }
  }
  return urls;
}

/**
 * 先订阅再首查，首查与订阅之间发生的变化不会漏掉。首查失败时撤销订阅并抛出。
 * 材质源就绪后预加载全部封面方块，打开新建实例、侧栏时不再等图。返回解除绑定的函数。
 */
export async function bindArtStatus({ load, listenChanged, onError }: ArtStatusBinding): Promise<() => void> {
  let disposed = false;
  let latest = 0;

  const refresh = async () => {
    const ticket = ++latest;
    const dto = await load();
    // 连续两次变化时只认最后一次查询的结果
    if (disposed || ticket !== latest) return;
    const next = artStatusFromDto(dto);
    setArtStatus(next);
    if (next.source !== null) preloadArt(coverArtUrls());
  };

  const unlisten = await listenChanged(() => {
    refresh().catch(onError);
  });
  try {
    await refresh();
  } catch (error) {
    unlisten();
    throw error;
  }
  return () => {
    disposed = true;
    unlisten();
  };
}
