import type { Observer } from "./observers";

/** One conversation's observer list, kept fresh only while there is something
 *  to watch: a running observer, or a follow-up still waiting for the local
 *  turn to release. Otherwise it rests until `kick` (a new "Watching" row) or
 *  `wake` (the backend says a follow-up is ready). No React. */
export function startObserverPoll({ list, onRows, followup, everyMs = 1000 }: {
  list: () => Promise<Observer[]>;
  onRows: (rows: Observer[]) => void;
  /** False means a local turn is still cleaning up; try again next tick. */
  followup: () => boolean;
  everyMs?: number;
}) {
  let alive = true;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (alive && timer === undefined) timer = setTimeout(() => { timer = undefined; void refresh(); }, everyMs);
  };
  const refresh = async () => {
    let live = false;
    try {
      const rows = await list();
      if (!alive) return;
      onRows(rows);
      if (pending && followup()) pending = false;
      live = rows.some(observer => observer.status.state === "running");
    } catch { /* Browser previews have no native observer registry. */ }
    if (live || pending) schedule();
  };
  const kick = () => {
    if (!alive) return;
    clearTimeout(timer);
    timer = undefined;
    void refresh();
  };
  void refresh();
  return {
    kick,
    wake: () => { pending = true; kick(); },
    stop: () => { alive = false; clearTimeout(timer); },
  };
}
