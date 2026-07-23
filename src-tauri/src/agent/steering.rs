//! Mid-run loop/drift monitor.
//!
//! Small local models (the ones Klide leans on) get stuck in tight loops:
//! re-reading the same file, re-running the same failing command, calling the
//! same tool with the same arguments turn after turn without making progress.
//! This module watches a run's recent tool-call signatures and, when it sees a
//! call recur past a threshold, hands the run loop a one-time steering nudge to
//! inject into the next turn's context so the model breaks out of the loop.
//!
//! It is pure and Tauri-free: the run loop feeds it each turn's signatures and
//! acts on what it returns. That keeps the whole heuristic unit-testable off the
//! app. Inspired by ReasonBlocks' server-side failure monitors, but owned
//! entirely by Klide's Rust harness — no external service, no wrapping.

use super::tools::NormalizedToolCall;
use std::collections::{HashMap, HashSet, VecDeque};

/// How many recent turns of tool-call signatures the monitor remembers.
const WINDOW_TURNS: usize = 4;
/// How many times one signature must recur inside the window before we steer.
/// Three identical calls inside four turns is a stuck loop, not a coincidence.
const REPEAT_THRESHOLD: usize = 3;
/// How many times one signature must *fail* inside the window before we steer.
/// A call that errors identically twice won't fix itself on a third try — that's
/// worth interrupting one repeat earlier than a benign (succeeding) loop.
const FAIL_THRESHOLD: usize = 2;
/// How many times one signature may fail identically across the *whole run*
/// before the monitor gives up: a call that has failed this many times even
/// after a nudge and an advisor consult is not going to recover, so ending the
/// run beats burning turns to the cap.
const EARLY_EXIT_FAILURES: usize = 4;

/// One executed tool call, as the monitor sees it: its signature plus whether it
/// failed. The run loop knows `failed` only after the call runs, so it collects
/// these across a turn and hands the batch to `observe` once the turn settles.
pub(super) struct CallObservation {
    pub signature: String,
    pub failed: bool,
}

/// A stable fingerprint of one tool call: its name plus its canonical input.
/// Two calls with the same name and the same arguments share a signature —
/// exactly the "did the agent just do this again?" question the monitor asks.
/// `serde_json` renders object keys in sorted order, so the same input always
/// stringifies identically regardless of the order the model emitted them.
pub(super) fn call_signature(call: &NormalizedToolCall) -> String {
    format!("{}::{}", call.name, call.input)
}

/// The `system` message that carries a steering nudge into the next turn.
/// Mirrors `compaction_system_message`: a mid-conversation system turn is an
/// established shape in this loop, so providers accept it fine.
pub(super) fn steering_system_message(nudge: &str) -> serde_json::Value {
    serde_json::json!({ "role": "system", "content": nudge })
}

/// A one-line preview of a longer block (advisor advice) for the transcript
/// marker: first non-empty line, trimmed to ~80 chars with an ellipsis.
pub(super) fn preview(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() > 80 {
        let head: String = line.chars().take(79).collect();
        format!("{head}…")
    } else {
        line.to_string()
    }
}

/// Wrap a stronger advisor's guidance (from an auto-escalated consult) as the
/// steering message injected into the next turn.
pub(super) fn advisor_steering_message(advice: &str) -> serde_json::Value {
    steering_system_message(&format!(
        "[STEERING] A stronger advisor reviewed this stuck loop and gave this guidance:\n{advice}\n\n\
         Follow it instead of repeating the failing call."
    ))
}

/// One steering intervention: the `nudge` is injected into the model's context;
/// the `reason` is the short, human-readable line the transcript records so the
/// operator can see *why* the run was steered. `escalate` marks the sharper
/// loops (a call that keeps *failing*) where the run loop should consult a
/// stronger advisor rather than just nudge — the executor is stuck on something
/// a nudge alone won't resolve.
pub(super) struct Steering {
    pub nudge: String,
    pub reason: String,
    pub escalate: bool,
}

