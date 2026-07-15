/** Human-readable message from an unknown thrown value (Error, string, or a
 *  Tauri command rejection, which is usually already a string). */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
