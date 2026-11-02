// 第三步：添加账户。三种方式各打开同一个登录弹窗（叠在向导之上），向导本身不复刻登录界面；
// 添加成功后在上方列出已添加的账户，三张选项卡收成一行按钮，「继续添加」再展开。
// 不能用的方式在这一步就置灰并写原因：向导期间主界面没挂上，登录失败卡里「打开设置」去不了设置页。

import { useState } from "react";
import { Icon } from "../../art/Icon";
import { AccountAvatar } from "../../art/skin/AccountAvatar";
import { accountKindLabel, MSA_CLIENT_ID_MISSING } from "../../copy/flows";
import type { Account } from "../../domain/adapt";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { useSkinInfo } from "../../state/queries/home";
import { Button } from "../../ui/Button";
import { ACCOUNT_STEP_COPY, LOGIN_OPTIONS } from "./copy";
import s from "./onboarding.module.css";
import { useOnline } from "../../state/online";
import { microsoftLoginUnavailable } from "../../state/selectors";

type LoginOption = (typeof LOGIN_OPTIONS)[number];
type LoginKind = LoginOption["kind"];

interface Availability {
  online: boolean;
  microsoftUnavailable: boolean;
}

/** 这种方式现在用不了的原因；能用为 null。 */
function blockedReason(option: LoginOption, { online, microsoftUnavailable }: Availability): string | null {
  if (option.kind === "microsoft" && microsoftUnavailable) return MSA_CLIENT_ID_MISSING.onboardingReason;
  if (option.online && !online) return ACCOUNT_STEP_COPY.offlineReason;
  return null;
}

function AccountChip({ account }: { account: Account }) {
  const skin = useSkinInfo(account.uuid);
  return (
    <li className={s.accountChip}>
      <AccountAvatar uuid={account.uuid} skin={skin.status === "ready" ? skin.data : null} size={32} />
      <span className={s.accountText}>
        <span className={s.accountName}>{account.name}</span>
        <span className={s.caption}>{accountKindLabel(account.kind, account.authServer)}</span>
      </span>
    </li>
  );
}

function useOpenLogin(): (kind: LoginKind) => void {
  const actions = useLauncherActions();
  const run = useRunner();
  return (kind) => void run(() => actions.openLogin(kind), ACCOUNT_STEP_COPY.loginFailed);
}

function OptionCards({ availability }: { availability: Availability }) {
  const open = useOpenLogin();
  return (
    <ul className={s.loginOptions}>
      {LOGIN_OPTIONS.map((option) => {
        const reason = blockedReason(option, availability);
        return (
          <li key={option.kind}>
            <button type="button" className={s.loginOption} data-kind={option.kind} disabled={reason !== null} onClick={() => open(option.kind)}>
              <span className={s.loginIcon}>
                <Icon name={option.icon} size={20} />
              </span>
              <span className={s.loginText}>
                <span className={s.loginName}>{option.name}</span>
                <span className={s.caption}>{reason === null ? option.desc : reason}</span>
              </span>
              <Icon name="chevron-right" size={16} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function OptionButtons({ availability }: { availability: Availability }) {
  const open = useOpenLogin();
  return (
    <div className={s.loginButtons}>
      {LOGIN_OPTIONS.map((option) => {
        const reason = blockedReason(option, availability);
        return (
          <Button key={option.kind} icon={option.icon} disabledReason={reason === null ? undefined : reason} onClick={() => open(option.kind)}>
            {option.name}
          </Button>
        );
      })}
    </div>
  );
}

export function StepAccount() {
  const accounts = useLauncherSelector((s) => s.accounts);
  const online = useOnline();
  const microsoftUnavailable = useLauncherSelector(microsoftLoginUnavailable);
  const availability: Availability = { online, microsoftUnavailable };
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={s.stepBody}>
      {accounts.length > 0 && (
        <section className={s.added}>
          <div className={s.othersHead}>
            <span className={s.subheading}>{ACCOUNT_STEP_COPY.added}</span>
            {!expanded && (
              <Button size="sm" variant="ghost" icon="plus" onClick={() => setExpanded(true)}>
                {ACCOUNT_STEP_COPY.addMore}
              </Button>
            )}
          </div>
          <ul className={s.accountChips}>
            {accounts.map((a) => (
              <AccountChip key={a.uuid} account={a} />
            ))}
          </ul>
        </section>
      )}
      {accounts.length === 0 || expanded ? <OptionCards availability={availability} /> : <OptionButtons availability={availability} />}
    </div>
  );
}
