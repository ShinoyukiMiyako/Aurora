import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTime, readBuildInfo, releaseChannel } from "./build-info.mjs";

describe("发布通道", () => {
  it("没有预发布标识都算正式版，主版本为 0 的也一样；构建元数据不影响通道", () => {
    expect(releaseChannel("0.99.12")).toBe("stable");
    expect(releaseChannel("1.0.0")).toBe("stable");
    expect(releaseChannel("12.3.4")).toBe("stable");
    expect(releaseChannel("1.0.0+build.7")).toBe("stable");
    expect(releaseChannel("0.9.0+20261031")).toBe("stable");
  });

  it("0.1.0 与 1.0.0 一样算正式版，不再按主版本为 0 算预览版", () => {
    expect(releaseChannel("0.1.0")).toBe("stable");
    expect(releaseChannel("0.1.0")).toBe(releaseChannel("1.0.0"));
  });

  it("预发布标识只看第一段，不分大小写，可带序号", () => {
    expect(releaseChannel("1.0.0-beta")).toBe("beta");
    expect(releaseChannel("2.3.4-beta.1")).toBe("beta");
    expect(releaseChannel("1.0.0-BETA2")).toBe("beta");
    expect(releaseChannel("0.2.0-dev")).toBe("preview");
    expect(releaseChannel("0.1.0-Dev.38")).toBe("preview");
    expect(releaseChannel("0.1.0-dev7.1")).toBe("preview");
  });

  // 启动器只给 dev、beta 两种预发布标识配了清单，别的标识它判为不支持自更新，这里同样不认
  it("认不出的预发布标识与不合语义化版本的写法直接报错", () => {
    for (const tag of ["rc", "RC2", "alpha", "preview", "nightly", "devel", "betax"]) {
      expect(() => releaseChannel(`1.0.0-${tag}.1`)).toThrow(`预发布标识「${tag.toLowerCase()}」不对应任何发布通道`);
    }
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

  // 同一用例可以写几份配置，都落在这一个临时目录里，用例结束一起删。
  const conf = (body: unknown, name = "tauri.conf.json") => {
    dir ??= mkdtempSync(join(tmpdir(), "pf-build-info-"));
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };

  it("官方构建：版本号取自 tauri.conf.json，通道由它推出", () => {
    const tauriConfPath = conf({ productName: "x", version: "1.2.0-beta.2" });
    expect(readBuildInfo({ tauriConfPath, env: { SOURCE_DATE_EPOCH: "1761900000", PETALFALL_OFFICIAL_BUILD: "1" }, now: new Date(0) })).toEqual({
      version: "1.2.0-beta.2",
      channel: "beta",
      builtAt: "2025-10-31T08:40:00.000Z",
    });
  });

  it("没设 PETALFALL_OFFICIAL_BUILD 时通道为 local，版本号与构建时间照旧", () => {
    for (const version of ["1.0.0", "0.1.0", "1.2.0-beta.2", "1.0.0-dev.42"]) {
      const tauriConfPath = conf({ version }, `${version}.json`);
      expect(readBuildInfo({ tauriConfPath, env: { SOURCE_DATE_EPOCH: "1761900000" }, now: new Date(0) })).toEqual({
        version,
        channel: "local",
        builtAt: "2025-10-31T08:40:00.000Z",
      });
    }
  });

  it("PETALFALL_OFFICIAL_BUILD 设了就算，取值不论，空串也算", () => {
    const stable = conf({ version: "1.0.0" }, "stable.json");
    const preview = conf({ version: "1.1.0-dev.7" }, "preview.json");
    for (const flag of ["", " ", "0", "false", "1"]) {
      const env = { PETALFALL_OFFICIAL_BUILD: flag };
      expect(readBuildInfo({ tauriConfPath: stable, env, now: new Date(0) }).channel, JSON.stringify(flag)).toBe("stable");
      expect(readBuildInfo({ tauriConfPath: preview, env, now: new Date(0) }).channel, JSON.stringify(flag)).toBe("preview");
    }
  });

  it("认不出的预发布标识不论是不是官方构建都让构建停下", () => {
    const tauriConfPath = conf({ version: "1.0.0-rc.1" });
    expect(() => readBuildInfo({ tauriConfPath, env: {}, now: new Date(0) })).toThrow("预发布标识「rc」不对应任何发布通道");
    expect(() => readBuildInfo({ tauriConfPath, env: { PETALFALL_OFFICIAL_BUILD: "1" }, now: new Date(0) })).toThrow("预发布标识「rc」不对应任何发布通道");
  });

  // 与启动器、发布流水线共用一份通道向量：各处各写各的用例时，规则分了岔两边的测试也能同时通过。
  it("官方构建的通道与共用版本向量逐条一致：向量里的 dev 在这里叫 preview，认不出通道的直接报错", () => {
    const vectors = JSON.parse(readFileSync(new URL("../../crates/petalfall-release/testdata/version-order.json", import.meta.url), "utf8")) as {
      channel: { version: string; channel: "dev" | "beta" | "stable" | null }[];
    };
    const names = { dev: "preview", beta: "beta", stable: "stable" } as const;
    expect(new Set(vectors.channel.map((entry) => entry.channel))).toEqual(new Set(["dev", "beta", "stable", null]));
    vectors.channel.forEach((entry, i) => {
      const tauriConfPath = conf({ version: entry.version }, `vector-${i}.json`);
      const read = () => readBuildInfo({ tauriConfPath, env: { PETALFALL_OFFICIAL_BUILD: "1" }, now: new Date(0) });
      if (entry.channel === null) expect(read, entry.version).toThrow("不对应任何发布通道");
      else expect(read().channel, entry.version).toBe(names[entry.channel]);
    });
  });

  it("tauri.conf.json 没写 version 时报错", () => {
    const tauriConfPath = conf({ productName: "x" });
    expect(() => readBuildInfo({ tauriConfPath, env: {}, now: new Date(0) })).toThrow("没有写 version");
  });
});
