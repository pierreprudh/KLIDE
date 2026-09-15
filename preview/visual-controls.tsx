// Repro for an inset authored SVG and a direct inspection of the exported PNG.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderMarkdown } from "../src/components/markdown";
import { renderVisualPng } from "../src/components/visualExport";
import "../src/styles/tokens.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/monaspace-neon/400.css";
document.documentElement.dataset.theme = "klide-light";
const example = '```svg\n<svg viewBox="0 0 720 420"><text x="40" y="40" font-size="14">How a corrupt file erases the whole store</text><rect x="40" y="70" width="160" height="64" rx="8"/><text x="60" y="100">Corrupt file</text><path d="M210 102H250" stroke="var(--viz-line)"/><rect x="260" y="70" width="160" height="64" rx="8"/><text x="280" y="100">Read returns empty</text><path d="M430 102H470" stroke="var(--viz-line)"/><rect x="480" y="70" width="190" height="64" rx="8"/><text x="495" y="100">Next write erases data</text></svg>\n```';
function Page() {
  const content = useRef<HTMLDivElement>(null);
  const [png, setPng] = useState("");
  const [result, setResult] = useState("");
  const [narrow, setNarrow] = useState(false);
  const [tall, setTall] = useState(false);
  const tallExample = '```svg\n<svg viewBox="0 0 440 1000"><rect x="20" y="20" width="400" height="960" rx="8"/><text x="45" y="60">Tall diagram — all four edges should fit</text><text x="45" y="950">Bottom of the diagram</text></svg>\n```';
  return <main style={{margin:"32px auto",width:narrow?360:720,color:"var(--fg)"}}>
    <p>The figure should align with this paragraph and have no large blank footer.</p>
    <button onClick={() => setNarrow(!narrow)}>Toggle narrow column</button>
    <button onClick={() => setTall(!tall)}>Toggle tall diagram</button>
    <div ref={content}>{renderMarkdown(tall ? tallExample : example)}</div>
    <button onClick={async () => { try {setPng(await renderVisualPng(content.current!.querySelector('.klide-viz')!));} catch(e) {setResult(String(e));} }}>Inspect PNG</button>

    <p role="status">{result}</p>
    {png ? <img alt="Exported visual" src={png} style={{maxWidth:"100%"}} onLoad={e => setResult(`PNG decoded: ${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} /> : null}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Page/>);
