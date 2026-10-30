import type { ArtStatusDto } from "../../art";
import { IpcError } from "../../errors";
import { emitMockEvent } from "../events";
import type { MockHandlers } from "../types";
import { hasMockAccount } from "./accounts";

// ipc/ 只能以类型方式引用别的模块，事件名与名单在这里按后端各写一份。
const ART_CHANGED_EVENT = "aurora://art-changed";
const THUMB_HOSTS: readonly string[] = ["cdn.modrinth.com", "media.forgecdn.net", "launchercontent.mojang.com"];

// 浏览器里没有材质协议，材质源恒为 null：界面全部画回落件，不发任何材质请求。
const INITIAL: ArtStatusDto = { source: null, panorama: false };

let status: ArtStatusDto = { ...INITIAL };

/** 给测试与预览用：模拟后端换了材质源，状态有变化就推送变更事件（与后端 refresh 一致）。 */
export function setMockArtStatus(next: ArtStatusDto): void {
  const changed = JSON.stringify(next) !== JSON.stringify(status);
  status = next;
  if (changed) emitMockEvent(ART_CHANGED_EVENT, next);
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const handlers: MockHandlers = {
  art_status: () => status,

  // 浏览器里没有皮肤缓存：存在的账户一律回 null（画剪影），不存在的与后端一样报 AccountNotFound。
  skin_info: (args) => {
    const uuid = args.accountUuid;
    if (typeof uuid !== "string") throw new IpcError("unknown", "invalid args `accountUuid` for command `skin_info`: missing required key accountUuid");
    if (!hasMockAccount(uuid)) throw new IpcError("AccountNotFound", `账户不存在: ${uuid}`, { uuid });
    return null;
  },

  // 只做后端同样的地址与主机校验并给出同样的键（地址的 SHA-1），不下载任何东西。
  thumb_register: async (args) => {
    const raw = args.url;
    if (typeof raw !== "string") throw new IpcError("unknown", "invalid args `url` for command `thumb_register`: missing required key url");
    let url: URL;
    try {
      url = new URL(raw);
    } catch (e) {
      throw new IpcError("invalid_argument", `缩略图地址不合法：${raw}：${String(e)}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new IpcError("invalid_argument", `缩略图地址不合法：${raw}：只支持 http / https`);
    if (!THUMB_HOSTS.includes(url.hostname)) {
      throw new IpcError("invalid_argument", `缩略图主机 ${url.hostname} 不在允许名单内`, { host: url.hostname });
    }
    return sha1Hex(raw);
  },
};

export function reset(): void {
  status = { ...INITIAL };
}
