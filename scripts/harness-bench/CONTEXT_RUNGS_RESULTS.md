# Context-saving rungs — 2026-11-16

Question: Code Mode (`run_script`, PR #524) keeps bulk reads out of context, but
does it generalize to weaker models? And is there something in between plain
reads and a program?

Three arms on the same native Harness, Plan mode, read-only tasks:

- **off** — plain read Tools only.
- **batch** — plain Tools plus `read_many`: a form, not a program. The model
  names files (list, glob, or a JSON-string list), picks fields or lines,
  filters with `keep`, and asks for `list` / `count` / `sum:<field>`. Klide
  does the parsing and arithmetic. Plain Tools stay available.
- **script** — plain Tools plus `run_script` (QuickJS).

Tasks: the three archived 2026-10-30 tasks verbatim, plus three scaling tasks:
`rollup-25`, `rollup-100` (sum active rows across the files `index.json`
lists; a decoy file sits outside the index) and `audit-40` (flag services
matching three conditions). Grading: exact final JSON plus an unchanged
workspace. Decision rule, fixed before the runs: on the scaling tasks, at
least 20% saving, pass count not lower, time at most 10% higher.

Driver: `code_mode.py`. Data: [context-rungs-2026-11-16-data.json](context-rungs-2026-11-16-data.json)
(manifests, summaries, every trial without transcripts). Source `3de81f3`.

## DeepSeek V4.1 Flash (OpenRouter) — 5 repeats, 90 trials, $0.46

| Arm | Verdict | Scaling passes | Cost vs off | Time vs off |
| --- | --- | ---: | ---: | ---: |
| off | — | 10/15 | — | — |
| batch | keep | 14/15 | −39.5% | −50.6% |
| script | keep | 15/15 | −46.3% | −36.2% |

`rollup-100` decides it: off failed 0/5 (out of turns, ~$0.041, 152 s);
batch 5/5 (~$0.004, 25 s); script 5/5 (~$0.005, 19 s). On the small
archived tasks nothing is gained, matching the 2026-10-30 result.

7 of the 12 DeepSeek failures were the model ending after a preamble ("I'll
start by reading…") with no tool call, in every arm — a separate Harness
issue, not an arm effect.

## qwen3.5:9b (Ollama, 32k context) — 3 repeats, 54 trials

Script was forced on for this run (`KLIDE_CODE_MODE=force`); Klide never
offers it to a local model.

| Arm | Verdict | Scaling passes | Uncached input vs off | Time vs off |
| --- | --- | ---: | ---: | ---: |
| off | — | 3/9 | — | — |
| batch | keep | 3/9 | −78.6% | −70.8% |
| script | drop | 2/9 | −47.7% | +22.8% |

The small model writes scripts badly: up to 13 per task, repairing its own
errors until the 300 s timeout. With `read_many` it answers fast but often
wrong for reasoning reasons, not tool ones — on `rollup-100` it sent
`files: "batch-*.json"` with no `keep`, so it summed the decoy and inactive
rows. Off failed the same task by filling 54–90k tokens of context.

## lfm3:1.7b (Ollama, 32k context) — after the index guard, 23 trials

Run after `read_many` learned `files: {"from": "index.json"}`, the glob-past-
an-index note and the no-`keep` note; off vs batch only. Stopped after two of
three repeats: the answer was already plain.

| Arm | Scaling passes | Single read | Batch calls |
| --- | ---: | ---: | ---: |
| off | 0/5 | 2/2 | — |
| batch | 0/6 | 2/2 | 28, in one trial |

At 1.7B the model fails every multi-file task with or without the batch form:
it reads files one by one, rereads them, messages itself, or runs out of its
reply budget reasoning. In the one trial it used `read_many`, it read one file
per call and sent `pick` JSON-encoded in a string — now accepted, like
`files`. The guard could not be tested on this model; a rerun on
qwen3.5:9b is what would show whether it stops the glob shortcut.

## Conclusion

- Code Mode helps only a model that writes correct code first time. Keep it
  off by default and never offered to local models (already the rule).
- `read_many` is the middle rung: most of the saving on a strong model, and
  no loss on a weak one. It is added beside the plain Tools, never instead of
  them — small models need the plain Tools.
- Still a prototype: offered only when `KLIDE_READ_MANY=1`. The misuse guard
  (`files.from`, the index note, the no-`keep` note) is in; rerun qwen3.5:9b
  before a default.
- Below a size, no rung helps: lfm3 1.7B cannot do multi-file aggregation.

## Limits

One model per run; synthetic read-only tasks; arms offer the extra Tool but do
not force it; provider caches not reset; debug-build timing.
