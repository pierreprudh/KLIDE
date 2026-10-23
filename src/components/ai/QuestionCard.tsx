import { useEffect, useRef, useState, type ReactNode } from "react";

import { AskIcon } from "../../icons";
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

/** The letter a row answers to — `A` for the first. The same letter is its
 *  key: pressed while the card has focus, it picks the row. */
export function choiceLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** A row's letter, drawn as the keycap it is. */
function LetterKey({ index, small }: { index: number; small?: boolean }) {
  return <kbd aria-hidden className="klide-choice-key" data-small={small ? "1" : undefined}>{choiceLetter(index)}</kbd>;
}

/** The mark a row wears in place of a letter: a worker's own logo when the
 *  option is a provider, the model's maker when it is a model. Falls back to
 *  the row's letter when nothing is known. */
function ChoiceMark({ option, index, choices }: { option: string; index: number; choices: QuestionChoices }) {
  if (isKnownProvider(option)) return <ProviderLogo id={option} size={14} />;
  const mark = makerMark(option, choices.moreModelsFrom, 14);
  if (mark) return mark;
  return <LetterKey index={index} small={!isPlainList(choices)} />;
}

/** Which row a key picks: its letter (by the character, so AZERTY's A is A),
 *  or `1`…`9` by key code, so an AZERTY top row works without Shift. */
