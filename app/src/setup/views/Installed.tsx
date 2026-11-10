import type { ReactNode } from "react";
import { Button } from "../../ui/Button";
import type { Channel, Probe } from "../contract";
import { dataWriter, type SetupCopy } from "../copy";
import { Frame } from "../Frame";
import { installedCase } from "../model";
import { PathRow } from "../PathRow";
import styles from "./Installed.module.css";

export interface InstalledProps {
  copy: SetupCopy;
  /** 种类、两边的通道、newer 的原因与数据关都由后端判定好，页面照 model 的 installedCase 挑情形。 */
  probe: Probe;
  busy: boolean;
  /** 点了打开之后按钮转加载。 */
  opening: boolean;
  /** 升级，含在「换到」页上确认换到更快通道的那种。 */
  onUpdate(): void;
  /** 在「换到」页上确认装回更慢通道上更早的版本。 */
  onSwitch(): void;
  /** 只在 same、broken 下用。 */
  onReinstall(): void;
  onOpen(): void;
}

interface Page {
  title: string;
  lead: string;
  /** 说明要能选中复制：读不懂记录的那一页，反馈问题时要带上路径和原因。 */
  selectable: boolean;
  footer: ReactNode;
}

/**
 * upgrade（含跨通道的普通升级）与「换到」页：主「升级」或「换到某通道」，次「打开」。same：主「打开」次「重新安装」。
 * newer 与数据拦截：只有「打开」，程序文件不全时连它也没有。broken：主「重新安装」。
 * 提权时不提供打开，same 的「重新安装」也不升成主按钮：这时用户多半只是误点，不该把人往重装上引。
 * 位置是只读的：换位置等于搬数据目录，不在这里做。
 */
export function Installed({ copy, probe, busy, opening, onUpdate, onSwitch, onReinstall, onOpen }: InstalledProps) {
  const { existing, elevated, payloadVersion: payload } = probe;
  if (existing === null) throw new Error("没有现有安装，不该进已安装页");
  const situation = installedCase(probe);
  const text = copy.installed;
  const name = (channel: Channel) => copy.channel[channel];
  // 数据拦截盖过任何种类，程序文件不全（broken）时也会停在这一页，那时打不开
  const opens = !elevated && existing.kind !== "broken";

  // 打开和发起安装互斥：查进程的间隙里把启动器开起来，覆盖安装会直接结束它
  const open = (variant: "primary" | "secondary") =>
    opens ? (
      <Button variant={variant} loading={opening} disabled={busy} focusableWhenDisabled onClick={onOpen}>
        {text.open}
      </Button>
    ) : undefined;
  const install = (label: string, onClick: () => void) => (
    <>
      {open("secondary")}
      <Button variant="primary" loading={busy} disabled={opening} focusableWhenDisabled onClick={onClick}>
        {label}
      </Button>
    </>
  );
  const reinstall = (variant: "primary" | "secondary") => (
    <Button variant={variant} loading={busy} disabled={opening} focusableWhenDisabled onClick={onReinstall}>
      {text.reinstall}
    </Button>
  );
  // 更新模式下停在装不了的页上：落樱是为这次更新关掉的，能从这里打开时告诉用户
  const reopen = (lead: string, closedForUpdate: boolean) => (closedForUpdate && opens ? text.closedForUpdate(lead) : lead);

  const page = ((): Page => {
    switch (situation.kind) {
      case "upgrade":
        return { title: text.kind.upgrade.title(existing.version), lead: text.kind.upgrade.lead(existing.version, payload), selectable: false, footer: install(text.update, onUpdate) };
      case "cross_upgrade":
        return { title: text.kind.upgrade.title(existing.version), lead: text.kind.upgrade.cross(name(situation.channels.payload), payload), selectable: false, footer: install(text.update, onUpdate) };
      case "switch_to": {
        const [ci, cp] = [name(situation.channels.installed), name(situation.channels.payload)];
        const toSlower = situation.mode === "switch";
        const lead = toSlower ? text.kind.switch.lead(ci, existing.version, cp, payload) : text.kind.upgrade.switching(ci, existing.version, cp, payload);
        return { title: text.kind.switch.title(cp), lead, selectable: false, footer: install(text.switchTo(cp), toSlower ? onSwitch : onUpdate) };
      }
      case "same":
        return {
          title: text.kind.same.title(existing.version),
          lead: text.kind.same.lead(existing.version, payload),
          selectable: false,
          footer: (
            <>
              {reinstall("secondary")}
              {open("primary")}
            </>
          ),
        };
      case "broken":
        return { title: text.kind.broken.title(existing.version), lead: text.kind.broken.lead(existing.version, payload), selectable: false, footer: reinstall("primary") };
      case "newer": {
        const leads = text.kind.newer.lead;
        const lead =
          situation.reason === "faster_channel" || situation.reason === "slower_channel"
            ? leads[situation.reason](name(situation.channels.installed), existing.version, name(situation.channels.payload), payload)
            : leads[situation.reason](existing.version, payload);
        return { title: text.kind.newer.title(existing.version), lead: reopen(lead, situation.closedForUpdate), selectable: false, footer: open("primary") };
      }
      case "data_blocked": {
        const { block, closedForUpdate } = situation;
        if (block.problem === "unreadable") {
          if (block.reason === null) throw new Error("数据格式记录读不懂，拦截详情却没给原因");
          return { title: text.dataUnreadable.title, lead: reopen(text.dataUnreadable.lead(block.path, block.reason), closedForUpdate), selectable: true, footer: open("primary") };
        }
        const writer = dataWriter(block);
        const lead = writer === null ? text.dataTooNew.unnamed(payload) : text.dataTooNew.named(name(writer.channel), writer.version, payload);
        return { title: text.dataTooNew.title, lead: reopen(lead, closedForUpdate), selectable: false, footer: open("primary") };
      }
    }
  })();

  return (
    <Frame
      title={page.title}
      // 说明在窗口的拖动区里，要选中就得单独退出拖动区
      lead={
        page.selectable ? (
          <span className={styles.selectable} data-tauri-drag-region="false">
            {page.lead}
          </span>
        ) : (
          page.lead
        )
      }
      footer={page.footer}
    >
      <div className={styles.content}>
        <PathRow label={text.locationLabel} path={existing.dir} />
        {elevated && existing.kind !== "broken" && <p className={styles.elevated}>{copy.done.elevated}</p>}
        <p className={styles.legalNote}>{text.legalNote}</p>
      </div>
    </Frame>
  );
}
