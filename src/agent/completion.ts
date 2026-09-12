/** Evidence for one completed attempt, captured by the shared transcript fold.
 * Commands are execution evidence, not a claim that tests or the task passed. */
import { isSpreadsheetPath } from "../spreadsheets/paths";

export type RunCompletion = {
  runId: string;
  completedAt: number;
  outcome: string;
  files: string[];
  commands: { id: string; label: string; status: "passed" | "failed" | "unknown"; output?: string }[];
  warnings: string[];
  /** Files a command left behind — a deck, a PDF, a generated report. Kept
   *  apart from `files` on purpose: these went through no diff review and have
   *  no checkpoint, so they can be opened and read but never reverted, and
   *  presenting them as changes would promise a rollback that does not exist. */
  artifacts?: { path: string; bytes: number; created: boolean }[];
  /** True when the attempt ended without finishing — cancelled, turn cap, or
   *  a provider/harness failure. The edits it applied before stopping are
   *  real files on disk, so the card still opens; it just never presents them
   *  as a result. */
  stopped?: boolean;
  /** Existing files referenced by an older run; no creation or rollback claim. */
  references?: { path: string; bytes: number }[];
};

/** Routine replies and successful read-only work do not need a review entry. */
export function completionDocumentCount(completion: RunCompletion): number {
  return completionDocuments(completion).length;
}

/** Previewable files written by an edit tool are also readable documents.
 * Keep their original change evidence; this is only the document projection. */
export function completionDocuments(completion: RunCompletion) {
  const documents = new Map((completion.artifacts ?? []).map(artifact => [artifact.path, artifact]));
  for (const path of completion.files) if ((isSpreadsheetPath(path) || /\.(docx?|pptx?|xlsx?|pdf|odt|odp|ods|rtf|png|jpe?g|webp|svg|html?)$/i.test(path)) && !documents.has(path)) documents.set(path, { path, bytes: 0, created: false });
  for (const reference of completion.references ?? []) if (!documents.has(reference.path)) documents.set(reference.path, { ...reference, created: false });
  return [...documents.values()];
}

export function hasCompletionReview(completion: RunCompletion): boolean {
  return completion.files.length > 0 || completion.warnings.length > 0 ||
    (completion.artifacts?.length ?? 0) > 0 || (completion.references?.length ?? 0) > 0 ||
    completion.commands.some((command) => command.status !== "passed");
}

/** Recovery belongs to the view, not the replay-owned transcript. */
export function latestReviewCompletion(
  messages: readonly {role: string; completion?: RunCompletion}[],
  recovered: {runId: string; references: {path: string; bytes: number}[]} | null,
  conversationId?: string,
): RunCompletion | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const original = messages[i].role === "system" ? messages[i].completion : undefined;
    const candidate = original && recovered?.runId === original.runId
      ? {...original, references: recovered.references} : original;
    if (candidate && hasCompletionReview(candidate)) return candidate;
  }
  // Older saved conversations can contain the transcript without a completion
  // row. Verified references still deserve a document entry in that view.
  if (recovered && recovered.runId === conversationId && recovered.references.length > 0) {
    return {runId: recovered.runId, completedAt: 0, outcome: "Referenced documents",
      files: [], commands: [], warnings: [], references: recovered.references};
  }
  return undefined;
}
