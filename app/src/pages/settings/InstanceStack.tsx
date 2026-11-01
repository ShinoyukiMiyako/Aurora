// 叠放的实例头像：「3 个实例需要 Java 21」「2 个实例用自定义内存」前面的那一小串。

import type { InstanceSummary } from "../../domain/adapt";
import { InstanceAvatar } from "../../launch/InstanceAvatar";
import s from "./settings.module.css";

/** 最多叠几个；数量写在后面的文字里，这里只示意是哪些实例。 */
const STACK_LIMIT = 5;

export function InstanceStack({ instances }: { instances: readonly InstanceSummary[] }) {
  return (
    <span className={s.avatarStack} aria-hidden="true">
      {instances.slice(0, STACK_LIMIT).map((inst) => (
        <InstanceAvatar key={inst.id} instance={inst} size={24} status={false} />
      ))}
    </span>
  );
}
