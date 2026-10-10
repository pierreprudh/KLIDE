---
name: klide
description: Continue this conversation in the Klide app. Use when the user asks to open, continue, move, follow up or hand off this session to Klide — "open this in Klide", "continue in Klide", "I need to follow up this conversation in Klide".
---

<!-- Installed by Klide (Settings › General › From other apps). Turning that toggle off removes this file. -->

# Continue in Klide

Klide resumes this exact CLI session in one of its AI panels, in the folder
you are working in. Nothing is copied or summarized: it is the same session.

1. Pick your provider id: Codex → `codex`, OpenCode → `opencode`,
   Oh My Pi → `omp`, Claude Code → `claude-code`.

2. Run exactly this, with that id in place of `PROVIDER`, nothing else:

   ```bash
   open "klide://resume?provider=PROVIDER&project=$(python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.getcwd()))')"
   ```

   Klide takes the newest session of that CLI in this folder, which is this
   one. If you know your own session id (Claude Code has it in
   `$CLAUDE_CODE_SESSION_ID`; Codex shows it in `/status`), add
   `&session=<id>` to make it exact.

3. If `open` reports that no application handles the URL, Klide is not
   installed in /Applications (links reach the installed app, never a dev
   build). Say so and stop.

4. Then tell the user in one line: Klide is opening this session, and they
   should end this terminal session before typing there, because two
   processes on one session would both write its transcript.

Do not put the conversation into the link, do not write a summary file, and
do not run anything else.
