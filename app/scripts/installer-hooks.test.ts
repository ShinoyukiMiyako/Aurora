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

function functionBody(name: string): string {
  const body = new RegExp(`^Function ${name}$([\\s\\S]*?)^FunctionEnd$`, "m").exec(hooks)?.[1];
  if (body === undefined) throw new Error(`钩子里找不到函数 ${name}`);
  return body;
}

// 宏里的 !define 要到 !insertmacro 才生效，MUI 生成 .onGUIInit 和编译函数体时都还看不到，所以只认宏外的
function fileDefine(name: string): string {
  const outsideMacros = hooks.replace(/^!macro\b[\s\S]*?^!macroend$/gm, "");
  const value = new RegExp(`^!define ${name} (.+)$`, "m").exec(outsideMacros)?.[1];
  if (value === undefined) throw new Error(`钩子的宏外找不到 !define ${name}`);
  return value.replace(/^"(.*)"$/, "$1");
}

function instructions(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith(";"));
}

// 压栈的寄存器要按相反顺序弹回，写过的寄存器都得先压栈，不然调用方的值被冲掉
function expectRegistersRestored(code: string[]): void {
  const pushed = code.filter((line) => line.startsWith("Push ")).map((line) => line.slice("Push ".length));
  const popped = code.filter((line) => line.startsWith("Pop ")).map((line) => line.slice("Pop ".length));
  expect(pushed.length).toBeGreaterThan(0);
  expect(popped).toEqual([...pushed].reverse());
  const written = code
    .map((line) => /^(?:StrCpy|ReadRegStr) (\$R?\d)\b/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
  expect(written.length).toBeGreaterThan(0);
  expect(written.filter((register) => !pushed.includes(register))).toEqual([]);
}

// 运行期逻辑整个包在第一层 ${If} 里：嵌套深度第一次回到 0 的就是最后一行
function expectWrappedByFirstIf(code: string[]): void {
  let depth = 0;
  const depths = code.map((line) => {
    if (line.startsWith("${If} ")) depth += 1;
    if (line === "${EndIf}") depth -= 1;
    return depth;
  });
  expect(depths.indexOf(0)).toBe(code.length - 1);
}

const brandSource = "crates/petalfall-base/src/brand.rs";
const authSource = "crates/petalfall-core/src/auth.rs";
const configSource = "crates/petalfall-core/src/config.rs";

describe("卸载钩子的删除名单", () => {
  const body = macroBody("PETALFALL_DELETE_DATA");

  it("具名文件和启动器写进数据根的文件一一对应", () => {
    const configFile = "config.json";
    expect(readSource("crates/petalfall-core/src/facade.rs")).toContain(`data_dir.join("${configFile}")`);
    const credentials = rustConst(authSource, "CREDENTIALS_FILE");
    const slug = /macro_rules! app_slug[\s\S]*?"([a-z]+)"/.exec(readSource(brandSource))?.[1];
    expect(readSource("crates/petalfall-base/src/fs.rs")).toContain('concat!(".", crate::app_slug!(), "-write-probe")');
    expect(targets(body, "Delete")).toEqual(
      [
        configFile,
        `${configFile}${rustConst(configSource, "BROKEN_SUFFIX")}*`,
        credentials,
        `${credentials}${rustConst(authSource, "BROKEN_SUFFIX")}*`,
        rustConst(authSource, "OFFLINE_ACCOUNTS_FILE"),
        rustConst("app/src-tauri/src/tasks.rs", "TASK_JOURNAL_FILE"),
        rustConst("crates/petalfall-core/src/playtime.rs", "PLAYTIME_FILE"),
        rustConst("crates/petalfall-core/src/java.rs", "PROBE_CACHE_FILE"),
        ".*.tmp",
        `.${slug}-write-probe`,
      ].sort(),
    );
  });

  it("通配的临时文件名覆盖两种原子写的命名", () => {
    expect(readSource("crates/petalfall-base/src/fs.rs")).toContain('".{}.{:016x}.tmp"');
    expect(readSource("crates/petalfall-auth/src/credential.rs")).toContain('".{}.{}.{}.tmp"');
  });

  it("递归删除只落在启动器自有的子目录上", () => {
    const cacheDir = "cache";
    expect(readSource("crates/petalfall-core/src/art/mod.rs")).toContain(`self.data_dir().join("${cacheDir}")`);
    expect(targets(body, "RMDir /r")).toEqual(
      [
        rustConst("app/src-tauri/src/logging.rs", "LOGS_DIR"),
        cacheDir,
        rustConst("crates/petalfall-java/src/detect.rs", "MANAGED_RUNTIME_DIR"),
        rustConst("crates/petalfall-core/src/authlib.rs", "AGENT_DIR"),
        rustConst("crates/petalfall-core/src/template.rs", "TEMPLATES_DIR"),
      ].sort(),
    );
    // 上面只数了带子目录名的写法，这里确认整份脚本没有别的递归删除
    expect(hooks.match(/^\s*RMDir \/r /gm)).toHaveLength(targets(body, "RMDir /r").length);
  });

  it("游戏目录不在任何一条删除里", () => {
    const gameDir = rustConst("crates/petalfall-instance/src/lib.rs", "MINECRAFT_DIR_NAME");
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

  it("缺 WebView2 时向导运行打进包里的引导器，不走模板的下载", () => {
    // 模板默认用 NSISdl 下载引导器，NSISdl 不支持 HTTPS，微软的地址连 http 也跳到 https，沙箱实测必定失败
    expect(conf.bundle.windows.webviewInstallMode).toEqual({ type: "embedBootstrapper" });
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

describe("发布者改名后的目录键", () => {
  it("新键就是模板按发布者和产品名拼出的 MANUPRODUCTKEY", () => {
    expect(fileDefine("PETALFALL_DIR_KEY")).toBe(`Software\\${conf.bundle.publisher}\\${conf.productName}`);
  });

  it("老键是 dev.10 及更早的包记目录的位置", () => {
    // 那时没设发布者，模板取 identifier 的第二段；这些包已经发出去，这个值不跟着配置变
    expect(fileDefine("PETALFALL_LEGACY_DIR_KEY")).toBe("Software\\petalfall\\Petalfall");
    expect(fileDefine("PETALFALL_LEGACY_DIR_KEY")).not.toBe(fileDefine("PETALFALL_DIR_KEY"));
  });
});

describe("老安装第一次被新包交互或被动安装", () => {
  const name = fileDefine("MUI_CUSTOMFUNCTION_GUIINIT");
  const code = instructions(functionBody(name));

  it("MUI 生成的 .onGUIInit 调的是本文件里的函数", () => {
    expect(hooks.match(new RegExp(`^Function ${name}$`, "gm"))).toHaveLength(1);
  });

  it("新键空着且老键有值时才把老目录抄进新键", () => {
    expect(code.slice(2, 4)).toEqual([
      'ReadRegStr $0 HKCU "${PETALFALL_DIR_KEY}" ""',
      'ReadRegStr $1 HKCU "${PETALFALL_LEGACY_DIR_KEY}" ""',
    ]);
    const write = code.indexOf('WriteRegStr HKCU "${PETALFALL_DIR_KEY}" "" $1');
    expect(write).toBeGreaterThan(1);
    expect(code.slice(write - 2, write)).toEqual(['${If} $0 == ""', '${AndIf} $1 != ""']);
  });

  it("只替换模板的默认目录，命令行带 /D= 的不动", () => {
    expect(code.filter((line) => line.startsWith("StrCpy $INSTDIR "))).toEqual(["StrCpy $INSTDIR $1"]);
    const replace = code.indexOf("StrCpy $INSTDIR $1");
    expect(code[replace - 1]).toBe(`\${If} $INSTDIR == "$LOCALAPPDATA\\${conf.productName}"`);
    expect(code[replace + 1]).toBe("${EndIf}");
  });

  it("用到的寄存器原样还回去", () => {
    expectRegistersRestored(code);
  });
});

describe("更新器静默更新老安装", () => {
  const code = instructions(macroBody("NSIS_HOOK_PREINSTALL"));
  const runtime = code.slice(3);

  it("编译期只认当前用户安装", () => {
    // 钩子直接读写 HKCU，SHCTX 也只在当前用户安装时落在 HKCU
    expect(code.slice(0, 3)).toEqual([
      '!if "${INSTALLMODE}" != "currentUser"',
      expect.stringMatching(/^!error "/),
      "!endif",
    ]);
  });

  it("只在更新模式下动目录，引导器的 /S /D= 不经过这里", () => {
    expect(runtime[0]).toBe("${If} $UpdateMode = 1");
    expectWrappedByFirstIf(runtime);
  });

  it("目录取自卸载项的 InstallLocation，去掉模板加的引号", () => {
    const read = runtime.indexOf('ReadRegStr $0 SHCTX "${UNINSTKEY}" "InstallLocation"');
    expect(read).toBeGreaterThan(0);
    expect(runtime.slice(read + 1, read + 5)).toEqual([
      "StrCpy $1 $0 1",
      `\${If} $1 == '"'`,
      "StrCpy $0 $0 -1 1",
      "${EndIf}",
    ]);
  });

  it("只替换模板自己推出来的默认目录或新键里的目录", () => {
    const replace = runtime.indexOf("StrCpy $INSTDIR $0");
    expect(replace).toBeGreaterThan(5);
    expect(runtime.slice(replace - 6, replace)).toEqual([
      '${If} $INSTDIR == "$LOCALAPPDATA\\${PRODUCTNAME}"',
      "${OrIf} $INSTDIR == $1",
      '${If} $0 != ""',
      "${AndIf} $0 != $INSTDIR",
      '${AndIf} ${FileExists} "$0\\${MAINBINARYNAME}.exe"',
      "StrCpy $1 $INSTDIR",
    ]);
    // 比对时 $1 得是新键里的目录：往前找最近一次写 $1 的指令
    const lastWrite = runtime
      .slice(0, replace - 6)
      .reverse()
      .find((line) => /^(?:StrCpy|ReadRegStr) \$1 /.test(line));
    expect(lastWrite).toBe('ReadRegStr $1 SHCTX "${MANUPRODUCTKEY}" ""');
  });

  it("换目录后重新 SetOutPath，再非递归删掉模板建出的目录", () => {
    // File 往 $OUTDIR 里放；RMDir 删不掉当前目录，必须先切走
    const replace = runtime.indexOf("StrCpy $INSTDIR $0");
    expect(runtime.slice(replace, replace + 3)).toEqual(["StrCpy $INSTDIR $0", "SetOutPath $INSTDIR", 'RMDir "$1"']);
  });

  it("用到的寄存器原样还回去", () => {
    expectRegistersRestored(runtime);
  });
});

describe("安装完成后清掉老键", () => {
  const code = instructions(macroBody("NSIS_HOOK_POSTINSTALL"));

  it("编译期核对新键就是模板的 MANUPRODUCTKEY，且和老键不同", () => {
    expect(code.slice(0, 6)).toEqual([
      '!if "${MANUPRODUCTKEY}" != "${PETALFALL_DIR_KEY}"',
      expect.stringMatching(/^!error "/),
      "!endif",
      '!if "${MANUPRODUCTKEY}" == "${PETALFALL_LEGACY_DIR_KEY}"',
      expect.stringMatching(/^!error "/),
      "!endif",
    ]);
  });

  it("只删老键和空了的老发布者键", () => {
    const legacy = fileDefine("PETALFALL_LEGACY_DIR_KEY");
    expect(code.slice(6)).toEqual([
      'DeleteRegKey HKCU "${PETALFALL_LEGACY_DIR_KEY}"',
      `DeleteRegKey /ifempty HKCU "${legacy.slice(0, legacy.lastIndexOf("\\"))}"`,
    ]);
    // 上面只看了安装后钩子，这里确认整份钩子没有别的删注册表
    expect(hooks.match(/^\s*DeleteReg(?:Key|Value) /gm)).toHaveLength(2);
  });
});
