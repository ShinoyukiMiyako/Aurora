import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildInfo } from "./scripts/build-info.mjs";
import { buildTarget } from "./scripts/build-target.mjs";
import { thirdPartyManifest } from "./scripts/third-party-licenses.mjs";
import { LICENSE_TEXT_FILE, THIRD_PARTY_LICENSES_FILE } from "./scripts/licenses-file.mjs";

const host = process.env.TAURI_DEV_HOST;

const APP_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 第三方许可清单只在关于页打开时才要：构建时作为静态文件写进产物，开发服务器上请求到才现生成。
 * 不做成模块：引入它的代码在测试里没有这个插件，按模块解析会让所有间接引入的测试一起失败；前端用 fetch 按需读取。
 */
function thirdPartyLicenses(rootPackage: string): Plugin {
  const manifest = () => JSON.stringify(thirdPartyManifest({ appDir: APP_DIR, cargoManifest: join(APP_DIR, "..", "Cargo.toml"), rootPackage, env: process.env }));
  return {
    name: "petalfall:third-party-licenses",
    configureServer(server) {
      server.middlewares.use(`/${THIRD_PARTY_LICENSES_FILE}`, (_req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(manifest());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: THIRD_PARTY_LICENSES_FILE, source: manifest() });
    },
  };
}

/**
 * 协议全文随启动器与引导程序一起分发：AGPL 第 5(d) 条要界面上能看到协议，离线也要能看。
 * 不用 ?raw 导入：路径出了 src，开发服务器还得放开 fs.allow。
 */
function licenseText(): Plugin {
  const text = () => readFileSync(join(APP_DIR, "..", "LICENSE"), "utf8");
  return {
    name: "petalfall:license-text",
    configureServer(server) {
      server.middlewares.use(`/${LICENSE_TEXT_FILE}`, (_req, res) => {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(text());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: LICENSE_TEXT_FILE, source: text() });
    },
  };
}

/** 体积大、改动少的依赖各自成块：主块不超过 500 kB 的警告线，应用代码改动时这些块的缓存也不失效。 */
const VENDOR_CHUNKS: readonly [chunk: string, packages: readonly string[]][] = [
  ["react", ["react", "react-dom", "scheduler"]],
  ["motion", ["framer-motion", "motion-dom", "motion-utils"]],
  ["tauri", ["@tauri-apps/api", "@tauri-apps/plugin-dialog"]],
];

function vendorChunk(id: string): string | null {
  const normalized = id.split("\\").join("/");
  for (const [chunk, packages] of VENDOR_CHUNKS) {
    if (packages.some((pkg) => normalized.includes(`/node_modules/${pkg}/`))) return chunk;
  }
  return null;
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const target = buildTarget(mode);
  return {
    plugins: [react(), tailwindcss(), thirdPartyLicenses(target.rootPackage), licenseText()],

    define: {
      __PETALFALL_BUILD__: JSON.stringify(readBuildInfo({ tauriConfPath: join(APP_DIR, "src-tauri", "tauri.conf.json"), env: process.env, now: new Date() })),
    },

    build: {
      outDir: target.outDir,
      rollupOptions: {
        input: join(APP_DIR, target.html),
        output: { manualChunks: vendorChunk },
      },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: target.port,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: target.hmrPort,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**", "**/src-tauri-setup/**"],
      },
    },
  };
});
