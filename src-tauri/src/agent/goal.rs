//! The `/goal` finish line.
//!
//! A `/goal <objective>` turn is an ordinary Work (`goal`) Run with one extra
//! rule at the end: the model saying "done" is a claim, and the Harness checks
//! it. When the Run has changed the workspace and a check command is
//! configured (the Harness setting "test after edit", the same command the
//! loop already runs after each accepted edit), the loop runs that command
//! once more when the model tries to finish. A failing check does not end the
//! Run: its output goes back to the model as the next user turn and the
//! model goes another round, up to `max_rounds`. A passing check, a Run that
//! changed nothing, or a missing check command ends the Run as before — the
//! marker left in the Transcript says which. Exhausted failures end in error.
//! Delegate CLI goals are always checked, since their work bypasses dispatch.
//!
//! This module is the pure half: what to do with a check's outcome, and the
//! words. Running the command and pushing the message is the loop's job
//! (`run_agent_loop`, the `TurnDecision::Final` arm), so this file stays
//! testable without a provider or a shell.

use serde::{Deserialize, Serialize};

/// What a `/goal` turn carries on the run request.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSpec {
    /// The objective as the user typed it after `/goal`.
    pub objective: String,
    /// Rounds the check may fail before the Run ends anyway. `None` → the
    /// default. A round is one "done" claim the Harness sent back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<usize>,
}

/// Three rounds: enough for a real fix-forward, few enough that a model that
/// cannot make the check pass stops burning tokens and hands the output back.
pub const DEFAULT_MAX_ROUNDS: usize = 3;
pub const MAX_ROUNDS_CEILING: usize = 10;

/// The tail of the check's output the model sees. Test runners print the
/// failures last, so the tail is the useful end.
const OUTPUT_TAIL_CHARS: usize = 6_000;

impl GoalSpec {
    pub fn rounds(&self) -> usize {
        self.max_rounds
            .unwrap_or(DEFAULT_MAX_ROUNDS)
            .clamp(1, MAX_ROUNDS_CEILING)
    }
}

/// The check command's outcome, as the loop observed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckOutcome {
    pub command: String,
    pub ok: bool,
    pub output: String,
}

/// What the loop does with a "done" claim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GateVerdict {
    /// End the Run. `marker` is the one line the Transcript keeps about the
    /// finish line (a steering marker); `None` when the gate had nothing to
    /// say because the Run never changed the workspace.
    Finish { marker: Option<String> },
    /// Send the check's output back and run another round. `marker` goes to
    /// the Transcript, `message` to the model as the next user turn.
    Retry { marker: String, message: String },
}

/// The gate's rule, in one place.
///
/// * The Run changed nothing → nothing to check, finish quietly.
/// * No check command configured → finish, and say so: the gate could not
///   verify, which the reader should know rather than assume.
/// * The check passed → finish, with the command named as evidence.
/// * The check failed with rounds left → retry.
/// * The check failed on the last round → finish, saying it failed, so the
///   completion is honest rather than silent.
///
/// `rounds_used` counts the retries already sent (0 on the first claim).
pub fn verdict(
    spec: &GoalSpec,
    work_done: bool,
    check: Option<&CheckOutcome>,
    rounds_used: usize,
) -> GateVerdict {
    if !work_done {
        return GateVerdict::Finish { marker: None };
    }
    let Some(check) = check else {
        return GateVerdict::Finish {
            marker: Some(
                "Goal: no check command is set, so the finish was not verified — set one in Settings → Harness → Test after edit"
                    .to_string(),
            ),
        };
    };
    let max = spec.rounds();
    if check.ok {
        let rounds = if rounds_used == 0 {
            String::new()
        } else {
            format!(" after {} round{}", rounds_used + 1, if rounds_used == 0 { "" } else { "s" })
        };
        return GateVerdict::Finish {
            marker: Some(format!("Goal reached: `{}` passed{rounds}", check.command)),
        };
    }
    let round = rounds_used + 1;
    if round >= max {
        return GateVerdict::Finish {
            marker: Some(format!(
                "Goal not reached: `{}` still fails after {max} round{} — handing back",
                check.command,
                if max == 1 { "" } else { "s" }
            )),
        };
    }
    GateVerdict::Retry {
        marker: format!(
            "Goal check `{}` failed — round {round} of {max}, going again",
            check.command
        ),
        message: retry_message(spec, check, round, max),
    }
}

