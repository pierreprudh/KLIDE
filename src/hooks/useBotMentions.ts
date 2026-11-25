import { useEffect, useState } from "react";
import { klideBotMentions, type BotMention } from "../ipc/klideBot";
import { errMessage } from "../errors";

type Snapshot = { root: string | null; items: BotMention[]; loading: boolean; error: string | null; checkedAt: number | null };
const EMPTY: Snapshot = { root: null, items: [], loading: false, error: null, checkedAt: null };

/** Only poll while the Mentions pane is visible. Late results cannot cross projects. */
export function useBotMentions(root: string | null, active: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!root || !active) return;
    let disposed = false;
    setSnapshot(current => ({ root, items: current.root === root ? current.items : [], loading: true, error: null, checkedAt: current.root === root ? current.checkedAt : null }));
    void klideBotMentions(root).then(items => {
      if (!disposed) setSnapshot({ root, items, loading: false, error: null, checkedAt: Date.now() });
    }).catch(error => {
      if (!disposed) setSnapshot(current => ({ ...current, loading: false, error: errMessage(error) }));
    });
    return () => { disposed = true; };
  }, [root, active, revision]);
  useEffect(() => {
    if (!root || !active) return;
    const timer = setInterval(() => setRevision(v => v + 1), 120_000);
    return () => clearInterval(timer);
  }, [root, active]);
  return {
    ...(snapshot.root === root ? snapshot : { ...EMPTY, loading: !!root && active }),
    refresh: () => setRevision(v => v + 1),
  };
}
