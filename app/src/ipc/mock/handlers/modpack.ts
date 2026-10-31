// 整合包导入的假后端：实例名按后端同一套规则校验（写法、长度、保留名、不区分大小写的重名），
// 本地文件按扩展名认格式，平台整合包的版本与清单从共用的工程目录（ipc/mock/catalog）里取。导入是长任务：
// 登记任务、推送带 task_id 的事件、响应取消，成功后新实例进入实例列表，清单里的 Mod 落进它的 mods/。

import type { PlatformId } from "../../discover";
import { IpcError } from "../../errors";
import type { InstanceNameRule, ModpackInstallOutcomeDto, ModpackPreviewDto, ModpackSource, ModpackSummaryDto, PackFormat, PackLoader } from "../../modpack";
import { INSTANCE_NAME_MAX_CHARS } from "../../modpack";
import { findMockSource, type MockPackManifest } from "../catalog";
import type { MockArgs, MockHandlers } from "../types";
import { MOCK_GAME_DIR, argReader, emitCoreEvent, parsePlatform, runMockTask, simulateDownload } from "./discover";
import { addMockInstance, mockInstanceIds } from "./instances";
import { placeMockPackMods } from "./mods";

/** 本地整合包文件的假清单：读不到真文件，每个本地包都报这一份。 */
const LOCAL_MANIFEST: MockPackManifest = {
  remoteFiles: 48,
  modFiles: 41,
  remoteBytes: 96_468_992,
  overrideFiles: 57,
  overrideBytes: 364_233,
  loader: { kind: "fabric", version: "0.16.9" },
};
const LOCAL_MINECRAFT = "1.21.1";
const LOCAL_VERSION = "1.0.0";

const RULE_TEXT: Record<InstanceNameRule, string> = {
  empty: "名字不能为空",
  too_long: `名字最多 ${INSTANCE_NAME_MAX_CHARS} 个字符`,
  illegal_char: '不能含 \\ / : * ? " < > | 与控制字符，也不能以点开头或结尾',
  reserved: "这是 Windows 的保留名",
  duplicate: "已有同名的版本或实例",
};

