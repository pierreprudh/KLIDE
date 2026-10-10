---
name: klide
description: Continue this conversation in the Klide app. Use when the user asks to open, continue, move or hand off this session to Klide — "open this in Klide", "continue in Klide", "send this conv to Klide".
---

<!-- Installed by Klide (Settings › General › From other apps). Turning that toggle off removes this file. -->

# Continue in Klide

Klide resumes this exact Claude Code session in one of its AI panels
(`claude --resume <id>`), in the project this session runs in. Nothing is
copied or summarized: it is the same session, so `claude --resume` in a
terminal still finds it afterwards.

1. Run exactly this command, nothing else:

   ```bash
   open "klide://resume?provider=claude-code&session=$CLAUDE_CODE_SESSION_ID"
   ```

   `CLAUDE_CODE_SESSION_ID` is set in this shell by Claude Code. Klide reads
   the project from the session's own transcript; add
   `&project=<url-encoded absolute path>` only if Klide says it could not.

2. If `open` reports that no application handles the URL, Klide is not
   installed in /Applications (links reach the installed app, never a
   `tauri dev` build). Say so and stop.

3. Then tell the user in one line: Klide is opening this session, and they
   should end this terminal session (`/exit`) before typing there, because two
   processes on one session would both write its transcript.

Do not put the conversation into the link, do not write a summary file, and
do not run anything else.