export function choiceIndexForKey(e: { key: string; code: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): number {
  if (e.metaKey || e.ctrlKey || e.altKey) return -1;
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase().charCodeAt(0) - 65;
  const digit = /^Digit([1-9])$/.exec(e.code);
  return digit ? Number(digit[1]) - 1 : -1;
}

/** The question's first line is its title; whatever follows is the reason
 *  behind it, set under it in the quieter face. */
export function splitQuestion(question: string): { title: string; detail: string } {
  const text = question.trim();
  const at = text.indexOf("\n");
  if (at < 0) return { title: text, detail: "" };
  return { title: text.slice(0, at).trim(), detail: text.slice(at + 1).trim() };
}

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

function ChoiceRows({ choices, onChoose, current, flush, labels, other, onOther, autoFocus }: {
  choices: QuestionChoices;
  onChoose: (answer: string) => void;
  current?: string;
  flush?: boolean;
  labels?: readonly string[];
  /** A last row after the answers — the "Something else…" box — that the
   *  next letter moves into. */
  other?: ReactNode;
  onOther?: () => void;
  autoFocus?: boolean;
}) {
  const [models, setModels] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
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
  // The letters only answer once the list has focus, so it takes focus when
  // the question arrives — unless someone is typing elsewhere, whose next
  // letter must not become an answer.
  useEffect(() => {
    if (!autoFocus) return;
    const active = document.activeElement as HTMLElement | null;
    const typing = !!active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    if (!typing) listRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Answers"
      tabIndex={-1}
      onKeyDown={(e) => {
        // The "Something else…" box takes its own keys; a letter there is text.
        if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
        const at = choiceIndexForKey(e);
        if (at >= 0 && at < choices.options.length) {
          e.preventDefault();
          onChoose(choices.options[at]);
        } else if (at === choices.options.length && onOther) {
          e.preventDefault();
          onOther();
        }
      }}
      // The rows sit 10px in from the card's edge so their hover fill is a
      // rounded row, not a stripe — and their keys still land on the
      // question's column (10 + 8 = the card's 18).
      style={{ display: "grid", gap: 2, padding: flush ? "2px 0 4px" : "10px 10px 0", outline: "none" }}
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
              gap: plain ? 12 : 10,
              padding: plain ? "7px 8px" : "6px 8px",
              border: "none",
              background: "transparent",
              color: "var(--fg-strong)",
              font: "inherit",
              fontSize: plain ? 14 : 13,
              lineHeight: 1.5,
              textAlign: "left",
              cursor: "pointer",
              minWidth: 0,
            }}
          >
            <span aria-hidden style={{ width: plain ? 24 : 18, height: plain ? 24 : 18, flexShrink: 0, display: "grid", placeItems: "center" }}>
              <ChoiceMark option={option} index={index} choices={choices} />
            </span>
            <span
              style={{
                minWidth: 0,
                ...(plain
                  ? { overflowWrap: "anywhere" as const, paddingTop: 1.5 }
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
          <span aria-hidden style={{ width: 16, height: 16, margin: "0 1px", flexShrink: 0, borderRadius: "50%", border: "1px dashed var(--border-strong)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <ModelPicker provider={provider} model="" availableModels={models} onChange={onChoose} direction="up" fluid bareHover catalogOnly={choices.kind === "dispatch"} placeholder={choices.kind === "dispatch" ? "Browse all models…" : "Another model…"} />
          </div>
        </div>
      )}
      {other}
    </div>
  );
}

/** Keycaps drawn on the primary button: its own ink, thinned, so the chord
 *  reads as part of the button rather than a chip stuck to it. */
function ButtonKeys({ keys }: { keys: string[] }) {
  return (
    <span aria-hidden style={{ display: "inline-flex", gap: 2 }}>
      {keys.map((k) => (
        <kbd
          key={k}
          style={{
            minWidth: 20,
            height: 20,
            padding: "0 4px",
            display: "grid",
            placeItems: "center",
            borderRadius: 5,
            background: "color-mix(in srgb, var(--control-primary-fg) 14%, transparent)",
            color: "color-mix(in srgb, var(--control-primary-fg) 82%, transparent)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1,
          }}
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** Kit asked something and the run is parked until it hears back.
 *
 *  It waits in the conversation, right above the composer — the same place a
 *  command or a peer's message waits — on every surface. (On the Focus canvas
 *  it used to be a window in the side column, which put the one thing that
 *  holds the run as far from the reading column as the screen allows.)
 *
 *  A quiet "Question" head, the question as a title with whatever follows its
 *  first line set under it as the reason, then the answers as rows lettered
 *  like keycaps — the letter is the key. A list of answers still takes a
 *  typed one: its last lettered row is a "Something else…" box, so a pick is
 *  one click (or one key) and a better answer is never refused. Skip and Send
 *  sit at the foot. */
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
  const { title, detail } = splitQuestion(lifted ? lifted.question : question);
  const options = lifted ? lifted.options : choices?.options ?? [];

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

  const answerBox = typing && (
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
        minHeight: picking ? 21 : 32,
        maxHeight: 168,
        resize: "none",
        background: "transparent",
        border: "none",
        color: "var(--fg-strong)",
        font: "inherit",
        fontSize: 14,
        lineHeight: 1.5,
        padding: picking ? "1.5px 0 0" : "6px 0 5px",
        outline: "none",
        display: "block",
      }}
    />
  );

  return (
    <section
      className="ai-qa-card"
      aria-label="Question from the assistant"
      onKeyDown={(e) => {
        // Esc skips from anywhere in the card; the answer box handles its own.
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          onSkip();
        }
      }}
      style={{
        // The accent-tinted hairline every "waiting on you" card carries,
        // quieter here: the head's tile already says who is waiting.
        background: "var(--bg-elevated)",
        border: "1px solid color-mix(in srgb, var(--accent) 16%, var(--border))",
        borderRadius: 14,
        marginBottom: 8,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Who is asking, in a tinted tile, and a ring that closes once there
          is an answer to send. The question below is the card's body. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 18px 0" }}>
        <span
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            borderRadius: 8,
            color: "var(--accent)",
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
          }}
        >
          <AskIcon size={16} />
        </span>
        <span style={{ flex: 1, minWidth: 0, color: "var(--fg-strong)", fontSize: 15, fontWeight: 700 }}>Question</span>
        <span
          aria-hidden="true"
          className="klide-question-ring"
          data-ready={canSend ? "1" : undefined}
        />
      </div>
      <div style={{ padding: "14px 18px 0", maxHeight: "min(260px, 32dvh)", overflowY: "auto", overscrollBehavior: "contain" }}>
        <div style={{ color: "var(--fg-strong)", fontSize: 15, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {title}
        </div>
        {detail && (
          <div style={{ marginTop: 4, color: "var(--fg-subtle)", fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {detail}
          </div>
        )}
      </div>
      {dispatching && <div style={{ paddingTop: 8 }}><DispatchPicker choices={choices!} onChoose={onChoose!} /></div>}
      {picking && !dispatching && (
        <ChoiceRows
          choices={{ ...choices!, options }}
          labels={lifted?.labels}
          onChoose={onChoose!}
          autoFocus
          onOther={typing ? () => answerRef.current?.focus() : undefined}
          other={typing ? (
            // The last lettered row is the box itself: a click anywhere on it
            // puts the caret in, and its letter moves there from the list.
            <div
              className="klide-choice-row klide-choice-other"
              onClick={() => answerRef.current?.focus()}
              style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "7px 8px", cursor: "text", minWidth: 0 }}
            >
              <span aria-hidden style={{ width: 24, height: 24, flexShrink: 0, display: "grid", placeItems: "center" }}>
                <LetterKey index={options.length} />
              </span>
              {answerBox}
            </div>
          ) : undefined}
        />
      )}
      {!picking && <div style={{ display: "flex", padding: "6px 18px 0" }}>{answerBox}</div>}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "12px 18px 18px" }}>
        <button
          type="button"
          onClick={onSkip}
          title="Answer nothing and let the run carry on (Esc)"
          className="klide-button klide-button-secondary klide-question-skip"
          style={{ minHeight: 32, padding: "0 12px", borderRadius: 9, fontSize: 13, fontWeight: 400 }}
        >
          Skip
        </button>
        {typing && (
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSend}
            aria-label="Send answer"
            title={picking ? "Send answer (↩)" : "Send answer (⌘↩)"}
            className="klide-button klide-button-primary klide-question-send"
            style={{ minHeight: 32, padding: "0 6px 0 14px", borderRadius: 9, gap: 10, fontSize: 13 }}
          >
            Send
            <ButtonKeys keys={picking ? ["↩"] : ["⌘", "↩"]} />
          </button>
        )}
      </div>
    </section>
  );
}
