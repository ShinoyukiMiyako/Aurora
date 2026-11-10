// 微软设备码登录。状态全部来自状态容器（获取代码中 -> 等待浏览器 -> 成功 / 失败），这里只负责呈现与按钮：
// - 代码过期由界面按 expiresAt 判定（不等后端的错误到达），过期后只能关闭或重新获取。
// - 「复制并打开网页」先把代码写进剪贴板再打开验证页；复制失败就不打开，免得用户到了网页却没有代码。
// - 点遮罩不关（流程里有要抄的代码）；Esc、关闭按钮与「取消登录」都会请后端停掉轮询。
// - 获取代码时按拿到代码后的样子画：两步说明照常显示，只有链接、代码格与倒计时条是骨架，代码到了原位交叉淡化，
//   弹窗不变高。骨架过了加载门的延迟才出现、出现了至少停留同样久，代码很快回来时界面不闪。
// - 等待、成功、失败三种面在主体里交叉淡化，弹窗面板随之形变。
// 弹窗本身由 LoginFlow 渲染（各种登录共用一个），这里只算外框与主体交上去。

import { motion, useReducedMotionConfig } from "framer-motion";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import { AccountAvatar } from "../../art/skin/AccountAvatar";
import { Spinner } from "../../art/Spinner";
import { ACTION_ERROR, MICROSOFT_LOGIN_COPY, microsoftLoginFailure, withoutSettingsAction, type LoginFailureAction } from "../../copy/flows";
import type { Account } from "../../domain/adapt";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import { useLoadingGate, type LoadingView } from "../../lib/loading-gate";
import { codeCell, fade, springs } from "../../lib/motion";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { errorDetailOf } from "../../state/errors";
import { onboardingActive } from "../../state/selectors";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { deviceCodeExpired, deviceCodeRemaining, type DeviceLogin, type LoginState } from "../../state/login";
import { Banner } from "../../ui/Banner";
import { Button, GlyphSlot } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { LabelSlot } from "../../ui/LabelSlot";
import { Loadable } from "../../ui/Loadable";
import { ProgressBar } from "../../ui/ProgressBar";
import { Skeleton } from "../../ui/Skeleton";
import { DEVICE_DIALOG_COPY, LOGIN_ERROR } from "../../copy/login";
import styles from "./login.module.css";
import { useLoginSkin } from "./skin";
import { Swap } from "./Swap";
import { useReportView, type ReportView } from "./view";

/** 没有 Xbox 档案时引导去建档案的网址。 */
const XBOX_URL = "https://www.xbox.com";

/** 字符数超过这个值换小一号的格子，免得一行放不下。 */
const LONG_CODE = 9;
/** 获取代码时占位的格子：微软的代码通常是 8 位、中间一个连字符，骨架按 4 格、短横、4 格排。 */
const PLACEHOLDER_HALF = 4;

/** 底栏两个按钮在获取、等待、过期之间换文案：叠在同一格里按最宽的一条定宽，换文案时右对齐的底栏不横移。 */
const DISMISS_LABELS = [DEVICE_DIALOG_COPY.cancelLogin, DEVICE_DIALOG_COPY.close];
const PRIMARY_LABELS = [MICROSOFT_LOGIN_COPY.copyAndOpen, MICROSOFT_LOGIN_COPY.reacquire];

type MicrosoftLogin = Extract<LoginState, { kind: "microsoft" }>;
type WaitingDevice = Extract<DeviceLogin, { status: "waiting" }>;

/** 过期倒计时进度条的满额：第一次看到这个代码时离过期还有多久。 */
export function useCodeLifetime(device: DeviceLogin): number | null {
  const lifetime = useRef<{ code: string; totalMs: number } | null>(null);
  if (device.status !== "waiting") return null;
  if (lifetime.current === null || lifetime.current.code !== device.userCode) {
    lifetime.current = { code: device.userCode, totalMs: device.expiresAt - Date.now() };
  }
  return lifetime.current.totalMs;
}

