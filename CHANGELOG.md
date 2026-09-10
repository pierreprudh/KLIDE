# Changelog

Notable changes per milestone. Dates are completion dates.

## Unreleased — on the v0.6 line (since 2026-08-23)

Hardening after the 0.6.1 cut. The v0.6 orchestration milestone itself is
still open.

### Project Memory

- **Project Memory is now a native Harness capability.** Durable entries use a
  versioned schema with kinds, review state, tags, source references, and
  supersession. Plan and Goal runs can call `memory_search` and `memory_read`;
  deterministic offline ranking returns match reasons and provenance, normal
  recall excludes stale/superseded knowledge, and the Transcript stamps both
  Tools with `read_project_memory` instead of pretending they read Workspace
  files. Markdown remains the local source of truth; no external provider or
  network service is involved.

### Agent coordination

- **Runs talk to each other.** A Rust-owned coordination journal
  (`.klide/coordination/events.jsonl`) gives every Plan/Goal Run a stable id,
  a state, and an inbox. Native Tools `agent_list` / `agent_send` /
  `agent_wait` / `agent_cancel` / `agent_read_result` let one conversation
  address another in the same Workspace; peers see thread titles, not raw ids.
  Another agent's words never reach a conversation unreviewed: the receiving
  side's operator gets the same inline card as a shell command, can welcome a
  peer for the rest of the run, and approval wakes an idle conversation with a
  no-text turn. Replies to a question the receiver itself asked skip the card.
  Delivered mail travels as a `user` turn labelled as agent mail, never as
  `system`. (PR #84, 2026-09-05.)
- **Delegate CLIs are on the same plane.** Claude Code, Codex and OpenCode
  sessions Klide launches now carry Klide's embedded MCP server
  (`klide mcp coordination`, same binary as the app) and see the same five
  operations as MCP tools — `agent_list`, `agent_send`, `agent_wait`,
  `agent_read_result`, plus `agent_publish_result` since a CLI has to say when
  it is done. The MCP child owns nothing: every call is relayed over loopback
  to a bridge in the app that binds the caller's Run id and Workspace from the
  PTY session it was spawned with, so no tool argument can speak as another
  agent or reach another journal. A Delegate registers as a `delegate` Run at
  spawn (its conversation id, the same id the panel uses), its status hooks
  move its state (`working` / `blocked` / `waiting`), and process exit settles
  it (`done` / `failed` / `cancelled`). Mail addressed to a Delegate shows the
  same review card in its panel; the CLI reads approved mail when it calls
  `agent_wait` — pull, not push, because Klide owns no turn boundary inside a
  foreign CLI. Per-CLI wiring: Claude Code `--mcp-config <per-session file>`,
  Codex `-c mcp_servers.klide.*` overrides, OpenCode `OPENCODE_CONFIG`; Oh My
  Pi and custom CLIs run unchanged.

### Harness

- **Auto picks the model.** A new `Auto` Provider at the top of every picker
  leaves the choice to the Harness. At run start Rust rules out what cannot do
  the job — no API key, local server down, no tool support when the Mode needs
  tools, a context window the prompt won't fit — then takes the user's starred
  models cheapest-first, falling back to what Ollama has installed. The pick is
  locked for the conversation (a continuation reuses its transcript's origin,
  never re-routes), `RunStarted` carries the resolved pair so every surface
  shows what actually ran, and a new `RouteResolved` Transcript line records
  the reason plus every candidate ranked above it and why it lost. Delegate
  CLIs are never candidates. Deterministic, no classifier, no network beyond
  the probes it already had. See `MODEL_ROUTING.md`.
- **A huge tool output is retained on disk, not carried in context.** A tool
  result over 20 KB is written once to `<runs>/<run id>.values/<call id>.txt`
  and the provider sees a `[retained #id]` stub with a head-and-tail preview
  instead of the full text. A new `peek_value` tool reads numbered line ranges
  (up to 400 per call) or searches the stored text by substring; its output is
  capped at 16 KB, below the retention threshold by construction, so a peek can
  never itself be retained. The Transcript keeps the full result, so Mission
  Control and the UI show everything, and both replay shapes rebuild the
  identical stub from the Transcript — a resume sees exactly what the live turn
  saw, and a stub only ever points at a file that exists. If the disk write
  fails the result stays in context verbatim. Value files land owner-only like
  transcripts, and travel with the run when the runs folder moves. Compaction
  remains the second line of defense; a retained result is no longer lost when
  it runs. (Prime Agent, arXiv 2608.23552.)
- **The command gate can be waived per conversation.** A Goal run dispatched
  with `autoApproveCommands` executes `run_command` as if allowlisted — even
  over a rejection remembered earlier in the run, since escalating is the
  override. The waiver is chosen per conversation and never persisted (every
  panel reverts to prompting on reload); network targets, Mission attempts,
  and subagent runs keep the normal gate.
- **"Validate all" on the diff card covers the rest of the run.** The apply
  decision can carry `scope: "run"`: the pending edit applies, every later
  edit of the live run auto-applies without pausing (still proposed and
  checkpointed), and the conversation's policy flips to auto-accept so later
  turns arrive already reviewing nothing.
- **A run near its turn cap finishes instead of stopping.** Three turns short
  of the cap the model is steered to stop exploring and save what it has; on
  the final turn the harness withholds the tool schemas, so the only reply it
  can produce is a written one. Both steps ride the steering seam and land in
  the transcript, so a run that answers ends `Done` — no more `max_turns`
  error on work that was one sentence from finished.
- **A turn that reasons itself empty gets another try.** A reasoning model can
  spend its whole reply budget in the private reasoning channel and return a
  successful turn with no answer and no tool call. That turn is now dropped
  from the provider history and resampled at half the budget, instead of the
  run settling `Done` having said nothing under a notice blaming the wrong
  number (`num_ctx`, when what ran out was the reply budget).
- **A truncated command keeps its verdict.** Long tool output now keeps both
  ends and gives up the middle — a test run states its result in its last
  three lines, and the old head-only cut removed precisely the lines the
  command was run for. `web_fetch` stays head-only on purpose: a page's tail
  is footer, not verdict.
- **The agent can search previous conversations.** A read-only
  `search_conversations` tool (Plan and Goal modes) ranks matches from prior
  Harness conversations in the current workspace, excluding the current run
  and its children.
- **MLX keeps its prompt cache.** TODO snapshots append on change instead of
  rewriting an early system message, so the reusable prompt prefix — file
  contents included — survives across turns; future MLX-LM launches get a
  1 GB `--prompt-cache-bytes` budget so retained prefixes can't grow without
  bound. Synthetic replay measured first streamed delta dropping from ~3.8 s
  to ~0.6 s.

### Delegate runs and Mission Control

- **Historical delegate runs settle.** Lifecycle state is inferred from each
  CLI's own turn markers (Claude Code, Codex, OpenCode, omp) instead of
  transcript recency alone; Klide-hosted PTY hook and exit state join onto
  that history, and provider session ids persist into scrollback metadata so
  blocked/completed/failed/interrupted survive startup races and app
  restarts. This closes the v0.5.1 lifecycle item.
- **A replayed tool call says what it did.** The transcript now carries a
  delegate call's arguments and its result (bounded on the way in — `read_run`
  streams instead of slurping 90 MB files), so reopening a Claude Code session
  shows the same rows a live turn draws instead of eight rows reading "Bash".
  Every replayed delegate result says which CLI produced it: Klide applied no
  capability, permission prompt, or diff review to it.
