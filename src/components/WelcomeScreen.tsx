// The Welcome screen: choose your space.
//
// A space is who you are working as — Personal, Work — with its own GitHub
// identity. The film card sits on the left; the spaces on the right, three to a
// row with "+" centred under a full row. Choosing one opens its last project.
// "+" walks three steps (who, agent logins, folders) on the same split card.
//
// What is real today: the list, the GitHub picture, keyboard, opening the last
// project. What is not yet: switching anything when you change space — the
// GitHub pin, the agents' saved logins and per-space recents are the next
// slices, so a space added here is remembered on this Mac and nothing more.
import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { PixelNature } from "./PixelNature";
import { ProviderLogo } from "./ai/icons";
import { SETTINGS, useSetting } from "../settingsStore";
import { useUserInfo } from "../hooks/useUserInfo";
import { DELEGATES } from "../delegates";
import { SettingsIcon } from "../icons";

type Props = {
  recentFolders: string[];
  onOpenFolder: () => void;
  onOpenRecent: (path: string) => void;
  onOpenSettings: () => void;
};

type Space = { id: string; name: string; github: string; email: string; folders: string[] };

const STORE_KEY = "klide.spaces";

function loadSpaces(): Space[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const list = raw ? (JSON.parse(raw) as Space[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveSpaces(list: Space[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* private window or full storage — the list lives for this session */
  }
}

const STEPS = [
  { card: "Create your space", title: "Create your space", sub: "Who is this space for? Klide keeps it on this Mac." },
  { card: "Connect your agents", title: "Connect your agents", sub: "Each space uses the logins your tools already have." },
  { card: "Choose your folders", title: "Choose your folders", sub: "Projects in these folders open in this space." },
];

const ACCOUNT_AGENTS = DELEGATES.filter((d) => d.supportsAccounts);

export function WelcomeScreen({ recentFolders, onOpenFolder, onOpenRecent, onOpenSettings }: Props) {
  const [welcomeFilm] = useSetting(SETTINGS.welcomeFilm);
  const { githubLogin, username } = useUserInfo();
  const [stored, setStored] = useState<Space[]>(loadSpaces);
  const [adding, setAdding] = useState(false);

  // Until a space has been added, the one you are is the GitHub account Klide
  // already uses — shown, never written, so a later login change follows.
  const spaces: Space[] =
    stored.length > 0
      ? stored
      : [{ id: "personal", name: "Personal", github: githubLogin, email: "", folders: [] }];

  function addSpace(space: Space) {
    const next = [...(stored.length > 0 ? stored : spaces), space];
    setStored(next);
    saveSpaces(next);
    setAdding(false);
  }

  function enter() {
    const last = recentFolders[0];
    if (last) onOpenRecent(last);
    else onOpenFolder();
  }

  const film = (
    <div className="klide-welcome-stage ks-stage">
      <div className="klide-welcome-card is-nature">
        <PixelNature className="klide-nature-canvas" order={welcomeFilm} />
      </div>
    </div>
  );

  if (adding) {
    return (
      <AddSpace
        film={welcomeFilm}
        githubLogin={githubLogin}
        defaultName={username}
        first={stored.length === 0 && !githubLogin}
        onCancel={() => setAdding(false)}
        onDone={addSpace}
      />
    );
  }

  return (
    <div className="klide-welcome klide-welcome--split">
      {film}
      <Chooser
        spaces={spaces}
        onEnter={enter}
        onAdd={() => setAdding(true)}
        onOpenSettings={onOpenSettings}
      />
    </div>
  );
}

/* ───────────────────────────────────────────────────────── chooser ── */

function Chooser({
  spaces,
  onEnter,
  onAdd,
  onOpenSettings,
}: {
  spaces: Space[];
  onEnter: (space: Space) => void;
  onAdd: () => void;
  onOpenSettings: () => void;
}) {
  const slots = spaces.length + 1;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [opening, setOpening] = useState<Space | null>(null);

  function open(ix: number) {
    const space = spaces[ix];
    if (!space || opening) return;
    setActive(ix);
    setOpening(space);
    // Let the choice read for a beat before the workspace replaces the screen.
    window.setTimeout(() => {
      setOpening(null);
      onEnter(space);
    }, 360);
  }

  function move(to: number) {
    const ix = (to + slots) % slots;
    setActive(ix);
    refs.current[ix]?.focus();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (opening) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      // Physical keys (e.code), so ⌘1 works on AZERTY too.
      if (e.metaKey && /^Digit[1-9]$/.test(e.code)) {
        const ix = Number(e.code.slice(5)) - 1;
        if (ix < spaces.length) { e.preventDefault(); open(ix); }
        return;
      }
      if (e.metaKey && e.code === "KeyN") { e.preventDefault(); onAdd(); return; }
      if (e.metaKey && e.code === "Comma") { e.preventDefault(); onOpenSettings(); return; }
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      const cols = 3;
      if (e.key === "ArrowRight") { e.preventDefault(); move(active + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); move(active - 1); }
      else if (e.key === "ArrowDown" && active + cols < slots) { e.preventDefault(); move(active + cols); }
      else if (e.key === "ArrowUp" && active - cols >= 0) { e.preventDefault(); move(active - cols); }
      else if (e.key === "Enter" && (document.activeElement === document.body || !document.activeElement)) {
        e.preventDefault();
        if (active < spaces.length) open(active); else onAdd();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="klide-welcome-pane ks-pane">
      <div className="ks" data-opening={opening ? true : undefined}>
        <div className="ks-mark" role="img" aria-label="Klide" />
        <h1 className="klide-welcome-title ks-title">
          Choose your space
        </h1>

        <div
          className="ks-people"
          role="radiogroup"
          aria-label="Spaces"
          data-two-rows={spaces.length >= 3 || undefined}
        >
          {spaces.map((space, i) => (
            <button
              key={space.id}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={i === active}
              aria-keyshortcuts={i < 9 ? `Meta+${i + 1}` : undefined}
              tabIndex={i === active ? 0 : -1}
              className="ks-person"
              data-on={i === active || undefined}
              onFocus={() => setActive(i)}
              onClick={() => open(i)}
            >
              <Face space={space} />
              <span className="ks-name">{space.name}</span>
              <span className="ks-detail">{space.github ? `@${space.github}` : " "}</span>
            </button>
          ))}
          <button
            ref={(el) => { refs.current[spaces.length] = el; }}
            type="button"
            className="ks-person"
            tabIndex={active === spaces.length ? 0 : -1}
            aria-keyshortcuts="Meta+N"
            onFocus={() => setActive(spaces.length)}
            onClick={onAdd}
          >
            <span className="ks-face ks-face-add" aria-hidden>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </span>
            <span className="ks-name">Add space</span>
            <span className="ks-detail">{" "}</span>
          </button>
        </div>

        <p className="ks-status" aria-live="polite">{opening ? <>Opening {opening.name}…</> : null}</p>
      </div>

      <footer className="ks-foot">
        <button type="button" className="ks-settings" aria-keyshortcuts="Meta+Comma" onClick={onOpenSettings}>
          <SettingsIcon size={16} />
          Settings
        </button>
        <span className="ks-keys">
          <button type="button" className="klide-welcome-kbd ks-arrow" aria-label="Previous space" tabIndex={-1} onClick={() => move(active - 1)}>←</button>
          <button type="button" className="klide-welcome-kbd ks-arrow" aria-label="Next space" tabIndex={-1} onClick={() => move(active + 1)}>→</button>
        </span>
      </footer>
    </div>
  );
}

/** The GitHub picture when there is one; the initial otherwise. Asked for at
 *  three times its 136 px box so it stays sharp on Retina and at hover scale. */
function Face({ space }: { space: Space }) {
  const url = space.github ? `https://github.com/${space.github}.png?size=420` : "";
  const [failed, setFailed] = useState(false);
  return (
    <span className="ks-face">
      {url && !failed ? (
        <img className="ks-face-img" src={url} alt="" draggable={false} onError={() => setFailed(true)} />
      ) : (
        space.name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

/* ─────────────────────────────────────────────────────── add space ── */

function AddSpace({
  film,
  githubLogin,
  defaultName,
  first,
  onCancel,
  onDone,
}: {
  film: Parameters<typeof PixelNature>[0]["order"];
  githubLogin: string;
  defaultName: string;
  first: boolean;
  onCancel: () => void;
  onDone: (space: Space) => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [who, setWho] = useState(defaultName);
  const [email, setEmail] = useState("");
  const [github, setGithub] = useState("");
  const [folders, setFolders] = useState<string[]>([]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function addFolder() {
    const picked = await openDialog({ directory: true, title: "Choose a folder for this space" });
    if (typeof picked === "string" && !folders.includes(picked)) setFolders([...folders, picked]);
  }

  function next() {
    if (step < 2) { setStep(step + 1); return; }
    const label = name.trim() || "Work";
    onDone({
      id: `${label.toLowerCase().replace(/\W+/g, "-")}-${Date.now().toString(36)}`,
      name: label,
      github,
      email: email.trim(),
      folders,
    });
  }

  const copy = STEPS[step];

  return (
    <div className="klide-welcome klide-welcome--split ks-add">
      <div className="klide-welcome-stage ks-stage">
        <div className="klide-welcome-card is-nature">
          <PixelNature className="klide-nature-canvas" order={film} />
          <div className="ks-veil" />
          <div className="ks-overlay">
            <div className="ks-overlay-head">
              <h1 className="ks-overlay-title">{first ? <>Get started<br />with Klide</> : <>Add a<br />space</>}</h1>
              <p className="ks-overlay-sub">Each space keeps its own GitHub, agent logins and projects.</p>
            </div>
            <div className="ks-steps">
              {STEPS.map((s, i) => (
                <button
                  key={s.card}
                  type="button"
                  className="ks-step"
                  data-on={i === step || undefined}
                  aria-current={i === step ? "step" : undefined}
                  disabled={i > step}
                  onClick={() => setStep(i)}
                >
                  <span className="ks-num">{i < step ? "✓" : i + 1}</span>
                  <span className="ks-step-label">{s.card}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="klide-welcome-pane">
        <form
          className="ks-form"
          onSubmit={(e) => { e.preventDefault(); next(); }}
        >
          <header className="ks-form-head">
            <h2 className="ks-h2">{copy.title}</h2>
            <p className="ks-lede">{copy.sub}</p>
          </header>

          {step === 0 && (
            <>
              {githubLogin ? (
                <button type="button" className="ks-oauth" data-on={github === githubLogin || undefined} onClick={() => setGithub(github === githubLogin ? "" : githubLogin)}>
                  <GitHubMark />
                  {github === githubLogin ? <>Using @{githubLogin}</> : <>Use GitHub @{githubLogin}</>}
                </button>
              ) : null}
              {githubLogin ? <div className="ks-or"><span>Or</span></div> : null}
              <div className="ks-group">
                <div className="ks-pair">
                  <label className="ks-field">
                    <span>Space name</span>
                    <input autoFocus className="ks-input" placeholder="eg. Work" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                  <label className="ks-field">
                    <span>Your name</span>
                    <input className="ks-input" placeholder="eg. Pierre" autoComplete="off" value={who} onChange={(e) => setWho(e.target.value)} />
                  </label>
                </div>
                <label className="ks-field">
                  <span>Email</span>
                  <input className="ks-input" type="email" placeholder="eg. you@company.com" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <small>Used on the commits this space makes.</small>
                </label>
              </div>
            </>
          )}

          {step === 1 && (
            <div className="ks-panel">
              {ACCOUNT_AGENTS.map((agent) => (
                <div key={agent.id} className="ks-row">
                  <span className="ks-row-logo"><ProviderLogo id={agent.id} size={18} /></span>
                  <span className="ks-row-main">
                    <span className="ks-row-name">{agent.label}</span>
                    <span className="ks-row-detail">Uses this Mac’s login for now</span>
                  </span>
                </div>
              ))}
              <p className="ks-hint">Switching a space will swap these logins — never while one of those agents is running.</p>
            </div>
          )}

          {step === 2 && (
            <div className="ks-panel">
              {folders.map((folder) => (
                <div key={folder} className="ks-row">
                  <span className="ks-row-main">
                    <span className="ks-row-name">{folder.replace(/^\/Users\/[^/]+/, "~")}</span>
                    <span className="ks-row-detail">Projects here open in this space</span>
                  </span>
                  <button type="button" className="ks-link" onClick={() => setFolders(folders.filter((f) => f !== folder))}>Remove</button>
                </div>
              ))}
              <div className="ks-row">
                <button type="button" className="ks-link" onClick={() => void addFolder()}>Add folder…</button>
              </div>
            </div>
          )}

          <button type="submit" className="ks-primary">{step < 2 ? "Continue" : "Create space"}</button>
          <p className="ks-alt">
            {step > 0 ? (
              <button type="button" className="ks-alt-link" onClick={() => setStep(step - 1)}>Back</button>
            ) : (
              <>Already set up? <button type="button" className="ks-alt-link" onClick={onCancel}>Choose a space</button></>
            )}
          </p>
        </form>
      </div>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
