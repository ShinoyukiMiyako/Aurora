export interface BuildTarget {
  outDir: string;
  /** 入口 HTML，相对 app/。 */
  html: string;
  /** 开发服务器端口，要与 tauri.conf.json 的 devUrl 一致。 */
  port: number;
  hmrPort: number;
  /** 第三方许可清单里 Rust 依赖闭包的起点。 */
  rootPackage: string;
}

export function buildTarget(mode: string): BuildTarget;
