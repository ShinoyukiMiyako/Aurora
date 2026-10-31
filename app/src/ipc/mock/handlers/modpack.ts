// 整合包导入的假后端：实例名按后端同一套规则校验（写法、长度、保留名、不区分大小写的重名），
// 本地文件按扩展名认格式，平台整合包从发现页 mock 的目录里取。导入是长任务：登记任务、推送带
// task_id 的事件、响应取消，成功后新实例名进入已占用名单。

import type { PlatformId } from "../../discover";
import { IpcError } from "../../errors";
import type { InstanceNameRule, ModpackInstallOutcomeDto, ModpackPreviewDto, ModpackSource, PackFormat } from "../../modpack";
import { INSTANCE_NAME_MAX_CHARS } from "../../modpack";
import type { MockArgs, MockHandlers } from "../types";
import { MOCK_GAME_DIR, argReader, emitCoreEvent, findCatalogueItem, parsePlatform, runMockTask, simulateDownload } from "./discover";
import { addMockInstance, mockInstanceIds } from "./instances";

/** mock 整合包都要求的游戏版本。 */
const MOCK_MINECRAFT = "1.21.1";
/** mock 整合包都报这个版本号。 */
const MOCK_PACK_VERSION = "1.0.0";

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

function previewModpack(args: MockArgs): ModpackPreviewDto {
  const path = nonBlank("path", argReader("preview_modpack", args).string("path"));
  const format = formatOf(path);
  return {
    format,
    name: stemOf(path),
    version: "1.0.0",
    summary: format === "modrinth" ? "本地整合包" : null,
    author: format === "curseforge" ? "未知作者" : null,
    minecraft: MOCK_MINECRAFT,
    loader: { kind: "fabric", version: "0.16.9" },
    remote_files: 48,
    remote_bytes: format === "modrinth" ? 96_468_992 : null,
    override_files: 57,
    override_bytes: 364_233,
  };
}

function packOf(source: ModpackSource): { name: string; format: PackFormat; platform: PlatformId | null } {
  if (source.kind === "file") return { name: stemOf(source.path), format: formatOf(source.path), platform: null };
  const found = findCatalogueItem(source.platform, source.project_id);
  if (!found || found.entry.resource_type !== "modpack") {
    throw new IpcError("mod_version_not_found", `平台 ${source.platform} 上工程 ${source.project_id} 未找到版本 ${source.version_id}`, {
      platform: source.platform,
      project_id: source.project_id,
      version_id: source.version_id,
    });
  }
  return { name: found.entry.title, format: source.platform === "modrinth" ? "modrinth" : "curseforge", platform: source.platform };
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
    // 已占用的名字以实例 mock 为准，导入成功的实例也记进那里。
    if (lower === MOCK_MINECRAFT.toLowerCase() || mockInstanceIds().some((v) => v.toLowerCase() === lower)) throw nameError(name, "duplicate");

    emitCoreEvent({ task_id: taskId, kind: "stage", message: `读取整合包 ${pack.name}：48 个远程文件，57 个覆盖文件` });
    await simulateDownload(taskId, `${pack.name} 的 48 个文件`, 96_468_992);
    addMockInstance(
      name,
      MOCK_MINECRAFT,
      { kind: "fabric", version: "0.16.9" },
      {
        platform: pack.platform,
        project_id: source.kind === "platform" ? source.project_id : null,
        version_id: source.kind === "platform" ? source.version_id : null,
        name: pack.name,
        version: MOCK_PACK_VERSION,
      },
    );
    emitCoreEvent({ task_id: taskId, kind: "stage", message: `整合包已导入为实例 ${name}` });
    return {
      version_id: name,
      version_dir: `${MOCK_GAME_DIR}/versions/${name}`,
      modpack: {
        schema: 1,
        format: pack.format,
        platform: pack.platform,
        project_id: source.kind === "platform" ? source.project_id : null,
        version_id: source.kind === "platform" ? source.version_id : null,
        name: pack.name,
        version: MOCK_PACK_VERSION,
        minecraft: MOCK_MINECRAFT,
        loader: { kind: "fabric", version: "0.16.9" },
        remote_files: 48,
        override_files: 57,
        installed_at: Math.floor(Date.now() / 1000),
      },
    };
  });
}

export const handlers: MockHandlers = {
  preview_modpack: previewModpack,
  install_modpack: installModpack,
};