/** 与后端 validate_instance_name 一致；返回去掉首尾空白后的名字或不合格的原因。 */
function checkName(raw: string): { name: string } | { rule: InstanceNameRule } {
  const name = raw.trim();
  if (name === "") return { rule: "empty" };
  if ([...name].length > INSTANCE_NAME_MAX_CHARS) return { rule: "too_long" };
  if (/[\\/:*?"<>|\p{Cc}]/u.test(name) || name.startsWith(".") || name.endsWith(".")) return { rule: "illegal_char" };
  const stem = name.split(".")[0].trimEnd().toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return { rule: "reserved" };
  return { name };
}

function nameError(name: string, rule: InstanceNameRule): IpcError {
  return new IpcError("instance_name_invalid", `实例名 ${name} 不可用：${RULE_TEXT[rule]}`, { name, rule });
}

function formatOf(path: string): PackFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mrpack")) return "modrinth";
  if (lower.endsWith(".zip")) return "curseforge";
  throw new IpcError("modpack_unsupported_extension", `只认 .mrpack 和 CurseForge 导出的 .zip：${path}`, { path });
}

function stemOf(path: string): string {
  const file = path.split(/[\\/]/).pop();
  if (file === undefined) throw new Error("split 至少返回一段");
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

/** 命令自己校验的空白值报 invalid_argument（与后端 non_blank 一致）。 */
function nonBlank(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new IpcError("invalid_argument", `${field} 不能为空`);
  return trimmed;
}

function parseSource(raw: unknown): ModpackSource {
  // source 的形状由 serde 反序列化：认不出来是 Tauri 的参数错误，到前端归一为 unknown。
  const malformed = () => new IpcError("unknown", `invalid args \`source\` for command \`install_modpack\`: ${JSON.stringify(raw)}`);
  if (typeof raw !== "object" || raw === null) throw malformed();
  const source = raw as Record<string, unknown>;
  const text = (key: string) => {
    const value = source[key];
    if (typeof value !== "string") throw malformed();
    return value;
  };
  if (source.kind === "platform") {
    return {
      kind: "platform",
      platform: parsePlatform(text("platform")),
      project_id: nonBlank("project_id", text("project_id")),
      version_id: nonBlank("version_id", text("version_id")),
    };
  }
  if (source.kind === "file") return { kind: "file", path: nonBlank("path", text("path")) };
  throw malformed();
}

/** 一个整合包导入要用的全部事实：名字、格式、来源、版本、清单。 */
interface PackFacts {
  name: string;
  format: PackFormat;
  platform: PlatformId | null;
  version: string;
  minecraft: string;
  /** 卷宗外的 Mod 文件名前缀。 */
  slug: string;
  packBytes: number;
  manifest: MockPackManifest;
}

function packOf(source: ModpackSource): PackFacts {
  if (source.kind === "file") {
    return {
      name: stemOf(source.path),
      format: formatOf(source.path),
      platform: null,
      version: LOCAL_VERSION,
      minecraft: LOCAL_MINECRAFT,
      slug: "pack",
      packBytes: 0,
      manifest: LOCAL_MANIFEST,
    };
  }
  const notFound = () =>
    new IpcError("mod_version_not_found", `平台 ${source.platform} 上工程 ${source.project_id} 未找到版本 ${source.version_id}`, {
      platform: source.platform,
      project_id: source.project_id,
      version_id: source.version_id,
    });
  const found = findMockSource(source.platform, source.project_id);
  if (found === undefined || found.project.resourceType !== "modpack") throw notFound();
  const version = found.source.versions.find((v) => v.info.version_id === source.version_id);
  if (version === undefined) throw notFound();
  if (version.manifest === null) throw new Error(`mock 目录里整合包 ${found.project.title} 的版本 ${source.version_id} 缺少清单`);
  const minecraft = version.info.game_versions[0];
  if (minecraft === undefined) throw new Error(`mock 目录里整合包 ${found.project.title} 的版本 ${source.version_id} 没有游戏版本`);
  if (version.info.file_size === null) throw new Error(`mock 目录里整合包 ${found.project.title} 的版本 ${source.version_id} 缺少 file_size`);
  return {
    name: found.project.title,
    format: source.platform === "modrinth" ? "modrinth" : "curseforge",
    platform: source.platform,
    version: version.info.version_number,
    minecraft,
    slug: found.source.slug,
    packBytes: version.info.file_size,
    manifest: version.manifest,
  };
}

function previewModpack(args: MockArgs): ModpackPreviewDto {
  const path = nonBlank("path", argReader("preview_modpack", args).string("path"));
  const format = formatOf(path);
  return {
    format,
    name: stemOf(path),
    version: LOCAL_VERSION,
    summary: format === "modrinth" ? "本地整合包" : null,
    author: format === "curseforge" ? "未知作者" : null,
    minecraft: LOCAL_MINECRAFT,
    loader: LOCAL_MANIFEST.loader,
    remote_files: LOCAL_MANIFEST.remoteFiles,
    remote_bytes: format === "modrinth" ? LOCAL_MANIFEST.remoteBytes : null,
    override_files: LOCAL_MANIFEST.overrideFiles,
    override_bytes: LOCAL_MANIFEST.overrideBytes,
  };
}

function loaderDto(loader: PackLoader | null) {
  return loader === null ? null : { kind: loader.kind, version: loader.version };
}

function installModpack(args: MockArgs): Promise<ModpackInstallOutcomeDto> {
  const read = argReader("install_modpack", args);
  const taskId = read.string("taskId");
  const source = parseSource(args.source);
  const requested = read.nullableString("name");
  return runMockTask(taskId, async () => {
    const pack = packOf(source);
    const raw = requested === null ? pack.name : requested;
    const checked = checkName(raw);
    if ("rule" in checked) throw nameError(raw, checked.rule);
    const name = checked.name;
    const lower = name.toLowerCase();
    // 已占用的名字以实例 mock 为准，导入成功的实例也记进那里；整合包要的原版自然目录也占着它的版本号。
    if (lower === pack.minecraft.toLowerCase() || mockInstanceIds().some((v) => v.toLowerCase() === lower)) throw nameError(name, "duplicate");

    const { manifest } = pack;
    emitCoreEvent({ task_id: taskId, kind: "stage", message: `读取整合包 ${pack.name}：${manifest.remoteFiles} 个远程文件，${manifest.overrideFiles} 个覆盖文件` });
    await simulateDownload(taskId, `${pack.name} 的 ${manifest.remoteFiles} 个文件`, manifest.remoteBytes);
    const modpack = {
      platform: pack.platform,
      project_id: source.kind === "platform" ? source.project_id : null,
      version_id: source.kind === "platform" ? source.version_id : null,
      name: pack.name,
      version: pack.version,
    };
    addMockInstance(name, pack.minecraft, loaderDto(manifest.loader), modpack);
    placeMockPackMods(name, pack.minecraft, manifest.loader === null ? [] : [manifest.loader.kind], manifest.modFiles, pack.slug);
    emitCoreEvent({ task_id: taskId, kind: "stage", message: `整合包已导入为实例 ${name}` });
    return {
      version_id: name,
      version_dir: `${MOCK_GAME_DIR}/versions/${name}`,
      modpack: {
        schema: 1,
        format: pack.format,
        ...modpack,
        minecraft: pack.minecraft,
        loader: loaderDto(manifest.loader),
        remote_files: manifest.remoteFiles,
        override_files: manifest.overrideFiles,
        installed_at: Math.floor(Date.now() / 1000),
      },
    };
  });
}

/** 平台整合包某个版本的清单摘要：与导入时同一份清单。CurseForge 的 Mod 数与大小后端经批量接口补齐，两种格式都报数。 */
function summarizeModpack(args: MockArgs): ModpackSummaryDto {
  const read = argReader("summarize_platform_modpack", args);
  const source: ModpackSource = {
    kind: "platform",
    platform: parsePlatform(read.string("platform")),
    project_id: nonBlank("project_id", read.string("projectId")),
    version_id: nonBlank("version_id", read.string("versionId")),
  };
  const pack = packOf(source);
  const { manifest } = pack;
  return {
    format: pack.format,
    name: pack.name,
    version: pack.version,
    minecraft: pack.minecraft,
    loader: loaderDto(manifest.loader),
    pack_bytes: pack.packBytes,
    remote_files: manifest.remoteFiles,
    mod_files: manifest.modFiles,
    remote_bytes: manifest.remoteBytes,
    override_files: manifest.overrideFiles,
    override_bytes: manifest.overrideBytes,
  };
}

export const handlers: MockHandlers = {
  preview_modpack: previewModpack,
  summarize_platform_modpack: summarizeModpack,
  install_modpack: installModpack,
};
