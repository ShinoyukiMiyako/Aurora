import { IpcError } from "../../errors";
import type { GpuAdaptersDto, InstalledRuntimeDto, JavaInstallationDto, JavaPathProblem, JavaVersionDto, RemoveJavaPathDto } from "../../java";
import { JAVA_PATH_INVALID, JAVA_RUNTIME_INCOMPLETE } from "../../java";
import type { MockArgs, MockHandlers, MockPersist } from "../types";
import { addMockExtraJavaPath, MOCK_DATA_DIR, removeMockExtraJavaPath, requireString, samePath, setMockJavaPaths, tauriArgError } from "./config";
import { simulateMockDownload } from "./system";
import { beginMockTask, endMockTask } from "./tasks";

function seedInstallations(): JavaInstallationDto[] {
  return [
    {
      path: "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot\\bin\\java.exe",
      version: { major: 21, minor: 0, security: 5, build: 11, raw: "21.0.5" },
      is_64bit: true,
      vendor: "Eclipse Adoptium",
      source: "registry",
      missing_files: [],
    },
    {
      path: "C:\\Program Files\\Java\\jre1.8.0_421\\bin\\java.exe",
      version: { major: 8, minor: 0, security: 421, build: 0, raw: "1.8.0_421" },
      is_64bit: true,
      vendor: "Oracle Corporation",
      source: "registry",
      missing_files: [],
    },
  ];
}

// 笔记本常见的一集显一独显：省电偏好挑集显，高性能偏好挑独显（排在第一）。
function seedGpuAdapters(): GpuAdaptersDto {
  return {
    adapters: [
      { name: "NVIDIA GeForce RTX 4060 Laptop GPU", vendor_id: 0x10de, dedicated_video_memory_mb: 8188, high_performance: true, power_saving: false },
      { name: "Intel(R) UHD Graphics", vendor_id: 0x8086, dedicated_video_memory_mb: 128, high_performance: false, power_saving: true },
    ],
    switchable: true,
  };
}

// Mojang 运行时清单里按主版本可下载的组件。
const RUNTIMES: Record<number, { component: string; version: JavaVersionDto }> = {
  8: { component: "jre-legacy", version: { major: 8, minor: 0, security: 51, build: 0, raw: "1.8.0_51" } },
  17: { component: "java-runtime-gamma", version: { major: 17, minor: 0, security: 8, build: 0, raw: "17.0.8" } },
  21: { component: "java-runtime-delta", version: { major: 21, minor: 0, security: 7, build: 0, raw: "21.0.7" } },
  25: { component: "java-runtime-epsilon", version: { major: 25, minor: 0, security: 1, build: 0, raw: "25.0.1" } },
};

const RUNTIME_FILES = 320;
const RUNTIME_BYTES = 48_000_000;

// mock 里「装得不完整」的手动 Java：路径带这一级目录时识别为缺 release 与 lib/modules。
const BROKEN_SEGMENT = /\\broken\\/i;
const BROKEN_MISSING = ["release", "lib/modules"];
// 识别出的主版本取路径里第一个 jdk-<n> / jdk<n>，认不出时当作 Java 21。
const MAJOR_IN_PATH = /jdk-?(\d+)/i;
const FALLBACK_MAJOR = 21;
const MANUAL_VENDOR = "Eclipse Adoptium";

let installations: JavaInstallationDto[] = seedInstallations();
let gpu: GpuAdaptersDto = seedGpuAdapters();
setMockJavaPaths(installations.map((j) => j.path));

function replaceInstallations(list: JavaInstallationDto[]): void {
  installations = list;
  setMockJavaPaths(installations.map((j) => j.path));
}

/** 测试辅助：直接换掉探测结果，例如构造不完整的运行时，或让手动添加的记录识别不出。 */
export function setMockJavaInstallations(list: readonly JavaInstallationDto[]): void {
  replaceInstallations(list.map((j) => ({ ...j, version: { ...j.version }, missing_files: [...j.missing_files] })));
}

/** 测试辅助：换掉本机显卡，例如只有一块显卡的台式机。 */
export function setMockGpuAdapters(dto: GpuAdaptersDto): void {
  gpu = { adapters: dto.adapters.map((a) => ({ ...a })), switchable: dto.switchable };
}

