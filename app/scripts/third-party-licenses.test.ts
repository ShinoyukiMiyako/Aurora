import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectCargoPackages, collectNpmPackages, distributionTarget, hostTarget, npmLicense } from "./third-party-licenses.mjs";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("npm 包的许可证写法", () => {
  it("SPDX 字符串、旧式 { type }、旧式 licenses 数组都认", () => {
    expect(npmLicense({ name: "a", version: "1.0.0", license: "MIT OR Apache-2.0" })).toBe("MIT OR Apache-2.0");
    expect(npmLicense({ name: "a", version: "1.0.0", license: { type: "ISC" } })).toBe("ISC");
    expect(npmLicense({ name: "a", version: "1.0.0", licenses: [{ type: "MIT" }, "Apache-2.0"] })).toBe("MIT OR Apache-2.0");
  });

  it("没有声明或写法认不出时报错，点名是哪个包", () => {
    expect(() => npmLicense({ name: "nolicense", version: "0.0.1" })).toThrow("nolicense@0.0.1 没有声明许可证");
    expect(() => npmLicense({ name: "empty", version: "1.0.0", license: "" })).toThrow("empty@1.0.0 没有声明许可证");
    expect(() => npmLicense({ name: "odd", version: "1.0.0", licenses: [42] })).toThrow("odd@1.0.0 的 licenses 写法认不出");
  });
});

describe("前端依赖闭包", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const writePkg = (dir: string, pkg: Record<string, unknown>) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  };

  /** 仿 pnpm 布局：顶层 node_modules 里是指向 .pnpm 虚拟仓库的链接，包自己的依赖装在虚拟仓库里它的旁边。 */
  function fixture() {
    root = mkdtempSync(join(tmpdir(), "pf-licenses-"));
    const app = join(root, "app");
    const nm = join(app, "node_modules");
    writePkg(app, { name: "app", dependencies: { a: "^1", "@s/b": "^2" }, devDependencies: { devonly: "^1" } });
    writePkg(join(nm, "a"), { name: "a", version: "1.0.0", license: "MIT", dependencies: { c: "^1" }, optionalDependencies: { "not-installed": "^1" } });
    writePkg(join(nm, "c"), { name: "c", version: "1.4.0", license: "BSD-3-Clause" });
    writePkg(join(nm, "devonly"), { name: "devonly", version: "9.9.9", license: "MIT" });
    const store = join(nm, ".pnpm", "@s+b@2.1.0", "node_modules");
    writePkg(join(store, "@s", "b"), { name: "@s/b", version: "2.1.0", license: { type: "ISC" }, dependencies: { c: "^2" } });
    writePkg(join(store, "c"), { name: "c", version: "2.0.3", licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] });
    mkdirSync(join(nm, "@s"), { recursive: true });
    symlinkSync(join(store, "@s", "b"), join(nm, "@s", "b"), "junction");
    return app;
  }

  it("只走 dependencies 与已安装的 optionalDependencies；同名不同版本各列一条；按名称、版本排序", () => {
    expect(collectNpmPackages(fixture())).toEqual([
      { ecosystem: "npm", name: "@s/b", version: "2.1.0", license: "ISC" },
      { ecosystem: "npm", name: "a", version: "1.0.0", license: "MIT" },
      { ecosystem: "npm", name: "c", version: "1.4.0", license: "BSD-3-Clause" },
      { ecosystem: "npm", name: "c", version: "2.0.3", license: "MIT OR Apache-2.0" },
    ]);
  });

  it("必需的依赖没装时报错", () => {
    const app = fixture();
    rmSync(join(app, "node_modules", "c"), { recursive: true });
    expect(() => collectNpmPackages(app)).toThrow("找不到依赖 c");
  });

  it("本工程：运行时依赖带着实际安装的版本，开发依赖不在清单里", () => {
    const packages = collectNpmPackages(APP_DIR);
    const react = JSON.parse(readFileSync(join(APP_DIR, "node_modules", "react", "package.json"), "utf8")) as { version: string };
    expect(packages).toContainEqual({ ecosystem: "npm", name: "react", version: react.version, license: "MIT" });
    expect(packages.some((p) => p.name === "@fontsource-variable/outfit" && p.license === "OFL-1.1")).toBe(true);
    expect(packages.some((p) => p.name === "vitest" || p.name === "vite" || p.name === "typescript")).toBe(false);
  });
});

