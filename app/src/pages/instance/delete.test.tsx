// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE_INSTANCE_COPY } from "../../copy/flows";
import { IpcError } from "../../ipc/errors";
import type { DeletionPreviewDto, WorldDto } from "../../ipc/instances";
import { LOADING_DELAY_MS } from "../../lib/loading-gate";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { drainFrames, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, deferred, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { useDeleteInstance } from "./delete";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const NOW = Date.UTC(2026, 9, 31, 12);
const ID = "生存";

let view: Rendered | undefined;
let launcher: LauncherApi;
let remove: ReturnType<typeof useDeleteInstance>;

function Probe() {
  launcher = useLauncher();
  remove = useDeleteInstance();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  stubMatchMedia(false);
  stubResizeObserver();
  bootOverrides(ipc, { instances: [instanceDto(ID)] });
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
});

const flush = () =>
  act(async () => {
    await settle(20);
  });

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function openDelete() {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
  const inst = launcher.state.instances.find((i) => i.id === ID);
  if (inst === undefined) throw new Error(`实例「${ID}」没有读到`);
  act(() => {
    void remove(inst);
  });
  await flush();
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-sk-modal-layer]:not([data-exiting]) [role="dialog"]');
  if (el === null) throw new Error("没有打开的确认框");
  return el;
}

/** 按钮的文字内容只有当前文案：换文案时淡出中的旧字画在伪元素上。 */
function footerButton(variant: "danger" | "ghost"): HTMLButtonElement {
  const el = dialog().querySelector<HTMLButtonElement>(`button[data-variant="${variant}"]`);
  if (el === null) throw new Error(`确认框里没有 ${variant} 按钮`);
  return el;
}

const world = (dir: string, size: number): WorldDto => ({
  dir_name: dir,
  level_status: "ok",
  level_error: null,
  name: dir,
  mode: "survival",
  last_played: null,
  size_bytes: size,
  modified_at: null,
});

const preview = (worlds: WorldDto[]): DeletionPreviewDto => ({
  id: ID,
  worlds,
  size_bytes: 0,
  file_count: 0,
  dependents: [],
  activity: null,
  used_by: null,
  backups_dir: `D:/Games/.minecraft/.petalfall/backups/instances/${ID}`,
  backup_count: 0,
});

describe("删除实例的确认框：清点结果到了以后", () => {
  // 清点一到就放开确认键、换文案的话，骨架还要停够最短时长：这段时间里玩家按得到「删除实例和 2 个存档」，
  // 却还没看到是哪 2 个存档；文案与正文先后各换一次，框也要先后形变两趟，第二趟把第一趟打断
  it("骨架出现过：确认键的文案与可按等骨架停够、正文换成存档清单的那一刻一起换", async () => {
    const pending = deferred<DeletionPreviewDto>();
    ipc.overrides.set("preview_instance_deletion", () => pending.promise);
    await openDelete();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([{ id: ID }]);
    const confirm = footerButton("danger");
    expect(confirm.textContent).toBe(DELETE_INSTANCE_COPY.confirmLabel(0));
    expect(confirm.getAttribute("aria-disabled")).toBe("true");

    // 等待期过了骨架显出来；骨架出现 100 ms 后清点才到
    await advance(LOADING_DELAY_MS + 100);
    await act(async () => {
      pending.resolve(preview([world("旧世界", 1024), world("新世界", 1024)]));
      await settle(20);
    });
    expect(footerButton("danger")).toBe(confirm);
    expect(confirm.textContent).toBe(DELETE_INSTANCE_COPY.confirmLabel(0));
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(dialog().textContent).not.toContain(DELETE_INSTANCE_COPY.worldsLead);

    // 骨架从出现起停够 LOADING_DELAY_MS 的前一刻：仍是骨架，确认键仍不可按
    await advance(LOADING_DELAY_MS - 100 - 1);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(dialog().textContent).not.toContain(DELETE_INSTANCE_COPY.worldsLead);

    await advance(1);
    expect(dialog().textContent).toContain(DELETE_INSTANCE_COPY.worldsLead);
    expect([...dialog().querySelectorAll("li:not([inert] li)")].map((li) => li.textContent)).toEqual(["旧世界", "新世界"]);
    expect(confirm.textContent).toBe(DELETE_INSTANCE_COPY.confirmLabel(2));
    expect(confirm.getAttribute("aria-disabled")).toBeNull();
  });

  it("清点失败：取消键等正文换成失败原因时才改叫「关闭」，确认键一直不可按", async () => {
    const pending = deferred<DeletionPreviewDto>();
    ipc.overrides.set("preview_instance_deletion", () => pending.promise);
    await openDelete();
    const cancel = footerButton("ghost");
    await advance(LOADING_DELAY_MS + 100);
    await act(async () => {
      pending.reject(new IpcError("io_failed", "拒绝访问：saves"));
      await settle(20);
    });
    expect(cancel.textContent).toBe("取消");
    expect(dialog().textContent).not.toContain(DELETE_INSTANCE_COPY.previewFailed("拒绝访问：saves"));

    await advance(LOADING_DELAY_MS - 100);
    expect(dialog().textContent).toContain(DELETE_INSTANCE_COPY.previewFailed("拒绝访问：saves"));
    expect(cancel.textContent).toBe(DELETE_INSTANCE_COPY.close);
    expect(footerButton("danger").getAttribute("aria-disabled")).toBe("true");
  });

  it("等待期里就到了：不出骨架，文案、可按与正文在同一刻换上", async () => {
    const pending = deferred<DeletionPreviewDto>();
    ipc.overrides.set("preview_instance_deletion", () => pending.promise);
    await openDelete();
    await advance(LOADING_DELAY_MS - 100);
    await act(async () => {
      pending.resolve(preview([world("旧世界", 1024)]));
      await settle(20);
    });
    const confirm = footerButton("danger");
    expect(dialog().textContent).toContain(DELETE_INSTANCE_COPY.worldsLead);
    expect(confirm.textContent).toBe(DELETE_INSTANCE_COPY.confirmLabel(1));
    expect(confirm.getAttribute("aria-disabled")).toBeNull();
  });
});
