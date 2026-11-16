// The provider picker's body (StackSideMenu) with the real provider rows and
// a fixture of which keys are set — open on the stack holding the choice.
// The second copy sits at the window's right and bottom edges, where the side
// card has to flip left and lift.
//
//   http://localhost:1420/preview/provider-menu.html
//   ?theme=klide-light (default) | dark   ?stack=Local (open another stack)
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { PROVIDER_GROUPS } from "../src/agent/providers";
import type { ProviderId } from "../src/agent/types";
import { ProviderLogo } from "../src/components/ai/icons";
import { StackSideMenu, type Stack } from "../src/components/ai/StackSideMenu";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

const KEYED = new Set(["anthropic", "openai", "openrouter", "groq"]);
const selected = params.get("selected") ?? "anthropic";

const stacks: Stack[] = PROVIDER_GROUPS.map((g) => ({
  label: g.label,
  rows: g.items
    .filter((i) => i.available)
    .map((i) => {
      const keyless = g.label === "API" && !KEYED.has(i.id);
      return {
        id: i.id,
        label: i.name,
        icon: <ProviderLogo id={i.id as ProviderId} size={17} />,
        active: i.id === selected,
        dimmed: keyless,
        leadout: keyless,
        onPick: () => {},
      };
    }),
})).filter((s) => s.rows.length > 0);

function Page() {
  return (
    <>
      <div style={{ position: "fixed", top: 24, left: 24 }}>
        <StackSideMenu stacks={stacks} />
      </div>
      <div style={{ position: "fixed", bottom: 24, right: 24 }}>
        <StackSideMenu stacks={stacks} origin="bottom left" />
      </div>
    </>
  );
}

document.body.style.background = "var(--bg)";
ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
