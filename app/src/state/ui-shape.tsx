// 界面形状的缓存（ipc/ui-shape）接进 React：首帧前由 loadUiShape 与外观并行读出，经 UiShapeProvider 往下发；
// 页面在数据落定（读完、没出错）之后用 report 报这次的真实形状，下次启动首帧就按它占位，而不是先画一种形状、
// 数据到了再变成另一种。
//
// 写回是后台的事：变化攒 UI_SHAPE_WRITE_DELAY_MS 合并成一次写入，与已写进配置的值相同就不写。写不进去只记诊断日志，
// 不打扰玩家，已知值不前进，下次形状变化时再写。退出前最后一刻的变化可能来不及写，下次启动的占位差一点，读完数据就改过来。

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { logDiagnostic } from "../ipc/diagnostics";
import { getUiShape, RECENT_CARDS_MAX, setUiShape, type UiShapeDto, type UiShapePatchDto } from "../ipc/ui-shape";
import { describeError } from "./errors";

export { RECENT_CARDS_MAX };

export interface UiShape {
  /** 最近游玩按最宽一档列出的张数。各档显示时再按自己的上限截。 */
  recentCards: number;
  /** 实例库有没有修复横幅。 */
  repairBanner: boolean;
}

/** 没记过（旧配置没有这个键）时的形状，与后端的缺省值一致。 */
export const DEFAULT_UI_SHAPE: UiShape = { recentCards: 0, repairBanner: false };

/** 攒多久再写：同一轮读取里形状可能接连变几次（实例列表到了，设置随后到了），只写最后一次。 */
export const UI_SHAPE_WRITE_DELAY_MS = 1000;

function assertRecentCards(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > RECENT_CARDS_MAX) {
    throw new Error(`界面形状的 recent_cards 应为 0 到 ${RECENT_CARDS_MAX} 的整数，实为 ${String(value)}`);
  }
  return value;
}

function assertRepairBanner(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`界面形状的 repair_banner 应为布尔值，实为 ${String(value)}`);
  return value;
}

export function uiShapeFromDto(dto: UiShapeDto): UiShape {
  return { recentCards: assertRecentCards(dto.recent_cards), repairBanner: assertRepairBanner(dto.repair_banner) };
}

/** 校验并转成后端补丁；只写出出现的字段。 */
export function uiShapePatchToDto(patch: Partial<UiShape>): UiShapePatchDto {
  const dto: UiShapePatchDto = {};
  if ("recentCards" in patch) dto.recent_cards = assertRecentCards(patch.recentCards);
  if ("repairBanner" in patch) dto.repair_banner = assertRepairBanner(patch.repairBanner);
  return dto;
}

/** 首帧前读取；读取失败或取值不合法直接抛出，由启动流程显示错误页。 */
export async function loadUiShape(): Promise<UiShape> {
  return uiShapeFromDto(await getUiShape());
}

/** shape 里与 base 不同的字段；都相同时为 null。 */
function changedFields(shape: UiShape, base: UiShape): Partial<UiShape> | null {
  const patch: Partial<UiShape> = {};
  if (shape.recentCards !== base.recentCards) patch.recentCards = shape.recentCards;
  if (shape.repairBanner !== base.repairBanner) patch.repairBanner = shape.repairBanner;
  return Object.keys(patch).length === 0 ? null : patch;
}

/** 攒批、比对与串行写入，与 React 解耦：Provider 只负责挂上、卸下。 */
class ShapeWriter {
  /** 这次运行里最近一次报上来的形状。 */
  private latest: UiShape;
  /** 已写进配置的形状：启动时读到的值，之后是每次写成功后后端返回的值。 */
  private saved: UiShape;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 写入排成一条链：前一次没回来时后一次等着，比对用的已知值才是最新的。链上的每一步都不会失败。 */
  private writes: Promise<void> = Promise.resolve();
  private active = true;

  constructor(
    initial: UiShape,
    private readonly show: (shape: UiShape) => void,
  ) {
    this.latest = initial;
    this.saved = initial;
  }

  readonly report = (patch: Partial<UiShape>): void => {
    uiShapePatchToDto(patch);
    const next = { ...this.latest, ...patch };
    if (changedFields(next, this.latest) === null) return;
    this.latest = next;
    this.show(next);
    if (changedFields(next, this.saved) === null) this.cancel();
    else this.schedule();
  };

  /** 挂上（含严格模式卸下后的重挂）：卸下时撤掉的那次写入重新排上。 */
  resume(): void {
    this.active = true;
    if (this.timer === null && changedFields(this.latest, this.saved) !== null) this.schedule();
  }

  pause(): void {
    this.active = false;
    this.cancel();
  }

  private schedule(): void {
    this.cancel();
    this.timer = setTimeout(this.flush, UI_SHAPE_WRITE_DELAY_MS);
  }

  private cancel(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private readonly flush = (): void => {
    this.timer = null;
    this.writes = this.writes.then(() => this.write());
  };

  private async write(): Promise<void> {
    const patch = changedFields(this.latest, this.saved);
    if (patch === null) return;
    const dto = uiShapePatchToDto(patch);
    try {
      this.saved = uiShapeFromDto(await setUiShape(dto));
    } catch (error) {
      // 后台缓存，这里就是最外层：不弹通知，只记一笔；日志也写不进去时只能留在控制台
      await logDiagnostic("warn", "界面形状没有写进配置", { patch: dto, error: describeError(error) }).catch((logError: unknown) =>
        console.error("界面形状没有写进配置，诊断日志也没写进去", error, logError),
      );
      return;
    }
    // 在途期间形状又变回了写入之前的值：report 当时比对的是旧的已知值、没有排下一次，这里补上
    if (this.active && this.timer === null && changedFields(this.latest, this.saved) !== null) this.schedule();
  }
}

export interface UiShapeApi {
  /** 这次运行里最近一次知道的形状：启动时是上次记下的，数据落定后换成这次的。占位只读它，不自己测量。 */
  shape: UiShape;
  /** 数据落定之后报这次的真实形状（只带变了的字段也行）。加载中与读取失败时不要报，免得把失败记成「没有」。 */
  report(patch: Partial<UiShape>): void;
}

const UiShapeContext = createContext<UiShapeApi | null>(null);

export function useUiShape(): UiShapeApi {
  const api = useContext(UiShapeContext);
  if (!api) throw new Error("useUiShape 必须在 UiShapeProvider 之内使用");
  return api;
}

export interface UiShapeProviderProps {
  /** 首帧前由 loadUiShape 读到的值，同时视为已写进配置的值。 */
  initial: UiShape;
  children: ReactNode;
}

export function UiShapeProvider({ initial, children }: UiShapeProviderProps) {
  const [shape, setShape] = useState(initial);
  const [writer] = useState(() => new ShapeWriter(initial, setShape));
  useEffect(() => {
    writer.resume();
    return () => writer.pause();
  }, [writer]);
  const api = useMemo<UiShapeApi>(() => ({ shape, report: writer.report }), [shape, writer]);
  return <UiShapeContext.Provider value={api}>{children}</UiShapeContext.Provider>;
}
