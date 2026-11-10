// 第三步：添加账户。三种方式各打开同一个登录弹窗（叠在向导之上），向导本身不复刻登录界面；
// 添加成功后在上方列出已添加的账户，三张选项卡收成一行按钮，「继续添加」再展开。
// 不能用的方式在这一步就置灰并写原因：向导期间主界面没挂上，登录失败卡里「打开设置」去不了设置页。
// 「已添加」区出现、选项卡与按钮行互换都经 Appear 交叉淡入，竖排的兄弟由 useReflow 滑开，不整块硬跳。

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../art/Icon";
import { AccountAvatar } from "../../art/skin/AccountAvatar";
import { accountKindLabel, MSA_CLIENT_ID_MISSING } from "../../copy/flows";
import type { Account } from "../../domain/adapt";
import { useReflow } from "../../lib/reflow";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { useSkinInfo } from "../../state/queries/home";
import { Appear } from "../../ui/Appear";
import { Button } from "../../ui/Button";
import { ACCOUNT_STEP_COPY, LOGIN_OPTIONS } from "./copy";
import { useInsertItem } from "../../lib/useInsertItem";
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

/** enter：「已添加」区挂上之后才添加的账户自己淡入；随整个区一起出现的不单独入场。 */
function AccountChip({ account, enter }: { account: Account; enter: boolean }) {
  const skin = useSkinInfo(account.uuid);
  const item = useInsertItem();
  return (
    <motion.li className={s.accountChip} initial={enter ? item.initial : false} animate={item.animate}>
      <AccountAvatar uuid={account.uuid} skin={skin.status === "ready" ? skin.data : null} size={32} />
      <span className={s.accountText}>
        <span className={s.accountName}>{account.name}</span>
        <span className={s.caption}>{accountKindLabel(account.kind, account.authServer)}</span>
      </span>
    </motion.li>
  );
}

function AddedSection({ accounts, expanded, onExpand }: { accounts: readonly Account[]; expanded: boolean; onExpand: () => void }) {
  // 新胶囊插在中间或折到下一行时，其余胶囊从旧位置滑过去
  const reflow = useReflow<HTMLUListElement>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <section className={s.added}>
      <div className={s.othersHead}>
        <span className={s.subheading}>{ACCOUNT_STEP_COPY.added}</span>
        <Appear itemClassName={s.addMore}>
          {!expanded && (
            <Button key="add-more" size="sm" variant="ghost" icon="plus" onClick={onExpand}>
              {ACCOUNT_STEP_COPY.addMore}
            </Button>
          )}
        </Appear>
      </div>
      <ul ref={reflow} className={s.accountChips}>
        {accounts.map((a) => (
          <AccountChip key={a.uuid} account={a} enter={mounted.current} />
        ))}
      </ul>
    </section>
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
  // 「已添加」区出现、选项换形态时，下面的块从旧位置滑过去
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={s.stepBody}>
      <Appear>{accounts.length > 0 && <AddedSection key="added" accounts={accounts} expanded={expanded} onExpand={() => setExpanded(true)} />}</Appear>
      {/* 两种形态叠在同一处交叉淡入：离开的那一种脱离布局原地淡出，新的一种淡入落位 */}
      <Appear>{accounts.length === 0 || expanded ? <OptionCards key="cards" availability={availability} /> : <OptionButtons key="buttons" availability={availability} />}</Appear>
    </div>
  );
}
