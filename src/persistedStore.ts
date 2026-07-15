// Shared envelope for localStorage-backed array stores (races, tasks,
// conversations, …): parse guarded against corrupt/absent JSON, validate each
// element with the store's own predicate, and never throw. Stores contribute
// only their predicate — the try/parse/filter/catch skeleton lives once here
// so every store gets the same corruption resistance.

/** Read `key` as a JSON array and keep only elements passing `isValid`.
 *  Missing key, non-array JSON, parse errors, or an unavailable localStorage
 *  all yield `[]`. */
export function readValidatedArray<T>(key: string, isValid: (value: unknown) => value is T): T[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid);
  } catch {
    return [];
  }
}
