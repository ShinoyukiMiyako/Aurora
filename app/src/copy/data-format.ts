// 游戏目录被更新的版本用过、或记数据格式的文件读不懂时的说法：命令报错的正文、移动的拦截项与任务失败原因共用。
// 格式号本身不上界面，只说用过这份数据的是哪一版、该装哪一版。

import type { DataFormatUnreadableDto, GameDirDataTooNewDto } from "../ipc/instances";
import type { UpdateChannel } from "../ipc/system";
import { APP_NAME } from "../lib/app-info";
import { joinMixed, updateChannelLabel } from "./flows";

/** 用过这份数据的那一版：后端给的版本号与它所属的通道，两项同为空或同不为空。 */
export type DataWriter = Pick<GameDirDataTooNewDto, "written_by" | "written_by_channel">;

/** 后端没给出可信的版本时为 null；只给了版本或只给了通道是契约破坏，抛出。 */
function knownWriter({ written_by: version, written_by_channel: channel }: DataWriter): { version: string; channel: UpdateChannel } | null {
  if (version === null && channel === null) return null;
  if (version === null || channel === null) throw new Error(`written_by 与 written_by_channel 应同为空或同不为空，实为 ${JSON.stringify(version)}、${JSON.stringify(channel)}`);
  return { version, channel };
}

/** 用过这份数据的那一版的叫法：「预览版 1.1.0-dev.57」；不知道是哪一版时是「更新的落樱」。 */
export function dataWriterName(writer: DataWriter): string {
  const known = knownWriter(writer);
  return known === null ? `更新的${APP_NAME}` : `${updateChannelLabel(known.channel)} ${known.version}`;
}

/** 该装的那一版：「预览版 1.1.0-dev.57 或更新的版本」；不知道是哪一版时是「更新的版本」。 */
export function newerVersionToInstall(writer: DataWriter): string {
  return knownWriter(writer) === null ? "更新的版本" : `${dataWriterName(writer)} 或更新的版本`;
}

/** game_dir_data_too_new 的正文。 */
export function gameDirDataTooNewText(detail: GameDirDataTooNewDto): string {
  return joinMixed(`游戏目录 ${detail.path} 已经被`, dataWriterName(detail), "用过，这个版本读不了里面的实例。装上", newerVersionToInstall(detail), "，或者换一个游戏目录。");
}

/** data_format_unreadable 的正文，括号里是后端给的原因原文。 */
export function dataFormatUnreadableText(detail: DataFormatUnreadableDto): string {
  return `游戏目录 ${detail.path} 里的格式记录读不懂（${detail.reason}），为了不弄坏里面的实例，这次没有打开它。`;
}

/** 移动的拦截项 data_too_new：目标游戏目录被更新的版本用过。 */
export function moveTargetDataTooNewReason(writer: DataWriter): string {
  return joinMixed("目标游戏目录已经被", dataWriterName(writer), "用过，这个版本不能往里移");
}

/** 移动的拦截项 data_format_unreadable：目标游戏目录里记数据格式的文件读不懂，括号里是原因原文。 */
export function moveTargetDataFormatUnreadableReason(reason: string): string {
  return `目标游戏目录里的格式记录读不懂（${reason}），为了不弄坏里面的实例，不往里移`;
}

/**
 * 以任务失败结束时的原因。任务日志只存错误码与原文、没有 detail，说不出是哪个目录、哪一版用过，
 * 所以只说当前游戏目录与「更新的落樱」。
 */
export const DATA_FORMAT_TASK_FAILURE = {
  game_dir_data_too_new: `当前游戏目录被更新的${APP_NAME}用过，这个版本读不了里面的实例`,
  data_format_unreadable: "当前游戏目录里的格式记录读不懂，为了不弄坏里面的实例，这次没有动它",
} as const;
