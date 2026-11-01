// vite.config.ts 在构建时注入的常量。测试里没有 vite 构建，用到的测试自己 stubGlobal。

declare const __PETALFALL_BUILD__: import("../../scripts/build-info.mjs").BuildInfo;