- **A resume lands where you are looking.** Mission Control admissions reuse
  the panel a one-slot surface (Focus, anchored, grid) is already showing
  instead of appending an invisible one. "Resume in Claude Code" moves to the
  workbench, where the interactive session can actually render; a new
  "Continue in Focus" turns the run's transcript into a Klide thread pinned to
  the same agent and runs the CLI headless with the history folded in. The
  detail pane's three continue actions each say what they do.

### Conversation view

- **Each step of the plan carries its own history.** The todo strip above the
  composer numbers its steps instead of drawing hollow dots: a pending step
  shows its number in mono, the step in hand wears a thin accent arc sweeping
  around it, a finished step closes to the check. Click a row and what
  happened to that step drops down on the same thread — Planned, Reworded with
  the earlier wording, Reopened, Done in 34s — as offsets from the start of
  the plan. The active row counts up live in the same figures the Working row
  uses, a finished row keeps its span, and a step that was ticked and reopened
  says "2nd try". The fold from the store's mutation log to a per-step timeline
  is a pure module (`src/todoHistory.ts`) with its own tests; the strip stays a
  view. No new data: the Rust store already recorded every mutation.

- **The + menu picks the Mode; the foot bar decides the Goal policy.** The
  menu is back to three rows — Chat / Plan / Goal — and the policy (reviewing
  edits · auto-accept edits · full auto) became a standing note beside the
  branch in the conversation foot bar: one click cycles to the next, the
  label morphing in on the soft curve. Review wears the branch label's
  monochrome; a silenced gate wears the accent so it never reads as default.
  The transient mode line above the composer is gone (`/mode` peeks via
  toast), and the footer's "Accept modification" action renders only when a
  diff is paused or a settled run left revertable files — the permanently
  visible disabled placeholder read as a review-mode promise it wasn't.
- **A stretch of tool work folds into one row** — count, tools, chevron;
  opening it gives back exactly the rows that were there. Only prose-free
  runs of three or more calls fold; the moment the agent says something, the
  run ends. Folded rows stay mounted and `inert`.
