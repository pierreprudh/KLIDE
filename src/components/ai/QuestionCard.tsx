import { useEffect, useRef, useState } from "react";

import { AskIcon, SendIcon } from "../../icons";
import type { QuestionChoices } from "../../agent/types";
import { isDelegateProvider, isKnownProvider, providerName } from "../../agent/providers";
import type { ProviderId } from "../../agent/types";
import { listProviderModels } from "../../ipc/aiProviders";
import { makerMark } from "../../modelIdentity";
import { ProviderLogo } from "./icons";
import { ModelPicker } from "./ModelPicker";

type Props = {
  question: string;
  /** When set, the card is a short list to pick from — drawn as numbered rows
   *  like the plan's steps — instead of a box to type in. `1`…`4` pick by
   *  position (by key code, so an AZERTY top row works too). */
  choices?: QuestionChoices;
  answer: string;
  onAnswerChange: (next: string) => void;
  onSubmit: () => void;
  /** A clicked row answers with its text at once. */
  onChoose?: (answer: string) => void;
  onSkip: () => void;
};

/** What a choice row says. A provider id reads as its name; the CLI's
 *  `default` sentinel is the one model option that is not a model name, so it
 *  gets a sentence. */
export function choiceLabel(option: string, choices: QuestionChoices): { label: string; note?: string } {
  if (option === "default" && choices.moreModelsFrom) {
    return { label: `Let ${providerName(choices.moreModelsFrom)} choose`, note: "default" };
  }
  if (isKnownProvider(option)) return { label: providerName(option) };
  return { label: option };
}

/** The mark a row wears in place of a number: a worker's own logo when the
 *  option is a provider, the model's maker when it is a model, the Delegate's
 *  house for `default`. Falls back to the row's index when nothing is known. */
function ChoiceMark({ option, index, choices }: { option: string; index: number; choices: QuestionChoices }) {
  if (isKnownProvider(option)) return <ProviderLogo id={option} size={14} />;
  const mark = makerMark(option, choices.moreModelsFrom, 14);
  if (mark) return mark;
  return (
    <span
      aria-hidden
      style={{
        width: 16,
        height: 16,
        borderRadius: "50%",
        border: "1px solid var(--border-strong)",
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        color: "var(--fg-dim)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {index + 1}
    </span>
  );
}

const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4"];

/** A model that writes its answers into the question and offers only their
 *  letters as choices (`A`…`D`, `1`…`4`) gets the answers moved onto the rows:
 *  each lettered line leaves the question and becomes its row's label, and
 *  picking it answers with the line itself (`B. The Workspace refuses…`), so
 *  the model reads back what was chosen, not a bare letter. Null when the
 *  choices are real answers, or when any letter has no line to match. */
export function liftLetteredChoices(question: string, options: readonly string[]): { question: string; options: string[]; labels: string[] } | null {
  if (options.length === 0 || !options.every((o) => /^[A-Da-d1-4][.)]?$/.test(o.trim()))) return null;
  const lines = question.split("\n");
  const taken = new Set<number>();
  const lifted: { option: string; label: string }[] = [];
  for (const option of options) {
    const letter = option.trim().replace(/[.)]$/, "");
    const at = lines.findIndex((line, i) => !taken.has(i) && new RegExp(`^\\s*\\(?${letter}[.):]\\s+\\S`, "i").test(line));
    if (at < 0) return null;
    taken.add(at);
    const label = lines[at].replace(new RegExp(`^\\s*\\(?${letter}[.):]\\s+`, "i"), "").trim();
    lifted.push({ option: `${letter.toUpperCase()}. ${label}`, label });
  }
  return {
    question: lines.filter((_, i) => !taken.has(i)).join("\n").trim(),
    options: lifted.map((l) => l.option),
    labels: lifted.map((l) => l.label),
  };
}

/** Dispatch shortcuts: a Delegate's default and two models, or an API
 *  provider's first three. OpenCode's multi-provider catalog is browsed
 *  directly rather than recommending arbitrary alphabetical entries. */
