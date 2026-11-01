// 更新预览：「全部更新」与批量更新都先到这里逐项勾选，确认后才入队。
// 只吃 props 与自己的 state：打开期间下载进度、游戏日志都不让它重渲染。
// 更新日志点开才请求，平台给的正文经受限节点树渲染（Modrinth 为 Markdown，CurseForge 为 HTML），不注入原始 HTML。

import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Icon } from "../../art/Icon";
import { hueOf } from "../../art/illustrations/seed";
import { fade, springs } from "../../lib/motion";
import { useModChangelog, type UpdateCandidate } from "../../state/queries/instance";
import { Button } from "../../ui/Button";
import { Checkbox, type CheckState } from "../../ui/Checkbox";
import { Modal } from "../../ui/Modal";
import { RichText } from "../../ui/RichText";
import { parseBody } from "../../ui/richtext-parse";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { Thumb } from "../../ui/Thumb";
import { describeError } from "../../state/errors";
import { MOD_CHANNEL_LABEL, MODS_COPY, UPDATE_PREVIEW_COPY } from "./copy";
import styles from "./instance.module.css";
import type { ModRow } from "./model";

export interface UpdatePreviewModalProps {
  open: boolean;
  /** 实例查询用的 id（取更新日志）；实例还没装好为 null，这时不会打开预览。 */
  queryId: string | null;
  /** 可更新的行；update 为 null 的行不该传进来。 */
  rows: readonly ModRow[];
  /** 此刻不能更新的原因：预览开着时实例可能被别处锁住，确认键随之带原因禁用。能更新为 undefined。 */
  lock: string | undefined;
  onClose(): void;
  /** 勾选的几项，至少一项。 */
  onConfirm(picked: readonly UpdateCandidate[]): void;
}

interface PreviewItem {
  row: ModRow;
  candidate: UpdateCandidate;
}

export function UpdatePreviewModal({ open, queryId, rows, lock, onClose, onConfirm }: UpdatePreviewModalProps) {
  const items = useMemo(
    () =>
      rows
        .map((row): PreviewItem => {
          if (row.update === null) throw new Error(`更新预览只列可更新的 Mod，${row.fileName} 没有可用的更新`);
          return { row, candidate: row.update };
        })
        .sort((a, b) => a.row.name.localeCompare(b.row.name, "zh-CN") || a.row.fileName.localeCompare(b.row.fileName)),
    [rows],
  );
  // 记没勾的而不是勾了的：打开时默认全选，打开期间重查出来的新可更新项也按勾选算
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const picked = items.filter((i) => !excluded.has(i.candidate.file_name));
  const allState: CheckState = picked.length === 0 ? false : picked.length === items.length ? true : "mixed";
  // 展开项的签名：只有它变了才让下方各项做位移，窗口缩放、分档切换引起的重渲染不触发布局动画
  const expandedSignature = items
    .filter((i) => expanded.has(i.candidate.file_name))
    .map((i) => i.candidate.file_name)
    .join("|");

  const togglePicked = (fileName: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  const toggleAll = () => setExcluded(allState === true ? new Set(items.map((i) => i.candidate.file_name)) : new Set());
  const toggleExpanded = (fileName: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={UPDATE_PREVIEW_COPY.title}
      subtitle={UPDATE_PREVIEW_COPY.subtitle}
      footer={
        <>
          <Button onClick={onClose}>{UPDATE_PREVIEW_COPY.cancel}</Button>
          <Button
            variant="primary"
            disabledReason={lock !== undefined ? lock : picked.length === 0 ? UPDATE_PREVIEW_COPY.nonePicked : undefined}
            onClick={() => onConfirm(picked.map((i) => i.candidate))}
          >
            {UPDATE_PREVIEW_COPY.confirm(picked.length)}
          </Button>
        </>
      }
    >
      <div className={styles.previewHead}>
        <Checkbox checked={allState} onChange={toggleAll} label={UPDATE_PREVIEW_COPY.selectAll} />
        <span className={styles.previewCount}>{UPDATE_PREVIEW_COPY.picked(picked.length, items.length)}</span>
      </div>
      <div className={styles.previewList}>
        {items.map(({ row, candidate }) => {
          const unfolded = expanded.has(candidate.file_name);
          const channel = candidate.latest.release_channel;
          return (
            <motion.div key={candidate.file_name} className={styles.previewItem} layout="position" layoutDependency={expandedSignature} transition={springs.settle}>
              <div className={styles.previewRow}>
                <Checkbox
                  checked={!excluded.has(candidate.file_name)}
                  onChange={() => togglePicked(candidate.file_name)}
                  ariaLabel={UPDATE_PREVIEW_COPY.pick(row.name)}
                />
                <Thumb url={row.iconUrl} kind="mod" hue={hueOf(row.seed)} size={32} />
                <div className={styles.previewMain}>
                  <span className={styles.previewName}>{row.name}</span>
                  <span className={styles.previewVersions}>
                    {UPDATE_PREVIEW_COPY.versions(
                      candidate.current_version_number === null ? MODS_COPY.versionUnknown : candidate.current_version_number,
                      candidate.latest.version_number,
                    )}
                  </span>
                </div>
                {channel === "beta" && (
                  <Tag size="sm" tone="warn">
                    {MOD_CHANNEL_LABEL.beta}
                  </Tag>
                )}
                {channel === "alpha" && (
                  <Tag size="sm" tone="danger">
                    {MOD_CHANNEL_LABEL.alpha}
                  </Tag>
                )}
                <Button variant="ghost" size="sm" aria-expanded={unfolded} aria-label={UPDATE_PREVIEW_COPY.changelogLabel(row.name)} onClick={() => toggleExpanded(candidate.file_name)}>
                  {UPDATE_PREVIEW_COPY.changelog}
                  <motion.span className={styles.previewChevron} animate={{ rotate: unfolded ? 180 : 0 }} transition={springs.settle} initial={false}>
                    <Icon name="chevron-down" size={16} />
                  </motion.span>
                </Button>
              </div>
              {unfolded && (
                <motion.div className={styles.changelog} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }}>
                  <Changelog queryId={queryId} fileName={candidate.file_name} modVersionId={candidate.latest.version_id} />
                </motion.div>
              )}
            </motion.div>
          );
        })}
      </div>
    </Modal>
  );
}

function Changelog({ queryId, fileName, modVersionId }: { queryId: string | null; fileName: string; modVersionId: string }) {
  const changelog = useModChangelog(queryId, fileName, modVersionId, true);
  const body = changelog.status === "ready" ? changelog.data.body : null;
  const format = changelog.status === "ready" ? changelog.data.format : null;
  const blocks = useMemo(() => (body === null || format === null ? [] : parseBody(body, format)), [body, format]);

  if (changelog.status === "loading") return <Skeleton shape="text" lines={3} />;
  if (changelog.status === "error") {
    return (
      <div className={styles.changelogError}>
        <span className={styles.changelogErrorTitle}>{UPDATE_PREVIEW_COPY.changelogFailed}</span>
        <span className={styles.soft}>{describeError(changelog.error)}</span>
        <Button variant="ghost" size="sm" onClick={changelog.reload}>
          {UPDATE_PREVIEW_COPY.retry}
        </Button>
      </div>
    );
  }
  if (blocks.length === 0) return <p className={styles.changelogEmpty}>{UPDATE_PREVIEW_COPY.changelogEmpty}</p>;
  return <RichText blocks={blocks} />;
}