/// What the monitor wants the run loop to do at a turn boundary.
pub(super) enum Outcome {
    /// Keep going, but inject this steering (a nudge, or an advisor escalation).
    Steer(Steering),
    /// Stop the run: it is stuck beyond recovery. `String` is the reason line.
    GiveUp(String),
}

/// Watches recent tool calls for a stuck loop and, once per fresh loop, yields a
/// steering nudge. Side-effect-free: `observe` is the whole surface.
#[derive(Default)]
pub(super) struct LoopMonitor {
    /// Per-turn observation lists, oldest at the front, capped at `WINDOW_TURNS`.
    window: VecDeque<Vec<CallObservation>>,
    /// Signatures already steered on. An entry is dropped once its signature
    /// falls out of the window, so a loop that stops and later restarts on the
    /// same call gets steered again rather than staying silent forever.
    nudged: HashSet<String>,
    /// Cumulative identical failures per signature across the whole run (never
    /// windowed). Drives the give-up circuit breaker.
    lifetime_failures: HashMap<String, usize>,
}

impl LoopMonitor {
    /// Record one turn's executed tool calls. Steer when a signature is either
    /// *failing* repeatedly (the sharper, earlier signal) or simply repeating
    /// without progress — whichever fires first, once per fresh loop. At most one
    /// nudge per turn; if several calls loop at once the busiest fires first and
    /// the rest fire on later turns.
    pub(super) fn observe(&mut self, calls: Vec<CallObservation>) -> Option<Outcome> {
        // Accumulate lifetime failures and note which signatures failed *now*.
        let mut failed_now: Vec<String> = Vec::new();
        for obs in &calls {
            if obs.failed {
                *self.lifetime_failures.entry(obs.signature.clone()).or_default() += 1;
                failed_now.push(obs.signature.clone());
            }
        }
        // Circuit breaker: a call that has failed this many times across the run,
        // even after steering, isn't recovering — give up rather than loop on.
        for sig in &failed_now {
            let n = self.lifetime_failures.get(sig).copied().unwrap_or(0);
            if n >= EARLY_EXIT_FAILURES {
                let tool = sig.split("::").next().unwrap_or(sig);
                return Some(Outcome::GiveUp(format!(
                    "Gave up — `{tool}` failed {n}× this run without recovering, even after steering"
                )));
            }
        }

        self.window.push_back(calls);
        while self.window.len() > WINDOW_TURNS {
            self.window.pop_front();
        }

        // Occurrences of each signature across the whole window, and how many of
        // those failed. Counting occurrences (not distinct turns) catches both a
        // call repeated across turns and one repeated several times in one turn.
        // Keys are owned so the borrow of `self.window` ends here, freeing the
        // `&mut self` the `fire` calls below need.
        let mut total: HashMap<String, usize> = HashMap::new();
        let mut failed: HashMap<String, usize> = HashMap::new();
        for turn in &self.window {
            for obs in turn {
                *total.entry(obs.signature.clone()).or_default() += 1;
                if obs.failed {
                    *failed.entry(obs.signature.clone()).or_default() += 1;
                }
            }
        }

        // Forget debounce entries for signatures no longer in the window.
        self.nudged.retain(|sig| total.contains_key(sig));

        // A repeated *failure* is the higher-signal loop, so look for it first
        // and at a lower threshold. Then fall back to a plain repetition loop.
        self.fire(&failed, FAIL_THRESHOLD, Kind::Failure)
            .or_else(|| self.fire(&total, REPEAT_THRESHOLD, Kind::Repeat))
            .map(Outcome::Steer)
    }

    /// Pick the busiest not-yet-nudged signature in `counts` at or over
    /// `threshold` and, if any, mark it nudged and build its steering.
    /// Deterministic (count desc, then signature) so tests are stable.
    fn fire(&mut self, counts: &HashMap<String, usize>, threshold: usize, kind: Kind) -> Option<Steering> {
        let mut candidates: Vec<(&str, usize)> = counts
            .iter()
            .filter(|(sig, &n)| n >= threshold && !self.nudged.contains(sig.as_str()))
            .map(|(sig, &n)| (sig.as_str(), n))
            .collect();
        candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));

        let (signature, count) = candidates.first().map(|(s, n)| (s.to_string(), *n))?;
        self.nudged.insert(signature.clone());
        let tool = signature.split("::").next().unwrap_or(&signature);
        Some(match kind {
            Kind::Failure => Steering {
                nudge: failure_nudge(tool, count),
                reason: format!("Repeated failure — `{tool}` failed {count}× with identical arguments"),
                escalate: true,
            },
            Kind::Repeat => Steering {
                nudge: repeat_nudge(tool, count),
                reason: format!("Loop detected — `{tool}` called {count}× with identical arguments"),
                escalate: false,
            },
        })
    }
}