- **One agent, one mark.** A turn's provider and model stamps fall back
  independently to the thread's origin, and Claude Code / Codex get their
  maker mark even on `default`-model turns — the same replayed and live turn
  no longer wear different logos.
- **Tool machinery recedes.** Thinking hoists above the fold header, call and
  result rows step down a color token and inset from the prose edge, shell
  calls expand to the bare command line, and results render as raw mono text
  (markdown was mangling grep hits and file contents).
- **Your picture rides beside your message**, aligned to the message rather
  than the whole turn — with a Settings → Appearance switch to turn it off.
- **A turn that stops reaching the view heals from its transcript.** When the
  panel legitimately stops following a live run mid-turn, it now re-reads the
  run transcript on settle and adopts it, instead of showing tool calls and
  then silence while the answer sat on disk.

### Focus

- The hero composer footer carries the same Goal-policy decider as the
  conversation foot bar, so a policy can be chosen before the first message.
- **A dropped screenshot is a task.** One rule set (`ai/attachments.ts`)
  decides what a dropped or pasted file becomes: a photo travels as a data
  URI for a model that can see it, a document travels as the text shape an
  `@mention` produces, and a PDF or zip is refused by name. The start stage
  stages attachments beside the text and hands both to the panel.
- Composer polish: the start stage and conversation composer draw their
  controls in the same order (sending no longer reshuffles them), and the
  app-wide `focus-visible` ring is exempted by name so typing no longer
  paints clipped blue bars across the card.

### Storage

- **One screenshot may not cost a month of history.** Conversation-cache
  snapshots carry images only within a byte budget — older photos keep their
  name and lose their bytes — so a pasted 2 MB screenshot can no longer evict
  33 threads from the ~5 MB localStorage quota. The full image lives in the
  run transcript, which is the record.
- **Settings → Storage** shows what the cache holds and where transcripts
  live, with Drop cached photos, Clear, per-thread Forget, and Reveal.
- **Transcripts can live where you want.** The runs folder is user-choosable
  (`~/.klide/storage.json`); Rust validates by writing, moves only
  transcripts and run folders (checkpoints travel too), records the choice
  only after the move succeeds, and falls back to the default — saying why —
  when a chosen folder stops existing.

### Performance and hygiene

- Conversation persists are debounced (streaming was round-tripping the whole
  100-conversation index every ~50 ms), and the editor-tab disk poll stops
  re-registering App's listeners when nothing changed.
- The run supervisor retires a run's handle on settle instead of keeping its
  cancel token and pause channels for the app lifetime, and provider adapters
  share one reqwest client instead of paying DNS+TCP+TLS every turn.
- Keychain markers, provider `${VAR}` refs, and freshly created transcript /
  mission logs are written mode 0600.
- Docs: the app bundle is 27 MB, not the ~10 MB the stack table had claimed
  since Tauri was new here.

## v0.6.1 — Subscriptions and Reach (2026-08-23)

Work on the v0.6 line. The orchestration milestone itself — Missions as
outcomes, budgets, capacity, capability routing, validation contracts — is still
open; these are the shell and correctness changes landed so far. The macOS
bundle is still ad-hoc signed and not Apple-notarized.

### Subscriptions in Focus

- **Delegate CLIs are selectable in Focus.** Claude Code, Codex, OpenCode and
  Oh My Pi were filtered out of the Focus picker ("until that path is stable"),
  which left Focus able to run only what an API key could reach — so the
  subscription you already pay for was the one thing you couldn't start a Focus
  conversation with. Picking one now mounts its session on the Focus canvas,
  authenticated by its own CLI login, with no key anywhere in Klide.
- Goal mode stays open to a delegate in Focus's composer, matching the AI
  panel: the CLI does its own editing, so Klide's tool-support probe was never
  the right gate. And a delegate row is never quieted for a missing API key —
  by construction now, rather than by the accident of never being probed.
- **A delegate in Focus renders as a conversation, not a terminal.** One flag
  used to mean two things: "this provider edits the workspace itself" (a
  capability) and "this conversation *is* the CLI's interactive session" (a
  surface). They are separate now. The workbench keeps the session — its
  terminal, its PTY composer, its reattach. Focus runs the same delegate
  one-shot and headless (`delegate/chat.rs`) and renders the answer as an
  ordinary Klide message, so the chat-first surface stays chat-first whichever
  engine is behind it.
- **You can see what the delegate did.** Klide asked Claude Code for
  `--output-format text`, which reports an answer with no visible work behind
  it. It now asks for `stream-json`, and the CLI's own `tool_use` calls and
  their results are rendered as tool rows in the conversation — the delegate's
  Read / Edit / Bash steps, in Klide's own design.
  These arrive as a **separate** `observed_tool_call` / `observed_tool_result`
  event pair, never as `tool_call_started`. Klide dispatched none of them: they
  ran under the CLI's own permission mode, with no capability, no permission
  prompt and no diff review. Every row says `via Claude Code` for that reason,
  and `summarize_validation` — which counts capabilities — cannot mistake a
  delegate's `Bash` for a command Klide verified.
  A CLI with no structured mode keeps the prose path; it just shows no rows.
