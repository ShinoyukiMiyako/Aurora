// @vitest-environment jsdom
import { act, StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logDiagnostic } from "../ipc/diagnostics";
import { IpcError } from "../ipc/errors";
import { getUiShape, setUiShape, type UiShapeDto, type UiShapePatchDto } from "../ipc/ui-shape";
import { render, type Rendered } from "../test/dom";
import { DEFAULT_UI_SHAPE, loadUiShape, UI_SHAPE_WRITE_DELAY_MS, UiShapeProvider, uiShapeFromDto, useUiShape, type UiShape, type UiShapeApi } from "./ui-shape";

vi.mock("../ipc/ui-shape", async (orig) => ({ ...(await orig<typeof import("../ipc/ui-shape")>()), getUiShape: vi.fn(), setUiShape: vi.fn() }));
vi.mock("../ipc/diagnostics", () => ({ logDiagnostic: vi.fn() }));

const write = vi.mocked(setUiShape);
const read = vi.mocked(getUiShape);
const log = vi.mocked(logDiagnostic);

/** 后端行为：补丁合并进已写下的形状后返回整份。 */
function backendFrom(start: UiShapeDto) {
  let state = { ...start };
  return (patch: UiShapePatchDto) => {
    state = { ...state, ...patch };
    return Promise.resolve({ ...state });
  };
}

let api: UiShapeApi;
function Probe() {
  api = useUiShape();
  return null;
}

let view: Rendered | undefined;

function mount(initial: UiShape) {
  view = render(
    <UiShapeProvider initial={initial}>
      <Probe />
    </UiShapeProvider>,
  );
}

