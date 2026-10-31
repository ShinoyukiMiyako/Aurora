import { cx } from "../../lib/util";
import { ArtCrossfade } from "../illustrations/ArtCrossfade";
import { BitmapCanvas } from "../illustrations/BitmapCanvas";
import { useDevicePixelRatio } from "../illustrations/canvas";
import { accountHue } from "../illustrations/seed";
import styles from "./AccountAvatar.module.css";
import { AVATAR_SPECS, type AvatarSize, type SkinRef } from "./layout";
import { silhouetteFaceCanvas, skinFaceCanvas } from "./render";
import { useSkin } from "./useSkin";

export interface AccountAvatarProps {
  /** 账户 UUID：决定剪影的色相。 */
  uuid: string;
  /** 后端给出的皮肤信息；null 表示没有可用皮肤。 */
  skin: SkinRef | null;
  size: AvatarSize;
  /** 当前账户外环。 */
  current?: boolean;
  /** 单独出现（旁边没有账户名）时的可访问名称，如「Steve 的头像」；不传则 aria-hidden。 */
  label?: string;
  className?: string;
}

/**
 * 账户头像：皮肤正脸 + 帽子层，脸部按整数倍放大，四周留 4 px 底座边。
 * 先显示剪影，皮肤就绪后交叉淡化替换；取不到皮肤时一直是剪影，不留空白、不用名称首字。
 */
export function AccountAvatar({ uuid, skin, size, current = false, label, className }: AccountAvatarProps) {
  const { face, radius } = AVATAR_SPECS[size];
  const dpr = useDevicePixelRatio();
  const loaded = useSkin(skin);
  const canvas = (bitmap: CanvasImageSource) => <BitmapCanvas bitmap={bitmap} cssWidth={face} cssHeight={face} dpr={dpr} />;
  return (
    <span
      className={cx(styles.avatar, className)}
      style={{ width: size, height: size, borderRadius: radius }}
      data-sk-art="skin"
      data-art={loaded ? "skin" : "silhouette"}
      data-current={current || undefined}
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    >
      <span className={styles.face} style={{ width: face, height: face }}>
        <ArtCrossfade fallback={canvas(silhouetteFaceCanvas(accountHue(uuid), face, dpr))} real={loaded ? canvas(skinFaceCanvas(loaded, face, dpr)) : null} />
      </span>
    </span>
  );
}
