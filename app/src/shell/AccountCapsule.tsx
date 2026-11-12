// 账户胶囊：标题栏右列的当前账户，点开是账户切换菜单。没有账户时是「添加账户」，直接去账户页。
// 宽度按档：compact 只留头像，regular 头像 + 名字，wide 再加一行账户类型。当前账户需要重新登录时头像角上挂提醒点。
//
// 冷启动时窗口先于账户切片显示：读到之前是同尺寸的骨架胶囊，不把「还没读到」画成「没有账户」。
// 骨架与真实胶囊是同一个元素，宽度变化（骨架换成内容、切换账户、账户失效改写类型行）由它自己的布局动画伸缩；
// 被它推动的搜索与下载入口带着 SLIDES_WITH_CAPSULE，与胶囊同在标题栏的 LayoutGroup 里，跟着胶囊左缘一起滑。
//
// 切换菜单的行带头像与两行文字，通用菜单画不了，这里自己实现同一套键盘约定：
// 打开即聚焦当前账户，↑↓ 循环移动，Home / End 到首尾，Enter / Space 执行，Esc 关闭并把焦点还给胶囊。

import { AnimatePresence, motion, useReducedMotionConfig, type HTMLMotionProps } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../art/Icon";
import type { SkinRef } from "../art/skin/layout";
import { AccountAvatar } from "../art/skin/AccountAvatar";
import { ACTION_ERROR, NEXT_LAUNCH_SUFFIX, TOAST_COPY, accountKindLabel } from "../copy/flows";
import type { Account } from "../domain/adapt";
import { useLoadingGate } from "../lib/loading-gate";
import { fade, popMark, springs } from "../lib/motion";
import { useMounted } from "../lib/useMounted";
import { isImeComposing } from "../lib/util";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { useSkinInfo } from "../state/queries/home";
import { activeAccount, busyInstanceId } from "../state/selectors";
import { Popover } from "../ui/Popover";
import { Skeleton } from "../ui/Skeleton";
import { Tooltip } from "../ui/Tooltip";
import styles from "./AccountCapsule.module.css";
import { ACCOUNT_COPY, SHELL_ACTION_ERROR } from "../copy/shell";
import { useNav, useShell } from "./shell";
import type { Tier } from "./tier";
import { useRunner } from "./useRunner";

/** 胶囊高 34，圆角取高度一半；经 style 传给布局动画，宽度变化时圆角不被拉伸。 */
const CAPSULE_RADIUS = 17;

/**
 * 标题栏同一行里被胶囊伸缩推动的入口（搜索、下载）挂的布局动画：只动位置，和胶囊走同一条 morph 弹簧，
 * 胶囊左缘与它们同步移动，途中不会叠到胶囊上。
 * 它们自己从不改变布局，布局依赖取常量，下载进度这类高频重渲染不量布局。快照由标题栏的 LayoutGroup 统一取：
 * 组内任一节点开始布局动画时全组一起取快照，没有重渲染的兄弟也量得到旧位置。
 */
export const SLIDES_WITH_CAPSULE: Pick<HTMLMotionProps<"button">, "layout" | "layoutDependency" | "transition"> = {
  layout: "position",
  layoutDependency: 0,
  transition: { layout: springs.morph },
};

/**
 * 骨架里名字条与类型条的宽度：按常见的 6 到 8 个字符的玩家名取，骨架胶囊与「添加账户」差不多宽，
 * 两种结果到来时胶囊的伸缩都很小。
 */
const SKELETON_BAR = { name: 48, kind: 40, nameHeight: 10, kindHeight: 8 } as const;

/** 账户的皮肤；读取失败经外层统一错误处理报告，头像退回剪影（与「没有皮肤」同样的画法）。 */
export function useAccountSkin(uuid: string): SkinRef | null {
  const skin = useSkinInfo(uuid);
  const run = useRunner();
  const error = skin.status === "error" ? skin.error : null;
  useEffect(() => {
    if (error !== null) void run(() => Promise.reject(error), SHELL_ACTION_ERROR.skin);
  }, [error, run]);
  if (skin.status === "loading" || skin.data === undefined) return null;
  return skin.data;
}

/** 账户行的第二行：需要重新登录时说明这一点，否则写账户类型。 */
export function accountLine(account: Account): string {
  return account.status === "expired" ? ACCOUNT_COPY.needsRelogin : accountKindLabel(account.kind, account.authServer);
}

