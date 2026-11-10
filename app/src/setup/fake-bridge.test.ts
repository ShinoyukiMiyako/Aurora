import { describe, expect, it } from "vitest";
import { APP_NAME_EN } from "../lib/app-info";
import type { Channel, DataBlock, Existing, ExistingKind, InstallMode, Probe } from "./contract";
import { FAKE_PROBE, createFakeBridge, fakeFromQuery, judgedProbe } from "./fake-bridge";
import { initialState, reduce } from "./model";

const EXISTING_DIR = `E:\\${APP_NAME_EN}`;
const STAMP = `${EXISTING_DIR}\\data-format.json`;

function blockOf(data: "newer" | "newer_unnamed" | "unreadable", path: string): DataBlock {
  const blocks: Readonly<Record<typeof data, DataBlock>> = {
    newer: { problem: "too_new", path, recorded: 2, supported: 1, reason: null, writtenBy: "1.1.0-dev.61", writtenByChannel: "dev" },
    newer_unnamed: { problem: "too_new", path, recorded: 2, supported: 1, reason: null, writtenBy: null, writtenByChannel: null },
    unreadable: { problem: "unreadable", path, recorded: null, supported: 1, reason: "缺 data_format", writtenBy: null, writtenByChannel: null },
  };
  return blocks[data];
}

