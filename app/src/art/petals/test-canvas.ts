// 花瓣测试共用的 Canvas 替身：jsdom 没有 2D 上下文，也不解析 CSS 变量。
// 只被 *.test.ts(x) 引用。

import { vi } from "vitest";
import { stubCanvas as stubBitmapCanvas } from "../illustrations/test-canvas";

export type CanvasOp =
  | { kind: "clear"; width: number; height: number }
  | { kind: "alpha"; value: number }
  | { kind: "draw"; transform: number[]; width: number; height: number; x: number; y: number; alpha: number };

/** 记录绘制调用的 2D 上下文。 */
export class FakeContext {
  readonly ops: CanvasOp[] = [];
  imageSmoothingEnabled = false;
  private transform = [1, 0, 0, 1, 0, 0];
  private alpha = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  get globalAlpha(): number {
    return this.alpha;
  }

  set globalAlpha(value: number) {
    this.alpha = value;
    this.ops.push({ kind: "alpha", value });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f];
  }

  clearRect(): void {
    this.ops.push({ kind: "clear", width: this.canvas.width, height: this.canvas.height });
  }

  drawImage(image: HTMLCanvasElement, x: number, y: number): void {
    this.ops.push({ kind: "draw", transform: [...this.transform], width: image.width, height: image.height, x, y, alpha: this.alpha });
  }

  createImageData(width: number, height: number): { width: number; height: number; data: Uint8ClampedArray } {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  putImageData(): void {}

  /** 按 clear 切分出每一帧，每帧再按 alpha 切分出各层的绘制。 */
  frames(): { alphas: number[]; draws: Extract<CanvasOp, { kind: "draw" }>[] }[] {
    const frames: { alphas: number[]; draws: Extract<CanvasOp, { kind: "draw" }>[] }[] = [];
    for (const op of this.ops) {
      if (op.kind === "clear") frames.push({ alphas: [], draws: [] });
      else if (op.kind === "alpha") frames[frames.length - 1].alphas.push(op.value);
      else frames[frames.length - 1].draws.push(op);
    }
    return frames;
  }
}

/** 替换 getContext：每块画布一个 FakeContext；返回画布到上下文的表与精灵画布计数。 */
export function stubCanvas(): { contextOf(canvas: HTMLCanvasElement): FakeContext; created(): number } {
  // 花瓣和徽记同框：徽记的位图走 OffscreenCanvas，这里只接管页面上的画布
  stubBitmapCanvas();
  const contexts = new Map<HTMLCanvasElement, FakeContext>();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = new FakeContext(this);
      contexts.set(this, ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  });
  return {
    contextOf(canvas) {
      const ctx = contexts.get(canvas);
      if (!ctx) throw new Error("这块画布还没有取过上下文");
      return ctx;
    },
    created: () => contexts.size,
  };
}

/**
 * 画布上的花瓣色令牌一律视为已声明，第 i 阶解析成 color(srgb 0.9 g 0.8)，g 随阶位递减，可据此核对取色。
 * 只拦截画布元素（引擎用画布本身做取色探针），其余元素交还真实实现。返回读取次数，用来判断是否重建了精灵。
 */
export function stubPetalTokens(): { reads(): number } {
  const real = window.getComputedStyle.bind(window);
  let reads = 0;
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    if (!(el instanceof HTMLCanvasElement)) return real(el, pseudo);
    const m = /--sk-petal-(\d)/.exec(el.style.color);
    if (m) reads++;
    const shade = m ? Number(m[1]) : 0;
    return {
      color: `color(srgb 0.9 ${0.8 - shade * 0.1} 0.8)`,
      getPropertyValue: (name: string) => (name.startsWith("--sk-petal-") ? "color-mix(in srgb, var(--sk-accent) 24%, white)" : ""),
    } as unknown as CSSStyleDeclaration;
  });
  return { reads: () => reads };
}

export interface ManualFrames {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
  /** 依次执行当前排队的回调。 */
  run(now: number): void;
  pending(): number;
  cancelled(): number[];
}

export function manualFrames(): ManualFrames {
  const queue = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  let next = 1;
  return {
    request(callback) {
      const id = next++;
      queue.set(id, callback);
      return id;
    },
    cancel(id) {
      cancelled.push(id);
      queue.delete(id);
    },
    run(now) {
      const due = [...queue.values()];
      queue.clear();
      for (const callback of due) callback(now);
    },
    pending: () => queue.size,
    cancelled: () => [...cancelled],
  };
}