- **A delegate turn types out now.** `stream-json` alone emits each assistant
  block only once the model has finished writing it, so a Focus turn sat silent
  and then landed in one lump — and time-to-first-token measured a whole
  paragraph rather than a token. Klide also passes
  `--include-partial-messages`, whose `text_delta` events stream character by
  character. What remains in that number is real: a delegate turn pays for CLI
  boot, hook lifecycle and project-context loading before its first token, so
  expect a couple of seconds even on a trivial prompt.
  With partial messages on, every block arrives *twice* — as deltas, then whole
  — so a completed block is dropped once any delta has been seen, and the
  whole-block path stays for CLIs that stream nothing.
- **Delegate conversations are no longer read-only in the rail.** The tree dimmed
  every delegate group and tooltipped it "read only in Focus" — correct when a
  delegate conversation was always a PTY session with no transcript to reopen,
  wrong now that a Focus delegate run stores ordinary messages. Both that and
  the auto-resume path asked "is this a delegate?"; they now ask the question
  that was always meant — "does this conversation have anything to restore?" —
  through one shared predicate, so a headless delegate conversation reopens and a
  console-only one still doesn't.
- **OpenCode can hold a Focus conversation.** Its adapter reported "interactive
  PTY delegate only" and returned an error instead of headless args — harmless
  while Focus filtered delegates out of its picker, a failed turn the moment it
  stopped. `opencode run` with no message argument reads the prompt from stdin
  and exits, so the headless mode was there all along. (`-p` is `--password` for
  this CLI, not print; `--auto` matches the permission posture Claude Code and
  Codex already take, since a headless turn has no terminal to approve in.)
- **Observed tool rows render live, and TTFT stops lying about them.** The
  rows folded correctly on replay but never appeared while a turn was running:
  `turnDriver`'s event switch is a whitelist, `observed_tool_call` was not on
  it, and everything else falls through to "the panel handles this" — silently.
  A delegate also opens with several file reads before it says anything, and
  first-output was timed to its first *word*, so a run that started working
  immediately reported ~15s of latency. Observed activity now counts as first
  output, in both the harness and the driver. Harness runs are unaffected: a
  dispatched tool call can only follow the model's own response.
- **OpenCode shows its work too, and each CLI owns its own dialect.** Reading a
  delegate's structured stream moved behind the Delegate seam
  (`Delegate::parse_stream_line`), because the two CLIs disagree about
  everything but the meaning: Claude Code splits a call and its result across
  two Anthropic-shaped lines, OpenCode packs both into one `tool_use` event
  keyed by `callID` with a `state.status` saying which stage it is in. What they
  produce is one shared `StreamItem` vocabulary, so one loop in `chat.rs` drives
  either. `chat_stream.rs` keeps that vocabulary and the JSON helpers; each
  dialect and its fixtures live in the adapter that speaks it.
  OpenCode now runs with `--format json`, which also puts its output on stdout
  where it belongs. Text needed one new shape: OpenCode reports it per *part*
  rather than as deltas, and a growing part may be re-sent whole, so a part
  carries its text-so-far and the runner streams only the new suffix — no
  duplicated answer if it repeats, no lost text if it does not.
  omp keeps the prose path: it has `--mode json`, but its shape is unverified
  here (omp reads provider keys from the shell environment, and there are none
  to run it with), and a guessed dialect is worse than none.
- **A delegate's stderr stays out of the answer.** OpenCode puts its banner, its
  `→ Read README.md` progress lines and the entire stdout of every command it
  runs on stderr, and the prose path streamed all of it into the conversation
  prefixed `stderr:` — a turn came back as a wall of `ls -la` output with the
  real answer buried at the end. stderr is a CLI's chrome: it is collected for
  diagnostics and shown only when the turn fails. The answer is on stdout.
- The headless delegate turn is no longer capped at 180 seconds — a ceiling
  sized for answering questions, not for a Goal-mode task, which it would cut
  mid-edit. The bound is now a 30-minute backstop against a wedged CLI, with
  Stop as the real control. And that Stop now works: the child is spawned
  `kill_on_drop`, so cancelling a turn ends the CLI instead of leaving it
  editing the workspace with nobody reading its output.

### Provider gateway

- Klide can run the **opencodex** proxy (`ocx`) as a managed localhost server
  and register it as one self-hosted endpoint, which puts ~40 upstream
  providers — API-key or OAuth — behind the normal model picker and the full
  Rust tool loop, in Focus as everywhere else. Settings → API → Provider
  gateway owns install detection, start/stop, connect/disconnect, and the
  default `provider/model` route. No new wire adapter: the proxy speaks the
  OpenAI wire the custom-provider store already drives.