export const DeviceCodeDialog = memo(function DeviceCodeDialog({ login, report }: { login: MicrosoftLogin; report: ReportView }) {
  const actions = useLauncherActions();
  const run = useRunner();
  const { copyText } = useShell();
  const { go } = useNav();
  const device = login.device;
  const now = useNow(1000);
  const totalMs = useCodeLifetime(device);
  const onboarding = useLauncherSelector(onboardingActive);
  const gate = useLoadingGate(device.status === "requesting");

  const close = () => void run(() => actions.closeLogin(), ACTION_ERROR.cancelLogin);
  const restart = () => void run(() => actions.startMicrosoftLogin(login.intent), ACTION_ERROR.microsoftLogin);

  const success = device.status === "success";
  let body: ReactNode;
  let footer: ReactNode;
  switch (device.status) {
    // 获取中与等待中是同一张面，底栏也是同两个按钮，只换文案与图标，宽度不变
    case "requesting":
    case "waiting": {
      const waiting = device.status === "waiting" ? device : null;
      const expired = waiting !== null && deviceCodeExpired(waiting, now);
      const copyAndOpen = (code: WaitingDevice) => () =>
        void copyText(code.userCode).then((copied) => {
          if (copied) void run(() => actions.openExternal(code.verificationUri), LOGIN_ERROR.openPage);
        });
      body = <DeviceSteps view={gate.view} device={waiting} expired={expired} now={now} totalMs={totalMs} />;
      footer = (
        <>
          <Button variant="ghost" onClick={close}>
            <LabelSlot current={expired ? DEVICE_DIALOG_COPY.close : DEVICE_DIALOG_COPY.cancelLogin} options={DISMISS_LABELS} />
          </Button>
          <Button
            variant="primary"
            icon={expired ? "refresh" : "external"}
            disabled={waiting === null}
            data-autofocus={waiting === null ? undefined : ""}
            onClick={waiting === null ? undefined : expired ? restart : copyAndOpen(waiting)}
          >
            <LabelSlot current={expired ? MICROSOFT_LOGIN_COPY.reacquire : MICROSOFT_LOGIN_COPY.copyAndOpen} options={PRIMARY_LABELS} />
          </Button>
        </>
      );
      break;
    }
    case "success":
      body = <Success account={device.account} updated={device.updated} />;
      footer = (
        <Button variant="primary" data-autofocus="" onClick={close}>
          {MICROSOFT_LOGIN_COPY.done}
        </Button>
      );
      break;
    case "failed": {
      const failure = microsoftLoginFailure(device.code, device.message, device.detail);
      const copy = onboarding ? withoutSettingsAction(failure) : failure;
      const act = (action: LoginFailureAction) => () => {
        switch (action.kind) {
          case "retry":
            restart();
            return;
          case "open_xbox":
            void run(() => actions.openExternal(XBOX_URL), LOGIN_ERROR.openPage);
            return;
          case "use_offline":
            void run(() => actions.openLogin("offline", login.intent), ACTION_ERROR.addOffline);
            return;
          case "copy_error":
            void copyText(errorDetailOf(device.code, device.message, device.detail));
            return;
          case "close":
            close();
            return;
          case "open_client_id_settings":
            // client_id 在常规分区的高级卡片里；先关弹窗，免得它盖在设置页上面
            void run(async () => {
              await actions.closeLogin();
              go({ page: "settings", section: "general" });
            }, ACTION_ERROR.cancelLogin);
            return;
        }
      };
      body = (
        <Banner tone="danger" title={copy.title} announce>
          {copy.body}
        </Banner>
      );
      footer = (
        <>
          <Button variant="ghost" data-autofocus={copy.closeOnly ? "" : undefined} onClick={close}>
            {DEVICE_DIALOG_COPY.close}
          </Button>
          {copy.secondary !== null && (
            <Button variant="secondary" onClick={act(copy.secondary)}>
              {copy.secondary.label}
            </Button>
          )}
          {copy.primary !== null && (
            <Button variant="primary" data-autofocus="" onClick={act(copy.primary)}>
              {copy.primary.label}
            </Button>
          )}
        </>
      );
      break;
    }
  }

  useReportView(report, {
    kind: "microsoft",
    title: success ? DEVICE_DIALOG_COPY.doneTitle : DEVICE_DIALOG_COPY.title,
    subtitle: success ? undefined : DEVICE_DIALOG_COPY.subtitle,
    icon: "shield",
    size: "md",
    closeOnScrim: false,
    onClose: close,
    // 倒计时每秒重渲染一次，只在换状态、骨架换成代码时量布局
    layoutKey: `${device.status}:${gate.view}`,
    footer,
    body: <Swap id={success ? "success" : device.status === "failed" ? "failed" : "code"}>{body}</Swap>,
  });
  return null;
});

interface DeviceStepsProps {
  view: LoadingView;
  /** 已拿到的代码；还在获取时为 null。 */
  device: WaitingDevice | null;
  expired: boolean;
  now: number;
  totalMs: number | null;
}

