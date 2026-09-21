/** Normalize a filesystem path for UI ownership comparisons. */
export function normalizeProjectPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const slashed = path.trim().replace(/\\/g, "/");
  if (!slashed) return null;
  if (slashed === "/") return slashed;
  if (/^[A-Za-z]:\/+$/u.test(slashed)) return `${slashed.slice(0, 2)}/`;
  return slashed.replace(/\/+$/u, "");
}

/**
 * Klide stores managed worktrees beside their checkout as
 * `<workspace>-worktrees/<run>`. For workspace-level navigation that path is
 * an implementation detail: the owning workspace remains the checkout before
 * `-worktrees`.
 */
export function canonicalWorkspaceRoot(
  path: string | null | undefined,
): string | null {
  const normalized = normalizeProjectPath(path);
  if (!normalized) return null;
  const managedWorktree = /^(.*)-worktrees\/[^/]+$/u.exec(normalized);
  return managedWorktree?.[1] || normalized;
}

/**
 * Conversations created while ordinary first sends were automatically moved
 * into a `klide/run-*` worktree should now reopen on their owning Workspace.
 * Deliberate worktree flows use distinct branch families (`turn`, `wt`,
 * `task`, `race`, …) and must stay pinned.
 */
export function legacyAutoRunWorkspace(location: {
  cwd?: string | null;
  branch?: string | null;
  worktree?: string | null;
}): string | null {
  const cwd = normalizeProjectPath(location.cwd);
  const owner = canonicalWorkspaceRoot(cwd);
  if (!cwd || !owner || owner === cwd) return null;

  const branch = location.branch?.trim() ?? "";
  const pathName = cwd.split("/").filter(Boolean).pop() ?? "";
  const worktree = location.worktree?.trim() || pathName;
  const legacyBranch = /^klide\/run-/u.test(branch);
  const legacyWorktree = /^klide-run-/u.test(worktree);

  return legacyBranch || (!branch && legacyWorktree) ? owner : null;
}

function isSameOrDescendant(path: string, root: string): boolean {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(prefix);
}

/**
 * Whether a working directory belongs to a project, including Klide's linked
 * worktrees stored beside the checkout in `<project>-worktrees/<name>`.
 */
export function pathBelongsToProject(
  path: string | null | undefined,
  projectRoot: string | null | undefined,
): boolean {
  const normalizedPath = normalizeProjectPath(path);
  const normalizedRoot = normalizeProjectPath(projectRoot);
  if (!normalizedPath || !normalizedRoot) return false;
  if (isSameOrDescendant(normalizedPath, normalizedRoot)) return true;

  const worktreeContainer = `${normalizedRoot}-worktrees`;
  return isSameOrDescendant(normalizedPath, worktreeContainer);
}

/** Find the most specific visible project that owns a working directory. */
export function linkedProjectForPath(
  path: string | null | undefined,
  projectRoots: readonly string[],
): string | null {
  let bestMatch: string | null = null;
  for (const candidate of projectRoots) {
    const projectRoot = normalizeProjectPath(candidate);
    if (!projectRoot || !pathBelongsToProject(path, projectRoot)) continue;
    if (!bestMatch || projectRoot.length > bestMatch.length) bestMatch = projectRoot;
  }
  return bestMatch;
}

/** Extra folder context shown when a conversation isn't at the project root. */
export function linkedFolderLabel(
  path: string | null | undefined,
  projectRoot: string | null | undefined,
): string | null {
  const normalizedPath = normalizeProjectPath(path);
  const normalizedRoot = normalizeProjectPath(projectRoot);
  if (!normalizedPath || !normalizedRoot || normalizedPath === normalizedRoot) return null;

  const projectPrefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  if (normalizedPath.startsWith(projectPrefix)) {
    return normalizedPath.slice(projectPrefix.length) || null;
  }

  const worktreePrefix = `${normalizedRoot}-worktrees/`;
  if (normalizedPath.startsWith(worktreePrefix)) {
    return `Worktree · ${normalizedPath.slice(worktreePrefix.length)}`;
  }

  return normalizedPath.split("/").filter(Boolean).pop() ?? normalizedPath;
}

/**
 * The folder a project sits in — where its siblings live, and so where a
 * folder picker should open rather than wherever the OS last left it. Returns
 * null at a filesystem root, which has no useful parent to offer.
 */
export function parentDirectory(path: string | null | undefined): string | null {
  const normalized = normalizeProjectPath(path);
  if (!normalized || normalized === "/" || /^[A-Za-z]:\/$/u.test(normalized)) return null;
  const cut = normalized.lastIndexOf("/");
  if (cut < 0) return null;
  const parent = normalized.slice(0, cut);
  if (!parent) return normalized.startsWith("/") ? "/" : null;
  if (/^[A-Za-z]:$/u.test(parent)) return `${parent}/`;
  return parent;
}