- Starting the proxy no longer hijacks the Codex CLI. `ocx start` injects
  itself into `$CODEX_HOME/config.toml`; Klide un-injects immediately after a
  successful start so the Codex delegate keeps talking to OpenAI directly, and
  reports the config's real state instead of assuming it.

### One sidebar

- Focus and the free/anchored workbench now render **the same rail**
  (`WorkspaceRail`). There used to be two components — Focus's full-height rail
  over a project tree, and a separate icon-strip `ActivityBar` — which shared a
  few classes, drifted anyway, and made one workspace look like two different
  apps depending on the layout. The workbench keeps the panel tools only it can
  open (Explorer, Git, AI) by passing them in `nav`; that array and where a
  conversation lands are the only things the shells still differ in.
- The workbench therefore gains the **conversation history** that existed in
  Focus alone: projects, provider groups, search. Opening a row resumes it into
  an AI panel — into the panel already holding it, if one is.
- The tree marks **every conversation currently loaded**, not just one. Free
  mode can hold several at once across panels, and the rail is the only surface
  that can say which — so it says it the way this rail says everything, in the
  text: open rows go strong, and the one you are actually looking at keeps the
  accent route through the branch, because the route is what means "here" and
  there is only ever one here. No dot, no badge, no pill.
- Marking them is not enough, so the tree also **keeps them reachable**: an open
  conversation pins itself into its group's collapsed row window, its provider
  group and project unfold when it is loaded (once, on the transition — you can
  still fold it away), and a project holding one never drops into the "More"
  tail on recency. A conversation the rail claims is open can always be found.
- Gone with the ActivityBar: its collapse-to-56px pebble, the hover flyouts, and
  the Settings-section submenu. What replaces the pebble is the rail's own
  **inner edge**: drag it to set the width (200–460px), drag it past the fold
  point to put it away entirely, and drag it back off the window edge to
  bring it back at the width you left it. Double-click the edge or press **⌘B**
  to do the same without aiming; folded, one quiet button under the traffic
  lights says where it went. Like Codex, that button lives in the reserved app
  header rather than in the collapsing rail, so it never lands over the first
  editor tab, a panel header, or an overlay title.
  Width and fold are persisted and shared by both shells, so the rail is the
  same rail whichever layout you come back through.
- Folding keeps the rail mounted at zero width rather than unmounting it, so
  its disclosure state, scroll position and history subscriptions survive the
  fold — unfolding is a movement, not a reload.
- And it moves like Codex: width and content opacity share one 500ms low-bounce
  spring, so the panel gathers itself, travels and settles as one object,
  with its contents held at full width behind a clip — the tree slides out of
  view instead of reflowing every label through two hundred narrower layouts on
  the way. The sidebar trigger stays fixed in the titlebar while the rail moves
  beneath it, so folding and unfolding never makes the control jump. It is now
  the only fold button: the duplicate beside the profile is gone, and its pane
  retracts into a short handle as the rail closes instead of swapping glyphs.
