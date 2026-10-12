// Throwaway page for Settings › Appearance › Welcome › Nature film cards.
//
//   npx vite --port 1421   →  http://localhost:1421/preview/welcome-film.html
//   ?theme=dark | klide-light | cursor-dark | …
import { useState } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/monaspace-neon/400.css";
import "../src/styles/tokens.css";
import { WelcomeFilmCards } from "../src/components/settings/welcomeFilm";
import type { PixelNatureOrder } from "../src/components/pixelNatureEngine";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "cursor-dark";

function Page() {
  const [value, setValue] = useState<PixelNatureOrder>("shuffle");
  return (
    <div style={{ padding: 40, maxWidth: 760, background: "var(--bg)", minHeight: "100vh", color: "var(--fg)" }}>
      <div className="klide-surface">
        <WelcomeFilmCards value={value} onChange={setValue} />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