describe("fakeFromQuery", () => {
  it("默认从 boot 开始，让 App 真的走一遍探测", () => {
    const fake = fakeFromQuery("");
    expect(fake.initial.view).toBe("boot");
    expect(fake.lang).toBeNull();
  });

  it.each([
    ["location", "location"],
    ["blocked", "blocked"],
    ["installing", "installing"],
    ["slow", "installing"],
    ["done", "done"],
    ["failed", "failed"],
    ["legal", "legal"],
    ["fatal", "fatal"],
  ])("?state=%s 直达 %s 视图", (state, view) => {
    expect(fakeFromQuery(`?state=${state}`).initial.view).toBe(view);
  });

  it.each(["upgrade", "same", "newer", "broken", "switch"])("?state=installed&kind=%s 让探测带上这种现有安装", async (kind) => {
    const fake = fakeFromQuery(`?state=installed&kind=${kind}`);
    expect(fake.initial.view).toBe("boot");
    expect((await fake.bridge.probe()).existing?.kind).toBe(kind);
  });

  it("?code= 选失败原因，退出码是可显示的数字", () => {
    expect(fakeFromQuery("?state=failed&code=disk_full").initial.failure?.code).toBe("disk_full");
    expect(fakeFromQuery("?state=failed").initial.failure).toEqual({ code: "payload_exit", detail: "2" });
  });

  it("?mode= 选安装种类，升级和修复都不带目录", () => {
    expect(fakeFromQuery("?state=done&mode=upgrade").initial.plan).toEqual({ mode: "upgrade", dir: null, desktopShortcut: false });
    expect(fakeFromQuery("?state=installing&mode=repair").initial.plan).toEqual({ mode: "repair", dir: null, desktopShortcut: false });
  });

  it.each(["installing", "slow", "done", "failed"])("?state=%s&mode=switch：计划是 switch，探测是交互的换到更慢通道", (state) => {
    const fake = fakeFromQuery(`?state=${state}&mode=switch`);
    expect(fake.initial.plan).toEqual({ mode: "switch", dir: null, desktopShortcut: false });
    expect(fake.initial.probe?.existing).toEqual<Existing>({ kind: "switch", version: "1.1.0-dev.61", dir: EXISTING_DIR, channel: "dev" });
    expect(fake.initial.probe?.payloadChannel).toBe("beta");
    expect(fake.initial.probe?.handoff).toBe(true);
  });

  it("?state=blocked&mode=switch：启动器开着，按 switch 等它关", async () => {
    const fake = fakeFromQuery("?state=blocked&mode=switch");
    expect(fake.initial.view).toBe("blocked");
    expect(fake.initial.plan?.mode).toBe("switch");
    await expect(fake.bridge.launcherRunning()).resolves.toBe(true);
  });

  it("?mode=upgrade&cross=faster 走到完成页：按 upgrade 装，会写交接记录；cross=slower 不写", () => {
    const faster = fakeFromQuery("?state=done&mode=upgrade&cross=faster").initial;
    expect(faster.plan?.mode).toBe("upgrade");
    expect(faster.probe?.handoff).toBe(true);
    expect(faster.probe?.payloadChannel).toBe("dev");
    expect(fakeFromQuery("?state=done&mode=upgrade&cross=slower").initial.probe?.handoff).toBe(false);
  });

  it("?lang= 原样带出，?elevated 与 ?interrupted 进探测结果", async () => {
    const fake = fakeFromQuery("?lang=en&elevated=1&interrupted=1");
    expect(fake.lang).toBe("en");
    const probe = await fake.bridge.probe();
    expect(probe.elevated).toBe(true);
    expect(probe.interrupted).toBe(true);
  });

  it("写错状态名时抛错，不悄悄落到默认状态", () => {
    expect(() => fakeFromQuery("?state=nope")).toThrow("不是");
  });

  it("blocked 状态下启动器开着，别的状态没开", async () => {
    await expect(fakeFromQuery("?state=blocked").bridge.launcherRunning()).resolves.toBe(true);
    await expect(fakeFromQuery("?state=done").bridge.launcherRunning()).resolves.toBe(false);
  });

  it("不写 ?update 时是交互启动", async () => {
    expect((await fakeFromQuery("").bridge.probe()).update).toBeNull();
    expect((await fakeFromQuery("?state=installed&kind=upgrade").bridge.probe()).update).toBeNull();
  });

  it("?update 从 boot 开始，探测带上 /R 和能无人值守升级的现有安装，启动器没开，安装会真的成功", async () => {
    const fake = fakeFromQuery("?update");
    expect(fake.initial.view).toBe("boot");
    const probe = await fake.bridge.probe();
    expect(probe.update).toEqual({ relaunch: true });
    expect(probe.existing?.kind).toBe("upgrade");
    expect(probe.unattended).toBe("upgrade");
    await expect(fake.bridge.launcherRunning()).resolves.toBe(false);
    expect(fake.bridge.scenario.outcome).toBe("ok");
  });

  it("?norelaunch 是没带 /R，?elevated 照常进探测结果，?kind= 换现有安装看退回交互流程", async () => {
    const probe = await fakeFromQuery("?update&norelaunch&elevated=1&kind=same").bridge.probe();
    expect(probe.update).toEqual({ relaunch: false });
    expect(probe.elevated).toBe(true);
    expect(probe.existing?.kind).toBe("same");
    expect(probe.unattended).toBeNull();
  });

  it("?update&state=blocked 时启动器一直开着，state=failed 时按 ?code= 装失败，都从 boot 开始", async () => {
    const blocked = fakeFromQuery("?update&state=blocked");
    expect(blocked.initial.view).toBe("boot");
    await expect(blocked.bridge.launcherRunning()).resolves.toBe(true);
    const failed = fakeFromQuery("?update&state=failed&code=disk_full");
    expect(failed.initial.view).toBe("boot");
    expect(failed.bridge.scenario.outcome).toEqual({ code: "disk_full", detail: "os error 112" });
  });

  it("?update&switch 从 boot 开始，无人值守换通道、带 /R，安装会真的成功；blocked、failed 同样可用", async () => {
    const fake = fakeFromQuery("?update&switch");
    expect(fake.initial.view).toBe("boot");
    const probe = await fake.bridge.probe();
    expect(probe.update).toEqual({ relaunch: true });
    expect(probe.unattended).toBe("switch");
    expect(fake.bridge.scenario.outcome).toBe("ok");
    await expect(fakeFromQuery("?update&switch&state=blocked").bridge.launcherRunning()).resolves.toBe(true);
    expect(fakeFromQuery("?update&switch&state=failed&code=verify_failed").bridge.scenario.outcome).toEqual({ code: "verify_failed", detail: "uninstall.exe missing" });
  });

  it.each(["done", "installed", "location"])("?update 配 ?state=%s 时抛错：更新模式不能直达别的视图", (state) => {
    expect(() => fakeFromQuery(`?update&state=${state}`)).toThrow("?update 从 boot 开始走");
  });

  it.each([
    ["?switch", "?switch 是换通道开关，只跟着 ?update 用"],
    ["?state=installed&kind=same&cross=faster", "?cross= 只配升级，这里的现有安装是 same"],
    ["?state=installed&kind=upgrade&reason=faster", "?reason= 只配 newer，这里的现有安装是 upgrade"],
    ["?cross=faster", "?cross=、?reason= 要有现有安装"],
    ["?state=installing&reason=same", "?cross=、?reason= 要有现有安装"],
    ["?update&kind=switch", "不带开关的更新模式遇到更慢通道上更早的包判 newer"],
    ["?update&switch&kind=newer&reason=slower", "带开关的更新模式遇到更慢通道上更早的包判 switch"],
    ["?state=installed&kind=newer&reason=slower", "交互启动遇到更慢通道上更早的包判 switch"],
    ["?state=done&mode=upgrade&data=newer", "这组参数走不到 ?state=done，停在了 installed"],
    ["?state=installing&data=unreadable", "这组参数走不到 ?state=installing，停在了 location"],
    ["?state=location&mode=upgrade", "这组参数走不到 ?state=location，停在了 installed"],
    ["?update&kind=same&state=blocked", "?update&state=blocked 要后端判定能无人值守装"],
    ["?update&data=newer&state=failed", "?update&state=failed 要后端判定能无人值守装"],
    ["?state=installed&data=nope", "查询参数 nope 不是"],
    ["?state=installed&cross=sideways", "查询参数 sideways 不是"],
    ["?state=installed&kind=newer&reason=later", "查询参数 later 不是"],
  ])("%s 凑不成后端给得出的组合，抛错：%s", (search, message) => {
    expect(() => fakeFromQuery(search)).toThrow(message);
  });
});

