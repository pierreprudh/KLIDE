# Scheduled Runs

Scheduled in the sidebar is the home for schedules, in both Focus and the
workbench. Create a named schedule with instructions, a Workspace, agent/provider,
model, mode, local start time, and Once, Every hour, Every 24 hours, or Every
7 days. Select a schedule to edit it, run it now, pause/resume, cancel, or remove
it. New schedule opens a modal popup with a single instructions composer,
subscription/provider and model controls in its toolbar, and aligned repeat,
date and time fields below. Klide tokens govern typography, surfaces, shape and
focus. The window shares the command palette and Skills window’s composer glass,
edge treatment, gradient scrim and Esc control. Layout references: [Kobra Dialog](https://kobra.systems/components/dialog),
[Kobra Form](https://kobra.systems/components/form), and
[Beautiful UI Prompt Bar](https://www.beautifului.dev/#prompt-bar).
Agent choices use a searchable, grouped glass menu with logos, descriptions and
a selected checkmark. Repeat, mode and Machine share its keyboard selection and
Escape behavior. Advanced holds the optional name, workspace, mode and Machine. Create/Cancel
remain visible while it scrolls. The chat composer has no scheduling clock.

Each occurrence gets a fresh standalone Run id and transcript. Scheduled keeps
a durable history with the intended time, start/finish times, execution target,
status, error, and an Open Run action. Opening a Run uses the existing transcript
and live reattachment path, including permission and edit-review cards. The
schedule is independent of manual Conversations: deleting or continuing an
occurrence's conversation does not delete or change the schedule.

## Persistent local service

On macOS a per-user launchd service runs `klide scheduled --data-dir <app data>`.
It owns both the clock and scheduled Runs through the existing Run host and
Harness, including API providers and subscription agents. Closing Klide only
disconnects its observer. The service starts at login and launchd restarts it if
it exits. It has no idle timeout. A kernel lease admits only one scheduler per
app-data directory. Other platforms currently report persistent scheduling as
unsupported rather than saving tasks that cannot run.

Creating a schedule, resuming it, or using Run now ensures the service is ready
before saving the action. Opening Klide with existing schedules also checks the
service. Scheduled shows its health and an Enable/Retry action. The launch agent
is `~/Library/LaunchAgents/com.klide.scheduled.<data-directory-hash>.plist`;
service logs are under `<app data>/scheduled-host/`. It points to the current
Klide executable. Keep the installed app in place. An updated app replaces a
responsive idle service; active or unreachable owners are left alone, with a
visible service error if an update cannot safely proceed.

The Mac must be awake and the user logged in. Sleep suspends work; shutdown or
logout stops the service. After waking or logging in, each overdue schedule
launches once. The service checks every two seconds; missed intervals coalesce
with no backlog. Repeats use elapsed intervals from the original due time, not
calendar rules: Every 24 hours may shift local clock time across daylight-saving
changes. Failures stop automatic repeats until explicit retry.

The service resolves this Mac's saved provider credentials and CLI logins at
execution time. Managed local inference uses the same readiness/startup path as
Send. Only the executable path, app-data path, PATH and service options are saved
in the launch agent; no credentials or prompts are copied into it. Environment
variables present only in a terminal session are not a persistent credential
store. Keychain access or an expired CLI login may require user action.

Permission requests wait while Klide is closed. Reopen Klide and Open Run to
answer them or stop the Run. Saved schedules strip temporary full-auto command
authority and conversation resume/history pointers, and resolve the current
approved-command policy at dispatch. Existing app-wide attention and activity
watchers follow active scheduled Runs even while Scheduled is closed. The
headless host retains its existing limits: Klide-native nested subagents and
`run_command(notifyOnExit)` observer follow-ups are refused; use ordinary
background commands with `read_command_output` when appropriate.

## Controls and recovery

Run now starts a fresh occurrence without moving a repeating schedule's next
future due time. One schedule never overlaps its own active occurrence.
Pausing or cancelling prevents future occurrences; its active Run continues to
be tracked in history. Stop Run stops that occurrence. Removing an active
schedule is refused until its occurrence settles. Removing a schedule removes
its history index, while transcripts remain in ordinary Run storage.

Schedules and occurrence history live in `schedules.sqlite3` in app data,
independently of the configurable transcript location. A SQLite transaction
with FULL synchronization saves a fresh occurrence id before admission.
Successful admission saves its exact transcript boundary. Cross-process leases
serialize dispatch against edits/cancellation and transcript storage changes.
Each occurrence remembers its transcript directory. Revisions prevent delayed
UI reads from replacing newer service state.

Recovery leaves existing Run owners alone, then reads the terminal outcome once
idle. An uncertain dispatch or interrupted Run becomes a visible failure
requiring review; it is never replayed automatically. Automatic dispatch is
at-most-once, not exactly-once effects across a crash. Original
conversation-bound records migrate on read; an in-flight legacy occurrence
retains its original id for recovery, while future occurrences get fresh ids.

## Future Remote machine target

Schedules and occurrences persist an explicit execution target. This Mac is the
available target; the VPS option is visible but disabled. Remote targets are
rejected by the backend until remote execution exists. Moving to a VPS will
move clock and Run ownership together, use that Machine's workspace and
credentials, and reconcile ownership before activating it. There is no automatic
local/remote fallback or concurrent dispatch to both Machines.

Implementation: `agent/schedules.rs` owns persistence, history, claims, recovery
and the service clock. `scheduled_service.rs` owns launchd registration;
`pty_daemon.rs` hosts the authenticated socket and `daemon::RunHost` uses the
shared admission and Harness. The desktop observes schedule changes and handles
controls. `Scheduled.tsx` owns management; `scheduleStatus.ts` connects active
Runs to app-wide watchers.

Acceptance tests in `src-tauri/tests/scheduled_service.rs` run a real headless
process with isolated storage and local provider/CLI fixtures. They cover due
work without the desktop, restart without replay, waiting for permission until
reconnection, subscription dispatch, and an opt-in real launchd restart test.
