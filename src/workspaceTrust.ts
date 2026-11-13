// Activation consent lives in app storage, never in the repository itself.
const KEY = "klide.trustedWorkspaces.v1";
export function workspaceNeedsTrust(root: string, trusted: readonly string[]): boolean {
  return !trusted.includes(root);
}
export function confirmWorkspaceTrust(root: string): boolean {
  let trusted: string[] = [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(value)) trusted = value.filter((x): x is string => typeof x === "string");
  } catch { /* Broken storage never grants trust. */ }
  if (!workspaceNeedsTrust(root, trusted)) return true;
  if (!window.confirm(`Trust and open this workspace?\n\n${root}\n\nOpening enables Git inspection and project integrations. Agents, terminals and approved project configuration can execute code. Open only folders whose contents and configuration you trust.`)) return false;
  try { localStorage.setItem(KEY, JSON.stringify([...trusted, root])); } catch { /* Ask again next time. */ }
  return true;
}