/// Which loop the monitor caught — shapes the nudge wording only.
enum Kind {
    Failure,
    Repeat,
}

fn repeat_nudge(tool: &str, count: usize) -> String {
    format!(
        "[STEERING] You've called `{tool}` {count} times with the same arguments over the last \
         few turns without making progress — this looks like a loop. Stop repeating that call. \
         Use the result you already have, take a genuinely different approach, or ask the user a \
         clarifying question. Do not issue that same call again."
    )
}

fn failure_nudge(tool: &str, count: usize) -> String {
    format!(
        "[STEERING] `{tool}` has failed {count} times with the same arguments and the same \
         result — repeating it will not change the outcome. Read the error carefully and fix the \
         underlying cause, take a genuinely different approach, or ask the user for help. Do not \
         run that same call again."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, input: serde_json::Value) -> NormalizedToolCall {
        NormalizedToolCall {
            id: "id".to_string(),
            name: name.to_string(),
            input,
        }
    }

    /// Build a turn of *succeeding* calls.
    fn ok(calls: &[NormalizedToolCall]) -> Vec<CallObservation> {
        calls
            .iter()
            .map(|c| CallObservation { signature: call_signature(c), failed: false })
            .collect()
    }

    /// Build a turn of *failing* calls.
    fn err(calls: &[NormalizedToolCall]) -> Vec<CallObservation> {
        calls
            .iter()
            .map(|c| CallObservation { signature: call_signature(c), failed: true })
            .collect()
    }

    /// Project an outcome to its `Steer` payload, so the loop-detection tests
    /// (which don't exercise give-up) read as they did before `Outcome` existed.
    fn steer(o: Option<Outcome>) -> Option<Steering> {
        match o {
            Some(Outcome::Steer(s)) => Some(s),
            _ => None,
        }
    }

    #[test]
    fn signature_is_order_independent_for_object_keys() {
        let a = call("read_file", serde_json::json!({ "path": "a.rs", "start": 1 }));
        let b = call("read_file", serde_json::json!({ "start": 1, "path": "a.rs" }));
        assert_eq!(call_signature(&a), call_signature(&b));
    }

    #[test]
    fn distinct_calls_never_steer() {
        let mut m = LoopMonitor::default();
        for i in 0..8 {
            let c = call("read_file", serde_json::json!({ "path": format!("f{i}.rs") }));
            assert!(steer(m.observe(ok(&[c]))).is_none());
        }
    }

    #[test]
    fn repeated_identical_call_steers_once() {
        let mut m = LoopMonitor::default();
        let c = call("read_file", serde_json::json!({ "path": "a.rs" }));
        assert!(steer(m.observe(ok(&[c.clone()]))).is_none(), "1st call: below threshold");
        assert!(steer(m.observe(ok(&[c.clone()]))).is_none(), "2nd call: below threshold");
        let steering = steer(m.observe(ok(&[c.clone()]))).expect("3rd call trips the monitor");
        assert!(steering.nudge.contains("[STEERING]"));
        assert!(steering.nudge.contains("read_file"));
        assert!(steering.reason.contains("Loop detected"));
        // Debounced: a 4th identical call in the same loop stays quiet.
        assert!(steer(m.observe(ok(&[c]))).is_none(), "already steered, stays quiet");
    }

    #[test]
    fn intra_turn_repetition_trips_the_monitor() {
        let mut m = LoopMonitor::default();
        let c = call("run_command", serde_json::json!({ "command": "cargo check" }));
        // Same call three times inside one turn is already a loop.
        let steering = steer(m.observe(ok(&[c.clone(), c.clone(), c])));
        assert!(steering.expect("intra-turn loop").nudge.contains("run_command"));
    }

    #[test]
    fn repeated_failure_steers_earlier_than_repetition() {
        let mut m = LoopMonitor::default();
        let c = call("run_command", serde_json::json!({ "command": "cargo test" }));
        // First failure is not yet a loop.
        assert!(steer(m.observe(err(&[c.clone()]))).is_none(), "1st failure: below fail threshold");
        // Second identical failure trips the monitor — one repeat earlier than
        // the plain repetition rule (which needs three).
        let steering = steer(m.observe(err(&[c]))).expect("2nd identical failure steers");
        assert!(steering.reason.contains("Repeated failure"));
        assert!(steering.nudge.contains("failed 2 times"));
        assert!(steering.escalate, "a failure loop escalates to an advisor");
    }

    #[test]
    fn preview_takes_first_nonempty_line_and_truncates() {
        assert_eq!(preview("\n\n  Fix the import path.  \nmore"), "Fix the import path.");
        let long = "x".repeat(200);
        let p = preview(&long);
        assert!(p.ends_with('…') && p.chars().count() == 80);
    }

    #[test]
    fn repetition_loop_nudges_without_escalating() {
        let mut m = LoopMonitor::default();
        let c = call("read_file", serde_json::json!({ "path": "a.rs" }));
        m.observe(ok(&[c.clone()]));
        m.observe(ok(&[c.clone()]));
        let steering = steer(m.observe(ok(&[c]))).expect("3rd call trips repetition");
        assert!(!steering.escalate, "a plain repetition loop only nudges");
    }

    #[test]
    fn two_successes_do_not_steer_but_two_failures_do() {
        let c = call("run_command", serde_json::json!({ "command": "ls" }));
        // Succeeding twice is benign — below the repetition threshold.
        let mut ok_m = LoopMonitor::default();
        assert!(steer(ok_m.observe(ok(&[c.clone()]))).is_none());
        assert!(steer(ok_m.observe(ok(&[c.clone()]))).is_none(), "two successes stay quiet");
        // Failing twice is not.
        let mut err_m = LoopMonitor::default();
        assert!(steer(err_m.observe(err(&[c.clone()]))).is_none());
        assert!(steer(err_m.observe(err(&[c]))).is_some(), "two failures steer");
    }

    #[test]
    fn loop_that_stops_and_restarts_steers_again() {
        let mut m = LoopMonitor::default();
        let c = call("read_file", serde_json::json!({ "path": "a.rs" }));
        m.observe(ok(&[c.clone()]));
        m.observe(ok(&[c.clone()]));
        assert!(steer(m.observe(ok(&[c.clone()]))).is_some(), "first loop steers");

        // Flush the signature out of the window with unrelated work.
        let other = call("grep", serde_json::json!({ "q": "x" }));
        for _ in 0..WINDOW_TURNS {
            m.observe(ok(&[other.clone()]));
        }

        // The same call looping again is a fresh loop → steers again.
        m.observe(ok(&[c.clone()]));
        m.observe(ok(&[c.clone()]));
        assert!(steer(m.observe(ok(&[c]))).is_some(), "fresh loop steers again");
    }

    #[test]
    fn repeated_failure_gives_up_after_the_run_cap() {
        let mut m = LoopMonitor::default();
        let c = call("run_command", serde_json::json!({ "command": "cargo build" }));
        // The first few identical failures steer (nudge / escalate) but keep going.
        for _ in 0..(EARLY_EXIT_FAILURES - 1) {
            assert!(
                !matches!(m.observe(err(&[c.clone()])), Some(Outcome::GiveUp(_))),
                "below the run cap the monitor steers, never gives up",
            );
        }
        // The cap-th identical failure trips the circuit breaker.
        match m.observe(err(&[c])) {
            Some(Outcome::GiveUp(reason)) => {
                assert!(reason.contains("Gave up"));
                assert!(reason.contains("run_command"));
            }
            _ => panic!("expected give-up at the run failure cap"),
        }
    }
}