/** 获取中与等待中共用的一张面：两步说明常驻，链接、代码格与倒计时条在骨架与内容之间交叉淡化。 */
function DeviceSteps({ view, device, expired, now, totalMs }: DeviceStepsProps) {
  // 内容只在加载门放行之后求值，放行只发生在获取结束、代码已到之后
  const arrived = (): { code: WaitingDevice; totalMs: number } => {
    if (device === null || totalMs === null) throw new Error("设备码还没到，不该画代码");
    return { code: device, totalMs };
  };
  const ready = view === "content";
  return (
    <div className={styles.device}>
      <ol className={styles.steps}>
        <li className={styles.step}>
          <span className={styles.stepNo} aria-hidden="true">
            1
          </span>
          <div className={styles.stepBody}>
            <p className={styles.stepTitle}>{MICROSOFT_LOGIN_COPY.stepOpen}</p>
            <Loadable view={view} skeleton={<LinkSkeleton />}>
              {() => {
                const { code } = arrived();
                return (
                  <div className={styles.link}>
                    <span className={styles.linkText}>{code.verificationUri}</span>
                    <CopyLink text={code.verificationUri} />
                  </div>
                );
              }}
            </Loadable>
          </div>
        </li>
        <li className={styles.step}>
          <span className={styles.stepNo} aria-hidden="true">
            2
          </span>
          <div className={styles.stepBody}>
            <p className={styles.stepTitle}>{MICROSOFT_LOGIN_COPY.stepCode}</p>
            <Loadable view={view} skeleton={<CodeSkeleton />}>
              {() => <CodeCells code={arrived().code.userCode} expired={expired} />}
            </Loadable>
          </div>
        </li>
      </ol>
      <div className={styles.wait} data-expired={expired || undefined}>
        <p className={styles.waitLine} role="status">
          {/* 图标位常驻：加载门等待期间空着，转圈出现、换成时钟时文字不横移 */}
          <span className={styles.waitIcon}>
            <GlyphSlot glyph={view === "pending" ? null : expired ? "clock" : "spinner"}>
              {expired ? <Icon name="clock" size={18} /> : <Spinner size={18} decorative />}
            </GlyphSlot>
          </span>
          <span className={styles.waitText}>{!ready ? MICROSOFT_LOGIN_COPY.fetching : expired ? MICROSOFT_LOGIN_COPY.expired : MICROSOFT_LOGIN_COPY.waiting}</span>
          {ready && !expired && <span className={styles.countdown}>{MICROSOFT_LOGIN_COPY.expiresIn(deviceCodeRemaining(arrived().code, now))}</span>}
        </p>
        {/* 倒计时条（sm 档高 4）只减不增：每秒换一次标识，让它直接跳到新值 */}
        <Loadable view={view} skeleton={<Skeleton shape="block" width="100%" height={4} radius="pill" />}>
          {() => {
            const { code, totalMs: total } = arrived();
            return (
              <ProgressBar
                value={expired ? 0 : Math.min(1, deviceCodeRemaining(code, now) / total)}
                tone={expired ? "danger" : "accent"}
                size="sm"
                track={`${code.userCode}:${Math.floor(now / 1000)}`}
                label={DEVICE_DIALOG_COPY.remaining}
              />
            );
          }}
        </Loadable>
      </div>
    </div>
  );
}

/** 链接行的骨架：同样的边框底色与高度，网址是骨架条，复制键的位置空着。 */
function LinkSkeleton() {
  return (
    <div className={styles.link}>
      <span className={styles.linkText}>
        <Skeleton shape="text" width="64%" />
      </span>
      <span className={styles.copySpace} />
    </div>
  );
}

/** 代码格的骨架：格子与真格同尺寸，短横用真的。 */
function CodeSkeleton() {
  const half = (side: string) => Array.from({ length: PLACEHOLDER_HALF }, (_, i) => <Skeleton key={`${side}${i}`} shape="block" width={44} height={58} radius="md" />);
  return (
    <div className={styles.code}>
      {half("head")}
      <span className={styles.dash} />
      {half("tail")}
    </div>
  );
}

export function CodeCells({ code, expired }: { code: string; expired: boolean }) {
  // 减少动画：序号都按 0，整组一次淡入，不逐格等
  const reduced = useReducedMotionConfig() === true;
  const chars = [...code];
  const long = chars.filter((c) => c !== "-").length > LONG_CODE;
  return (
    <div className={styles.code} data-long={long || undefined} data-expired={expired || undefined} role="img" aria-label={DEVICE_DIALOG_COPY.codeLabel(code)}>
      {chars.map((ch, i) => (
        // 短横跟着自己的序号入场，不先于两侧的格子单独出现
        <motion.span key={`${code}-${i}`} className={ch === "-" ? styles.dash : styles.cell} variants={codeCell} custom={reduced ? 0 : i} initial="hidden" animate="show">
          {ch === "-" ? null : ch}
        </motion.span>
      ))}
    </div>
  );
}

function CopyLink({ text }: { text: string }) {
  const { copyText } = useShell();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () =>
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    });
  return <IconButton icon={copied ? "check" : "copy"} size="sm" label={copied ? DEVICE_DIALOG_COPY.copied : MICROSOFT_LOGIN_COPY.copyLink} onClick={copy} />;
}

function Success({ account, updated }: { account: Account; updated: boolean }) {
  const skin = useLoginSkin(account.uuid);
  return (
    <div className={styles.success}>
      <motion.span className={styles.successMark} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1, transition: { ...springs.base, opacity: fade.in } }} aria-hidden="true">
        <Icon name="check" size={24} />
      </motion.span>
      <p className={styles.successTitle} role="status">
        {updated ? MICROSOFT_LOGIN_COPY.updated(account.name) : MICROSOFT_LOGIN_COPY.success(account.name)}
      </p>
      <p className={styles.successSub}>{DEVICE_DIALOG_COPY.successSub}</p>
      <div className={styles.chip}>
        <AccountAvatar uuid={account.uuid} skin={skin} size={48} current />
        <div className={styles.chipText}>
          <p className={styles.chipName}>{account.name}</p>
          <p className={styles.chipLine}>{DEVICE_DIALOG_COPY.accountLine}</p>
        </div>
      </div>
    </div>
  );
}