/** 切换当前账户：成功后弹一条通知，游戏占着进程时说明只影响下一次启动。选中的已是当前账户时什么都不做。 */
export function useSwitchAccount(): (account: Account) => void {
  const actions = useLauncherActions();
  const currentId = useLauncherSelector((s) => s.currentAccountId);
  const gameBusy = useLauncherSelector((s) => busyInstanceId(s) !== null);
  const run = useRunner();
  return (account) => {
    if (account.uuid === currentId) return;
    const body = `${accountKindLabel(account.kind, account.authServer)}${gameBusy ? NEXT_LAUNCH_SUFFIX : ""}`;
    void run(() => actions.selectAccount(account.uuid), ACTION_ERROR.selectAccount).then((result) => {
      if (result.ok) actions.toast("success", TOAST_COPY.accountSwitched(account.name), body);
    });
  };
}

/** 胶囊此刻画的是什么：账户切片还没读到（骨架）、当前账户、没有账户（「添加账户」）。 */
type CapsuleKind = "loading" | "account" | "add";

export function AccountCapsule() {
  const current = useLauncherSelector(activeAccount);
  const accounts = useLauncherSelector((s) => s.accounts);
  const accountsLoading = useLauncherSelector((s) => s.status.accounts.kind === "loading");
  // 只有账户切片一次都没读到过才算加载。之后的重新读取（账户页刷新、登录后重读）沿用当前显示的状态，不打回骨架：
  // 没有账户时也一样，否则「添加账户」会先隐去再淡入，闪一下。挂载时已有当前账户，说明早就读到过
  const [loaded, setLoaded] = useState(!accountsLoading || current !== null);
  if (!accountsLoading && !loaded) setLoaded(true);
  const gate = useLoadingGate(accountsLoading && !loaded);
  const { tier } = useShell();
  const { route, go } = useNav();
  const switchTo = useSwitchAccount();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  // 挂载时就在的内容跟着外壳一起出现；之后才换上的（读完账户、切换账户、加上首个账户）淡入
  const mounted = useMounted();

  const account = gate.view === "content" ? current : null;
  const kind: CapsuleKind = gate.view !== "content" ? "loading" : account === null ? "add" : "account";
  // 菜单只属于「有当前账户」：账户没了时收起，免得之后加上账户时菜单自己弹出来
  if (account === null && open) setOpen(false);
  const compact = tier === "compact";
  // 只有改变宽度的内容进布局依赖：开合菜单、悬停与下载进度这类重渲染不量布局；分档切换随窗口缩放直接到位，不进依赖
  const layoutKey = account === null ? kind : `${account.uuid}\n${account.name}\n${accountLine(account)}`;

  const close = () => setOpen(false);
  const pick = (target: Account) => {
    close();
    switchTo(target);
  };
  const manage = () => {
    close();
    go({ page: "accounts" });
  };
  const onClick = () => {
    if (account === null) go({ page: "accounts" });
    else setOpen((v) => !v);
  };

  return (
    <>
      {/* 提示气泡只给 compact 档只剩图标的「添加账户」；包裹层常驻，换状态时胶囊不重挂，伸缩动画才接得上 */}
      <Tooltip content={ACCOUNT_COPY.add} side="bottom" disabled={!(compact && kind === "add")}>
        <motion.button
          ref={setAnchor}
          type="button"
          layout
          layoutDependency={layoutKey}
          transition={{ layout: springs.morph }}
          style={{ borderRadius: CAPSULE_RADIUS }}
          className={styles.capsule}
          data-kind={kind}
          data-pending={gate.view === "pending" || undefined}
          data-compact={compact || undefined}
          data-here={route.page === "accounts" || undefined}
          data-open={open || undefined}
          disabled={kind === "loading"}
          aria-hidden={kind === "loading" || undefined}
          aria-label={account !== null ? ACCOUNT_COPY.current(account.name, accountLine(account)) : kind === "add" ? ACCOUNT_COPY.addLabel : undefined}
          aria-haspopup={account === null ? undefined : "menu"}
          aria-expanded={account === null ? undefined : open}
          onClick={onClick}
        >
          {/* 换状态与换账户时新旧两层叠放交叉淡入：旧的一层脱离布局淡出，胶囊立即取新内容的宽度去伸缩 */}
          <AnimatePresence mode="popLayout">
            <motion.span
              key={account === null ? kind : account.uuid}
              className={styles.face}
              layout="position"
              layoutDependency={layoutKey}
              initial={mounted.current ? { opacity: 0 } : false}
              animate={{ opacity: 1, transition: fade.in }}
              exit={{ opacity: 0, transition: fade.out }}
            >
              {account !== null ? <CapsuleAccount account={account} tier={tier} /> : kind === "add" ? <CapsuleAdd tier={tier} /> : <CapsuleSkeleton tier={tier} />}
            </motion.span>
          </AnimatePresence>
        </motion.button>
      </Tooltip>
      {account !== null && (
        <Popover open={open} anchor={anchor} onClose={close} placement="bottom-end" role="presentation">
          <AccountMenu accounts={accounts} currentId={account.uuid} onPick={pick} onManage={manage} />
        </Popover>
      )}
    </>
  );
}