export function dispatchModelRows(worker: ProviderId, models: string[], current?: string): string[] {
  const named = models.filter((m) => m && m !== "default");
  // OpenCode aggregates multiple providers. Alphabetical entries are not
  // recommendations; offer its default and let the full catalog be browsed.
  const rows = worker === "opencode" ? ["default"] : isDelegateProvider(worker) ? ["default", ...named.slice(0, 2)] : named.slice(0, 3);
  // The model the call named leads when it is not already among the rows, so
  // confirming Kit's choice is the first click, not a hunt through the picker.
  if (current && !rows.includes(current)) rows.unshift(current);
  return rows;
}

/** What a dispatch card sends back: the agent and the model as one object,
 *  which the harness reads on the other side. */
export function dispatchAnswer(worker: ProviderId, model: string): string {
  return JSON.stringify({ worker, model });
}

/** Which agent, then which model — one card, two steps, a way back. The
 *  agent step is the plain rows; the model step is the same rows for the
 *  picked agent's models, headed by the agent's name as a link back to change
 *  it. Picking a model answers. Opens on the model step when the call already
 *  named the agent, so the common case is one click. */
function DispatchPicker({ choices, onChoose }: { choices: QuestionChoices; onChoose: (answer: string) => void }) {
  const [worker, setWorker] = useState<ProviderId | null>(choices.preselected ?? null);
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    if (!worker) return;
    let cancelled = false;
    setModels([]);
    listProviderModels(worker)
      .then((list) => { if (!cancelled) setModels(list); })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, [worker]);
  if (!worker) {
    return (
      <ChoiceRows
        choices={{ options: choices.options }}
        onChoose={(picked) => { if (isKnownProvider(picked)) setWorker(picked); }}
      />
    );
  }
  const current = worker === choices.preselected ? choices.preselectedModel : undefined;
  const rows = dispatchModelRows(worker, models, current);
  return (
    <div style={{ display: "grid", padding: "0 6px" }}>
      <button
        type="button"
        className="klide-choice-row"
        onClick={() => setWorker(null)}
        title="Change agent"
        aria-label={`Change agent (currently ${providerName(worker)})`}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px 2px", border: "none", background: "transparent", color: "var(--fg-subtle)", font: "inherit", fontSize: 12.5, textAlign: "left", cursor: "pointer", minWidth: 0 }}
      >
        <span aria-hidden style={{ fontFamily: "var(--font-mono)" }}>‹</span>
        <ProviderLogo id={worker} size={13} />
        <span style={{ color: "var(--fg-strong)" }}>{providerName(worker)}</span>
        <span>· change</span>
      </button>
      <ChoiceRows
        key={worker}
        choices={{ options: rows, moreModelsFrom: worker, kind: "dispatch" }}
        current={current}
        onChoose={(model) => onChoose(dispatchAnswer(worker, model))}
        flush
      />
    </div>
  );
}

/** A list of model ids reads as code; a list of answers reads as prose — full
 *  sentences that wrap, in the UI face. Only a list drawn from a provider's
 *  models (or a dispatch's) is the former. */
function isPlainList(choices: QuestionChoices): boolean {
  return !choices.moreModelsFrom && choices.kind !== "dispatch";
}

