// 外置登录（authlib-injector 认证服务器）：服务器 -> 登录 -> 选择角色（只有一个角色时没有这一步）。
// 能原位说清的错误（连不上、不是认证服务器、地址无效、账户密码错、网络断、没有角色、服务器拒绝）显示在出错的那一步；
// 其余错误照常交给外层统一处理（error 通知）。登录成功后由状态容器关掉弹窗并发通知。
// 重新登录时带着上次解析好的 API 地址、服务器名与账号进来：直接停在登录这一步，密码为空，不再探测一次服务器。
// 从皮肤站把服务器链接拖进窗口时带着解出来的地址进来：填进第一步并立即执行一次「下一步」，与用户手动点一样。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import { AccountAvatar } from "../../art/skin/AccountAvatar";
import { ACTION_ERROR, AUTHLIB_COPY, LITTLESKIN_API } from "../../copy/flows";
import type { AuthlibProfile, AuthServer } from "../../domain/adapt";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import type { AuthlibPrefill } from "../../state/login";
import { usedAuthServers } from "../../state/selectors";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import { IconButton } from "../../ui/IconButton";
import { Modal } from "../../ui/Modal";
import { useRovingGroup } from "../../ui/roving";
import { TextInput } from "../../ui/TextInput";
import { AUTHLIB_DIALOG_COPY, LOGIN_ERROR } from "../../copy/login";
import { loginProblem, normalizeServerUrl, probeProblem, type InlineProblem, type LoginProblem } from "./errors";
import styles from "./login.module.css";

export type AuthlibStep = "server" | "login" | "profile";

const STEP_ORDER: readonly AuthlibStep[] = ["server", "login", "profile"];

interface PendingProfiles {
  pendingId: string;
  serverName: string;
  profiles: AuthlibProfile[];
}

/** 重新登录时的服务器：API 根地址就是上次登录时解析出来的那个，域名从它取。 */
function prefilledServer(prefill: AuthlibPrefill): { url: string; info: AuthServer } {
  return { url: prefill.serverUrl, info: { apiRoot: prefill.serverUrl, serverName: prefill.serverName, host: new URL(prefill.serverUrl).host } };
}

/** 两份「用过的验证服务器」逐项相同：账户列表换了新数组、内容没变时不让弹窗重渲染。 */
function sameServers(a: readonly { serverUrl: string; serverName: string }[], b: readonly { serverUrl: string; serverName: string }[]): boolean {
  return a.length === b.length && a.every((s, i) => s.serverUrl === b[i].serverUrl && s.serverName === b[i].serverName);
}