function CapsuleAccount({ account, tier }: { account: Account; tier: Tier }) {
  return (
    <>
      <CapsuleAvatar account={account} />
      {tier !== "compact" && (
        <span className={styles.text}>
          <span className={styles.name}>{account.name}</span>
          {tier === "wide" && (
            <span className={styles.kind} data-expired={account.status === "expired" || undefined}>
              {accountLine(account)}
            </span>
          )}
        </span>
      )}
    </>
  );
}

function CapsuleAdd({ tier }: { tier: Tier }) {
  return (
    <>
      <Icon name="user" size={16} />
      {tier !== "compact" && <span>{ACCOUNT_COPY.add}</span>}
    </>
  );
}

/** 账户切片还没读到时的骨架：头像位与名字条（wide 档再加类型条），外框与真实胶囊同一个。 */
function CapsuleSkeleton({ tier }: { tier: Tier }) {
  return (
    <>
      <Skeleton shape="square" size={24} />
      {tier !== "compact" && (
        <span className={styles.skeletonText}>
          <Skeleton shape="block" width={SKELETON_BAR.name} height={SKELETON_BAR.nameHeight} radius="pill" />
          {tier === "wide" && <Skeleton shape="block" width={SKELETON_BAR.kind} height={SKELETON_BAR.kindHeight} radius="pill" />}
        </span>
      )}
    </>
  );
}

function CapsuleAvatar({ account }: { account: Account }) {
  const skin = useAccountSkin(account.uuid);
  // 减少动画时缩放一步到位，照用 dot 档的退场会先跳到 0.6 再淡出：只留淡入淡出
  const mark = useReducedMotionConfig() === true ? popMark.reduced : popMark.dot;
  return (
    <span className={styles.avatar}>
      <AccountAvatar uuid={account.uuid} skin={skin} size={24} />
      {/* 需要重新登录的提醒点：出现时弹入，恢复后淡出缩小 */}
      <AnimatePresence>
        {account.status === "expired" && <motion.span key="expired" className={styles.warnDot} aria-hidden="true" {...mark} />}
      </AnimatePresence>
    </span>
  );
}

interface AccountMenuProps {
  accounts: readonly Account[];
  currentId: string;
  onPick: (account: Account) => void;
  onManage: () => void;
}

function AccountMenu({ accounts, currentId, onPick, onManage }: AccountMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const items = () => (listRef.current === null ? [] : [...listRef.current.querySelectorAll<HTMLElement>("[data-menu-item]")]);

  useLayoutEffect(() => {
    const all = items();
    const target = all.find((el) => el.dataset.current !== undefined);
    if (target === undefined) throw new Error("账户菜单里没有当前账户");
    target.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (isImeComposing(event)) return;
    const all = items();
    const from = all.findIndex((el) => el === document.activeElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (from + 1) % all.length;
        break;
      case "ArrowUp":
        next = from <= 0 ? all.length - 1 : from - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = all.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    all[next].focus();
  };

  return (
    <div ref={listRef} className={styles.menu} role="menu" aria-label={ACCOUNT_COPY.menuLabel} onKeyDown={onKeyDown}>
      {accounts.map((account) => (
        <AccountRow key={account.uuid} account={account} current={account.uuid === currentId} onPick={() => onPick(account)} />
      ))}
      <div className={styles.separator} role="separator" />
      <button type="button" className={styles.item} role="menuitem" tabIndex={-1} data-menu-item="" onClick={onManage}>
        <span className={styles.manageIcon} aria-hidden="true">
          <Icon name="users" size={16} />
        </span>
        <span className={styles.itemText}>
          <span className={styles.itemName}>{ACCOUNT_COPY.manage}</span>
          <span className={styles.itemLine}>{ACCOUNT_COPY.manageHint}</span>
        </span>
      </button>
    </div>
  );
}

function AccountRow({ account, current, onPick }: { account: Account; current: boolean; onPick: () => void }) {
  const skin = useAccountSkin(account.uuid);
  return (
    <button
      type="button"
      className={styles.item}
      role="menuitemradio"
      aria-checked={current}
      tabIndex={-1}
      data-menu-item=""
      data-current={current || undefined}
      onClick={onPick}
    >
      <AccountAvatar uuid={account.uuid} skin={skin} size={32} current={current} />
      <span className={styles.itemText}>
        <span className={styles.itemName}>{account.name}</span>
        <span className={styles.itemLine} data-expired={account.status === "expired" || undefined}>
          {accountLine(account)}
        </span>
      </span>
      {current && (
        <span className={styles.check} aria-hidden="true">
          <Icon name="check" size={16} />
        </span>
      )}
    </button>
  );
}