function report(patch: Partial<UiShape>) {
  act(() => api.report(patch));
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  write.mockImplementation(backendFrom({ recent_cards: 0, repair_banner: false }));
  log.mockResolvedValue(undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("DTO 转换与首帧前的读取", () => {
  it("snake_case 转成界面字段", () => {
    expect(uiShapeFromDto({ recent_cards: 6, repair_banner: true })).toEqual({ recentCards: 6, repairBanner: true });
  });

  it("张数不是 0 到 6 的整数、横幅不是布尔值时抛错，不回落成没记过", async () => {
    for (const bad of [7, -1, 1.5, "3"]) {
      expect(() => uiShapeFromDto({ recent_cards: bad as number, repair_banner: false })).toThrow(`recent_cards 应为 0 到 6 的整数，实为 ${String(bad)}`);
    }
    expect(() => uiShapeFromDto({ recent_cards: 0, repair_banner: "yes" as never })).toThrow("repair_banner 应为布尔值，实为 yes");
    read.mockResolvedValue({ recent_cards: "3" as never, repair_banner: false });
    await expect(loadUiShape()).rejects.toThrow("recent_cards 应为 0 到 6 的整数");
    read.mockResolvedValue({ recent_cards: 2, repair_banner: true });
    await expect(loadUiShape()).resolves.toEqual({ recentCards: 2, repairBanner: true });
  });

  it("不在 Provider 里取用直接报错", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow("useUiShape 必须在 UiShapeProvider 之内使用");
    spy.mockRestore();
  });
});

describe("写回", () => {
  it("与已写下的相同就不写：同一个值报多少次都不发请求", async () => {
    mount({ recentCards: 2, repairBanner: true });
    for (let i = 0; i < 5; i++) report({ recentCards: 2, repairBanner: true });
    await advance(5 * UI_SHAPE_WRITE_DELAY_MS);
    expect(write).not.toHaveBeenCalled();
    expect(api.shape).toEqual({ recentCards: 2, repairBanner: true });
  });

  it("变了就攒 1 秒再写一次，界面上的形状立即换成新值", async () => {
    mount(DEFAULT_UI_SHAPE);
    report({ recentCards: 3 });
    expect(api.shape).toEqual({ recentCards: 3, repairBanner: false });
    await advance(UI_SHAPE_WRITE_DELAY_MS - 1);
    expect(write).not.toHaveBeenCalled();
    await advance(1);
    expect(write.mock.calls).toEqual([[{ recent_cards: 3 }]]);
    await advance(5 * UI_SHAPE_WRITE_DELAY_MS);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("1 秒内两处的变化合并成一次写入；又有变化时从最后一次重新计时，只写最后的值", async () => {
    mount(DEFAULT_UI_SHAPE);
    report({ recentCards: 3 });
    await advance(600);
    report({ repairBanner: true });
    await advance(600);
    report({ recentCards: 5 });
    await advance(UI_SHAPE_WRITE_DELAY_MS - 1);
    expect(write).not.toHaveBeenCalled();
    await advance(1);
    expect(write.mock.calls).toEqual([[{ recent_cards: 5, repair_banner: true }]]);
  });

  it("攒着的时候又变回已写下的值：这次不写", async () => {
    mount({ recentCards: 4, repairBanner: false });
    report({ recentCards: 1 });
    await advance(500);
    report({ recentCards: 4 });
    await advance(5 * UI_SHAPE_WRITE_DELAY_MS);
    expect(write).not.toHaveBeenCalled();
  });

  it("写成功后已知值前进：再变回启动时的值要写回去", async () => {
    mount(DEFAULT_UI_SHAPE);
    report({ recentCards: 3 });
    await advance(UI_SHAPE_WRITE_DELAY_MS);
    report({ recentCards: 0 });
    await advance(UI_SHAPE_WRITE_DELAY_MS);
    expect(write.mock.calls).toEqual([[{ recent_cards: 3 }], [{ recent_cards: 0 }]]);
  });

  it("写入在途时变回了旧值：回来之后补写一次，配置里不留那次在途的值", async () => {
    let finish: (dto: UiShapeDto) => void = () => {
      throw new Error("写入还没发出");
    };
    write.mockImplementationOnce(() => new Promise<UiShapeDto>((resolve) => (finish = resolve)));
    mount(DEFAULT_UI_SHAPE);
    report({ recentCards: 3 });
    await advance(UI_SHAPE_WRITE_DELAY_MS);
    expect(write).toHaveBeenCalledTimes(1);
    report({ recentCards: 0 });
    await advance(5 * UI_SHAPE_WRITE_DELAY_MS);
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ recent_cards: 3, repair_banner: false });
      await Promise.resolve();
    });
    await advance(UI_SHAPE_WRITE_DELAY_MS);
    expect(write.mock.calls).toEqual([[{ recent_cards: 3 }], [{ recent_cards: 0 }]]);
  });

  it("写不进去：记一条诊断日志，不抛给界面；已知值不前进，再报同样的变化会重写", async () => {
    write.mockRejectedValueOnce(new IpcError("io_failed", "配置文件写不进去"));
    mount(DEFAULT_UI_SHAPE);
    report({ recentCards: 3 });
    await advance(UI_SHAPE_WRITE_DELAY_MS);
    expect(log.mock.calls).toEqual([["warn", "界面形状没有写进配置", { patch: { recent_cards: 3 }, error: "配置文件写不进去" }]]);
    // 已知值还是启动时的 0：报回 0 不算变化，不发请求
    report({ recentCards: 0 });
    await advance(UI_SHAPE_WRITE_DELAY_MS);
    expect(write).toHaveBeenCalledTimes(1);
    report({ recentCards: 3 });
    await advance(UI_SHAPE_WRITE_DELAY_MS);
    expect(write.mock.calls).toEqual([[{ recent_cards: 3 }], [{ recent_cards: 3 }]]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("卸载时攒着的变化不再写", async () => {
    mount(DEFAULT_UI_SHAPE);
    report({ repairBanner: true });
    view?.unmount();
    view = undefined;
    await advance(5 * UI_SHAPE_WRITE_DELAY_MS);
    expect(write).not.toHaveBeenCalled();
  });

  it("严格模式下先卸再挂一次：挂载时报的变化照样写，只写一次", async () => {
    function Reporter() {
      const { report: send } = useUiShape();
      useEffect(() => send({ recentCards: 2 }), [send]);
      return null;
    }
    view = render(
      <StrictMode>
        <UiShapeProvider initial={DEFAULT_UI_SHAPE}>
          <Reporter />
        </UiShapeProvider>
      </StrictMode>,
    );
    await advance(UI_SHAPE_WRITE_DELAY_MS);
    expect(write.mock.calls).toEqual([[{ recent_cards: 2 }]]);
  });

  it("报的值不合法是调用方的错，当场抛出", () => {
    mount(DEFAULT_UI_SHAPE);
    expect(() => api.report({ recentCards: 7 })).toThrow("recent_cards 应为 0 到 6 的整数，实为 7");
    expect(api.shape).toEqual(DEFAULT_UI_SHAPE);
  });
});