- Dragging the edge is exempt from all of that, and exactly so: no transition (it
  would trail your pointer by the fold's whole duration). When narrowing an open
  rail, it now pauses at the usual 200px minimum for a short 32px detent, then
  releases smoothly into the fold if the drag continues. Reopening from zero
  still follows the pointer directly without jumping to the minimum width.
  Release settles it with the transition back on, so an out-of-bounds release
  eases into the nearest legal width instead of snapping to it. Under
  `prefers-reduced-motion` the fold
  is a cut.

### Focus rail

- The rail is a flat surface again: one hairline on its inner edge instead of a
  30px `backdrop-filter`, a drop shadow and an inset highlight stacked together.
  Rows moved onto the app-wide soft-fill recipe, and radii, heights and weights
  onto the token scale.
- Nesting rebuilt on a single indentation grid, so a child's icon lands exactly
  where its parent's label began at every level and rail width.
- The tree reads as one continuous line. The vertical was a CSS border and the
  curve an SVG stroke in a different colour, with the curve redrawing its own
  stub over the border, so the join was visible. Both now share one colour
  token; the turn is an exact quarter-arc, tangent where it leaves the trunk and
  where it reaches the row; the vertical belongs to each item, so it ends at the
  last junction instead of dangling past it and climbs to its parent's junction
  instead of starting a row late.
- The tree clears row icons on both axes, measured from the icon box rather than
  the artwork — the horizontal run used to cross any provider mark that fills
  its box, and the trunk descended through the parent glyph it hung from.
- Expanding a project draws its tree: trunk grows down, curve unrolls, row
  fades, overlapping into one wave that runs providers first and then
  conversations. Rows only fade, because translating one would drag its curve
  off the trunk for the length of the animation.
- Project names pin to the top of the rail while their history scrolls, with the
  pinned state detected from a sentinel — observing the header itself reports
  "stuck" for any header merely clipped at the bottom of the scroller.
- The project list is capped with a quiet More toggle, the "Projects" eyebrow is
  gone, and the rail has its own 6px scrollbar instead of the app-wide 10px one.
- A Git island on the Focus canvas, rail destination rows and an identity row.

### Menus

- Rust owns the application menu. The frontend had been calling
  `Menu.default().append(Projects).setAsAppMenu()`, and `Menu.default()` is
  Tauri's *stock* menu whose macOS File submenu holds nothing but Close Window —
  so every rebuild, including one per change to the recents list, silently
  replaced the real menu and took Open Folder, Close Tab, Find in Files, the
  Command Palette and Settings with it. The frontend now calls
  `menu_sync_projects` and Rust stays the only writer.
- File gains Open Project… (⌘O), Open Recent, Save (⌘S) and Close Project; Edit
  and View are restored.

### Harness and providers

- Subagents are the harness's own work. `spawn_subagent` used to emit an event
  and park on the question pause while the AI panel resolved the role, composed
  the child prompt, ran the nested Run, and answered with its last message — so
  closing or reloading the panel mid-subagent left the parent parked forever and
  its report lost. The Rust harness now owns all of it behind the supervisor
  seam: the role comes from `agent::subagents`, the child inherits the parent's
  system prompt with a role block appended, and the report is read from the
  child's transcript, which is durable. A subagent survives a panel unmount, a
  reload and a reattach, like every other Harness run.
- Cancelling a run now cancels the subagent it is waiting on, instead of
  orphaning a child that keeps running headless.
- A run that names an editing subagent is refused. The tool promises a delegate
  that "cannot edit", and only the schema's `enum` was holding that line; the
  model's menu is now derived from the roles that are read-only, and the same
  list is checked again when the call arrives. Editing roles stay reachable
  where they always were — a human naming one in an `@mention`.
- A run waiting on a subagent reports `Paused` rather than borrowing the
  question pause's `WaitingForPermission`, which claimed a prompt was waiting
  when nothing was.
- Fresh Klide conversations and Mission Control tasks now run in a dedicated
  Git worktree by default. The checkout is created before the Harness or
  delegate CLI starts, remains pinned across every workspace layout, and is
  cleaned up if a delegate fails to launch without writing work. Non-Git
  folders continue locally; other isolation failures never silently fall back
  to the main checkout.
- The harness measures model time per turn, and conversations carry a creation
  date, so duration is never re-derived from wall-clock time at render.
- Self-hosted provider endpoints can be renamed from Settings.
- Vision detection stops waving through text-only models: `claude-3-5-haiku`
  (Anthropic's one text-only chat model, dotted OpenRouter spelling included)
  and the o-series small builds (`o1-mini`, `o1-preview`, `o3-mini`) no longer
  read as vision-capable. And the adapter seam now forwards only the image
  formats the hosted APIs accept (jpeg/png/gif/webp) — an svg or bmp
  attachment is dropped instead of 400-failing the whole turn.
- Reopening the Mission console no longer re-announces a mission that finished
  long ago: terminal events toast exactly once, when they happen. Both console
  effects read the event log through one `terminalOutcome` helper, so the
  reopen state and the announcement can't disagree about whether a mission is
  parked.

### Focus shell and terminal

- The native shell docks *under* the Focus canvas instead of replacing it, so
  the conversation keeps its mount and its run subscriptions keep streaming
  while you work in the shell. It is the same single PTY the workbench drawer
  shows, at the same remembered height — opening it in Focus never starts a
  second one.
- One icon vocabulary: thirty private glyph copies across ActivityBar,
  FocusMode, StatusBar, WelcomeScreen and the rail destinations now resolve to
  `src/icons.tsx` (Phosphor Light behind an `Icon` primitive; provider logos,
  file-type marks and AgentMark stay hand-drawn). The AI panel's mark is a
  speech bubble, not the sparkle cliché.
- In Focus the terminal renders as a floating card — inset, four rounded
  corners, a hairline all the way round — because xterm's composited canvas
  can ignore a radius clip in this webview. Split panes now share their
  alignment rules with the header, so a tab sits over the pane it names and
  both dividers resolve to the same pixel.

### GitHub identity

- Klide pins its GitHub identity in `~/.klide/github_account.json` and applies
  it per-command via `GH_TOKEN`, instead of wearing whichever account `gh`
  happened to have active — the avatar, PR author, and push credentials can no
  longer disagree (and pushes from the wrong account no longer 403). Settings
  grows a GitHub account row to choose it.

### Architecture review (2026-08-04, PR #31)

Six reproduced defects fixed:

- **The Transcript is as durable as the Mission log.** Appends go through one
  flushed `O_APPEND` write and summaries through an atomic replace
  (`durable.rs`), so a crash can't publish a torn line and the polling run
  board can't read half a summary. Reading now tolerates exactly one thing — a
  torn *final* line — and errors on interior corruption instead of silently
  skipping it, which used to shorten replayed history, under-count the
  Validation contract, and lower cost totals with no sign anything was wrong.
- **Validation no longer misreports allowlisted command tools.** The
  transcript records each tool call's *capability* at dispatch time instead of
  leaving readers to guess from the tool's name, so a run that validated its
  own edits through a workspace-defined command tool no longer reads
  `unverified`. Headless Mission attempts derive the interactive tools to
  disable from the Pause capability rather than a hand-written list.
- **Live ptyd sessions survive the persistence toggle.** The toggle only
  routes *new* spawns; existing daemon sessions keep write, snapshot, and
  reuse — previously keystrokes into them were silently dropped and reattach
  repainted without a dedup high-water mark.
- **The delegate layer compiles off unix.** The ptyd wire types moved to an
  ungated `pty_wire.rs` and the client answers "no daemon here" on non-unix
  targets — one of two real blockers behind the Windows/Linux TODO item (the
  keyring feature selection remains the other).
- **The git IPC drift guard got its blind spot closed.** `create_pr` and
  `github_commit_avatars` gained wrappers and the guard now matches the whole
  family, the skills wire is typed end-to-end, and a literal NUL byte that had
  been hiding `settings/accounts.tsx` from every grep is gone.
- **Persistent-approval trust has teeth.** The repository fingerprint guarding
  persisted permission decisions is now covered by tests that fail if it stops
  moving for tracked edits, new commits, or untracked-file contents.

And the duplication sweep behind them:

- One `SessionHosting` trait over the in-process and ptyd session hosts, with
  the reuse/broadcast policies tested against fake hosts.
- `src/runPresentation.ts` — one module turns a Run's state into its word and
  tone (was eight drifting tables); the two legitimate meanings of "waiting"
  are documented and pinned instead of "fixed" into agreement.
- `ai/contextBudget.ts` extracts the auto-compaction arithmetic behind 21
  tests (the draft can no longer trigger a paid summarisation call), and
  `ai/autonomyLadder.ts` single-sources the Mode × diff-review ladder. The
  Focus start stage's fake context gauge — chosen window size divided by the
  largest option — is a label now.
- Mission Control gives one answer per provider name, colour, and mark
  (`providerShortName`, `providerBrandColor`, shared brand paths).
- The four Pause ceremonies collapse into one `run_pause_tool`;
  `AgentEvent::ts()` replaces two 23-arm matches; one shared `glob_match`
  serves the glob tool and the command allowlist.
- Shared modules earn their callers: `time.ts` owns `relativeTime` (four
  byte-identical copies gone), new `fileSearch.ts` gives ⌘P and the `@file`
  picker the same ranking, new `dragSession.ts` ends the stashed-cursor resize
  ritual, new `editorLanguage.ts` ends the twin extension tables, and the Rust
  menu builds from one `MENU_ITEMS` table with a source-reading drift test.

## v0.5.0 — Agent Operations (2026-07-16; closeout 2026-07-21)

- Race the same task across two Harness runs in isolated worktrees, keep sibling
  runs together in Mission Control, and compare status, validation, files,
  commands, tokens, cost, time, and worktree evidence side by side.
- Remove a newly created race worktree — including its recipe-copied config
  files and the branch created for it — when its Harness run fails to start,
  while preserving any checkout that holds other work.
- Validate persisted race groups before projecting them into Mission Control,
  with direct regression coverage for persistence, bounded history, partial
  dispatch, and orphan cleanup.
- Run frontend tests/build and Rust tests automatically on pushes to `main` and
  on pull requests.
- Verify that the release profile produces a 26 MB Apple Silicon `Klide.app`;
  the final closeout reran the frontend suite, production build, and full Rust
  suite (including PTY socket integration), then booted the bundled app and
  embedded frontend successfully. Distribution signing and notarization remain
  the publishing gate.

- Git Review grew into a full workbench: branch diff against the recorded fork base, PR list/create/open/checkout/merge actions, a commit history graph, and a structured commit-detail pane with avatars and full-width diffs.
- Delegate live status moved to hooks for Claude Code, Codex, and OpenCode, so Mission Control can show working/waiting/blocked state without scraping terminal output.
- Live-strip urgency and needs-you toasts make active delegate sessions visible while keeping the main workbench quiet.
- Subscription and custom CLI providers now share a cleaner default-model path: the "default" sentinel lets each CLI use its own configured default instead of forcing a stale model flag.
- Custom CLI agents are first-class in Settings, the AI panel, and dispatch.
- Mission Control now scopes delegate run history to the current workspace, keeping old runs from other projects out of the operator view.
- Production build splits the heaviest browser libraries (Monaco, xterm, Tauri, React) into named vendor chunks, and the main screens and modals now lazy-load on demand instead of shipping in the initial bundle.
- Docs were refreshed for the production README and changelog.

## v0.4 — Review Queue + Evidence Layer

- Mission Control answers "what is running?", "what needs me?", and "what changed?" at a glance — quiet rows, attention queue, per-run reasons + one next action.
- Evidence summaries per run — last meaningful event, branch, files touched, diff/review entry point, tokens/cost, sub-agent count, and saved-memory status, consistent across Klide and delegate runs.
- Delegate observability — Claude sub-agent visibility (counts `Agent`/`Task` calls, excludes sidechain turns) and symmetric routine badging.
- Reviewable memory — completed runs draft a note you accept, edit, or skip in the Memory modal before it becomes durable.
- Settings open instantly — sections mount on first visit, so per-provider status calls don't block the surface.
- Delegate account switching — save and switch Codex / Claude Code / OpenCode CLI logins from Settings without minting tokens.
- Parked (intentionally): natural-language scheduling and proactive suggestions — until the review/evidence loop has more daily mileage.

### Agent harness capability

- `run_command` — approval-gated shell execution so the agent can run tests/build/lint and verify its own work.
- Configurable turn cap (default 50) + command timeout (default 180s) + per-run command allowlist.
- Eval foundation — golden tool-layer scenarios run as `cargo test`; documented tool schema + lineage in `KLIDE_HARNESS_SCHEMA.md`.
- Scripted model-loop eval — fake provider turns choose tools, real tools execute, and tool results replay into the next provider message.
- Project-persistent command allowlist — "Approve for project" stores exact `run_command` approvals in `.klide/command-allowlist.json`.
- Test-after-edit — optional Settings → Harness command runs after accepted edits, alongside built-in Rust/JSON syntax checks.
- Provider seam extracted into `run_agent_loop` — production calls `ai_chat` through `RealProviderCaller`; tests can inject a mock provider caller.

## v0.3

- Self-hosted providers — add your own OpenAI-compatible endpoints (label + base URL + keychain token) in Settings; they appear in the provider picker under "Self-hosted", with live model listing and per-endpoint default model.
- Collapsible, glass-headed provider picker that scales to many providers.
- Project Memory v3 — touched-file links, run metadata, and automatic durable notes for completed Klide runs.
- Skills install/uninstall plus "Save as skill" generation from finished sessions.
- Mission Control handoff polish — resume/open delegate sessions in the right CLI surface, nested sub-agent runs, token/cost/file summaries, and brand marks.
- Workspace-rooted filesystem hardening — file reads/writes flow through checked Rust commands instead of broad webview FS permissions.
- Codebase Interview — `userAnswerQuestion` pause tool plus `/interview` for capturing project decisions.

## v0.2 (verified 2026-06-08)

- Plan / Build modes, `@`-mentions, slash commands, project-rules loading.
- Provider switcher — Ollama, OpenAI-compatible APIs, and subscription CLIs all live.
- Streaming through Rust for every provider.
- API keys stored in the OS keychain, managed from Settings.
- Quiet agent control surface with mode switching, provider choice, context pressure, skills, rules, history, and diff review.
- Real Claude Code / Codex / OpenCode delegate PTYs in the AI panel.
- Mission Control v2 — inspect runs, resume delegate sessions, and hand off a run to another CLI.
- Project Memory v1 — summarize a session into durable `.klide/memory/` markdown and browse it in a centered modal.
- Skills install + uninstall via `npx skills add`, with provenance grouping (Vercel / Matt Pocock / Anthropic / Personal / Workspace).
- "Save as skill" sparkle — auto-generates a `SKILL.md` for reusable patterns in finished sessions.
- Profile modal — local IDE profile (avatar + identity + workspace), `⌘.`
- Command palette · find-in-files · editable harness settings · checkpoint rollback.
- Live provider smoke matrix verified for Ollama, MLX, Anthropic direct API, one OpenAI-compatible API, and Claude Code / Codex / OpenCode delegates.
- Premium polish pass on the always-visible chrome (ActivityBar, TabBar, StatusBar, WelcomeScreen).
- Parked: Context Lens/project graph heuristics. If revived, feed Memory/summarization instead of silently injecting chat context.

## v0.1 — MVP

- Layout shell — activity bar, sidebar, tabs, editor, terminal, AI panel, status bar.
- File explorer — open folder, tree view, click to open.
- Tabs — multiple files, switch, close.
- Editor — Monaco with syntax highlighting + `Cmd+S`.
- Status bar — filename, language, cursor position.
- Terminal panel — real shell via PTY, toggleable.
- AI panel — streaming chat against local Ollama (native `tools` API).
- Agent mode — `write_file` / `create_file` with diff review.
