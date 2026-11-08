// 同一份 vite.config.ts 构建两个前端：启动器和安装引导程序，按 --mode 分支。不开第二个配置文件：
// build-config.test.ts 的类型检查和工作区里的 pnpm 依赖都只认这一份。

const LAUNCHER = {
  outDir: "dist",
  html: "index.html",
  port: 1420,
  hmrPort: 1421,
  rootPackage: "petalfall-tauri",
};

const SETUP = {
  outDir: "dist-setup",
  html: "setup.html",
  port: 1430,
  hmrPort: 1431,
  rootPackage: "petalfall-setup",
};

export function buildTarget(mode) {
  return mode === "setup" ? SETUP : LAUNCHER;
}