fn retry_message(spec: &GoalSpec, check: &CheckOutcome, round: usize, max: usize) -> String {
    let output = tail(&check.output, OUTPUT_TAIL_CHARS);
    format!(
        "The goal is not reached yet: the check `{command}` fails after your last change (round {round} of {max}).\n\n\
         ```\n{output}\n```\n\n\
         Goal: {objective}\n\n\
         Read what the check reports, fix forward, run the check yourself, and only then report done. \
         If the failure is unrelated to the goal and was already failing before you started, say so plainly instead of changing it.",
        command = check.command,
        objective = spec.objective.trim(),
    )
}

fn tail(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count <= max_chars {
        return trimmed.to_string();
    }
    let skip = count - max_chars;
    let kept: String = trimmed.chars().skip(skip).collect();
    format!("… ({skip} earlier characters omitted)\n{kept}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> GoalSpec {
        GoalSpec { objective: "make the tab tests pass".into(), max_rounds: None }
    }
    fn failing() -> CheckOutcome {
        CheckOutcome { command: "npm test".into(), ok: false, output: "1 failed".into() }
    }
    fn passing() -> CheckOutcome {
        CheckOutcome { command: "npm test".into(), ok: true, output: "all green".into() }
    }

    #[test]
    fn a_run_that_changed_nothing_finishes_quietly() {
        assert_eq!(verdict(&spec(), false, Some(&failing()), 0), GateVerdict::Finish { marker: None });
    }

    #[test]
    fn no_check_command_finishes_and_says_the_finish_was_not_verified() {
        match verdict(&spec(), true, None, 0) {
            GateVerdict::Finish { marker: Some(m) } => assert!(m.contains("not verified"), "{m}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_passing_check_finishes_with_the_command_as_evidence() {
        match verdict(&spec(), true, Some(&passing()), 0) {
            GateVerdict::Finish { marker: Some(m) } => assert_eq!(m, "Goal reached: `npm test` passed"),
            other => panic!("{other:?}"),
        }
        match verdict(&spec(), true, Some(&passing()), 1) {
            GateVerdict::Finish { marker: Some(m) } => assert_eq!(m, "Goal reached: `npm test` passed after 2 rounds"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_failing_check_goes_another_round_with_the_output_and_the_objective() {
        match verdict(&spec(), true, Some(&failing()), 0) {
            GateVerdict::Retry { marker, message } => {
                assert_eq!(marker, "Goal check `npm test` failed — round 1 of 3, going again");
                assert!(message.contains("1 failed"));
                assert!(message.contains("Goal: make the tab tests pass"));
                assert!(message.contains("round 1 of 3"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_last_round_hands_back_honestly() {
        match verdict(&spec(), true, Some(&failing()), 2) {
            GateVerdict::Finish { marker: Some(m) } => {
                assert_eq!(m, "Goal not reached: `npm test` still fails after 3 rounds — handing back")
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rounds_are_clamped_and_default_to_three() {
        assert_eq!(spec().rounds(), 3);
        assert_eq!(GoalSpec { objective: "x".into(), max_rounds: Some(0) }.rounds(), 1);
        assert_eq!(GoalSpec { objective: "x".into(), max_rounds: Some(99) }.rounds(), MAX_ROUNDS_CEILING);
        // One round means one claim: the first failure already hands back.
        let one = GoalSpec { objective: "x".into(), max_rounds: Some(1) };
        assert!(matches!(verdict(&one, true, Some(&failing()), 0), GateVerdict::Finish { .. }));
    }

    #[test]
    fn the_model_sees_the_tail_of_a_long_output() {
        let long = "x".repeat(10_000);
        let out = CheckOutcome { command: "npm test".into(), ok: false, output: long };
        let GateVerdict::Retry { message, .. } = verdict(&spec(), true, Some(&out), 0) else { panic!() };
        assert!(message.contains("earlier characters omitted"));
        assert!(message.len() < 7_000);
    }

    #[test]
    fn the_spec_rides_the_wire_in_camel_case() {
        let parsed: GoalSpec = serde_json::from_str(r#"{"objective":"ship","maxRounds":2}"#).unwrap();
        assert_eq!(parsed, GoalSpec { objective: "ship".into(), max_rounds: Some(2) });
        let bare: GoalSpec = serde_json::from_str(r#"{"objective":"ship"}"#).unwrap();
        assert_eq!(bare.max_rounds, None);
    }
}