export function AuthlibDialog({ prefill, dropped }: { prefill: AuthlibPrefill | null; dropped: string | null }) {
  const usedServers = useLauncherSelector((s) => usedAuthServers(s, [LITTLESKIN_API]), sameServers);
  const actions = useLauncherActions();
  const run = useRunner();
  const [step, setStep] = useState<AuthlibStep>(prefill === null ? "server" : "login");

  // ---- 第一步：服务器
  const [serverInput, setServerInput] = useState(prefill !== null ? prefill.serverUrl : dropped !== null ? dropped : "");
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<InlineProblem | null>(null);
  const [server, setServer] = useState<{ url: string; info: AuthServer } | null>(() => (prefill === null ? null : prefilledServer(prefill)));
  const normalized = normalizeServerUrl(serverInput);

  const probe = (input: string) =>
    void run(async () => {
      const url = normalizeServerUrl(input);
      setProbing(true);
      setProbeError(null);
      try {
        const outcome = await actions.probeAuthServer(url).then(
          (info) => ({ ok: true as const, info }),
          (error: unknown) => {
            const problem = probeProblem(error);
            if (problem === null) throw error;
            return { ok: false as const, problem };
          },
        );
        if (!outcome.ok) {
          setProbeError(outcome.problem);
          return;
        }
        setServer({ url, info: outcome.info });
        setStep("login");
      } finally {
        setProbing(false);
      }
    }, LOGIN_ERROR.probe);

  // 拖进来的地址只自动探测一次：StrictMode 的二次执行、之后的重渲染都不再探测；失败时原因照常写在这一步
  const autoProbed = useRef(false);
  const probeDropped = useRef(probe);
  probeDropped.current = probe;
  useEffect(() => {
    if (dropped === null || autoProbed.current) return;
    autoProbed.current = true;
    probeDropped.current(dropped);
  }, [dropped]);

  // ---- 第二步：登录
  const [username, setUsername] = useState(prefill === null || prefill.username === null ? "" : prefill.username);
  // 账号已经填好时，打开就落在密码框
  const focusPassword = prefill !== null && prefill.username !== null;
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<LoginProblem | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const canLogin = username.trim() !== "" && password !== "";

  // ---- 第三步：角色
  const [pending, setPending] = useState<PendingProfiles | null>(null);
  const [profileUuid, setProfileUuid] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);

  const submitLogin = () => {
    if (!canLogin || loggingIn) return;
    if (server === null) throw new Error("外置登录还没有选定服务器");
    const url = server.url;
    void run(async () => {
      setLoggingIn(true);
      setLoginError(null);
      try {
        const outcome = await actions.authlibLogin(url, username.trim(), password).then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => {
            const problem = loginProblem(error);
            if (problem === null) throw error;
            return { ok: false as const, problem };
          },
        );
        if (!outcome.ok) {
          setLoginError(outcome.problem);
          if (outcome.problem.kind === "credentials") {
            setPassword("");
            passwordRef.current?.focus();
          }
          return;
        }
        // logged_in：状态容器已经关掉弹窗
        if (outcome.result.status !== "select_profile") return;
        const first = outcome.result.profiles[0];
        if (first === undefined) throw new Error("认证服务器要求选择角色，却没有给出任何角色");
        setPending({ pendingId: outcome.result.pendingId, serverName: outcome.result.serverName, profiles: outcome.result.profiles });
        setProfileUuid(first.uuid);
        setStep("profile");
      } finally {
        setLoggingIn(false);
      }
    }, ACTION_ERROR.authlib);
  };

  const submitProfile = () => {
    if (pending === null || profileUuid === null) throw new Error("还没有可选的角色");
    const { pendingId } = pending;
    void run(async () => {
      setSelecting(true);
      try {
        await actions.selectAuthlibProfile(pendingId, profileUuid);
      } finally {
        setSelecting(false);
      }
    }, ACTION_ERROR.authlib);
  };

  // 换步之后焦点落到这一步的第一个输入（弹窗自己的初始焦点只在打开时生效）
  const bodyRef = useRef<HTMLDivElement>(null);
  const firstStep = useRef(true);
  useLayoutEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    const body = bodyRef.current;
    if (body === null) throw new Error("外置登录弹窗的内容还没挂载");
    const target = body.querySelector<HTMLElement>("[data-autofocus]");
    if (target === null) throw new Error(`外置登录的「${AUTHLIB_DIALOG_COPY.steps[STEP_ORDER.indexOf(step)]}」一步没有可聚焦的输入`);
    target.focus();
  }, [step]);

  const close = () => void run(() => actions.closeLogin(), LOGIN_ERROR.close);
  const back = () => {
    if (step === "login") {
      setLoginError(null);
      setStep("server");
    } else if (step === "profile") {
      setPending(null);
      setStep("login");
    }
  };

  let footer: ReactNode;
  switch (step) {
    case "server":
      footer = (
        <>
          <Button variant="ghost" onClick={close}>
            {AUTHLIB_DIALOG_COPY.cancel}
          </Button>
          <Button variant="primary" iconRight="arrow-right" loading={probing} disabled={normalized === ""} onClick={() => probe(serverInput)}>
            {AUTHLIB_COPY.next}
          </Button>
        </>
      );
      break;
    case "login":
      // 登录在途时不能退回去换服务器：回来的结果仍会把弹窗带到这次服务器的角色选择上
      footer = (
        <>
          <Button variant="ghost" disabled={loggingIn} onClick={back}>
            {AUTHLIB_DIALOG_COPY.back}
          </Button>
          <Button variant="primary" loading={loggingIn} disabled={!canLogin} onClick={submitLogin}>
            {AUTHLIB_COPY.login}
          </Button>
        </>
      );
      break;
    case "profile":
      footer = (
        <>
          <Button variant="ghost" disabled={selecting} onClick={back}>
            {AUTHLIB_DIALOG_COPY.back}
          </Button>
          <Button variant="primary" loading={selecting} onClick={submitProfile}>
            {AUTHLIB_COPY.pickProfile}
          </Button>
        </>
      );
      break;
  }

  return (
    <Modal open onClose={close} size="md" icon="server" title={AUTHLIB_COPY.title} closeOnScrim={false} footer={footer}>
      <div ref={bodyRef} className={styles.authlib}>
        <StepIndicator step={step} />
        {step === "server" && (
          <div className={styles.section}>
            <Field label={AUTHLIB_COPY.serverLabel} hint={normalized !== "" && normalized !== serverInput.trim() ? AUTHLIB_DIALOG_COPY.willUse(normalized) : undefined}>
              <TextInput
                type="url"
                value={serverInput}
                onChange={(value) => {
                  setServerInput(value);
                  setProbeError(null);
                }}
                placeholder={AUTHLIB_COPY.serverPlaceholder}
                icon="server"
                clearable
                spellCheck={false}
                autoComplete="off"
                data-autofocus=""
                onEnter={() => {
                  if (normalized !== "" && !probing) probe(serverInput);
                }}
              />
            </Field>
            <div className={styles.presets}>
              <button type="button" className={styles.preset} onClick={() => setServerInput(LITTLESKIN_API)}>
                {AUTHLIB_COPY.preset}
              </button>
              {usedServers.map((used) => (
                <button key={used.serverUrl} type="button" className={styles.preset} title={used.serverUrl} onClick={() => setServerInput(used.serverUrl)}>
                  {used.serverName}
                </button>
              ))}
            </div>
            {/* 这一步的说明块留给探测失败；地址不是 https 与它可能同时成立，这句写成行 */}
            {normalized.startsWith("http://") && (
              <p className={styles.warnNote}>
                <Icon name="alert" size={16} className={styles.warnNoteIcon} />
                <span>{AUTHLIB_COPY.httpWarning}</span>
              </p>
            )}
            {probeError !== null && (
              <Callout tone="danger" announce>
                <strong className={styles.problemTitle}>{probeError.title}</strong>
                <span>{probeError.body}</span>
              </Callout>
            )}
          </div>
        )}
        {step === "login" && server !== null && (
          <div className={styles.section}>
            <div className={styles.serverCard}>
              <span className={styles.serverIcon} aria-hidden="true">
                <Icon name="server" size={18} />
              </span>
              <div className={styles.serverText}>
                <p className={styles.serverName}>{server.info.serverName}</p>
                <p className={styles.serverUrl}>{server.info.apiRoot}</p>
              </div>
              <Button variant="ghost" size="sm" disabled={loggingIn} onClick={back}>
                {AUTHLIB_DIALOG_COPY.changeServer}
              </Button>
            </div>
            <Field label={AUTHLIB_COPY.username}>
              <TextInput
                value={username}
                onChange={setUsername}
                autoComplete="username"
                spellCheck={false}
                data-autofocus={focusPassword ? undefined : ""}
                onEnter={submitLogin}
              />
            </Field>
            <Field label={AUTHLIB_COPY.password} hint={AUTHLIB_COPY.passwordNote} error={loginError !== null && loginError.kind === "credentials" ? AUTHLIB_COPY.badCredentials : undefined}>
              <TextInput
                ref={passwordRef}
                type={reveal ? "text" : "password"}
                value={password}
                onChange={(value) => {
                  setPassword(value);
                  if (loginError !== null && loginError.kind === "credentials") setLoginError(null);
                }}
                autoComplete="current-password"
                data-autofocus={focusPassword ? "" : undefined}
                onEnter={submitLogin}
                trailing={
                  <IconButton
                    icon="eye"
                    size="sm"
                    label={AUTHLIB_DIALOG_COPY.showPassword}
                    pressed={reveal}
                    onClick={() => setReveal((v) => !v)}
                  />
                }
              />
            </Field>
            {loginError !== null && loginError.kind === "network" && (
              <Callout
                tone="danger"
                announce
                action={
                  <Button variant="secondary" size="sm" icon="refresh" onClick={submitLogin}>
                    {AUTHLIB_COPY.retry}
                  </Button>
                }
              >
                {AUTHLIB_COPY.network}
              </Callout>
            )}
            {loginError !== null && loginError.kind === "no_profile" && (
              <Callout tone="warn" announce>
                <strong className={styles.problemTitle}>{AUTHLIB_COPY.noProfile.title}</strong>
                <span>{AUTHLIB_COPY.noProfile.body}</span>
              </Callout>
            )}
            {loginError !== null && loginError.kind === "rejected" && (
              <Callout tone="danger" announce>
                {loginError.message}
              </Callout>
            )}
          </div>
        )}
        {step === "profile" && pending !== null && profileUuid !== null && (
          <ProfilePicker pending={pending} value={profileUuid} onChange={setProfileUuid} />
        )}
      </div>
    </Modal>
  );
}

