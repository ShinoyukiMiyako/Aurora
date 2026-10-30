import { useShell } from "../shell/context"; // expect T6
import { getConfig } from "../ipc/config"; // expect T6
const lazyHome = () => import("../pages/Home"); // expect T6
export { useShell, getConfig, lazyHome };