async function installJava(args: MockArgs): Promise<InstalledRuntimeDto> {
  const taskId = requireString(args, "taskId", "install_java");
  const major = args.requiredMajor;
  if (typeof major !== "number" || !Number.isInteger(major) || major < 0) {
    throw tauriArgError("install_java", "requiredMajor", "expected u32");
  }
  beginMockTask(taskId);
  try {
    const runtime = RUNTIMES[major];
    if (runtime === undefined) throw new IpcError("java_failed", `Mojang 没有提供匹配 Java ${major} 的运行时`);
    await simulateMockDownload(taskId, RUNTIME_FILES, RUNTIME_BYTES);
    const exe = `${MOCK_DATA_DIR}\\runtime\\${major}\\bin\\java.exe`;
    if (!installations.some((j) => j.path === exe)) {
      replaceInstallations([...installations, { path: exe, version: runtime.version, is_64bit: true, vendor: "Mojang", source: "managed", missing_files: [] }]);
    }
    return { component: runtime.component, version: runtime.version, java_executable: exe };
  } finally {
    endMockTask(taskId);
  }
}

// mock 不碰磁盘也不跑 java -version，只复刻路径本身就能判定的两种问题。
type PathOnlyProblem = Extract<JavaPathProblem, "not_absolute" | "not_java_executable">;
const PROBLEM_TEXT: Readonly<Record<PathOnlyProblem, string>> = {
  not_absolute: "Java 路径须是绝对路径",
  not_java_executable: "只能添加 java.exe 或 javaw.exe",
};

function invalidJavaPath(path: string, reason: PathOnlyProblem): IpcError {
  return new IpcError(JAVA_PATH_INVALID, `${PROBLEM_TEXT[reason]}: ${path}`, { path, reason });
}

function fileNameOf(path: string): { dir: string; name: string } {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/** 与后端 inspect_manual_java 的校验顺序一致：绝对路径、文件名、javaw 换成 java、识别、完整性。 */
function inspectManual(input: string): JavaInstallationDto {
  const path = input.trim();
  if (!/^([A-Za-z]:[\\/]|\\\\)/.test(path)) throw invalidJavaPath(path, "not_absolute");
  const { dir, name } = fileNameOf(path);
  const lower = name.toLowerCase();
  if (lower !== "java.exe" && lower !== "javaw.exe") throw invalidJavaPath(path, "not_java_executable");
  const exe = lower === "javaw.exe" ? `${dir}java.exe` : path;
  if (BROKEN_SEGMENT.test(exe)) {
    throw new IpcError(JAVA_RUNTIME_INCOMPLETE, `这个 Java 缺少 ${BROKEN_MISSING.join("、")}，可能没装完整: ${exe}`, { path: exe, missing: [...BROKEN_MISSING] });
  }
  const matched = MAJOR_IN_PATH.exec(exe);
  const major = matched === null ? FALLBACK_MAJOR : Number(matched[1]);
  const legacy = major <= 8;
  return {
    path: exe,
    version: { major, minor: 0, security: legacy ? 452 : 2, build: 0, raw: legacy ? `1.${major}.0_452` : `${major}.0.2` },
    is_64bit: true,
    vendor: MANUAL_VENDOR,
    source: "manual",
    missing_files: [],
  };
}

function addJavaPath(args: MockArgs): JavaInstallationDto {
  const java = inspectManual(requireString(args, "path", "add_java_path"));
  const existing = installations.findIndex((j) => samePath(j.path, java.path));
  // 去重时托管运行时的来源优先于手动添加，其余来源让位给手动添加
  if (existing < 0) replaceInstallations([...installations, java]);
  else if (installations[existing].source !== "managed") replaceInstallations(installations.map((j, i) => (i === existing ? java : j)));
  addMockExtraJavaPath(java.path);
  return java;
}

function removeJavaPath(args: MockArgs): RemoveJavaPathDto {
  const path = requireString(args, "path", "remove_java_path").trim();
  const result = removeMockExtraJavaPath(path);
  if (result.removed) replaceInstallations(installations.filter((j) => !(j.source === "manual" && samePath(j.path, path))));
  return result;
}

export const handlers: MockHandlers = {
  detect_java: () => installations,
  install_java: (args) => installJava(args),
  add_java_path: (args) => addJavaPath(args),
  remove_java_path: (args) => removeJavaPath(args),
  gpu_adapters: () => gpu,
};

export function reset(): void {
  replaceInstallations(seedInstallations());
  gpu = seedGpuAdapters();
}

// 配置里的手动 Java 与默认 Java 会随配置快照留下；探测结果不一起留，刷新后它们就对不上探测结果，手动项会显示成识别不出。
export const persist: MockPersist = {
  version: 1,
  snapshot: (): JavaInstallationDto[] => installations,
  restore: (data) => {
    setMockJavaInstallations(data as JavaInstallationDto[]);
  },
};
