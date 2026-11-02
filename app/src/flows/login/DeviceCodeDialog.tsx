// 微软设备码登录。状态全部来自状态容器（获取代码中 -> 等待浏览器 -> 成功 / 失败），这里只负责呈现与按钮：
// - 代码过期由界面按 expiresAt 判定（不等后端的错误到达），过期后只能关闭或重新获取。
// - 「复制并打开网页」先把代码写进剪贴板再打开验证页；复制失败就不打开，免得用户到了网页却没有代码。
// - 点遮罩不关（流程里有要抄的代码）；Esc、关闭按钮与「取消登录」都会请后端停掉轮询。

import { motion } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import { AccountAvatar } from "../../art/skin/AccountAvatar";
import { Spinner } from "../../art/Spinner";
import { ACTION_ERROR, MICROSOFT_LOGIN_COPY, microsoftLoginFailure, withoutSettingsAction, type LoginFailureAction } from "../../copy/flows";
import type { Account } from "../../domain/adapt";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import { fade, springs } from "../../lib/motion";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { errorDetailOf } from "../../state/errors";
import { onboardingActive } from "../../state/selectors";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { deviceCodeExpired, deviceCodeRemaining, type DeviceLogin, type LoginState } from "../../state/login";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { IconButton } from "../../ui/IconButton";
import { Modal } from "../../ui/Modal";
import { ProgressBar } from "../../ui/ProgressBar";
import { Skeleton } from "../../ui/Skeleton";
import { DEVICE_DIALOG_COPY, LOGIN_ERROR } from "../../copy/login";
import styles from "./login.module.css";
import { useLoginSkin } from "./skin";

/** 没有 Xbox 档案时引导去建档案的网址。 */
const XBOX_URL = "https://www.xbox.com";

/** 代码格子逐个弹出的间隔（秒）。 */
const CELL_STAGGER_S = 0.05;
/** 字符数超过这个值换小一号的格子，免得一行放不下。 */
const LONG_CODE = 9;
/** 获取代码时占位的格子数：微软的代码通常是 8 位、中间一个连字符。 */
const PLACEHOLDER_CELLS = 8;

type MicrosoftLogin = Extract<LoginState, { kind: "microsoft" }>;

/** 过期倒计时进度条的满额：第一次看到这个代码时离过期还有多久。 */
export function useCodeLifetime(device: DeviceLogin): number | null {
  const lifetime = useRef<{ code: string; totalMs: number } | null>(null);
  if (device.status !== "waiting") return null;
  if (lifetime.current === null || lifetime.current.code !== device.userCode) {
    lifetime.current = { code: device.userCode, totalMs: device.expiresAt - Date.now() };
  }
  return lifetime.current.totalMs;
}

