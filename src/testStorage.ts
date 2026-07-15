// Test-only in-memory Storage shim, stubbed over the global localStorage in
// specs (vi.stubGlobal("localStorage", memoryStorage())). Lives in src/ so
// vitest specs share one implementation instead of drifting copies.

export function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
