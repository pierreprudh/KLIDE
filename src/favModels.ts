// Favorite models — one shared, persisted star list so every model picker (the
// AI panel's ModelPicker and the orchestrator's chooser) reads and writes the
// SAME favourites and stays in sync.
//
// Storage: localStorage key "klide.favoriteModels", a JSON array of
// `"<provider> <model>"` keys (the AI panel's original format).
//
// Read-THROUGH: every check reads localStorage fresh rather than trusting an
// in-memory cache. That keeps the two surfaces in sync even across Vite
// hot-reloads or duplicate module instances — localStorage is the single source
// of truth, so a star set in one panel is seen by the other the moment it reads.

const KEY = "klide.favoriteModels";
const SEP = " ";
const NUL = String.fromCharCode(0);

const favKey = (provider: string, model: string) => provider + SEP + model;

function read(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return new Set<string>();
    // Migrate legacy keys that used a NUL separator (an old bug) to the space
    // form, so favourites saved before the fix still resolve.
    return new Set<string>(
      raw.filter((x) => typeof x === "string").map((k: string) => k.split(NUL).join(SEP)),
    );
  } catch {
    return new Set<string>();
  }
}

function write(set: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* storage full / unavailable */
  }
}

const listeners = new Set<() => void>();

export function isFavModel(provider: string, model: string): boolean {
  return read().has(favKey(provider, model));
}

/** Favourite models for one provider, in star order (the Set preserves
 *  insertion order, so the first entry is the oldest star — the "top"
 *  favourite). Used to seed the model choice on a provider switch. */
export function favModelsFor(provider: string): string[] {
  const prefix = provider + SEP;
  return [...read()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

export function toggleFavModel(provider: string, model: string): void {
  const set = read();
  const k = favKey(provider, model);
  if (set.has(k)) set.delete(k);
  else set.add(k);
  write(set);
  for (const l of listeners) l();
}

export function subscribeFavModels(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
