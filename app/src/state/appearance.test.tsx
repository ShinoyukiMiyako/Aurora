// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Appearance } from "../domain/types";
import { getAppearance, setAppearance as persist, type AppearanceDto, type AppearancePatchDto } from "../ipc/appearance";
import { render, stubMatchMedia, type Rendered } from "../test/dom";
import {
  AppearanceProvider,
  appearanceFromDto,
  appearancePatchToDto,
  applyAppearance,
  DEFAULT_APPEARANCE,
  loadAppearance,
  useAppearance,
  type AppearanceApi,
} from "./appearance";

vi.mock("../ipc/appearance", () => ({ getAppearance: vi.fn(), setAppearance: vi.fn() }));

const html = document.documentElement;
const DAY_DTO: AppearanceDto = { mode: "day", accent: "sakura", petals: true, panorama: false, reduce_motion: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 后端行为：把补丁合并进已确认的状态后返回。 */
function backendMerging(start: AppearanceDto) {
  let state = { ...start };
  return (patch: AppearancePatchDto) => {
    state = { ...state, ...patch };
    return Promise.resolve({ ...state });
  };
}

let api: AppearanceApi;
function Probe() {
  api = useAppearance();
  return null;
}

let view: Rendered | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  for (const attr of ["data-sk-mode", "data-sk-accent", "data-sk-reduced"]) html.removeAttribute(attr);
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe("DTO 转换", () => {
  it("snake_case 转成领域字段", () => {
    expect(appearanceFromDto({ mode: "night", accent: "moss", petals: false, panorama: true, reduce_motion: true })).toEqual({
      mode: "night",
      accent: "moss",
      petals: false,
      panorama: true,
      reduceMotion: true,
    });
  });

  it("未知取值直接抛错", () => {
    expect(() => appearanceFromDto({ ...DAY_DTO, accent: "rose" as never })).toThrow("未知的强调色：rose");
    expect(() => appearanceFromDto({ ...DAY_DTO, mode: "dusk" as never })).toThrow("未知的外观明暗：dusk");
    expect(() => appearanceFromDto({ ...DAY_DTO, petals: "yes" as never })).toThrow("外观字段 petals 应为布尔值");
  });

  it("补丁只写出出现的字段", () => {
    expect(appearancePatchToDto({ reduceMotion: true })).toEqual({ reduce_motion: true });
    expect(appearancePatchToDto({ mode: "night", accent: "amethyst" })).toEqual({ mode: "night", accent: "amethyst" });
    expect(appearancePatchToDto({})).toEqual({});
    expect(() => appearancePatchToDto({ accent: "teal" as never })).toThrow("未知的强调色：teal");
  });

  it("loadAppearance 读后端并校验", async () => {
    vi.mocked(getAppearance).mockResolvedValueOnce({ ...DAY_DTO, accent: "amethyst" });
    expect(await loadAppearance()).toEqual({ ...DEFAULT_APPEARANCE, accent: "amethyst" });
    vi.mocked(getAppearance).mockResolvedValueOnce({ ...DAY_DTO, mode: "noon" as never });
    await expect(loadAppearance()).rejects.toThrow("未知的外观明暗：noon");
  });
});

describe("applyAppearance", () => {
  it("明暗与强调色永远显式写出", () => {
    applyAppearance(DEFAULT_APPEARANCE, false);
    expect(html.getAttribute("data-sk-mode")).toBe("day");
    expect(html.getAttribute("data-sk-accent")).toBe("sakura");
    expect(html.hasAttribute("data-sk-reduced")).toBe(false);
  });

  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])("应用设置 %s、系统偏好 %s -> 减少动画 %s", (setting, system, reduced) => {
    applyAppearance({ ...DEFAULT_APPEARANCE, reduceMotion: setting }, system);
    expect(html.hasAttribute("data-sk-reduced")).toBe(reduced);
  });
});

