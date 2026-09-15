import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "../src/styles/tokens.css";
import { ArtifactOutputRows, ArtifactOutputSelection } from "../src/components/ai/ArtifactOutputPicker";
import type { ArtifactOutput } from "../src/components/ai/artifactOutput";
document.documentElement.dataset.theme = "dark";
function Preview() {
 const [open, setOpen] = useState(true);
 const [value, setValue] = useState<ArtifactOutput | null>(null);
 return <main style={{padding: 48, background: "var(--bg)", minHeight: "100vh", color: "var(--fg)", fontFamily: "var(--font-ui)"}}>
 {open && <div role="menu" aria-label="Create an artifact" style={{width:238, padding:5, border:"1px solid var(--border)", borderRadius:8, background:"var(--bg-elevated)"}}>
 <button className="klide-focus-add-menu-row">Add file<span className="klide-focus-add-menu-meta">@</span></button>
 <div className="klide-focus-add-menu-divider"/>
 <ArtifactOutputRows value={value} onChange={setValue}/>
 <button className="klide-focus-add-menu-row">Chat</button><button className="klide-focus-add-menu-row">Plan</button><button className="klide-focus-add-menu-row">Goal</button>
 </div>}<div style={{marginTop:16}}><button type="button" aria-label="Toggle main menu" aria-expanded={open} onClick={() => setOpen(!open)} style={{background:"transparent", border:0, color:"var(--fg)", fontSize:22, cursor:"pointer"}}>+</button><ArtifactOutputSelection value={value} onClear={()=>setValue(null)}/></div>
 </main>;
}
createRoot(document.getElementById("root")!).render(<Preview/>);