export function DeviceCodeDialog({ login }: { login: MicrosoftLogin }) {
  const actions = useLauncherActions();
  const run = useRunner();
  const { copyText } = useShell();
  const { go } = useNav();
  const device = login.device;
  const now = useNow(1000);
  const totalMs = useCodeLifetime(device);
  const onboarding = useLauncherSelector(onboardingActive);

  const close = () => void run(() => actions.closeLogin(), ACTION_ERROR.cancelLogin);
  const restart = () => void run(() => actions.startMicrosoftLogin(login.intent), ACTION_ERROR.microsoftLogin);

  const success = device.status === "success";
  let body: ReactNode;
  let footer: ReactNode;
  switch (device.status) {
    case "requesting":
      body = <Requesting />;
      footer = (
        <>
          <Button variant="ghost" onClick={close}>
            {DEVICE_DIALOG_COPY.cancelLogin}
          </Button>
          <Button variant="primary" icon="external" disabled>
            {MICROSOFT_LOGIN_COPY.copyAndOpen}
          </Button>
        </>
      );
      break;
    case "waiting": {
      if (totalMs === null) throw new Error("等待中的设备码没有记下有效期");
      const expired = deviceCodeExpired(device, now);
      body = <Waiting device={device} expired={expired} remainingMs={deviceCodeRemaining(device, now)} totalMs={totalMs} now={now} />;
      footer = expired ? (
        <>
          <Button variant="ghost" onClick={close}>
            {DEVICE_DIALOG_COPY.close}
          </Button>
          <Button variant="primary" icon="refresh" data-autofocus="" onClick={restart}>
            {MICROSOFT_LOGIN_COPY.reacquire}
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={close}>
            {DEVICE_DIALOG_COPY.cancelLogin}
          </Button>
          <Button
            variant="primary"
            icon="external"
            data-autofocus=""
            onClick={() =>
              void copyText(device.userCode).then((copied) => {
                if (copied) void run(() => actions.openExternal(device.verificationUri), LOGIN_ERROR.openPage);
              })
            }
          >
            {MICROSOFT_LOGIN_COPY.copyAndOpen}
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

  return (
    <Modal
      open
      onClose={close}
      size="md"
      icon="shield"
      title={success ? DEVICE_DIALOG_COPY.doneTitle : DEVICE_DIALOG_COPY.title}
      subtitle={success ? undefined : DEVICE_DIALOG_COPY.subtitle}
      closeOnScrim={false}
      footer={footer}
    >
      {body}
    </Modal>
  );
}

function Requesting() {
  return (
    <div className={styles.device}>
      <div className={styles.code} aria-hidden="true">
        {Array.from({ length: PLACEHOLDER_CELLS }, (_, i) => (
          <Skeleton key={i} shape="block" width={44} height={58} radius="md" />
        ))}
      </div>
      <p className={styles.waitLine} role="status">
        <Spinner size={18} decorative />
        <span>{MICROSOFT_LOGIN_COPY.fetching}</span>
      </p>
    </div>
  );
}

interface WaitingProps {
  device: Extract<DeviceLogin, { status: "waiting" }>;
  expired: boolean;
  remainingMs: number;
  totalMs: number;
  now: number;
}

function Waiting({ device, expired, remainingMs, totalMs, now }: WaitingProps) {
  return (
    <div className={styles.device}>
      <ol className={styles.steps}>
        <li className={styles.step}>
          <span className={styles.stepNo} aria-hidden="true">
            1
          </span>
          <div className={styles.stepBody}>
            <p className={styles.stepTitle}>{MICROSOFT_LOGIN_COPY.stepOpen}</p>
            <div className={styles.link}>
              <span className={styles.linkText}>{device.verificationUri}</span>
              <CopyLink text={device.verificationUri} />
            </div>
          </div>
        </li>
        <li className={styles.step}>
          <span className={styles.stepNo} aria-hidden="true">
            2
          </span>
          <div className={styles.stepBody}>
            <p className={styles.stepTitle}>{MICROSOFT_LOGIN_COPY.stepCode}</p>
            <CodeCells code={device.userCode} expired={expired} />
          </div>
        </li>
      </ol>
      <div className={styles.wait} data-expired={expired || undefined}>
        <p className={styles.waitLine} role="status">
          {expired ? <Icon name="clock" size={18} /> : <Spinner size={18} decorative />}
          <span className={styles.waitText}>{expired ? MICROSOFT_LOGIN_COPY.expired : MICROSOFT_LOGIN_COPY.waiting}</span>
          {!expired && <span className={styles.countdown}>{MICROSOFT_LOGIN_COPY.expiresIn(remainingMs)}</span>}
        </p>
        {/* 倒计时条只减不增：每秒换一次标识，让它直接跳到新值 */}
        <ProgressBar
          value={expired ? 0 : Math.min(1, remainingMs / totalMs)}
          tone={expired ? "danger" : "accent"}
          size="sm"
          track={`${device.userCode}:${Math.floor(now / 1000)}`}
          label={DEVICE_DIALOG_COPY.remaining}
        />
      </div>
    </div>
  );
}

export function CodeCells({ code, expired }: { code: string; expired: boolean }) {
  const chars = [...code];
  const long = chars.filter((c) => c !== "-").length > LONG_CODE;
  return (
    <div className={styles.code} data-long={long || undefined} data-expired={expired || undefined} role="img" aria-label={DEVICE_DIALOG_COPY.codeLabel(code)}>
      {chars.map((ch, i) =>
        ch === "-" ? (
          <span key={`${code}-${i}`} className={styles.dash} />
        ) : (
          <motion.span
            key={`${code}-${i}`}
            className={styles.cell}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in, delay: i * CELL_STAGGER_S } }}
          >
            {ch}
          </motion.span>
        ),
      )}
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
      <motion.span className={styles.successMark} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in } }} aria-hidden="true">
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