describe("新情形的探测结果", () => {
  type Judged = Pick<Probe, "payloadVersion" | "payloadChannel" | "newerReason" | "allowedModes" | "unattended" | "handoff" | "dataBlock"> & {
    existing: Pick<Existing, "kind" | "version" | "channel">;
  };

  it.each<[string, string, Judged]>([
    [
      "交互的换到更慢通道",
      "?state=installed&kind=switch",
      { existing: { kind: "switch", version: "1.1.0-dev.61", channel: "dev" }, payloadVersion: "1.0.0-beta.5", payloadChannel: "beta", newerReason: null, allowedModes: ["switch"], unattended: null, handoff: true, dataBlock: null },
    ],
    [
      "换到更快的通道",
      "?state=installed&cross=faster",
      { existing: { kind: "upgrade", version: "1.0.0-beta.3", channel: "beta" }, payloadVersion: "1.0.0-dev.60", payloadChannel: "dev", newerReason: null, allowedModes: ["upgrade"], unattended: null, handoff: true, dataBlock: null },
    ],
    [
      "升到更慢通道上更新的版本",
      "?state=installed&cross=slower",
      { existing: { kind: "upgrade", version: "1.0.0-beta.4", channel: "beta" }, payloadVersion: "1.0.0", payloadChannel: "stable", newerReason: null, allowedModes: ["upgrade"], unattended: null, handoff: false, dataBlock: null },
    ],
    [
      "newer 不写原因时是同通道",
      "?state=installed&kind=newer",
      { existing: { kind: "newer", version: "0.3.0", channel: "stable" }, payloadVersion: "0.2.0", payloadChannel: "stable", newerReason: "same_channel", allowedModes: [], unattended: null, handoff: false, dataBlock: null },
    ],
    [
      "newer 同通道",
      "?state=installed&kind=newer&reason=same",
      { existing: { kind: "newer", version: "0.3.0", channel: "stable" }, payloadVersion: "0.2.0", payloadChannel: "stable", newerReason: "same_channel", allowedModes: [], unattended: null, handoff: false, dataBlock: null },
    ],
    [
      "newer 安装包在更快通道",
      "?state=installed&kind=newer&reason=faster",
      { existing: { kind: "newer", version: "1.0.0", channel: "stable" }, payloadVersion: "1.0.0-beta.4", payloadChannel: "beta", newerReason: "faster_channel", allowedModes: [], unattended: null, handoff: false, dataBlock: null },
    ],
    [
      "newer 不带开关的更新模式遇到更慢通道",
      "?update&kind=newer&reason=slower",
      { existing: { kind: "newer", version: "1.1.0-dev.61", channel: "dev" }, payloadVersion: "1.0.0-beta.5", payloadChannel: "beta", newerReason: "slower_channel", allowedModes: [], unattended: null, handoff: false, dataBlock: null },
    ],
    [
      "newer 认不出通道",
      "?state=installed&kind=newer&reason=unknown",
      { existing: { kind: "newer", version: "0.3.0-rc.1", channel: null }, payloadVersion: "0.2.0", payloadChannel: "stable", newerReason: "unknown_channel", allowedModes: [], unattended: null, handoff: false, dataBlock: null },
    ],
    [
      "带开关的更新模式",
      "?update&switch",
      { existing: { kind: "switch", version: "1.1.0-dev.61", channel: "dev" }, payloadVersion: "1.0.0-beta.5", payloadChannel: "beta", newerReason: null, allowedModes: ["switch"], unattended: "switch", handoff: false, dataBlock: null },
    ],
    [
      "带开关的更新模式遇到能升级的包，开关不起作用",
      "?update&switch&kind=upgrade",
      { existing: { kind: "upgrade", version: "0.1.0", channel: "stable" }, payloadVersion: "0.2.0", payloadChannel: "stable", newerReason: null, allowedModes: ["upgrade"], unattended: "upgrade", handoff: false, dataBlock: null },
    ],
    [
      "更新模式跟到更快通道，不写交接记录",
      "?update&cross=faster",
      { existing: { kind: "upgrade", version: "1.0.0-beta.3", channel: "beta" }, payloadVersion: "1.0.0-dev.60", payloadChannel: "dev", newerReason: null, allowedModes: ["upgrade"], unattended: "upgrade", handoff: false, dataBlock: null },
    ],
  ])("%s（%s）", async (_, search, expected) => {
    expect(await fakeFromQuery(search).bridge.probe()).toMatchObject(expected);
  });

  it.each(["newer", "newer_unnamed", "unreadable"] as const)("?data=%s 拦在现有安装的探测结果上：什么都不允许、不无人值守、不写交接记录", async (data) => {
    for (const search of [`?state=installed&data=${data}`, `?state=installed&kind=switch&data=${data}`, `?update&data=${data}`, `?update&switch&data=${data}`]) {
      expect(await fakeFromQuery(search).bridge.probe()).toMatchObject({ allowedModes: [], unattended: null, handoff: false, dataBlock: blockOf(data, STAMP) });
    }
    // newer 的原因与数据关无关，照样给
    expect(await fakeFromQuery(`?state=installed&kind=newer&reason=faster&data=${data}`).bridge.probe()).toMatchObject({ newerReason: "faster_channel", allowedModes: [], dataBlock: blockOf(data, STAMP) });
  });

  it.each(["newer", "newer_unnamed", "unreadable"] as const)("首装时 ?data=%s 拦在选目录上：探测不带拦截，目录校验报 data_incompatible 并带同形详情", async (data) => {
    const fake = fakeFromQuery(`?data=${data}`);
    const probe = await fake.bridge.probe();
    expect(probe.dataBlock).toBeNull();
    expect(probe.allowedModes).toEqual(["fresh"]);
    const dir = `D:\\游戏\\${APP_NAME_EN}`;
    const check = await fake.bridge.checkDir(dir);
    expect(check.issue).toBe("data_incompatible");
    expect(check.dataBlock).toEqual(blockOf(data, `${dir}\\data-format.json`));
    const empty = await fake.bridge.checkDir("");
    expect(empty.issue).toBe("empty");
    expect(empty.dataBlock).toBeNull();
    expect(fakeFromQuery(`?state=location&data=${data}`).initial.view).toBe("location");
  });

  it("不写 ?data= 时目录校验放行", async () => {
    const check = await fakeFromQuery("").bridge.checkDir("D:\\Games");
    expect(check.issue).toBeNull();
    expect(check.dataBlock).toBeNull();
  });
});

