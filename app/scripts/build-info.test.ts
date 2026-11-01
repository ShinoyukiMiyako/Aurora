import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTime, readBuildInfo, releaseChannel } from "./build-info.mjs";

describe("发布通道", () => {
  it("没有预发布标识：0.x 算预览版，1.0 起为正式版；构建元数据不影响通道", () => {
    expect(releaseChannel("0.1.0")).toBe("preview");
    expect(releaseChannel("0.99.12")).toBe("preview");
    expect(releaseChannel("1.0.0")).toBe("stable");
    expect(releaseChannel("12.3.4")).toBe("stable");
    expect(releaseChannel("1.0.0+build.7")).toBe("stable");
    expect(releaseChannel("0.9.0+20261031")).toBe("preview");
  });

  it("预发布标识只看第一段，不分大小写，可带序号", () => {
    expect(releaseChannel("1.0.0-beta")).toBe("beta");
    expect(releaseChannel("2.3.4-beta.1")).toBe("beta");
    expect(releaseChannel("1.0.0-RC2")).toBe("beta");
    expect(releaseChannel("1.0.0-alpha.3")).toBe("preview");
    expect(releaseChannel("1.0.0-Preview")).toBe("preview");
    expect(releaseChannel("1.1.0-nightly.20261031")).toBe("preview");
    expect(releaseChannel("0.2.0-dev")).toBe("preview");
  });

  it("认不出的预发布标识与不合语义化版本的写法直接报错", () => {
    expect(() => releaseChannel("1.0.0-foo")).toThrow("预发布标识「foo」不对应任何发布通道");
    expect(() => releaseChannel("1.0.0-betaish")).toThrow("预发布标识「betaish」");
    expect(() => releaseChannel("1.0")).toThrow("不是语义化版本");
    expect(() => releaseChannel("v1.0.0")).toThrow("不是语义化版本");
    expect(() => releaseChannel("")).toThrow("不是语义化版本");
  });
});

describe("构建时间", () => {
  const now = new Date("2026-10-31T08:15:30.000Z");

  it("没设 SOURCE_DATE_EPOCH（或设成空串）取当前时间", () => {
    expect(buildTime({}, now)).toBe("2026-10-31T08:15:30.000Z");
    expect(buildTime({ SOURCE_DATE_EPOCH: "" }, now)).toBe("2026-10-31T08:15:30.000Z");
  });

  it("设了 SOURCE_DATE_EPOCH 按秒换算，与当前时间无关", () => {
    expect(buildTime({ SOURCE_DATE_EPOCH: "0" }, now)).toBe("1970-01-01T00:00:00.000Z");
    expect(buildTime({ SOURCE_DATE_EPOCH: "1761900000" }, now)).toBe("2025-10-31T08:40:00.000Z");
    for (let i = 0; i < 20; i++) {
      const seconds = Math.floor(Math.random() * 4_000_000_000);
      expect(buildTime({ SOURCE_DATE_EPOCH: String(seconds) }, now)).toBe(new Date(seconds * 1000).toISOString());
    }
  });

  it("SOURCE_DATE_EPOCH 不是整数秒时报错，不悄悄退回当前时间", () => {
    expect(() => buildTime({ SOURCE_DATE_EPOCH: "1761900000.5" }, now)).toThrow("不是以秒计的整数时间戳");
    expect(() => buildTime({ SOURCE_DATE_EPOCH: "-1" }, now)).toThrow("不是以秒计的整数时间戳");
    expect(() => buildTime({ SOURCE_DATE_EPOCH: "2026-10-31" }, now)).toThrow("不是以秒计的整数时间戳");
  });
});

describe("读取构建信息", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const conf = (body: unknown) => {
    dir = mkdtempSync(join(tmpdir(), "pf-build-info-"));
    const path = join(dir, "tauri.conf.json");
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  it("版本号取自 tauri.conf.json，通道由它推出", () => {
    const tauriConfPath = conf({ productName: "x", version: "1.2.0-beta.2" });
    expect(readBuildInfo({ tauriConfPath, env: { SOURCE_DATE_EPOCH: "1761900000" }, now: new Date(0) })).toEqual({
      version: "1.2.0-beta.2",
      channel: "beta",
      builtAt: "2025-10-31T08:40:00.000Z",
    });
  });

  it("tauri.conf.json 没写 version 时报错", () => {
    const tauriConfPath = conf({ productName: "x" });
    expect(() => readBuildInfo({ tauriConfPath, env: {}, now: new Date(0) })).toThrow("没有写 version");
  });
});
