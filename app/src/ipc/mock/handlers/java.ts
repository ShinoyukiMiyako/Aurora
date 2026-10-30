import { IpcError } from "../../errors";
import type { InstalledRuntimeDto, JavaInstallationDto, JavaVersionDto } from "../../java";
import type { MockArgs, MockHandlers } from "../types";
import { MOCK_DATA_DIR, requireString, setMockJavaPaths, tauriArgError } from "./config";
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
    },
    {
      path: "C:\\Program Files\\Java\\jre1.8.0_421\\bin\\java.exe",
      version: { major: 8, minor: 0, security: 421, build: 0, raw: "1.8.0_421" },
      is_64bit: true,
      vendor: "Oracle Corporation",
      source: "registry",
    },
  ];
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

let installations: JavaInstallationDto[] = seedInstallations();
setMockJavaPaths(installations.map((j) => j.path));

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
      installations = [
        ...installations,
        { path: exe, version: runtime.version, is_64bit: true, vendor: "Mojang", source: "managed" },
      ];
      setMockJavaPaths(installations.map((j) => j.path));
    }
    return { component: runtime.component, version: runtime.version, java_executable: exe };
  } finally {
    endMockTask(taskId);
  }
}

export const handlers: MockHandlers = {
  detect_java: () => installations,
  install_java: (args) => installJava(args),
};

export function reset(): void {
  installations = seedInstallations();
  setMockJavaPaths(installations.map((j) => j.path));
}