describe("各情形的探测结果自洽，状态机照单接收", () => {
  const VARIANTS: Readonly<Record<ExistingKind, readonly string[]>> = {
    upgrade: ["", "&cross=faster", "&cross=slower"],
    same: [""],
    broken: [""],
    switch: [""],
    newer: ["", "&reason=same", "&reason=faster", "&reason=slower", "&reason=unknown"],
  };
  const LAUNCHES = ["interactive", "update", "update_switch"] as const;
  const DATA = [null, "newer", "newer_unnamed", "unreadable"] as const;
  /** 后端判定表：数据放行时每种种类允许的模式。 */
  const MODE_OF: Readonly<Record<ExistingKind, InstallMode | null>> = { upgrade: "upgrade", same: "repair", broken: "repair", switch: "switch", newer: null };

  // 只排掉后端给不出的组合：switch 不出现在不带开关的更新模式，安装包更慢的 newer 只出现在不带开关的更新模式
  const CASES = (Object.keys(VARIANTS) as ExistingKind[]).flatMap((kind) =>
    VARIANTS[kind].flatMap((variant) =>
      LAUNCHES.filter((launch) => (kind === "switch" ? launch !== "update" : variant === "&reason=slower" ? launch === "update" : true)).flatMap((launch) =>
        DATA.map((data): [string, ExistingKind, string, (typeof LAUNCHES)[number], (typeof DATA)[number]] => {
          const head = launch === "interactive" ? "?state=installed" : launch === "update" ? "?update" : "?update&switch";
          return [`${head}&kind=${kind}${variant}${data === null ? "" : `&data=${data}`}`, kind, variant, launch, data];
        }),
      ),
    ),
  );

  it("组合数与预期一致", () => {
    // upgrade 3×3×4，same、broken 各 3×4，switch 2×4，newer 4×3×4 加 slower 1×4
    expect(CASES).toHaveLength(36 + 12 + 12 + 8 + 48 + 4);
  });

  it.each(CASES)("%s", async (search, kind, variant, launch, data) => {
    const probe = await fakeFromQuery(search).bridge.probe();
    const blocked = data !== null;
    const interactive = launch === "interactive";
    expect(probe.existing?.kind).toBe(kind);
    expect(probe.update === null).toBe(interactive);
    expect(probe.dataBlock === null).toBe(!blocked);
    expect(probe.newerReason === null).toBe(kind !== "newer");
    const mode = MODE_OF[kind];
    expect(probe.allowedModes).toEqual(blocked || mode === null ? [] : [mode]);
    expect(probe.unattended).toBe(blocked || interactive || (kind !== "upgrade" && kind !== "switch") ? null : mode);
    expect(probe.handoff).toBe(!blocked && interactive && (kind === "switch" || variant === "&cross=faster"));

    const state = reduce(initialState, { type: "probed", probe });
    expect(state.view).toBe(probe.unattended === null ? "installed" : "preparing");
  });
});

