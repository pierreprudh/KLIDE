# Changelog

## Unreleased

- The compaction row reads as a row of the conversation: its mark (Phosphor's StackSimple — the turns folded into layers — from the app's icon set, in place of a hand-drawn glyph) sits in the gutter where the agent marks sit, and "Compacted 5 earlier turns ›" is the same disclosure line as "Worked for" — the UI face, not mono — opening onto the summary in the text column.
- A compaction's notes carry a ledger of what the folded turns did. Dogfood on lfm2.5 at 32k, reading files one per turn: the run compacted every few reads, and each time the model's notes forgot which files it had read, so it read them again, overflowed again, and compacted again. Each summary now ends with every tool call in the folded turns — the argument that names it, failed ones marked — and the folded results are saved to the value store at compaction time, so the line says which `peek_value` id reopens it instead of re-running the call.
- GitHub Copilot joins the CLI agents. Its CLI (`npm i -g @github/copilot`, `copilot login`) runs on your Copilot plan: a terminal session starts it with the first message (`-i`) and resumes with `--resume`, Klide's agent tools reach it as a session-only MCP server (`--additional-mcp-config`, your own `~/.copilot` servers untouched), a Focus turn streams its answer, its finished thinking and its tool rows (`--output-format json`) and continues the same Copilot session from turn to turn (`--resume`, so only the newest message is sent), and a Mission task dispatches it one-shot. Headless, edits are allowed and shell commands are denied — Copilot refuses them itself, "no interactive user response" — except the commands the project already approved in Klide, which ride over as `--allow-tool shell(…)` (a trailing ` *` becomes Copilot's `:*` prefix; any other wildcard is dropped, never widened), and Klide's own agent tools. Its version check reads the `@github/copilot` npm feed. Live-checked against copilot 1.0.101 (`installed_copilot_streams_tools_and_resumes`, opt-in). Its sessions (`~/.copilot/session-state/<id>/events.jsonl`) are on Mission Control's board — title, the model `auto` actually picked, tokens net of cache reads, files touched, the conversation with each tool's result — wearing Copilot's mark, and "continue this in Klide" works from Copilot through the `/klide` skill it already reads from `~/.agents/skills`. Not yet: its reasoning-effort levels (they depend on the model — `auto` refuses any).
- The compaction marker sits where the summary begins. Live, it was appended at the end of the conversation, under the answer of the turn that ran on it, and everything above it — that turn included — was dimmed as if the model no longer saw it. A compaction at the start of a Run is now drawn above that turn's message, live and on reload alike (the run's region moves down with it, so streaming stays attached); one mid-run is folded into the run's rows at its place; a Compact between turns stays below the exchange it folded.
- A Run that compacts itself mid-run keeps its newest tool result. On Ollama the rebuilt prompt used the continuation replay's text fold, which attaches a result to the *next* assistant turn; mid-run the newest result has none yet, so it was dropped and the prompt ended on the model's own pending call — lfm2.5 then invented the file and looped (dogfood). A mid-run rebuild now uses the structured shape the Run was already sending.
- A compaction's notes are notes. Dogfood on lfm2.5: the stored summary was the model's own reasoning (`<think>…We need to read the file…`) — a model that thinks inline returns it as text, and a small one read the instruction as the next step of the task — so "what's my first message?" found nothing. The reasoning is now cut from the notes (unclosed reasoning counts as none, and the stand-in notes are used), the instruction says plainly that it isn't the user and isn't the task, and every request of the user's in the folded turns rides along word for word — the first one always, then the newest twelve — whatever the model wrote. Re-checked on lfm2.5: it writes goal / files / open work.
- The live "Thinking" header runs for models that think inline. It waited for the reply text to be empty, and an inline `<think>` streams as text, so those models showed a static "Thought process" and a bare caret while they thought.
- Compaction no longer refuses a conversation made of one big exchange ("Nothing to compact yet — every turn is still recent"). The cut keeps about a quarter of the budget verbatim at a turn boundary, and with one request, one turn of nine file reads and the answer, the only boundary that met the budget kept everything. It now falls back to a later boundary — fold the request and the batch, keep the answer. The Compact button also cuts against the window the gauge shows (an Ollama cap) instead of the model's trained maximum. On Ollama this was the only fold available: its replay carries earlier tool results inside the assistant text, where trimming and the squeeze can't reach them.
- A turn whose tool batch alone overflows the window no longer ends the Run. Dogfood: a small local model read nine 12 KB files in one turn on a 32k window; trimming protects the newest results and the summary needs older turns to fold, so the fit guard refused the request ("needs 46162, but the window is 32768"). Before refusing, the loop now moves inline tool results to the run's value store — this turn's unsent results first, which costs the prompt cache nothing, then older ones — and stops as soon as the request fits; the model reads the `peek_value` stubs and can open any file in full. Only a request that can't fit even then is refused.
- Fixed: picking a reasoning level on a current Claude model failed every turn. The adapter sent `thinking: {type: "enabled", budget_tokens}`, which Opus 4.7+, Sonnet 5/5.5, Haiku 5.5 and Fable refuse with a 400 ("thinking.type.enabled is not supported for this model"). Models from 4.6 on now get adaptive thinking with the level as `output_config.effort` (summarized thinking from 4.7 on, so the stream isn't a silent pause); older models keep the token budget. Verified live on Sonnet 5.5 and Haiku 4.5 (`live_anthropic_reflection_levels`).
- CI runs the Rust tests again. `cargo audit` had failed since before #213 and skipped them: quinn-proto and rustls are bumped past their advisories; the three zip 0.6 advisories (all about extracting an archive to disk, which neither Klide nor ironcalc does) are recorded as ignored in `.cargo/audit.toml` with that reason, until ironcalc moves to zip ≥ 9.
- A Run that outgrows its window summarizes its own older turns — any Run: a Mission attempt, a worker or a background chat as much as a conversation in a panel. Compaction was the panel's job, so a headless Run could only trim tool results and overflowed once its own messages filled the window. Now, when the prompt still crowds the window after trimming, the loop asks the conversation's model for notes-to-self (the conversation exactly as last sent plus one instruction, so the call reads the cached prefix), folds everything before a turn boundary into them, keeps the newest ~quarter verbatim, and rebuilds the prompt through replay so the next request is the bytes a follow-up will send. The operator's latest request rides along word for word when it falls in the folded part; an empty or failed summary falls back to notes built from the turns. `/compact` and the Compact button run the same cut and summary in Rust (`agent_compact_conversation`), and the panel's send-time auto-compaction is gone.
- Fixed: compaction promised to keep the most recent turns verbatim but kept none. The marker is appended after the turns it keeps, and replay dropped everything before it, so the model saw only the summary. The marker now records how many events before it it keeps (`kept`), and replay honours that; markers written before keep nothing, as before.
- Prompt caching, end to end. A Run's prompt now opens with the exact bytes of the request before it, so the provider's cache serves the history instead of re-reading it at full price. On Anthropic, the system prompt and tools carry an explicit breakpoint on the hour (shared by every conversation in the project), a conversation you are in caches on the hour too — a diff review or a reply ten minutes later still reads it — and a headless Run (Mission attempt, worker) on five minutes; an hour breakpoint can't read a five-minute entry, so a conversation never mixes them (measured). OpenAI gets a `prompt_cache_key` per conversation, OpenRouter's Claude and Gemini get breakpoints, DeepSeek/xAI/local servers get a stable prefix. What used to break it: every later system message (TODO list, steering nudges, compaction summary) was hoisted into Anthropic's top-level `system`; the TODO list was rewritten in place near the top of every request; a requested skill's instructions were appended to the system prompt; tool calls were replayed in a different shape than the live loop sent them; and none of the loop's own injections were in the transcript, so a follow-up rebuilt a different history. Now later system messages stay where they were added (a `system` turn on models that read one, fenced text otherwise, with a one-shot plain retry if a model refuses the shape), TODO snapshots are append-only, every injection is recorded (`context_injected`) and replayed in place, and live and replay build tool calls in one canonical shape. Usage carries `cacheReadTokens` / `cacheWriteTokens` (the prompt stays the whole prompt, so the gauge is unchanged), cost prices cache reads and writes, Anthropic list prices are current, and each answer's stats show "N% cached". Live check: the third request of a loop reads 6,834 of 6,868 prompt tokens on Haiku 5.5, 99.7% on Sonnet 4.6 (`cargo test --lib live_anthropic_prompt_cache -- --ignored`).
- In-run trimming cuts every eligible old tool result in one pass rather than five per turn — each pass edits cached history, so one batch pays for it once — and a cut result is retained, not lost: its full text goes to the run's value store and the model reads it back with `peek_value`, the stub being exactly what replay rebuilds.
- Native Harness and Hermes MCP runs can propose evidence-backed lessons with `memory_propose`. The Memory inbox lets you edit, keep, or dismiss them; pending lessons stay out of recall. Proposals survive restarts and share the main checkout across worker worktrees. Hermes memory search/read verified end to end in the app.
- The toasts worth acting on can be acted on. "Claude Code needs your input", "…finished its turn" and "Background observer updated <conversation>" now carry **Open**, which lands the conversation exactly where a click in the rail would — Focus's canvas or an AI panel, raised if it is already open, its project brought along. A Delegate session that never became a stored conversation is reattached to its live terminal instead, Mission Control's Reattach. App hands the opener over through `conversationNavigation.ts`, the same seam Settings uses.
- Notifications stack. Toasts used to line up as separate glass chips, four deep, each with its own timer. The newest now sits in front in the bottom-right corner and older ones tuck behind it — 14px of each showing, 5% smaller, content hidden — and pointing at the stack (or tabbing into it) fans it out into a readable list and pauses every timer until the pointer leaves. Each toast carries its tone as one mark (check, info, warning, error) instead of tinting the text; a dismissed toast slides right and the rest close the gap. Shape after bencho.dev's toast stack, cut from Klide's tokens.
- A provider that breaks before answering is tried once more, and a failure you can retry says so. An OpenRouter upstream crash ("Upstream error from CoreWeave: Internal server error") ended the run on the failure row with nothing to do but resend the whole message, rerunning the commands that had already worked. Now a broken upstream (500, 502, 529, an aggregator's in-stream upstream error) that failed before a single chunk reached the conversation is called again after two seconds, once per call and at most twice per Run, with a line in the conversation saying so; a refused request (4xx), a proxy timeout, a call that had already streamed part of an answer, and a Delegate CLI (which runs its own tools) are never retried. A retryable failure that still ends the conversation offers **Try again**, which continues from where the Run stopped, the tools that already ran kept as history, not run again. A live failure is now drawn as the same Run-failed row a reopened thread shows, instead of a ⚠ line in place of the answer.
- A background worker's report resumes the conversation the way it was working: its mode, its turn budget and its rung, full auto included, and a flip made while the parent still runs carries into the follow-up. It used to wake a read-only Plan turn of four tool turns, so a full-auto conversation that dispatched an implementer stopped to ask before its own `git log` once the report came back. A background shell's completion still wakes a bounded Plan turn without full-auto authority, and the report stays fenced as untrusted data.
- A delegation shows one loader while its worker starts — the row's own "Starting…" — not a second "running subagent working…" line under it. Turn-budget notices ("Finalization reserve…", "Last of N tool turns…") no longer split one stretch of work into two "Worked for" folds. The dispatch card offers OpenCode's default and "Browse all models…" instead of the first entries of its alphabetical catalog.
- Hermes Focus conversations now use ACP for streamed answers, observed tool activity, edit permission prompts, and session continuity. Explicit reasoning-effort selections retain the CLI transport. The authenticated embedded MCP server exposes reviewed Project Memory search and read operations to supported Delegates using the native schemas and retrieval policy. Added an installed-Hermes transport smoke test and a repeatable native/Hermes comparison benchmark.

- While a run works, a turn that said nothing shows the gist of its thought where its sentence would be. A reasoning model often narrates only to itself — eleven turns, no visible word, twelve thousand characters of thinking — and the live digest was one work line with no thread. The first paragraph of each settled turn's thought (two sentences at most, markdown furniture off) now stands in the sentence's slot, one shade quieter than prose because it is a thought and not a reply; a thought still streaming is not read, and the settled run folds it away with the rest.
- Hermes's own setup is a first-class choice. A Hermes conversation always ran natively on Hermes's own model and key when nothing was picked, but the picker hid that behind "No configured source yet". The agent's own row now shows what Hermes runs on by itself — its `config.yaml` model, who serves it and which key name its `.env` sets — and selecting it runs Hermes natively; the trigger reads that model instead of "default". Settings → Hermes gains a "Hermes's own setup" block that says the same and changes Hermes's default model through its own `hermes config set`, so the terminal Hermes follows. Nothing reads a key's value; names only.
- Hermes's own `.env` can be aligned from Settings. Hermes loads `~/.hermes/.env` over the environment it inherits, so a key set there (by `hermes setup`) silently beat the source picked in Klide; Klide refused the launch and told you to edit the file. Settings → Hermes now shows the variables that file sets differently and offers both directions: **Use Hermes's key in Klide** files the key Hermes names for that provider into Klide's keychain, **Give Hermes Klide's values** rewrites those entries in place, so the terminal Hermes runs on them too. The refusal in the conversation now points there.
- While a run works, a new sentence arrives at the foot of the work, under the last step. It used to appear at the top: a sentence still streaming has no call behind it yet, so the fold read it as the answer, closed the rows above it to "Worked for" and drew it under the line, then reopened everything with the sentence at the bottom once the next call came. A row still arriving now stays the last step of the run it follows, with the caret, until its turn settles.
- A delegation's details read once. Opened, the "Dispatched to" row used to show the brief twice (the row's own line, then the child's first turn), the receipt sentence written for the model ("You are not waiting for it…"), the child's answer and then its first paragraph again in plain text (the Goal completion the panel draws as a card at the top level), a speed line, and a second spine inside the first. It now shows the facts of the dispatch as a short list — Model, Branch, Run, Dispatch — then the child's own rows one size down, off the column's one spine: the brief and the completion are dropped because the row already says both, and a later user turn (a goal-check round) stays.
- The dispatch card offers **Full auto** beside Cancel / Dispatch: approve the dispatch and start this one worker on the full-auto rung, whatever the conversation's own rung is. The choice rides the card's answer (`workerFullAuto`) into the worker's request; a conversation already on full auto needs no such click.
- A worker's report row is the link between the two agents. Where it said "Claude Code implementer reported" in plain words, it now draws the worker's mark, a short hairline and this conversation's mark — the way two conversations talking are linked — then who reported and the commit the Harness observed in the worker's checkout (`commit` now rides the `subagent_resolved` event as Git evidence, never the worker's claim). Clicking the row scrolls back to the "Dispatched to" row it answers.
- Every new conversation gets a name beside its first turn, the way OpenCode names its sessions: one short call on the cheap tier — the thread's own vendor's cheapest model when its key is there (Haiku, GPT nano, DeepSeek chat, Ministral), else the cheapest keyed model anywhere, a local thread's own model, a Delegate's routed source's vendor or the local default — delivered as the same event, so the rail row is rewritten when it lands. A thread on a local model never names through a hosted one. Settings › Harness has the toggle and a pin for who names. OpenCode v1 sessions' own names are read too.
- A worker runs full auto when its parent does, or when you say so on its card. A CLI worker used to start with Klide's rung off ("a CLI has its own policy") — true before its prompts were relayed into Klide, wrong since: a conversation on full auto dispatched a worker that stopped for every `git add`. The parent's rung, as it stands at dispatch, now rides the worker's request, and each command the rung answers is recorded as answered by policy, as in the parent. A worker's card under the "Dispatched to" row also gains **Full auto**: the child's own rung, flipped the way the foot bar flips the parent's — this command and every later one run unasked. A Mission attempt still keeps the policy approval froze.
- A worker's permission prompt is answered from the conversation that dispatched it. A Delegate CLI running headlessly as a worker asks before a command (`--permission-prompt-tool`), and the relay raised that prompt on the child's own Run — where no panel is attached, so a background worker waited on nobody until it timed out thirty minutes later (first dogfood, 2026-10-15). The "Dispatched to" / "Delegated to" row's watcher now folds the child's `permission_requested` / `permission_resolved`, the line reads "asking · <command>" without a loader, and the same card the panel draws for its own gate appears under the row, resolved against the child's Run id. The card builder moved out of `AiPanel` into `src/components/ai/permissionCard.ts` so both surfaces draw one shape.
- An OpenCode conversation takes the name OpenCode gives its session. The CLI titles a session with its small model beside the first turn; Klide takes it from the CLI's `session.renamed` event while the answer is still streaming (the session record is read once the turn is over only if the event never came), and the rail adopts the name for a thread nobody has named yet. A name you typed is never touched, and the first name sticks even though each new CLI session gets one of its own.
- An OpenCode turn the provider refused now says why. OpenCode exits 1 with an empty stderr in JSON mode and puts the rejection on its stream, which the exit path used to discard: "OpenCode exited with exit status: 1" for a Go model the account's region setting refuses now reads "This Go model requires Global regions…".
- An opt-in live test (`installed_claude_live_openrouter_tool_loop`, `cargo test -- --ignored`) runs the installed Claude Code through the bridge to OpenRouter's DeepSeek with the key resolved the way the app resolves it, and asserts the tool loop and the upstream usage.
- A conversation keeps the agent and model it began on: the rail mark and group never move to a later turn's pair (records 0.6.9 refiled are healed on load), and in a Delegate thread the agent menu routes that CLI onto the picked Provider's model instead of swapping the CLI.
- Enable provider/model effort controls across supported harness routes, including per-run Hermes reasoning and bridge-level overrides for Claude Code, Codex, and OpenCode.
- Share the nested intelligence-source selector across coding harnesses, with existing favorites and explicit compatibility indicators.
- Route Claude Code, OpenCode, and Codex through Klide API keys, local/self-hosted endpoints, and Nous Portal without changing the selected harness or persistent CLI configuration.
- Translate Messages/Responses protocols, namespaced functions, and custom patch-tool inputs; classify model metadata and billing by intelligence source.
- Keep credentials in the process host and restore routed terminal variables after shell profiles. Validate installed CLI tool loops against isolated mock APIs.

## 0.6.10 (2026-10-13)

- Added Amp, Cursor, Factory, and Hermes CLI providers, with official logos and documentation links. DeepSeek remains a native API provider.
- Missing CLI providers are dimmed in the chat pickers; installed CLIs appear first.
- Hermes can use a model provider and API key configured in Klide. Its model control now has nested intelligence-source, provider, and model menus, styled like the existing model selector and synchronized with shared model favorites.
- Hermes uses the same provider catalog as the base selector. Supported API, local, and self-hosted endpoints can power Hermes; CLI subscription routes that still require an inference bridge are clearly marked.
- Delegate prompts identify the selected harness instead of calling every agent Kit. The chosen model remains separate from the coding agent.
- Recorded harness/model independence as a core product principle. New CLI adapters currently support terminal launches and plain-text Focus turns; imported history and structured tool events remain future work.

## Unreleased

- Auto works on day one, with one API key and no stars. Each hosted Provider row names one model per rung — light, standard, strong — and the task shape picks the rung: Chat is light, Plan and Goal are standard, a long brief or several attached files bumps one up. Stars still lead, now nearest the task's rung first; what Ollama has installed sits at light, so a chat stays local and a Goal goes to the keyed model that fits. OpenRouter's row puts its own router (`openrouter/auto`) on every rung, so an OpenRouter-only user gets a trained router for free. The reason on `RouteResolved` names the rung, and says when nothing sat at the wanted one. OpenRouter's `-1` "priced per request" is no longer read as the cheapest model on the bench.

- A worker can be dispatched in the background. `spawn_subagent` with `background: true` returns the child's Run id at once instead of parking the conversation; the same card is asked, the same worktree is made, and the report — Git evidence included — is delivered to the conversation when the worker settles, by a follow-up turn if the conversation is idle, the way a background shell's completion arrives. The "Dispatched to" row keeps following the child live; meanwhile `agent_list` shows it, `agent_cancel` stops it, and `agent_read_result` reads what it published. Several workers can now run at once from one conversation.
- Threads already saved with another Provider's model (a Claude Code thread on `deepseek/…`) are healed at boot: the model is dropped so the thread opens on the CLI's own default, the same rule a resume now applies when a recorded model is plainly foreign.
- A thread carried onto another Provider without a recorded model no longer keeps the previous Provider's model: a Claude Code session opened from a DeepSeek chat showed "deepseek-v4.1" in its composer. It now starts where a switch to that Provider would (remembered pick, star, or the CLI's own default).

- In Focus, an opened CLI session becomes a Focus conversation on that agent, not a terminal: the transcript is carried in ("Continue in Focus") and the thread remembers the CLI's session id, so its first headless turn runs `claude --resume <id>` on the real session instead of a cold start over the folded history. In the workbench the same request opens the CLI's own terminal, as before.
- Open a CLI conversation from a Klide conversation. Kit has `list_cli_sessions` and `open_cli_session`: "open the Claude Code conv about the login bug" lists the matches, asks when several fit, and opens the one in a new panel beside the conversation, `--resume`d in its own folder. Works for Claude Code, Codex, OpenCode and Oh My Pi, with any model that calls tools.
- `klide://resume` without a session id takes the newest session of that CLI in `project=`, so Codex, OpenCode and Oh My Pi can hand a session to Klide too; the From other apps toggle now installs a second `/klide` skill in `~/.agents/skills` for them.
- Continue a Claude Code terminal session in Klide. `klide://resume?provider=claude-code&session=<id>` resumes that CLI session in an AI panel, in the project its transcript names; Settings › From other apps installs a `/klide` skill so "open this conversation in Klide", said to Claude Code, opens that link with the shell's own session id. Links also carry an explicit `project=`, and any Delegate with a resume flag is accepted.

## 0.6.9 (2026-10-12)

- Added OpenCode 2 support across Focus, interactive sessions, and Missions while retaining OpenCode 1 compatibility. Private local servers stream native answers, reasoning, and tool activity, recover interrupted event delivery from durable history, and support resumed turns and native slash commands.
- Fixed duplicate OpenCode answers when reasoning preceded text. Reasoning now appears separately in the thinking display and remains in completed conversations.
- OpenCode V2 model discovery uses a private query, so an unavailable shared service cannot hide Go, free, or configured local models. Credentials remain managed by OpenCode.
- Provider commands appear before Klide commands in the slash menu, with section labels.
- Reopened conversations use their latest dispatched provider/model pair while earlier responses keep their own labels. Focus's New task picker remembers human model choices per provider, and partial delegate model lists no longer replace saved choices.
- Added an isolated OpenCode smoke test covering model discovery, reasoning and answer streaming, resume, commands, and status callbacks without paid inference.

## 0.6.8 (2026-10-07)

- Sight lets a model without image support borrow another model's vision. Settings can select the Eyes model; automatic selection prefers an installed local vision model. Descriptions, attribution, and usage are retained in the conversation.
- App and background agent runs now share admission, placement, controls, and crash recovery. Panic recovery finishes the transcript and error summary before a retry can start, and releases shells and delegate sessions.
- The Memory window separates proposals to review, saved memories, and the selected document.
- Mistral model context windows, tools, and image support come from its model metadata. Provider and model marks have been refreshed.
- Fixed the blank-window startup case and environment-reference defaults in API key settings.
- Updated source-map-js to its patched version; frontend and Rust CI pass.

- Agent commands now start in the environment a terminal would give them: the login shell's PATH and variables (captured once per launch, so a Finder-opened Klide no longer runs Apple's `/usr/bin/python3`), the project's `.venv` first when there is one, and no variable whose name contains `KEY`, `SECRET` or `TOKEN`. A Python script's approval card names the interpreter it will start — version and venv — before Run.
- A shell command that is really a Python script (`python3 - <<'PY'` or `python3 -c`) now shows as one on the approval card: the Python mark where `$` would be, the files it writes named in the reason line, and the program as highlighted code, one statement per line, first three lines until expanded. A command with anything chained after the script keeps the plain shell line, and no `python3 *` pattern is offered.
- The Welcome card now plays a big-pixel nature film in place of the ASCII globe: five scenes (dawn, forest, a lake at night, under the surface, a summer meadow), played at a calm 0.5× pace, with tile seams and a light film grain. Scenes change through a wave of code glyphs that resolves into the next landscape. Cells stay integer-sized for crisp Retina pixels, the film pauses while the window is hidden, and Reduce motion shows a still meadow.

## 0.6.7 (2026-10-06)

- Live local inference testing exposed a context mismatch: Klide’s tool prompt exceeded the managed llama.cpp server’s 8k limit. Managed servers now use 16k, with matching provider metadata and more conservative memory estimates. Llama app setup guidance calls out the same context requirement.

- Added Llama app as a local provider with the Llama logo, model discovery on port 9931, and a download link in Local Servers settings. Llama manages its own server and models.
- Documented the Klide Q8 model comparison between Ollama and llama.cpp on Apple M5, including per-task latency, tool-call correctness, raw results and reproduction commands. The small sample shows no clear engine advantage; failed plain-text tasks are identified explicitly.
- Added an opt-in live benchmark through Klide’s streaming adapters. It does not execute workspace tools or run the full agent harness.

## 0.6.6 (2026-10-05)

- The Settings advisor model picker opens toward the available space in the window.

- Failed `/goal` checks now end the Run in error with the check output, rather than reporting successful completion. Delegate CLI goals also run the configured check even when Klide dispatched no tools.
- Project Memory now proposes up to two evidence-backed lessons for review after meaningful work. The Memory inbox shows pending proposals; users can keep or dismiss them. Duplicate and dismissed lessons are suppressed, with bounded pending proposals and automatic expiry.

## Claude Code effort (2026-09-26)

- Claude Code now offers low, medium, high, xhigh, and max reasoning effort in the existing picker. The selection reaches both terminal launch/resume and Focus chat turns.

## GitHub observer cards (2026-09-24)

- Watcher cards fill the conversation width and also stay in Focus's right-side panel, sharing the same live status. Closing the panel leaves a GitHub icon to reopen the watcher.
- Plain `gh run watch <id> --exit-status` observers now show a compact GitHub card in the conversation, refreshing the pinned run's checks every eight seconds while visible. Completion still wakes the original conversation through the native observer.
- Cards link to GitHub and open the associated PR directly in Git Review. Failed checks, unavailable status, and results from older PR commits are distinct from success. Completed cards retain no command logs and remain available for the app session (up to eight recent completed GitHub observers per conversation).


Notable changes per milestone. Dates are completion dates.

## Unreleased

- A photo dropped on a model that can't see images is no longer refused. Another model describes it first — an installed local vision model when there is one (the picture stays on the machine), else a hosted model you have a key for, or the pair chosen under Settings → AI → Eyes model — and the blind model reads the description where the picture would have been. The thread still shows the picture, and the describing itself appears under the message as a `look_at_image` step — running while the eyes look, then holding what they read, like any tool call. The described attachment is recorded on the transcript so a reopened conversation replays the same prose and the same step. Subscription CLIs can't be eyes yet, and a photo is still refused when nothing can see it.

### Plan or Work, and a `/goal` to reach

- **Two rows.** The Mode menu offers Plan and Work — Work is the `goal` tier
  under the name of what it does, and it is the default: a new composer opens
  on it. Chat is no longer a pick; a model that cannot call tools still
  collapses Work to it, and the Work row stays marked, greyed, so the pick
  is still readable. `/work` and `/plan` switch; `/chat` is gone.
- **`/goal <objective>`.** Goal is a command now, the way Claude Code and Codex
  spell a one-shot: it stays in the draft as typed, the turn rides in Work
  whatever the picker says, and the system prompt asks the model to say what
  done means, work through the checks, and stop only at the finish line. A
  bare `/goal` is not a turn.
- The transcript, the Rust Harness and the Mission documents keep `goal` as
  the tier's id; only the words changed (CONTEXT.md, HARNESS_CONTRACT.md).
- **The goal gate.** A `/goal` turn's "done" is checked. When the model stops
  after changing the workspace, the Harness runs the post-edit check command
  (Settings → Harness → Test after edit) once more; a failure comes back to the
  model as the next message and it goes another round, three by default. The
  conversation shows each round as a marker — `Goal check … failed — round 1
  of 3, going again`, then `Goal reached: … passed` — or says plainly that no
  check is set, so an unverified finish never reads as a verified one. A
  `/goal` turn also gets a tool-turn cap of at least 200, the long leash a
  goal needs.

### Approving from the keyboard

- **↵ runs, Esc denies.** The command card the run is blocked on answers the
  keyboard: ↵ approves once, Esc denies, from anywhere that isn't a text
  field — and from the composer itself while it is empty, so you never leave
  the field. Typed text keeps ↵ for queueing the message.
- **The decision in words.** The card says Deny · Run (Allow, Accept,
  Dispatch by kind) with its keys beside it; the scope options — this run,
  this project, a pattern — stay as quiet icons behind a hairline.

### Delegates

- **Codex and Oh My Pi show their work in Focus.** Both CLIs now run a
  headless turn in their structured mode (`codex exec --json`, `omp --mode
  json`) and are read into the same rows Claude Code and OpenCode already
  get: each command, patch and MCP call as a tool row with its result, text
  as it arrives, a sandbox refusal as a failed row that says "Declined".
  Both also continue their own session across turns (`codex exec resume
  <thread>`, `omp --resume=<id>`), so a turn sends only the newest message
  instead of the whole transcript. Fixtures were captured from the real CLIs
  (codex-cli 0.154, omp 15.13.3); Codex's item shapes follow its
  `exec_events.rs`.
- **A mode change reaches a resumed delegate session.** A continued session
  gets only the newest message, so switching Chat → Goal (or toggling a skill,
  editing the project rules) used to be announced to nobody. The runner now
  remembers a fingerprint of the instructions each session has seen and, when
  they changed, says them again ahead of the message. In the prompt rather
  than on `--append-system-prompt`, because Claude Code records its system
  prompt on a session's first request and ignores the flag on `--resume`. An
  unchanged turn still sends just the message.
- **Claude Code asks you, per call.** A headless Claude Code turn used to
  refuse anything its own rules did not pre-approve — `gh pr list` came back
  "requires approval" and the turn moved on without it. The turn now names
  Klide's embedded MCP server as its `--permission-prompt-tool`: every prompt
  the CLI would have shown in a terminal lands on the same card Klide shows for
  its own shell commands, in the conversation that is running it, with the
  same answers — once, for this run, for this project. "For this project"
  writes the project allowlist the next headless turn carries, so a project
  that only ever used Claude Code finally builds one. The full-auto policy
  answers a command without a card and says so in the transcript; a command
  rejected this run is declined without asking twice. Klide answers the
  question only — the CLI still runs the call itself, and the call stays
  observed. Works in both hosts, the app and the background `ptyd` run host.
- **A CLI's home is honoured everywhere.** `CODEX_HOME`, `CLAUDE_CONFIG_DIR`
  and OpenCode's XDG directories now reach every place Klide touches a
  Delegate's files — the status-hook installer, the gateway's Codex
  un-inject, connector discovery, the account switcher, model caches, skills,
  Mission Control's run listing and reads. Before, one of nine Codex sites
  read `CODEX_HOME`, so a moved home got its hook in one `config.toml` and its
  un-inject in another. Each adapter resolves its own paths
  (`delegate/home.rs`); a source scan keeps `~/.codex` out of every other module.
- **One truth per CLI.** Label, binary, login commands and the accounts flag
  live on the adapter; the Provider registry, the account switcher, the commit
  co-author line and the frontend (`src/delegates.ts`, pinned by a drift test)
  read them from there. OpenCode's login hint no longer disagrees with itself
  (`opencode auth login`), its auth check reads the same `auth.json` the
  switcher snapshots instead of always saying yes, and omp's runs are priced
  as free like every other Delegate's.

### From other apps

- **`klide://` links.** `klide://new?prompt=…&project=…` opens a new Focus
  conversation with the composer pre-filled — never sent, since any web page
  can fire a link; `klide://open?path=/file:42` opens a file at a line,
  bringing its repository along; `klide://project?path=…` opens a folder.
  Paths are checked in Rust; a bad link is a toast, not a silent no-op.
  macOS delivers links to the installed app in `/Applications`, not to
  `tauri dev`.
- **Ask Kit in the Services menu.** Settings → General → From other apps
  installs a Quick Action: select text anywhere, right-click → Services →
  Ask Kit.

### Connectors

- **The assistant can use your connectors.** In Plan and Goal, a conversation
  reaches every enabled MCP server through `connector_tools` (what it offers)
  and `connector_call` (run one tool). Tools the server marks read-only run as
  asked; anything that can change something asks first, per tool, with the
  usual run/project scopes. Full auto never answers it.
- **Connect GitHub in one click.** Settings → Connectors adds GitHub's own MCP
  server (`api.githubcopilot.com/mcp/`, repos · issues · pull requests ·
  actions), signed in as the account Klide already uses. No token is typed or
  stored: the header holds `${KLIDE_GITHUB_TOKEN}`, resolved at connect time.
- **Remote connectors.** A connector can be a URL (Streamable HTTP, JSON or
  event-stream replies), and discovery now imports the remote servers Claude
  Code, Codex and OpenCode have configured instead of skipping them. Header and
  env values may be `${VAR}` references.
- Connectors stay connected across messages instead of starting per Run, and
  start in the background at launch.

### Permission

- **Settings → Harness → Tools per mode now takes effect.** The toggles were
  saved as `goal.write_file` and sent verbatim, which matched no Tool, so every
  toggle was dead. A turned-off Tool is now neither offered nor dispatched, the
  chips come from the Tool registry per mode (Chat included), and the Skills
  inventory groups Tools by the capability Rust records.
- **Approving a command does not approve it in the background.** A background
  or watched command asks on its own card; the project allowlist covers
  foreground commands only, and full auto is recorded as full auto.
- **Full auto no longer lets another agent's messages in unreviewed**, and a
  Mission attempt or child Run can no longer be flipped by a conversation's rung.

## v0.6.5 — Shells, Watchers, Links (2026-09-23)

Three things the v0.6 line gained after the 0.6.4 cut. A long command no
longer has to be sat on: a Run can start a shell in the background, read what
it wrote since last time, stop it, or ask to be woken when it exits. A
delegated subagent is no longer a static line: the parent's conversation
follows the child Run live, and a worker that failed comes back as a failure.
And what an answer names is something you can reach — a URL opens in the
browser under its name, a rooted path opens in Finder, and a file of the open
project opens in a tab.

Around them, the interface pass: a context menu that behaves like a native
menu, a conversation rename that sticks, command history that reads as
history rather than a result, and a Skills modal with the same brow as every
other overlay.

The v0.6 orchestration milestone is unchanged: Missions as outcomes, budgets,
capacity, capability routing and validation contracts are still open. The macOS
bundle is still ad-hoc signed rather than Apple-notarized. This is a patch cut
on the v0.6 line, not that milestone.

### Background shells (a command that outlives the turn)

- **`run_command` can start a command instead of running it.** A foreground
  command blocks the turn and dies on a timer — 180s by default — which is
  right for `npm test` and wrong for anything that waits on the world: a
  deploy, `gh run watch`, a slow migration were killed mid-flight and reported
  as failures. `run_command(background: true)` now returns a shell id at once
  and the agent keeps working; `read_command_output(shellId)` returns only what
  was written since the last read, so a polling loop sees each line once;
  `kill_command(shellId)` stops it. The registry (`agent/background.rs`) is
  Tauri-free like the PTY host, caps each buffer at 256 KB and *reports*
  dropped bytes rather than handing back a silent gap, and marks stderr so a
  warning does not read as a result.
- **Nothing the agent started outlives the Run.** Shells are reaped in
  `settle_run`, the one terminal door every outcome passes through,
  cancellation included. Shells are run-scoped: another Run's shell id is
  indistinguishable from one that never existed, and a model that lost its own
  id gets its shells listed back so it recovers instead of doing the work
  twice.
- **Polling is its own capability.** `read_command_output` and `kill_command`
  carry a `ManageBackgroundShell` capability rather than `RunCommand`, for two
  reasons: a poll must not re-open the permission card every ten seconds, and
  a poll recorded as a command would inflate every Validation contract's
  command count.
- **A shell can wake the conversation.** A background command can ask to
  notify on exit; when it does, the conversation gets a follow-up turn with
  the result instead of waiting to be polled. The wake reads as a continuation
  of the answer that started the shell — one action row, each answer keeping
  its stats — with a finished marker on the tool-row indent and a hairline
  joining the wake to the exchange it belongs to on hover.

### Subagent watcher (a child Run you can see working)

- **The "Delegated to" line follows the child live.** `spawn_subagent` parked
  the parent and showed one static line while the child read forty files. The
  child is a Run like any other — Rust already persists its events and
  broadcasts them — so the fold now records its id (`childRunId`, from
  `subagent_requested`, so a reloaded transcript can pick a live child back
  up) and the delegation row shows its current step, step count, tokens, a
  clock, and the child's own rows on click. The same line sits under an
  `@role` background report, which previously showed a bare `· working…`.
  Settled means a real report landed, never the "Running spawn_subagent…"
  placeholder, so a running child never flashes a "View activity" button
  beside a static line, and an interrupted child stops animating.
- **A subagent inherits the parent's command timeout.** `SubagentRunSpec`
  carries `command_timeout_secs`, so a child reads the Settings value instead
  of silently falling back to 180s.

### Workers (what a child's result may claim)

- **A failed child is a failed Tool result.** Loop completion is not task
  success: a cancelled, exhausted or errored child could return `Ok` with the
  answer it wrote before stopping. A child report now counts as success only
  when its durable Run summary says `done` and it produced an answer; anything
  else returns `ok: false` to the parent with the error itself, and the result
  carries `runId` and `outcome`. Success describes execution, not an accepted
  validation contract.
- **An isolated worker reports its checkout as Git saw it.** After settlement
  the result records `headCommit`, `branch` and `hasUncommittedChanges`; a
  failed inspection is exposed as `checkoutError`, never converted to a clean
  checkout, and auto-commit stays best-effort rather than an unconditional
  "committed" claim. The worker's prose cannot certify that its branch is
  ready to merge.
- **Dependent dispatches pin a source commit.** `spawn_subagent.source_ref`
  names a branch or commit of the same repository; the Harness resolves it to
  a full commit id *before* the dispatch card, shows that id on the card, and
  creates a fresh worker branch at exactly that commit. With nothing named, a
  Git worker pins the parent's HEAD the same way. A tester following an
  implementer receives the implementer's `checkout.headCommit` and works on
  its committed changes without merging them into the parent; only committed
  files transfer, invalid references fail without falling back to HEAD, and an
  existing worker branch is never adopted for a pinned dispatch.
- **Mission Control keeps a worker's tool-only turns.** The detail pane used
  to fold commentary and tool-only messages into summaries; inspection now
  preserves every message at its original position.

### Links and places (what an answer names, you can open)

- **A URL in an answer is a link, and it opens where links open.** A model
  writing a URL in prose left it as text, and the one link shape the renderer
  did understand carried `target="_blank"` — which in a Tauri webview has no
  tab and no back button, so following it would replace the running app with
  a web page. `externalLink.ts` is now the one door out of the webview: it
  linkifies a bare URL with its sentence punctuation left outside, opens it in
  the system browser under Tauri and a new window elsewhere, and toasts
  rather than failing silently. A drawing's anchors are delegated to the same
  door. The `opener` plugin the frontend had been calling is finally
  registered on the Rust side — every part looked present and one line joined
  them — and a drift test walks the frontend for `@tauri-apps/plugin-*`
  imports and asserts each is registered in the builder.
- **A link reads as its name.** A 90-character URL is a worm across a
  sentence and the part a reader wants is one word inside it. `linkIdentity`
  names it — the repo, the package, the product, or the hostname when Klide
  has no name for the site — and moves the address to the hover. Marks come
  from a table, never a favicon fetch: an app whose claim is that it runs
  locally does not announce to every host a model mentions that you are
  reading about it. The conversation also moves from 13 to 14px — the answer,
  your own message, the composer — while chrome stays at 13.
- **A rooted path opens in Finder.** A backticked `/Users/…` or `~/…` path
  reads as the word that carries the meaning and reveals in the file manager
  through `revealPath.ts`. Rooted is the rule on purpose: a name written
  relative to a project belongs to whichever repository the answer is
  *about*, which is often not the one Klide has open. Emphasis renders its
  contents through the same inline pass, so **`/Users/…`** shows both. The
  folder pickers now start where the last opened project's siblings live.
- **This project's own files open in the editor.** A relative path is a
  *candidate* until the open repository recognises it: `workspaceIndex.ts`
  runs the walk `⌘P` already uses, once per project, lazily, on the first
  relative path an answer names. A recognised file opens as a tab at its
  cited line; anything else — another project's folder, a directory, a
  branch name shaped like a folder — stays prose or goes to Finder.

### Interface

- **The context menu joins the app's popover sheet and behaves like a native
  menu.** Explorer rows and conversation rows share one ContextMenu, which
  now wears the same sheet every other popover wears and unfolds from the
  corner that sits on its anchor. Rows are real menuitems: arrows walk them,
  Home/End jump, a letter finds the next row, Enter takes it, Escape and Tab
  leave; one highlight serves pointer and keyboard and it is the focus ring.
  The sheet closes when the page under it scrolls. Every popover entrance now
  honours `prefers-reduced-motion`.
- **Rename a conversation in place, and the name sticks.** The row's `⋯` menu
  gains Rename; the title becomes an input where it is read, sharing the
  Explorer's in-place editor (`InlineNameInput.tsx`). Mission Control's rename
  used to be overwritten by the next autosave, which re-derived the title
  from the first message; a Stored conversation now carries `renamed` and a
  given name wins over a derived one. Naming a thread does not bump
  `updatedAt`, because naming is not using.
- **Command history reads as history, not a result.** A completion card whose
  run changed no files and produced no document but ran commands now says so
  — passed, failed, without a result — and keeps failures intact; a later,
  different command is not proof of recovery. Only a fence with an explicit
  source language gets syntax colours; an unlabelled fence or one marked
  `console` / `output` / `log` is shown as text, since guessing colours
  terminal output as code.
- **A pasted API key replaces a stale env reference.** A dangling `${VAR}`
  reference used to win over a freshly pasted Keychain key, so the row
  verified against the reference, failed, and rejected the next paste as a
  literal. The method saved last wins, and a key typed under Env ref says to
  switch to Paste.
- **Focus starter cards stand bare.** The four direction cards drop the 26px
  tile behind each glyph; a browser preview page renders the real HomeCard
  against the real tokens.
- **The Skills modal wears the same brow as Memory and Worktrees.** The
  header drops its counts, says its name at 20px in a 50px strip, the rail
  drops its "Sections" label, and a row's meta line eases in over 240ms with
  a short delay so a cursor swept down the list does not strobe.
- **The install note says how to open the bundle.** Control-click › Open is
  gone from macOS 15; the README now points at Privacy & Security › Open
  Anyway, with `xattr -dr com.apple.quarantine` as the direct alternative.
  Distribution is GitHub Releases only; notarization is deferred, recorded
  in TODO.md with what taking it on would cost.

### Known findings, open

A review over the background-shells diff raised eleven findings, none fixed
in this cut. The three that matter: the AiPanel retry on "run already active"
has no attempt cap, so a send behind a Run parked on an unanswered card can
spin without an error; the observer guard admits race members, so a race run
can register an observer that wakes a Run whose worktree a merge may already
have torn down; and a background command admitted by an allowlist entry or the
full-auto rung starts without the disclosure the permission card carries. The
rest are smaller: a possibly-recycled process-group pid killed after reap, a
1 Hz observer poll per mounted panel whether or not an observer exists, a
failed follow-up that still toasts success, observer guidance injected into
Chat and Plan prompts that have no `run_command`, and an `observer_completed`
that does not mark an interrupted turn.

## v0.6.4 — Workers, Connectors, Visuals (2026-09-20)

Three things the v0.6 line gained after the 0.6.3 cut. A Harness Run can hand
a task to another CLI agent as a worker — a gated dispatch, an isolated
worktree, a Run of its own — instead of shelling out to `claude -p`. Klide
connects to the MCP servers you already configured elsewhere. And an answer
can draw: an `html` or `svg` fence renders as a picture in the conversation,
themed and sanitized, with a page getting a document of its own.

Around them, an interface pass: a skill typed into the chatbox reads as a
skill, the Settings controls say their own value, a conversation row folds its
actions behind one mark, and the context gauge finally measures the window the
turn actually ran in.

The v0.6 orchestration milestone is unchanged: Missions as outcomes, budgets,
capacity, capability routing and validation contracts are still open. The macOS
bundle is still ad-hoc signed rather than Apple-notarized. This is a patch cut
on the v0.6 line, not that milestone.

### Workers (a subagent that is another CLI agent)

- **`spawn_subagent` can name a `worker`.** Asked to "have Claude implement
  this, then have Codex test it", a Harness Run had no door but the shell: it
  ran `claude -p` and `codex exec` through `run_command`, six approval prompts
  and no Run of its own for either agent. A call that names a worker — any
  Delegate id, `claude-code`, `codex`, `opencode`, `omp` — now hands the task
  to that CLI as a nested Run of its own: the operator approves the dispatch
  on an inline card (this once or not at all, never remembered, never silenced
  by full auto), the worker gets an isolated worktree on a `klide/worker-…`
  branch, runs as itself with the role's instructions rather than Kit's
  persona, and its edits are committed to that branch on settle. The parent
  gets the report plus the branch to review; nothing in its checkout changes.
  With a worker the editing roles `implementer` and `tester` are allowed;
  without one the tool stays read-only on the parent's model, as before.
- **A worker with no model named asks which one.** Before the dispatch card,
  the question card offers the CLI's own default first, the next two models
  its cache lists, and the whole catalogue behind the model picker — drawn as
  numbered rows like the plan, picked with a click or `1`…`4`. Skipping is the
  CLI's default; a model the call named is not re-asked. The same rows serve
  `userAnswerQuestion`, which gains an optional `choices` list.
- **An editing role with no worker asks which agent should take it**, and
  which model, on one card in two steps: the agents usable here — Delegates
  installed, API providers with a key — each wearing its mark, then the picked
  agent's models, with the agent's name one link back to change it. Every
  dispatch Kit decided is put to the user this way: what Kit named only
  pre-selects rows — one click confirms, another changes — and skipping keeps
  Kit's pick, or is the user's no when Kit named nothing. A dispatch the user
  spelled out themselves — "have Codex on gpt-5.4 do it", or a CLI named
  alone, which means its default — asks nothing and goes straight to the
  dispatch approval.
- **API providers are workers too.** `worker: "anthropic"` (or any hosted
  provider with a key) runs Klide's own Harness on a model of that house as a
  nested Run in its own worktree, edits applied without review there; the
  dispatch card names it with its model. Rows on the question card wear the
  model's maker or the worker's logo in place of a number.

### Connectors (MCP servers Klide connects to)

- **Settings › Connectors.** A connector is one named stdio MCP server plus the
  decision to use it, stored in `~/.klide/connectors.json`. The page reads the
  MCP config the user already has — Claude Code's `~/.claude.json` and the
  project's `.mcp.json`, Codex's `~/.codex/config.toml`, OpenCode's
  `opencode.json` — and offers each entry for import; Klide never edits another
  tool's file, and its own `klide mcp coordination` entry is never offered.
  **Check** starts the server, completes the MCP handshake, lists its tools and
  kills it, with every read bounded by a deadline. The Skills modal's tool
  inventory lists added connectors beside the built-ins. Connector tools are
  not callable from the Harness yet; that is the next slice.


### Agent coordination

- **A send receipt reports the journal, not an assumption.** `agent_send` used
  to assert its own outcome: `acknowledged` whenever a reply came back,
  `queued` on every send that did not wait, whatever the receiving side had
  actually done with the message. Both doors — the native Harness Tool and the
  embedded MCP server — now build one receipt in the Rust core from the
  Envelope's real delivery state, including when an idempotent retry appended
  nothing, and report separately whether this call waited for and received a
  reply. A wait that times out does not cancel, resend, or move the message
  back to `queued`. A send that does not wait reads the state the command
  already returned rather than folding the journal a second time. The shape is
  versioned in `schemas/klide-coordination-send-receipt.schema.json`.
- **A reply stays inside the exchange it answers.** Knowing an Envelope id used
  to be enough to join someone else's thread: a third Run could send with that
  `replyTo`, and because the journal read the message as solicited it was
  auto-accepted, straight past the receiving side's review card. A new
  Run-authored reply must now reverse the original route — if A wrote to B,
  only B may answer A with that id. Operator-authored mail has no Run address
  to reverse onto, so only its recipient may answer it and that answer is
  reviewed like any other unsolicited message; the trusted operator may still
  answer on a Run's behalf, and a wait pinned to the sent Envelope accepts that
  answer. Enforcement happens before an event is appended, so historical
  journals keep their existing replay rules. (PR #101, 2026-09-13.)

### Visuals (a drawing the answer makes)

- **An `html` or `svg` fence renders as a picture in the conversation.** A
  model that wants to show a shape, a flow or a comparison writes it in an
  `html`, `svg` or `visualizer` fence and the block draws it in place, with the
  source one click away; a bare `<svg>` written without a fence is drawn too.
  The renderer is the trust boundary: an allowlist keeps the layout/SVG
  vocabulary and drops script, iframe, form and media whole, along with every
  `on*` handler and every URL that is not a `#` fragment, an inline image or a
  plain web link. A drawing's `<style>` is lifted out and re-anchored under the
  block's own scope class, ids suffixed to match, so two figures can both
  define `#arrow`. Colour is the other half: the block carries its own palette
  (`.klide-viz`) — Klide neutrals plus a modelled chroma — and everything the
  model writes is mapped onto it, so one drawing stays readable in all seven
  themes. Every pairing clears its WCAG bar on both grounds.
- **A model that writes a page gets a document, not a column.** A page is a
  page because its source said so — a doctype, an `<html>`/`<body>` wrapper, a
  `:root`/`body` rule — never inferred from shape, so existing diagrams render
  exactly as before. A page gets a frame, its own gutters back (defaults are
  class-level, so an authored `body { … }` wins), `vw` resolved as `cqw`
  because the block *is* the width the author meant, and a `height: 100vh`
  dropped: a visual has no screen and no fold.
- **The Focus canvas shows figures as an island.** Each drawing is a framed
  card inside the island's gutters, running the island's full width and scaled
  to the drawing's painted extent rather than its layout box, so nothing is
  cropped. Opening the fullscreen viewer is one motion from the card — ground,
  drawing, toolbar — and a card opened by pointer does not keep the highlight
  once the viewer closes. The drawing stays in the chat; the column shows it
  again only on a roomy canvas.

### The composer and skills

- **A skill typed into the chatbox reads as itself.** `/visualise draw the run
  loop` still goes out verbatim — the system prompt already names each enabled
  skill's command. What changes is what you see while typing: the command is
  drawn as the skill's name in the accent with its mark, and the textarea holds
  only the text after it, its first line indented by the lede's measured width
  so the caret sits after the mark and prose wraps underneath. There is no
  second state to keep — the draft is split and rejoined on every keystroke, and
  the lede reads the textarea's own padding and type size, which is how one
  component sits on the baseline in two composers with two geometries. A token
  appears only once a space closes the command, and only for a skill that is
  installed and enabled, because a lede for a skill the run would not follow
  promises what the send cannot keep. Backspace at the head of the line removes
  the skill and keeps the text.
- **A slash mid-sentence opens the menu; a path never does.** The `/` listbox
  is no longer tied to the head of the draft, and `src/main.tsx` is left alone.
  An enabled skill answers to `/` in both composers and leads the list;
  accepting one leaves its `/command` in the composer and the prompt names it.
- **The add menu can ask for a document.** Pick a document type and the turn
  asks the run for that file.
- **The Skills panel reads as headings and spacing.** Each skill reads as
  itself — the mark is the option — a selected row is a highlight rather than a
  colour, a skill's lede is chosen in the panel instead of hard-coded, and the
  panel opens rather than appearing.

### Delegate CLIs

- **A delegate CLI says which version it is, and updates itself when asked.**
  Klide launched claude / codex / opencode / omp from the login-shell PATH and
  never looked at which version it got. That bit: a PATH Codex at 0.147.0 while
  the ChatGPT app had shipped 0.153.4, and the run died as `400: The
  'gpt-6-astra' model requires a newer version of Codex` — a provider error with
  nothing in Klide to explain it. The version now sits on the Settings row that
  already says the CLI is installed, with the CLI's own updater beside it,
  running in a real PTY whose output streams into the row as it arrives. Two
  deliberate limits: Klide never updates in the background, because an update
  mid-fleet changes what every live delegate session is running, and Klide never
  invents an updater — an install Klide did not perform is not one it may
  replace. The per-CLI knowledge stays behind the Delegate seam (`version_args`,
  `update_args`, `parse_version`).
- **A worker's worktree can run the tests.** The worktree recipe shares
  `node_modules` and copies `.env` into every worker's checkout; without it a
  tester could write tests it had no way to run.

### Harness

- **The context gauge measures the window the turn ran in.** It divided usage
  by the model's trained window (128k for llama3.1) while Rust sized the real
  Ollama request at a flat 32k that grows with the conversation — a 30k
  conversation read as 23% full when its window was nearly spent. The Ollama
  adapter now stamps the `num_ctx` it sent onto the final frame's usage, and
  one rule module owns the denominator: the reported window after a turn, else
  the expected working window, with hosted providers keeping the detected one.
  The "Context window" picker is Ollama's alone, since only Ollama has a
  request field for it, and its caps derive from the trained window — no 128K
  offered for an 8k model. The request ceiling and the compaction bound read
  the same value.
- **Approved Mission orchestration is reachable from both doors.** Harness Runs
  and MCP agents can drive an approved Mission, not just the board.

### Interface

- **Settings controls say their own value.** A segmented row reads as its value
  until you reach for it, a slider shows how far along it is, and the sidebar
  runs to the window's top edge.
- **A conversation row folds its actions behind one mark.** Pin, inspect and
  delete live behind a single `⋯`; a row can open in Mission Control instead of
  a panel; the Run selected in Mission Control lights its conversation row; and
  the row you click lights up at once rather than when the panel catches up. An
  OpenCode row wears the model that answered it, and a worker on its default
  model wears its maker's mark rather than the product mark twice.
- **Git Review gives the graph the room.** The side panes are fixed and the
  history graph took what they left, which at a 1177px window was 264px — less
  than its own cells need, so the header read `COMMITDESCRIPTION DATE` and the
  date clipped mid-year. Files start at 260 and pull requests at 320, leaving
  the graph a real description column. And Staged is a section only once
  something is staged: the header no longer stays behind on a clean tree
  labelling an empty list with an *Unstage all* that has nothing to unstage.
- **The model picker opens on the favorites, not mid-list.**
- **Focus shows who is in the conversation.** Agent participants with metrics
  scoped per participant, the Git island's header setting two facts apart by
  space rather than a dot, and opening a conversation from the rail dismissing
  the overlay over it.
- **A turn that cannot stream still looks alive.** A Delegate turn that will
  not stream wears the loader, and a turn killed with the app says so.

### Fixes

- **Full auto reaches the Run that is asking.** The rung was read once, when
  a Run started: flipping to full auto while a conversation's Run worked left
  it asking for every command, and a message queued behind a live turn even
  carried the rung as it stood when the queue began. The flip now tells the
  live Run — later commands skip the gate, a command card up at that moment is
  answered, with the transcript recording that the policy answered rather
  than the user — and a queued turn reads the rung at send. A dispatch card, a
  network target or a peer's message is never swept up; stepping back down
  makes the Run ask again.
- **Goal runs on a direct Anthropic key work again.** The `mission_orchestrate`
  tool's input schema carried a top-level `oneOf`, which Anthropic's API
  refuses — and one refused tool fails the whole request, so every Goal turn
  on Anthropic died with a 400 before the model saw a word. Found by the first
  Anthropic worker dispatch. The per-action shape now lives in the field
  descriptions and in the request parser, where it was enforced anyway.
- **An Anthropic reply cut off at the output cap says so.** The cap was 4096
  tokens, the API's example value; a worker writing a test file hit it in the
  middle of its `write_file` JSON, the call never closed, and it vanished —
  the run ended "done" with nothing. Klide no longer caps the reply below the
  model: it asks for the largest budget any Claude model accepts and, when a
  model states a lower limit in its refusal, asks once more at exactly that.
  A call still cut off by `max_tokens` is dropped out loud: the reply says
  which call, at how many tokens, and to work in smaller pieces.
- **An API worker runs its commands without asking.** A headless child has
  no card to show, so the first `run_command` it reached parked it — and its
  parent — for good. The dispatch card the operator approves now says
  "commands run without asking", and the child runs that way, as a Delegate
  CLI does with its own policy. A plain subagent on the parent's model is
  unchanged and never runs commands unasked.
- **A capped Anthropic reply with nothing readable says so.** 16k tokens into
  a block the adapter does not parse ended a worker "done" with an empty
  message; the reply now says the budget was spent with nothing usable, and
  the unread block type is logged.
- **A worker that never spoke reports why.** A child run that ended on an
  error came back to the parent as "(subagent produced no output)"; it now
  comes back as the error itself, so Kit reacts to the cause.
- **The live "Delegated to" row shows the worker the card decided.** The
  dispatch event reaches the live fold, not only the reload.
- **A reload mid-generation no longer loses the run's answer.** Observed tool
  rows are never persisted, so replay adoption weighs the text a run produced
  rather than the rows around it.
- **TLS handshakes take the rustls 0.23.45 fix.**

## v0.6.3 — Coordination and Documents (2026-09-12)

Two things the v0.6 line gained after the 0.6.2 cut. Runs can address each
other — Harness conversations and Delegate CLIs alike, through one Rust-owned
journal — and a Run can now produce a real document instead of describing one:
a spreadsheet it creates, recalculates and revises, and that Klide opens itself.

The v0.6 orchestration milestone is unchanged: Missions as outcomes, budgets,
capacity, capability routing and validation contracts are still open. The macOS
bundle is still ad-hoc signed rather than Apple-notarized. This is a patch cut
on the v0.6 line, not that milestone.

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
  `system`. (PR #84, 2026-09-05.) Since 2026-09-10 every conversation with a
  Workspace is on the plane whatever its Mode or model: Chat carries the
  coordination tools and nothing else, so a Chat thread can be asked something
  and answer it.
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
  foreign CLI. Focus conversations on a Delegate get the same tools: the
  Harness hands each headless turn the wiring, and the turn's process acts as
  the conversation's Run. A Klide restart no longer costs a running CLI its
  agent tools: the MCP server is told where to find the bridge rather than a
  port, and the bridge rebuilds a session it never bound from that session's
  spawn record. Per-CLI wiring: Claude Code `--mcp-config <per-session file>`,
  Codex `-c mcp_servers.klide.*` overrides, OpenCode `OPENCODE_CONFIG`; Oh My
  Pi and custom CLIs run unchanged.

### Documents

- **A run makes a real workbook, and the app opens it.** Asking for a budget
  used to end at a shell with no Excel in it. Two native Tools close that:
  `write_spreadsheet` creates or patches an `.xlsx` — IronCalc recalculates, a
  formula error blocks the save, and the exported bytes are produced before the
  change is ever proposed — and the read-only `inspect_spreadsheet` returns
  paginated cells, formulas, results, errors and the hash an update has to
  present. A create never overwrites; an update rechecks the exact bytes at
  apply time. Neither Tool needs a shell, an Excel install, or the network.
- **Workbook bytes ride the write path that already exists.** `DiffProposal`
  carries an optional binary payload beside its readable cell diff, so a
  workbook goes through the same approval, the same rejection memory and the
  same checkpoint as any other edit; rollback restores the original bytes and
  refuses when the file has moved on since. A repeated edit that leaves Git
  status unchanged is still announced, so the second revision of a workbook
  does not quietly drop out of the evidence.
- **`.xlsx` and `.sheet.json` open in Klide.** A built-in sheet surface —
  worksheet tabs, formula bar, keyboard navigation, paste, undo — loads lazily
  behind its own `vendor-spreadsheet` chunk that the entry never preloads.
  **Add to chat** hands a cell's reference, input and calculated value to the
  focused composer without sending a message. This is local recalculation of
  common formulas, not Excel parity: charts, pivots, macros and full layout
  fidelity are out, and the limits are written down in
  `src/spreadsheets/README.md`.
- **A completion card lists documents, not only artifacts.** A workbook written
  by an ordinary edit tool keeps its change evidence and still appears as
  something to open, and `agent_run_document_references` recovers files an older
  transcript only mentions — opened from where they actually live, and never
  claimed as an edit the run made.

## v0.6.2 — Memory, Routing, Recovery (2026-09-11)

Hardening after the 0.6.1 cut. Project Memory becomes a Harness capability
rather than a panel, the Harness starts choosing its own model and its own
reasoning level, and a run that loses its view — a reload, a panel switch, an
app restart, a CLI that never announced itself — now heals from what was
written down instead of reading as stuck. The v0.6 orchestration milestone
itself is still open: Missions as outcomes, budgets, capacity, capability
routing and validation contracts are unchanged. The macOS bundle is still
ad-hoc signed and not Apple-notarized.

### Project Memory

- **Project Memory is now a native Harness capability.** Durable entries use a
  versioned schema with kinds, review state, tags, source references, and
  supersession. Plan and Goal runs can call `memory_search` and `memory_read`;
  deterministic offline ranking returns match reasons and provenance, normal
  recall excludes stale/superseded knowledge, and the Transcript stamps both
  Tools with `read_project_memory` instead of pretending they read Workspace
  files. Markdown remains the local source of truth; no external provider or
  network service is involved.

### Harness

- **A model's reasoning levels come from the CLI, not from a list Klide keeps.**
  Every picker offered the same five levels — minimal, low, medium, high, xhigh
  — to every model. For a Codex run that was wrong twice over: `gpt-6-astra`
  publishes low, medium, high, xhigh, max and ultra, and no `minimal` at all,
  so Klide showed a level the CLI rejects and hid two it has. Worse, the level
  a Codex run was given went nowhere — it was saved into harness settings,
  which only the Klide-wire adapters read. The set is now a backend fact per
  provider and model, read from the Codex CLI's own model manifest for a Codex
  run and from the provider registry for a wire run, and a CLI with no such
  switch shows no dial at all. The choice reaches Codex as a `-c
  model_reasoning_effort=` override for that launch, leaving the user's
  `config.toml` alone. A level saved against another model reads as Auto
  instead of being sent, and the legacy `max`→`xhigh` rewrite now runs only
  where `max` was merely an old name for it: a Codex `max` sits one step above
  `xhigh`, and folding it would have quietly run the task weaker than asked.

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
  the probes it already had. See `docs/MODEL_ROUTING.md`.
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

- **Terminals no longer paint `�` across a read boundary.** A PTY read can end
  in the middle of a multi-byte character — an accent, a box-drawing line, an
  emoji in a spinner — and decoding each read alone replaced both halves.
  `pty_frame.rs` holds the incomplete tail back for the next read, in both the
  Delegate PTY and the shell terminal, and the scrollback ring trims to a
  character boundary so a replay never opens on half a glyph.
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

- **The keyring backend is chosen per target.** `apple-native` was named as
  an unconditional feature, so the crate could not build anywhere but macOS.
  Cargo now selects `apple-native` on macOS, `windows-native` on Windows, and
  `sync-secret-service` + `crypto-rust` on Linux through target-specific
  dependency tables; the call sites are backend-neutral and did not change.
  The second of the two Windows/Linux compile blockers; what remains is a
  build on each OS.
- **Git status is a store, not App state.** `gitStatus.ts` polls each
  workspace root once while anyone listens and only wakes subscribers when
  the branch or the changed-file list actually differs. App used to store a
  fresh object every three seconds, re-rendering itself and every surface
  under it whether or not a file had changed.
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
- Eval foundation — golden tool-layer scenarios run as `cargo test`; documented tool schema + lineage in `docs/KLIDE_HARNESS_SCHEMA.md`.
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
