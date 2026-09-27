/** App owns the Git surface; conversation cards request a destination here. */
export type GitDestination = { root: string; pr: number; nonce: number };
let opener: ((destination: GitDestination) => void) | null = null;
export function registerGitOpener(next: typeof opener) { opener = next; }
export function openGitPr(root: string, pr: number) { opener?.({ root, pr, nonce: Date.now() }); }