function StepIndicator({ step }: { step: AuthlibStep }) {
  const current = STEP_ORDER.indexOf(step);
  return (
    <ol className={styles.stepper} aria-label={AUTHLIB_DIALOG_COPY.stepsLabel}>
      {AUTHLIB_DIALOG_COPY.steps.map((label, i) => (
        <li key={label} className={styles.stepperItem} data-state={i < current ? "done" : i === current ? "now" : "todo"} aria-current={i === current ? "step" : undefined}>
          <span className={styles.stepperDot} aria-hidden="true">
            {i < current ? <Icon name="check" size={12} /> : i + 1}
          </span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

function ProfilePicker({ pending, value, onChange }: { pending: PendingProfiles; value: string; onChange: (uuid: string) => void }) {
  const group = useRovingGroup(
    pending.profiles.map((p) => ({ value: p.uuid })),
    value,
    onChange,
    false,
  );
  return (
    <div className={styles.section}>
      <p className={styles.lead}>{AUTHLIB_DIALOG_COPY.profileHint(pending.serverName)}</p>
      <div className={styles.profiles} role="radiogroup" aria-label={AUTHLIB_DIALOG_COPY.profiles} onKeyDown={group.onKeyDown}>
        {pending.profiles.map((profile, i) => (
          <button
            key={profile.uuid}
            ref={group.register(i)}
            type="button"
            role="radio"
            aria-checked={profile.uuid === value}
            tabIndex={group.tabIndexOf(i)}
            className={styles.profile}
            data-autofocus={profile.uuid === value ? "" : undefined}
            onClick={() => onChange(profile.uuid)}
          >
            <AccountAvatar uuid={profile.uuid} skin={profile.skin} size={40} current={profile.uuid === value} />
            <span className={styles.profileName}>{profile.name}</span>
            {profile.uuid === value && <Icon name="check" size={16} className={styles.profileCheck} />}
          </button>
        ))}
      </div>
    </div>
  );
}
