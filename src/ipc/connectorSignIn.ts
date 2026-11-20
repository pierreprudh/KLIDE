// connectors_sign_in* — a remote connector's browser sign-in (MCP OAuth,
// `connector_oauth.rs`). Apart from `connectors.ts` so it rides the Settings
// chunk, not the entry: only Settings › Connectors signs anyone in.
import { invoke } from "@tauri-apps/api/core";
import { isRemote, type Connector, type ServerSpec } from "./connectors";

/** Sign in to a remote connector in the browser, then save it. The connector
 *  may be new (a catalog card) or stored (a row whose sign-in expired). Rust
 *  keeps the tokens in the Keychain; the store only says `${KLIDE_OAUTH}`.
 *  Resolves once the browser comes back and the server answered. */
export function signInConnector(connector: Connector): Promise<Connector[]> {
  return invoke<Connector[]>("connectors_sign_in", { connector });
}

/** Stop waiting on the browser; the pending sign-in fails as cancelled. */
export function cancelConnectorSignIn(): Promise<void> {
  return invoke<void>("connectors_sign_in_cancel");
}

/** Forget a connector's sign-in and switch it off. */
export function signOutConnector(id: string): Promise<Connector[]> {
  return invoke<Connector[]>("connectors_sign_out", { id });
}

/** Whether a connector signs in through the browser rather than with a key. */
export function usesSignIn(server: ServerSpec): boolean {
  return isRemote(server) && Object.values(server.headers).some((v) => v.includes("${KLIDE_OAUTH}"));
}
