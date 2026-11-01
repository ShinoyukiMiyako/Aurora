// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcRecorder } from "../../test/fake-bridge";
import { render } from "../../test/dom";
import { callsOf, resetRecorder } from "../../test/launcher";
import type { ResourceResult } from "../resource";
import { useVersionRequirements, type VersionRequirementsDto } from "./catalog";
import { useModpackSummary, type ModpackSummaryDto } from "./discover";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const tick = () => act(async () => undefined);

/** 把 hook 的每次结果记下来，返回最后一次。 */
async function probe<T>(use: () => ResourceResult<T>): Promise<{ last: () => ResourceResult<T>; unmount: () => void }> {
  const seen: ResourceResult<T>[] = [];
  function Probe() {
    seen.push(use());
    return null;
  }
  const view = render(<Probe />);
  await tick();
  return {
    last: () => {
      const result = seen.at(-1);
      if (result === undefined) throw new Error("Probe 没有渲染");
      return result;
    },
    unmount: view.unmount,
  };
}

beforeEach(() => {
  resetRecorder(ipc);
});

describe("新建实例的版本要求", () => {
  it("没选版本时不请求；选定后按版本查一次，Java 主版本与下载字节原样交给页面", async () => {
    const requirements: VersionRequirementsDto = { java_major: 17, download_bytes: 686_817_280 };
    ipc.overrides.set("version_requirements", () => requirements);

    const idle = await probe(() => useVersionRequirements(null));
    expect(idle.last().status).toBe("loading");
    expect(callsOf(ipc, "version_requirements")).toEqual([]);
    idle.unmount();

    const picked = await probe(() => useVersionRequirements("1.20.1-req"));
    expect(callsOf(ipc, "version_requirements")).toEqual([{ mcVersion: "1.20.1-req" }]);
    expect(picked.last()).toMatchObject({ status: "ready", data: requirements });
    picked.unmount();
  });

  it("有库没标大小时下载字节为 null，页面据此不显示体积", async () => {
    ipc.overrides.set("version_requirements", () => ({ java_major: 8, download_bytes: null }));
    const view = await probe(() => useVersionRequirements("1.5.2-req"));
    expect(view.last()).toMatchObject({ status: "ready", data: { java_major: 8, download_bytes: null } });
    view.unmount();
  });
});

describe("平台整合包摘要", () => {
  it("没选版本时不请求；选定后按平台、工程与版本查一次", async () => {
    const summary: ModpackSummaryDto = {
      format: "modrinth",
      name: "Sakura Pack",
      version: "1.2.0",
      minecraft: "1.20.1",
      loader: { kind: "fabric", version: "0.15.11" },
      pack_bytes: 1_048_576,
      remote_files: 48,
      mod_files: 41,
      remote_bytes: 512_000_000,
      override_files: 3,
      override_bytes: 2_048,
    };
    ipc.overrides.set("summarize_platform_modpack", () => summary);

    const idle = await probe(() => useModpackSummary("modrinth", "sakura-pack-req", null));
    expect(idle.last().status).toBe("loading");
    expect(callsOf(ipc, "summarize_platform_modpack")).toEqual([]);
    idle.unmount();

    const picked = await probe(() => useModpackSummary("modrinth", "sakura-pack-req", "v-120"));
    expect(callsOf(ipc, "summarize_platform_modpack")).toEqual([{ platform: "modrinth", projectId: "sakura-pack-req", versionId: "v-120" }]);
    expect(picked.last()).toMatchObject({ status: "ready", data: summary });
    picked.unmount();
  });

  it("读不了远端整合包时以错误交回，错误码原样保留", async () => {
    ipc.overrides.set("summarize_platform_modpack", () => {
      throw Object.assign(new Error("服务器不支持按范围读取"), { code: "remote_pack_unreadable" });
    });
    const view = await probe(() => useModpackSummary("curseforge", "cf-req-1", "f-9"));
    expect(view.last().status).toBe("error");
    expect(view.last().error).toMatchObject({ code: "remote_pack_unreadable" });
    view.unmount();
  });
});