function ChoiceRows({ choices, onChoose, current, flush, labels }: { choices: QuestionChoices; onChoose: (answer: string) => void; current?: string; flush?: boolean; labels?: readonly string[] }) {
  const [models, setModels] = useState<string[]>([]);
  const provider = choices.moreModelsFrom;
  const plain = isPlainList(choices);
  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    listProviderModels(provider)
      .then((list) => { if (!cancelled) setModels(list); })
      .catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, [provider]);
  return (
    <div
      role="listbox"
      aria-label="Answers"
      tabIndex={-1}
      onKeyDown={(e) => {
        const at = DIGIT_CODES.indexOf(e.code);
        if (at >= 0 && at < choices.options.length) {
          e.preventDefault();
          onChoose(choices.options[at]);
        }
      }}
      // The rows sit 6px in from the card's edge so their hover fill is a
      // rounded row, not a stripe — and their marks still land on the
      // question's column (6 + 8 = the header's 14).
      style={{ display: "grid", gap: 1, padding: flush ? "2px 0 4px" : "6px 6px 6px", outline: "none" }}
    >
      {choices.options.map((option, index) => {
        const { label: own, note } = choiceLabel(option, choices);
        const label = labels?.[index] ?? own;
        const code = !plain && !note && !isKnownProvider(option);
        return (
          <button
            key={option}
            type="button"
            role="option"
            aria-selected={option === current}
            data-current={option === current ? "1" : undefined}
            className="klide-choice-row"
            onClick={() => onChoose(option)}
            style={{
              display: "flex",
              alignItems: plain ? "flex-start" : "center",
              gap: 10,
              padding: "6px 8px",
              border: "none",
              background: "transparent",
              color: "var(--fg-strong)",
              font: "inherit",
              fontSize: 13,
              lineHeight: 1.5,
              textAlign: "left",
              cursor: "pointer",
              minWidth: 0,
            }}
          >
            <span aria-hidden style={{ width: 16, height: plain ? 19.5 : 16, flexShrink: 0, display: "grid", placeItems: "center" }}>
              <ChoiceMark option={option} index={index} choices={choices} />
            </span>
            <span
              style={{
                minWidth: 0,
                ...(plain
                  ? { overflowWrap: "anywhere" as const }
                  : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }),
                fontFamily: code ? "var(--font-mono)" : undefined,
                fontSize: code ? 12 : undefined,
              }}
            >
              {label}
            </span>
            {note && <span style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{note}</span>}
            {option === current && <span style={{ marginLeft: "auto", color: "var(--fg-dim)", fontSize: 11, flexShrink: 0 }}>Kit's pick</span>}
          </button>
        );
      })}
      {provider && (
        // The picker is the whole last row, not a control beside a label: the
        // same mark column as the rows above, then its trigger stretched to
        // the row's width with the row's words as its placeholder, so the
        // menu opens from where the eye already is.
        <div className="klide-choice-picker" style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", minWidth: 0 }}>
          <span aria-hidden style={{ width: 16, height: 16, flexShrink: 0, borderRadius: "50%", border: "1px dashed var(--border-strong)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <ModelPicker provider={provider} model="" availableModels={models} onChange={onChoose} direction="up" fluid bareHover catalogOnly={choices.kind === "dispatch"} placeholder={choices.kind === "dispatch" ? "Browse all models…" : "Another model…"} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Kit asked something and the run is parked until it hears back.
 *
 *  It waits in the conversation, right above the composer — the same place a
 *  command or a peer's message waits — on every surface. (On the Focus canvas
 *  it used to be a window in the side column, which put the one thing that
 *  holds the run as far from the reading column as the screen allows.)
 *
 *  The question, then either the answers to pick from or a borderless box to
 *  type in. A list of answers still takes a typed one: the foot is a one-line
 *  "Something else…" box beside Skip, so a pick is one click and a better
 *  answer is never refused. */
export function QuestionCard({
  question,
  choices,
  answer,
  onAnswerChange,
  onSubmit,
  onChoose,
  onSkip,
}: Props) {
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const canSend = answer.trim().length > 0;
  const picking = !!choices && choices.options.length > 0 && !!onChoose;
  const dispatching = picking && choices!.kind === "dispatch";
  // A dispatch answers with a JSON pair the harness parses, and a model list
  // already ends in a picker, so a free-typed answer belongs to plain lists.
  const typing = !picking || isPlainList(choices!);
  const lifted = picking && !dispatching ? liftLetteredChoices(question, choices!.options) : null;

  // The answer box grows with its text the way the composer does, with the
  // same guards: an empty box falls back to its one-row min-height, and a box
  // that has not been laid out yet is left alone until it has been.
  useEffect(() => {
    const ta = answerRef.current;
    if (!ta) return;
    if (ta.value === "") {
      ta.style.height = "";
      return;
    }
    if (ta.clientWidth === 0) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`;
  }, [answer]);

  return (
    <section
      className="ai-qa-card"
      aria-label="Question from the assistant"
      style={{
        // The accent-tinted hairline every "waiting on you" card carries.
        background: "color-mix(in srgb, var(--bg-elevated) 90%, transparent)",
        border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--border))",
        borderRadius: "var(--radius-lg)",
        marginBottom: 8,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* The mark says who is asking; the rows below put their numbers in the
          same column, so question and answers read as one exchange. */}
      <div style={{ display: "flex", gap: 10, padding: "12px 14px 0" }}>
        <span aria-hidden="true" style={{ flexShrink: 0, width: 16, height: 21, display: "grid", placeItems: "center", color: "var(--accent)" }}>
          <AskIcon size={14} />
        </span>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            color: "var(--fg-strong)",
            fontSize: 14,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            maxHeight: "min(240px, 30dvh)",
            overflowY: "auto",
            overscrollBehavior: "contain",
          }}
        >
          {lifted ? lifted.question : question}
        </div>
      </div>
      {dispatching && <div style={{ paddingTop: 6 }}><DispatchPicker choices={choices!} onChoose={onChoose!} /></div>}
      {picking && !dispatching && (
        <ChoiceRows choices={lifted ? { ...choices!, options: lifted.options } : choices!} labels={lifted?.labels} onChoose={onChoose!} />
      )}
      {!picking && <div style={{ height: 4 }} />}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 4,
          padding: "4px 8px 6px 0",
          borderTop: picking ? "1px solid color-mix(in srgb, var(--border) 45%, transparent)" : undefined,
        }}
      >
        {typing ? (
          <textarea
            ref={answerRef}
            className="klide-composer-textarea"
            autoFocus={!picking}
            value={answer}
            onChange={(e) => onAnswerChange(e.target.value)}
            onKeyDown={(e) => {
              // A one-line "something else" sends on Enter like a search box;
              // a full answer is prose and sends on ⌘↩ like the composer.
              const send = picking ? e.key === "Enter" && !e.shiftKey : (e.metaKey || e.ctrlKey) && e.key === "Enter";
              if (send) {
                e.preventDefault();
                if (canSend) onSubmit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onSkip();
              }
            }}
            placeholder={picking ? "Something else…" : "Answer…"}
            aria-label={picking ? "Answer something else" : "Answer"}
            rows={1}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 32,
              maxHeight: 168,
              resize: "none",
              background: "transparent",
              border: "none",
              color: "var(--fg-strong)",
              font: "inherit",
              fontSize: 13,
              lineHeight: 1.55,
              // Lines up under the question text, past the mark's column.
              padding: "6px 0 5px 40px",
              outline: "none",
              display: "block",
            }}
          />
        ) : <span style={{ flex: 1 }} />}
        <button
          type="button"
          onClick={onSkip}
          title="Answer nothing and let the run carry on (Esc)"
          className="klide-choice-row"
          style={{
            height: 28,
            padding: "0 10px",
            border: "none",
            background: "transparent",
            color: "var(--fg-subtle)",
            font: "inherit",
            fontSize: 12,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          Skip
        </button>
        {typing && (!picking || canSend) && <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label="Send answer"
          title={picking ? "Send answer (↩)" : "Send answer (⌘↩)"}
          style={{
            width: 28,
            height: 28,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            borderRadius: "50%",
            color: canSend ? "var(--control-primary-fg)" : "var(--fg-dim)",
            background: canSend ? "var(--accent)" : "var(--bg-elevated)",
            border: canSend ? "none" : "1px solid var(--border)",
            cursor: canSend ? "pointer" : "default",
            transition: "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), filter var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => { if (canSend) e.currentTarget.style.filter = "brightness(1.08)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
        >
          <SendIcon size={13} />
        </button>}
      </div>
    </section>
  );
}