describe("judgedProbe", () => {
  const existing = (kind: ExistingKind, channel: Channel | null): Existing => ({ kind, version: "0.3.0", dir: EXISTING_DIR, channel });

  it("没有现有安装时只允许首装", () => {
    expect(judgedProbe(FAKE_PROBE)).toEqual(FAKE_PROBE);
  });

  it("首装的探测结果带了数据拦截时报错：那一关在选目录", () => {
    expect(() => judgedProbe({ ...FAKE_PROBE, dataBlock: blockOf("newer", STAMP) })).toThrow("首装的数据关在选目录时核");
  });

  it.each<[Channel | null, Channel | null]>([
    ["stable", "stable"],
    ["beta", "dev"],
    [null, "beta"],
    ["dev", null],
  ])("switch 而安装包不在更慢通道（已装 %s、安装包 %s）时报错", (installed, payload) => {
    expect(() => judgedProbe({ ...FAKE_PROBE, payloadChannel: payload, existing: existing("switch", installed) })).toThrow("switch 只出自安装包通道严格更慢的情形");
  });

  it("调用方带进来的判定项一律按表重算，不照抄", () => {
    const probe = judgedProbe({ ...FAKE_PROBE, allowedModes: ["fresh"], handoff: true, existing: existing("same", "stable") } as Probe);
    expect(probe.allowedModes).toEqual(["repair"]);
    expect(probe.handoff).toBe(false);
  });
});

describe("createFakeBridge", () => {
  it("记录调用和参数", async () => {
    const fake = createFakeBridge();
    await fake.checkDir("D:\\a");
    await fake.openLauncher("D:\\b");
    expect(fake.calls).toEqual([
      { name: "checkDir", args: ["D:\\a"] },
      { name: "openLauncher", args: ["D:\\b"] },
    ]);
    expect(fake.callsOf("openLauncher")).toEqual([["D:\\b"]]);
  });

  it("install 依次发进度，再按设定的结果结束", async () => {
    const failure = { code: "disk_full", detail: "x" } as const;
    const fake = createFakeBridge({ outcome: failure, progress: [{ phase: "unpack", percent: 5, slow: false }] });
    const seen: number[] = [];
    await fake.onProgress((p) => seen.push(p.percent));
    await expect(fake.install({ mode: "fresh", dir: "D:\\a", desktopShortcut: true })).rejects.toBe(failure);
    expect(seen).toEqual([5]);
  });

  it("关闭请求按注册的判断放行或拦下，退订后放行", async () => {
    const fake = createFakeBridge();
    expect(fake.requestClose()).toBe(true);
    const unlisten = await fake.onCloseRequested(() => false);
    expect(fake.requestClose()).toBe(false);
    unlisten();
    expect(fake.requestClose()).toBe(true);
  });

  it("默认探测是全新安装", async () => {
    await expect(createFakeBridge().probe()).resolves.toEqual(FAKE_PROBE);
    expect(FAKE_PROBE.existing).toBeNull();
  });
});
