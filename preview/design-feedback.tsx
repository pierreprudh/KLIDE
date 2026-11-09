import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/700.css";
import "../src/styles/tokens.css";
import { fixtureConversation, FIXTURE_VERSION, FIXED_TIME, MODEL, WORKSPACE } from "./design-feedback/fixtures";
import { parseScenario } from "./design-feedback/scenarios";
import { forgetComposerDrafts } from "../src/components/ai/composerDraft";
import { SCENARIO_STATES } from "./design-feedback/events";
import { MODELS, installNativeFixture } from "./design-feedback/native";

const nextPaint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function boot() {
  // The native parity window has no Playwright clock. Freeze only Date, not
  // timers or animation frames, so synthetic labels match the browser run.
  if (new URLSearchParams(location.search).get("desktop") === "1") {
    const NativeDate = Date;
    globalThis.Date = new Proxy(NativeDate, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : [FIXED_TIME]); },
      apply() { return new NativeDate(FIXED_TIME).toString(); },
      get(target, property, receiver) { return property === "now" ? () => FIXED_TIME : Reflect.get(target, property, receiver); },
    });
  }
  const { scenarioId, theme } = parseScenario(new URLSearchParams(location.search));
  document.documentElement.dataset.theme = theme;
  const native = installNativeFixture(scenarioId);
  let conversation = fixtureConversation(scenarioId);
  localStorage.clear();
  localStorage.setItem("klide-conversations", JSON.stringify([conversation]));
  localStorage.setItem("klide.provider", "openai");
  const { AiPanel } = await import("../src/components/AiPanel");
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let reset!: (state?: string) => Promise<void>;
  const api = { ready, status: "loading", scenarioId, fixtureVersion: FIXTURE_VERSION, native, error: null as string | null,
    states: SCENARIO_STATES[scenarioId], reset: () => reset(), setState: async (state: string) => {
      if (!(SCENARIO_STATES[scenarioId] as readonly string[]).includes(state)) throw new Error(`Unknown state: ${state}`);
      await reset(state === "earlier" ? "initial" : state);
      if (state === "earlier") {
        const scroller = document.querySelector<HTMLElement>('[data-transcript-scroller]');
        if (!scroller) throw new Error("Production transcript scroller not found");
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event("scroll"));
        await nextPaint();
      }
    } };
  Object.assign(window, { __designFeedback: api });
  function Fixture() {
    const [revision, setRevision] = useState(0);
    const [model, setModel] = useState(conversation.model ?? MODEL);
    const [width, setWidth] = useState(window.innerWidth);
    useLayoutEffect(() => {
      const resize = () => setWidth(window.innerWidth);
      window.addEventListener("resize", resize);
      return () => window.removeEventListener("resize", resize);
    }, []);
    useLayoutEffect(() => {
      let active = true;
      void (async () => {
        await Promise.all(['400 14px "Atkinson Hyperlegible"', '700 14px "Atkinson Hyperlegible"', '400 14px "Monaspace Neon"', '700 14px "Monaspace Neon"'].map(font => document.fonts.load(font)));
        await document.fonts.ready;
        await nextPaint();
        if (active && scenarioId === "composer-menu") {
          const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
          if (!trigger) throw new Error("Production model picker trigger not found");
          trigger.click();
          await nextPaint();
        }
        if (active) { api.status = "ready"; readyResolve(); }
      })().catch(error => { api.error = String(error); api.status = "error"; readyReject(error); });
      reset = async (state = "initial") => {
        if (api.status === "loading") throw new Error("Wait for fixture readiness before resetting");
        api.status = "loading";
        api.ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        native.reset(state);
        conversation = fixtureConversation(scenarioId, state);
        setModel(conversation.model ?? MODEL);
        forgetComposerDrafts(conversation.id);
        localStorage.clear();
        localStorage.setItem("klide-conversations", JSON.stringify([conversation]));
        localStorage.setItem("klide.provider", conversation.provider ?? "openai");
        setRevision(x => x + 1);
        await api.ready;
      };
      return () => { active = false; };
    }, [revision]);
    return <main aria-label="Design feedback scenario" style={{ height: "100dvh", minWidth: 0, color: "var(--fg)", background: "var(--bg)", fontFamily: "var(--font-ui)", display: "flex", flexDirection: "column" }}>
      <AiPanel key={revision} workspaceRoot={WORKSPACE} workspaceBranch="fixture/design-feedback" visible width={width} fill variant="focus" panelId="design-fixture" initialConversationId={conversation.id} provider={conversation.provider} model={model} onModelChange={setModel} availableModels={scenarioId === "subagent-activity" ? ["default"] : MODELS} onAvailableModelsChange={() => {}} requireDiffReview stopAfterRejection skills={[]} harnessSettings={{ nameConversations: false }} />
    </main>;
  }
  createRoot(document.getElementById("root")!).render(<Fixture />);
  await ready;
}
void boot().catch(error => {
  Object.assign(window, { __designFeedback: { error: String(error) } });
  document.getElementById("root")!.textContent = String(error);
  console.error(error);
});
