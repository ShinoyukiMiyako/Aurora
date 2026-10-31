// 第三方许可清单：随应用分发的前端依赖（含字体包）与 Rust 依赖的名称、版本与许可证，构建时从依赖树现取，不手写。
// 由 vite.config.ts 的插件调用：构建时作为静态文件写进产物，开发服务器上请求到时现生成；关于页按需 fetch。
//
// - 前端：从 package.json 的 dependencies 出发，沿各包的 dependencies 与已安装的 optionalDependencies 走完闭包；
//   devDependencies 只参与构建，不随应用分发。目录按 Node 的解析规则逐级向上找，pnpm 的软链接取真实路径后再找。
// - Rust：cargo metadata 按本机目标平台过滤，从应用包出发只走普通依赖（build、dev 依赖不进二进制），去掉工作区自己的包。
//   --frozen 不联网、不改锁文件：清单必须和锁文件里实际编进去的版本一致。
// - 许可证原样照抄包里声明的字符串；没有声明的包直接报错，交给人去核实，不猜。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

function readPackageJson(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function findPackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** package.json 里许可证的几种写法：SPDX 字符串、旧式 { type }、旧式 licenses 数组（多份许可任选其一）。 */
export function npmLicense(pkg) {
  if (typeof pkg.license === "string" && pkg.license !== "") return pkg.license;
  if (pkg.license !== null && typeof pkg.license === "object" && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    return pkg.licenses
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry !== null && typeof entry === "object" && typeof entry.type === "string") return entry.type;
        throw new Error(`${pkg.name}@${pkg.version} 的 licenses 写法认不出：${JSON.stringify(entry)}`);
      })
      .join(" OR ");
  }
  throw new Error(`${pkg.name}@${pkg.version} 没有声明许可证`);
}

const byNameThenVersion = (a, b) => (a.name === b.name ? (a.version < b.version ? -1 : a.version > b.version ? 1 : 0) : a.name < b.name ? -1 : 1);

export function collectNpmPackages(appDir) {
  const found = new Map();
  const visit = (name, fromDir, optional) => {
    const dir = findPackageDir(name, fromDir);
    if (dir === null) {
      if (optional) return;
      throw new Error(`找不到依赖 ${name}（从 ${fromDir} 起）：先装好依赖再构建`);
    }
    if (found.has(dir)) return;
    const pkg = readPackageJson(dir);
    found.set(dir, { ecosystem: "npm", name: pkg.name, version: pkg.version, license: npmLicense(pkg) });
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, false);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, dir, true);
  };
  const root = readPackageJson(appDir);
  for (const dep of Object.keys(root.dependencies ?? {})) visit(dep, appDir, false);
  const unique = new Map([...found.values()].map((p) => [`${p.name}@${p.version}`, p]));
  return [...unique.values()].sort(byNameThenVersion);
}

/** 从 cargo metadata 的解析图里取应用包的普通依赖闭包，去掉工作区成员。 */
export function collectCargoPackages(metadata, rootPackage) {
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const workspace = new Set(metadata.workspace_members);
  const roots = metadata.packages.filter((p) => p.name === rootPackage && workspace.has(p.id));
  if (roots.length !== 1) throw new Error(`工作区里应恰好有一个名为 ${rootPackage} 的包，实际 ${roots.length} 个`);

  const seen = new Set();
  const stack = [roots[0].id];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (node === undefined) throw new Error(`cargo metadata 的解析图里缺少 ${id}`);
    for (const dep of node.deps) {
      if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
    }
  }

  return [...seen]
    .filter((id) => !workspace.has(id))
    .map((id) => {
      const pkg = packages.get(id);
      if (pkg === undefined) throw new Error(`cargo metadata 的包列表里缺少 ${id}`);
      if (typeof pkg.license !== "string" || pkg.license === "") {
        const file = pkg.license_file === null ? "" : `（只给了许可文件 ${pkg.license_file}）`;
        throw new Error(`${pkg.name}@${pkg.version} 没有声明 SPDX 许可证${file}`);
      }
      return { ecosystem: "cargo", name: pkg.name, version: pkg.version, license: pkg.license };
    })
    .sort(byNameThenVersion);
}

/** 本机 rustc 的目标三元组：应用在本机构建，分发的就是这个平台的依赖。 */
export function hostTarget() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split(/\r?\n/).find((l) => l.startsWith("host: "));
  if (line === undefined) throw new Error(`rustc -vV 的输出里没有 host 行：${out}`);
  return line.slice("host: ".length).trim();
}

export function readCargoMetadata(manifestPath, target) {
  const out = execFileSync("cargo", ["metadata", "--format-version", "1", "--frozen", "--filter-platform", target, "--manifest-path", manifestPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

export function thirdPartyManifest({ appDir, cargoManifest, rootPackage }) {
  const metadata = readCargoMetadata(cargoManifest, hostTarget());
  return { packages: [...collectNpmPackages(appDir), ...collectCargoPackages(metadata, rootPackage)] };
}
