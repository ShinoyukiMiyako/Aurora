import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildInfo } from "./scripts/build-info.mjs";
import { thirdPartyManifest } from "./scripts/third-party-licenses.mjs";
import { THIRD_PARTY_LICENSES_FILE } from "./src/lib/app-info";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const APP_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 第三方许可清单只在关于页打开时才要：构建时作为静态文件写进产物，开发服务器上请求到才现生成。
 * 不做成模块：引入它的代码在测试里没有这个插件，按模块解析会让所有间接引入的测试一起失败；前端用 fetch 按需读取。
 */
function thirdPartyLicenses(): Plugin {
  const manifest = () => JSON.stringify(thirdPartyManifest({ appDir: APP_DIR, cargoManifest: join(APP_DIR, "..", "Cargo.toml"), rootPackage: "aurora-tauri" }));
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

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), thirdPartyLicenses()],

  define: {
    __PETALFALL_BUILD__: JSON.stringify(readBuildInfo({ tauriConfPath: join(APP_DIR, "src-tauri", "tauri.conf.json"), env: process.env, now: new Date() })),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
