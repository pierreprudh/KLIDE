// Browser-only fixture for the live question card above the composer: a
// plain list with a reason line, a lifted lettered list, and a free answer.
// `?theme=light|dark`.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { QuestionCard } from "../src/components/ai/QuestionCard";

const q = new URLSearchParams(location.search);

function Card(props: { question: string; options?: string[]; typed?: string }) {
  const [answer, setAnswer] = useState(props.typed ?? "");
  return (
    <QuestionCard
      question={props.question}
      choices={props.options ? { options: props.options } : undefined}
      answer={answer}
      onAnswerChange={setAnswer}
      onSubmit={() => {}}
      onChoose={() => {}}
      onSkip={() => {}}
    />
  );
}

function Preview() {
  return (
    <main style={{ width: 560, margin: "24px auto", display: "grid", gap: 16, fontFamily: "var(--font-ui)", color: "var(--fg)" }}>
      <Card
        question={"Which store should the sessions live in?\nEvery request reads the session, so this is the hot path."}
        options={["Postgres — alongside the app", "Redis — expiring keys", "SQLite — one file on the box", "Signed cookies — no store at all"]}
      />
      <Card question={"Q4 · What happens when a Run writes outside the Workspace?\n\nA. It reads fine.\nB. The Workspace refuses it.\nC. Redacted."} options={["A", "B", "C"]} typed="Neither" />
      <Card question="What should the branch be called?" />
    </main>
  );
}

document.documentElement.dataset.theme = q.get("theme") ?? "light";
createRoot(document.getElementById("root")!).render(<Preview />);
