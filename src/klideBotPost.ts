// Post a klide-bot draft and say where it went — shared by the toast (in the
// entry chunk, so this stays tiny) and the Scheduled page's Run history.
import { klideBotPost, type KlideBotMention } from "./ipc/klideBot";
import { notify } from "./toast";
import { errMessage } from "./errors";
import { openExternal } from "./externalLink";

/** Post a draft, then say where it went. Shared by the toast and Run history. */
export async function postKlideBotReply(m: KlideBotMention): Promise<string | null> {
  try {
    const url = await klideBotPost(m.key);
    notify(`Replied to @${m.author} on #${m.prNumber}`, {
      tone: "success",
      action: { label: "View", run: () => { void openExternal(url); } },
    });
    return url;
  } catch (e) {
    notify(`Couldn't post the reply on #${m.prNumber}: ${errMessage(e)}`, { tone: "error" });
    return null;
  }
}