describe("清单按哪个平台过滤 Rust 依赖", () => {
  it("交叉编译时取 Tauri 传来的目标，不取构建机自己的平台", () => {
    const target = hostTarget() === "x86_64-pc-windows-msvc" ? "x86_64-unknown-linux-gnu" : "x86_64-pc-windows-msvc";
    expect(distributionTarget({ TAURI_ENV_TARGET_TRIPLE: target })).toBe(target);
  });

  it("不经 Tauri 直接构建时取本机平台，空值也算没传", () => {
    expect(distributionTarget({})).toBe(hostTarget());
    expect(distributionTarget({ TAURI_ENV_TARGET_TRIPLE: "" })).toBe(hostTarget());
  });
});

describe("Rust 依赖闭包", () => {
  const WS = "path+file:///repo/app/src-tauri#petalfall-tauri@0.1.0";
  const WS_LIB = "path+file:///repo/crates/petalfall-base#0.1.0";
  const reg = (name: string, version: string) => `registry+https://github.com/rust-lang/crates.io-index#${name}@${version}`;
  const pkg = (id: string, name: string, version: string, license: string | null, licenseFile: string | null = null) => ({
    id,
    name,
    version,
    license,
    license_file: licenseFile,
  });
  const normal = { kind: null, target: null };
  const build = { kind: "build", target: null };
  const dev = { kind: "dev", target: null };

  function metadata(overrides: { serdeLicense?: string | null; serdeFile?: string | null } = {}) {
    return {
      workspace_members: [WS, WS_LIB],
      packages: [
        pkg(WS, "petalfall-tauri", "0.1.0", null),
        pkg(WS_LIB, "petalfall-base", "0.1.0", null),
        pkg(reg("serde", "1.0.228"), "serde", "1.0.228", overrides.serdeLicense === undefined ? "MIT OR Apache-2.0" : overrides.serdeLicense, overrides.serdeFile ?? null),
        pkg(reg("cc", "1.2.0"), "cc", "1.2.0", "MIT OR Apache-2.0"),
        pkg(reg("proptest", "1.5.0"), "proptest", "1.5.0", "MIT OR Apache-2.0"),
        pkg(reg("unicode-ident", "1.0.18"), "unicode-ident", "1.0.18", "(MIT OR Apache-2.0) AND Unicode-3.0"),
        pkg(reg("windows-sys", "0.59.0"), "windows-sys", "0.59.0", "MIT OR Apache-2.0"),
      ],
      resolve: {
        nodes: [
          {
            id: WS,
            deps: [
              { name: "petalfall_base", pkg: WS_LIB, dep_kinds: [normal] },
              { name: "cc", pkg: reg("cc", "1.2.0"), dep_kinds: [build] },
              { name: "proptest", pkg: reg("proptest", "1.5.0"), dep_kinds: [dev] },
            ],
          },
          {
            id: WS_LIB,
            deps: [
              { name: "serde", pkg: reg("serde", "1.0.228"), dep_kinds: [normal] },
              { name: "windows_sys", pkg: reg("windows-sys", "0.59.0"), dep_kinds: [build, normal] },
            ],
          },
          { id: reg("serde", "1.0.228"), deps: [{ name: "unicode_ident", pkg: reg("unicode-ident", "1.0.18"), dep_kinds: [normal] }] },
          { id: reg("cc", "1.2.0"), deps: [] },
          { id: reg("proptest", "1.5.0"), deps: [] },
          { id: reg("unicode-ident", "1.0.18"), deps: [] },
          { id: reg("windows-sys", "0.59.0"), deps: [] },
        ],
      },
    };
  }

  it("只走普通依赖（经工作区内的包传递也算），去掉工作区成员、build 与 dev 依赖；许可证原样照抄", () => {
    expect(collectCargoPackages(metadata(), "petalfall-tauri")).toEqual([
      { ecosystem: "cargo", name: "serde", version: "1.0.228", license: "MIT OR Apache-2.0" },
      { ecosystem: "cargo", name: "unicode-ident", version: "1.0.18", license: "(MIT OR Apache-2.0) AND Unicode-3.0" },
      { ecosystem: "cargo", name: "windows-sys", version: "0.59.0", license: "MIT OR Apache-2.0" },
    ]);
  });

  it("依赖没声明 SPDX 许可证时报错，只给了许可文件的一并点出", () => {
    expect(() => collectCargoPackages(metadata({ serdeLicense: null }), "petalfall-tauri")).toThrow("serde@1.0.228 没有声明 SPDX 许可证");
    expect(() => collectCargoPackages(metadata({ serdeLicense: null, serdeFile: "LICENSE-CUSTOM" }), "petalfall-tauri")).toThrow("只给了许可文件 LICENSE-CUSTOM");
  });

  it("应用包名在工作区里找不到时报错", () => {
    expect(() => collectCargoPackages(metadata(), "petalfall-app")).toThrow("名为 petalfall-app 的包，实际 0 个");
  });
});