describe("AppearanceProvider", () => {
  const mount = (initial: Appearance = DEFAULT_APPEARANCE) => {
    view = render(
      <AppearanceProvider initial={initial}>
        <Probe />
      </AppearanceProvider>,
    );
  };

  it("在 Provider 之外使用直接抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow("useAppearance 必须在 AppearanceProvider 之内使用");
  });

  it("挂载时按初始值与系统偏好写 <html>", () => {
    stubMatchMedia(true);
    mount({ ...DEFAULT_APPEARANCE, mode: "night", accent: "moss" });
    expect(html.getAttribute("data-sk-mode")).toBe("night");
    expect(html.getAttribute("data-sk-accent")).toBe("moss");
    expect(html.hasAttribute("data-sk-reduced")).toBe(true);
    expect(api.reduced).toBe(true);
  });

  it("先同步改 <html>，后端确认后以确认值为准", async () => {
    stubMatchMedia(false);
    const pending = deferred<AppearanceDto>();
    vi.mocked(persist).mockReturnValueOnce(pending.promise);
    mount();
    let done!: Promise<void>;
    act(() => {
      done = api.setAppearance({ mode: "night" });
    });
    expect(html.getAttribute("data-sk-mode")).toBe("night");
    expect(api.appearance.mode).toBe("night");
    expect(vi.mocked(persist).mock.calls).toEqual([[{ mode: "night" }]]);
    await act(async () => {
      pending.resolve({ ...DAY_DTO, mode: "night", accent: "amethyst" });
      await done;
    });
    expect(html.getAttribute("data-sk-accent")).toBe("amethyst");
    expect(api.appearance).toEqual({ ...DEFAULT_APPEARANCE, mode: "night", accent: "amethyst" });
  });

  it("写入失败：界面回到后端最后确认的值，原错误抛给调用方", async () => {
    stubMatchMedia(false);
    vi.mocked(persist).mockImplementationOnce(backendMerging(DAY_DTO));
    mount();
    await act(() => api.setAppearance({ accent: "moss" }));
    expect(html.getAttribute("data-sk-accent")).toBe("moss");

    const failure = new Error("配置文件被占用");
    vi.mocked(persist).mockRejectedValueOnce(failure);
    let caught: unknown;
    await act(async () => {
      await api.setAppearance({ accent: "amethyst", mode: "night" }).catch((e: unknown) => {
        caught = e;
      });
    });
    expect(caught).toBe(failure);
    expect(html.getAttribute("data-sk-accent")).toBe("moss");
    expect(html.getAttribute("data-sk-mode")).toBe("day");
    expect(api.appearance).toEqual({ ...DEFAULT_APPEARANCE, accent: "moss" });
  });

  it("连续切换：只有最后一次请求决定界面，早到或晚到的旧结果都不改回去", async () => {
    stubMatchMedia(false);
    const first = deferred<AppearanceDto>();
    const second = deferred<AppearanceDto>();
    vi.mocked(persist).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount();
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = api.setAppearance({ accent: "amethyst" });
    });
    act(() => {
      p2 = api.setAppearance({ accent: "moss" });
    });
    expect(html.getAttribute("data-sk-accent")).toBe("moss");
    await act(async () => {
      second.resolve({ ...DAY_DTO, accent: "moss" });
      await p2;
    });
    await act(async () => {
      first.resolve({ ...DAY_DTO, accent: "amethyst" });
      await p1;
    });
    expect(html.getAttribute("data-sk-accent")).toBe("moss");
    expect(api.appearance.accent).toBe("moss");
  });

  it("旧请求失败时新请求仍在途，不回滚新请求的乐观值", async () => {
    stubMatchMedia(false);
    const first = deferred<AppearanceDto>();
    const second = deferred<AppearanceDto>();
    vi.mocked(persist).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mount();
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = api.setAppearance({ mode: "night" });
      p2 = api.setAppearance({ accent: "moss" });
    });
    const failure = new Error("写入失败");
    await act(async () => {
      first.reject(failure);
      await expect(p1).rejects.toBe(failure);
    });
    expect(html.getAttribute("data-sk-mode")).toBe("night");
    expect(html.getAttribute("data-sk-accent")).toBe("moss");
    await act(async () => {
      second.resolve({ ...DAY_DTO, mode: "night", accent: "moss" });
      await p2;
    });
    expect(api.appearance).toEqual({ ...DEFAULT_APPEARANCE, mode: "night", accent: "moss" });
  });

  it("非法补丁在发请求之前抛错，界面不动", async () => {
    stubMatchMedia(false);
    mount();
    await expect(api.setAppearance({ mode: "dusk" as never })).rejects.toThrow("未知的外观明暗：dusk");
    expect(persist).not.toHaveBeenCalled();
    expect(html.getAttribute("data-sk-mode")).toBe("day");
  });

  it("系统减少动画偏好变化时实时跟随，卸载后退订", () => {
    const media = stubMatchMedia(false);
    mount();
    expect(api.reduced).toBe(false);
    media.set(true);
    expect(api.reduced).toBe(true);
    expect(html.hasAttribute("data-sk-reduced")).toBe(true);
    media.set(false);
    expect(html.hasAttribute("data-sk-reduced")).toBe(false);
    expect(media.listenerCount()).toBe(1);
    view?.unmount();
    view = undefined;
    expect(media.listenerCount()).toBe(0);
  });

  it("应用设置开启减少动画时，系统偏好关闭也保持减少", async () => {
    const media = stubMatchMedia(false);
    vi.mocked(persist).mockImplementationOnce(backendMerging(DAY_DTO));
    mount();
    await act(() => api.setAppearance({ reduceMotion: true }));
    expect(html.hasAttribute("data-sk-reduced")).toBe(true);
    media.set(false);
    expect(html.hasAttribute("data-sk-reduced")).toBe(true);
    expect(api.reduced).toBe(true);
  });
});
