import type { ProviderId } from "../../agent/types";
import { ProviderLogo } from "./icons";

const VIBE_MODE_ICONS: Readonly<Record<string, string>> = {
  ask: "/vibe-permissions/ask.svg",
  "accept-edits": "/vibe-permissions/accept-edits.svg",
  "smart-approve": "/vibe-permissions/smart-approve.svg",
  "auto-approve": "/vibe-permissions/auto-approve.svg",
};

/** Vibe's native mode artwork, with the agent mark for its configured default. */
export function NativePermissionIcon({ provider, mode, size = 21 }: {
  provider: ProviderId; mode: string; size?: number;
}) {
  const src = provider === "vibe" ? VIBE_MODE_ICONS[mode] : undefined;
  return src
    ? <img src={src} width={size} height={size} alt="" aria-hidden="true" style={{ display: "block", flexShrink: 0 }} />
    : <ProviderLogo id={provider} size={size} />;
}
