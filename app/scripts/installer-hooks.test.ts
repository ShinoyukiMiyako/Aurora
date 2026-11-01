import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = join(APP_DIR, "..");
const TAURI_DIR = join(APP_DIR, "src-tauri");

const conf: Record<string, any> = JSON.parse(readFileSync(join(TAURI_DIR, "tauri.conf.json"), "utf8"));
// Windows 工作区检出的是 CRLF，下面的整行匹配不该受它影响
const hooks = readFileSync(join(TAURI_DIR, conf.bundle.windows.nsis.installerHooks), "utf8").replaceAll("\r\n", "\n");

function readSource(rel: string): string {
  return readFileSync(join(REPO_DIR, rel), "utf8");
}

// 钩子是 NSIS 脚本，用不了 Rust 常量，只能从源码里取值比对：启动器改了名而钩子没跟上，卸载时就悄悄漏删
function rustConst(rel: string, name: string): string {
  const value = new RegExp(`const ${name}: &str = "([^"]+)";`).exec(readSource(rel))?.[1];
  if (value === undefined) throw new Error(`${rel} 里找不到常量 ${name}`);
  return value;
}

function macroBody(name: string): string {
  const body = new RegExp(`^!macro ${name}\\b.*$([\\s\\S]*?)^!macroend$`, "m").exec(hooks)?.[1];
  if (body === undefined) throw new Error(`钩子里找不到宏 ${name}`);
  return body;
}

function targets(body: string, command: string): string[] {
  const prefix = `${command} "\${ROOT}\\`;
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length, -1))
    .sort();
}

const brandSource = "crates/aurora-base/src/brand.rs";
const authSource = "crates/aurora-core/src/auth.rs";
const configSource = "crates/aurora-core/src/config.rs";

describe("卸载钩子的删除名单", () => {
  const body = macroBody("PETALFALL_DELETE_DATA");

  it("具名文件和启动器写进数据根的文件一一对应", () => {
    const configFile = "config.json";
    expect(readSource("crates/aurora-core/src/facade.rs")).toContain(`data_dir.join("${configFile}")`);
    const credentials = rustConst(authSource, "CREDENTIALS_FILE");
    const slug = /macro_rules! app_slug[\s\S]*?"([a-z]+)"/.exec(readSource(brandSource))?.[1];
    expect(readSource("crates/aurora-base/src/fs.rs")).toContain('concat!(".", crate::app_slug!(), "-write-probe")');
    expect(targets(body, "Delete")).toEqual(
      [
        configFile,
        `${configFile}${rustConst(configSource, "BROKEN_SUFFIX")}*`,
        credentials,
        `${credentials}${rustConst(authSource, "BROKEN_SUFFIX")}*`,
        rustConst(authSource, "OFFLINE_ACCOUNTS_FILE"),
        rustConst("app/src-tauri/src/tasks.rs", "TASK_JOURNAL_FILE"),
        rustConst("crates/aurora-core/src/playtime.rs", "PLAYTIME_FILE"),
        rustConst("crates/aurora-core/src/java.rs", "PROBE_CACHE_FILE"),
        ".*.tmp",
        `.${slug}-write-probe`,
      ].sort(),
    );
  });

  it("通配的临时文件名覆盖两种原子写的命名", () => {
    expect(readSource("crates/aurora-base/src/fs.rs")).toContain('".{}.{:016x}.tmp"');
    expect(readSource("crates/aurora-auth/src/credential.rs")).toContain('".{}.{}.{}.tmp"');
  });

  it("递归删除只落在启动器自有的子目录上", () => {
    const cacheDir = "cache";
    expect(readSource("crates/aurora-core/src/art/mod.rs")).toContain(`self.data_dir().join("${cacheDir}")`);
    expect(targets(body, "RMDir /r")).toEqual(
      [
        rustConst("app/src-tauri/src/logging.rs", "LOGS_DIR"),
        cacheDir,
        rustConst("crates/aurora-java/src/detect.rs", "MANAGED_RUNTIME_DIR"),
        rustConst("crates/aurora-core/src/authlib.rs", "AGENT_DIR"),
        rustConst("crates/aurora-core/src/template.rs", "TEMPLATES_DIR"),
      ].sort(),
    );
    // 上面只数了带子目录名的写法，这里确认整份脚本没有别的递归删除
    expect(hooks.match(/^\s*RMDir \/r /gm)).toHaveLength(targets(body, "RMDir /r").length);
  });

  it("游戏目录不在任何一条删除里", () => {
    const gameDir = rustConst("crates/aurora-instance/src/lib.rs", "MINECRAFT_DIR_NAME");
    const code = hooks.split("\n").filter((line) => !line.trim().startsWith(";"));
    expect(code.filter((line) => line.includes(gameDir))).toEqual([]);
  });

  it("根目录本身只做非递归删除，放在具名删除之后", () => {
    expect(body.match(/^\s*RMDir "\$\{ROOT\}"$/gm)).toHaveLength(1);
    expect(body.indexOf('RMDir "${ROOT}"')).toBeGreaterThan(body.lastIndexOf("RMDir /r"));
  });

  it("根目录没有配置文件时什么都不删", () => {
    const lines = body.trim().split("\n").map((line) => line.trim());
    expect(lines[0]).toBe('${If} ${FileExists} "${ROOT}\\config.json"');
    expect(lines.at(-1)).toBe("${EndIf}");
    expect(lines.filter((line) => line.startsWith("${If}"))).toHaveLength(1);
  });
});

describe("卸载钩子的触发条件", () => {
  const body = macroBody("NSIS_HOOK_POSTUNINSTALL");

  it("只在勾了删除数据且不是更新时执行", () => {
    const code = body.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith(";"));
    expect(code.slice(0, 2)).toEqual(["${If} $DeleteAppDataCheckboxState = 1", "${AndIf} $UpdateMode <> 1"]);
    expect(code.at(-1)).toBe("${EndIf}");
  });

  it("安装目录和系统数据目录两个根都处理", () => {
    expect(body).toContain('!insertmacro PETALFALL_DELETE_DATA "$INSTDIR"');
    expect(body).toContain('!insertmacro PETALFALL_DELETE_DATA "$LOCALAPPDATA\\${PRODUCTNAME}"');
    expect(conf.productName).toBe(/macro_rules! app_name_en[\s\S]*?"([^"]+)"/.exec(readSource(brandSource))?.[1]);
  });
});

describe("安装包配置", () => {
  it("静默安装打不开目标文件时失败而不是跳过", () => {
    const outsideMacros = hooks.replace(/^!macro\b[\s\S]*?^!macroend$/gm, "");
    expect(outsideMacros).toMatch(/^AllowSkipFiles off$/m);
  });

  it("中文系统看到中文向导，其余回落英文", () => {
    expect(conf.bundle.windows.nsis.languages).toEqual(["English", "SimpChinese"]);
  });

  it("协议全文同时进向导和安装目录", () => {
    expect(conf.bundle.resources).toEqual({ [conf.bundle.licenseFile]: "LICENSE" });
    const license = join(TAURI_DIR, conf.bundle.licenseFile);
    expect(existsSync(license)).toBe(true);
    expect(readFileSync(license, "utf8")).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
  });
});
