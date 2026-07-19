import { describe, expect, it, vi } from "vitest";
import { createListenerScope, type Unlisten } from "./tauriEvents";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createListenerScope", () => {
  it("unregisters listeners that resolve before disposal", async () => {
    const unlisten = vi.fn<Unlisten>();
    const scope = createListenerScope();
    scope.add(Promise.resolve(unlisten));
    await Promise.resolve();

    scope.dispose();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("immediately unregisters listeners that resolve after disposal", async () => {
    const registration = deferred<Unlisten>();
    const unlisten = vi.fn<Unlisten>();
    const scope = createListenerScope();
    scope.add(registration.promise);

    scope.dispose();
    registration.resolve(unlisten);
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledOnce();
  });
});
