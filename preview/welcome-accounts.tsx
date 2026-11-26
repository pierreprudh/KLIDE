// Draft: Welcome as an account chooser (work / personal).
//
// First launch walks three steps on the right while the film card on the left
// shows where you are. After that the film card keeps its place and carries
// the accounts — pick one, or "+ Add account" to walk the steps again. The
// right side is then that account's Welcome: actions + its own recents.
//
//   http://localhost:1420/preview/welcome-accounts.html?state=setup|home&theme=klide-light|dark
import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "../src/styles/tokens.css";
import { PixelNature } from "../src/components/PixelNature";
import { KlideMark, ProviderLogo } from "../src/components/ai/icons";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "klide-light";

type Account = { id: string; name: string; who: string; github: string; folders: string[]; recents: string[] };

const SEED: Account[] = [
  {
    id: "personal",
    name: "Personal",
    who: "Pierre",
    github: "pierreprudh",
    folders: ["~/Documents/Private"],
    recents: ["~/Documents/Private/KIDE", "~/Documents/Private/notes", "~/Documents/Private/site"],
  },
  {
    id: "work",
    name: "Work",
    who: "Pierre",
    github: "pierre-work",
    folders: ["~/Work"],
    recents: ["~/Work/platform-api", "~/Work/dashboard"],
  },
];

// ?accounts=1|2|3|4 — how many people the selector shows.
const COUNT = Number(params.get("accounts") ?? 2);
const EXTRA: Account[] = [
  { id: "client", name: "Client", who: "Pierre", github: "pierre-client", folders: ["~/Clients"], recents: ["~/Clients/acme-site"] },
  { id: "oss", name: "Open source", who: "Pierre", github: "pierreprudh", folders: ["~/oss"], recents: ["~/oss/klide-skills"] },
];

const STEPS = ["Create your account", "Connect your agents", "Choose your folders"];
const STEP_COPY = [
  { title: "Create your account", sub: "Who is this account for? Klide keeps it on this Mac." },
  { title: "Connect your agents", sub: "Use the logins your tools already have." },
  { title: "Choose your folders", sub: "Projects in these folders open in this account." },
];

function App() {
  const [accounts, setAccounts] = useState<Account[]>(params.get("state") === "setup" ? [] : [...SEED, ...EXTRA].slice(0, COUNT));
  const [active, setActive] = useState(accounts[0]?.id ?? "");
  const [adding, setAdding] = useState(accounts.length === 0);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState({ name: "", who: "Pierre" });

  const current = accounts.find((a) => a.id === active);
  const first = accounts.length === 0;

  function finish() {
    const id = draft.name.toLowerCase().replace(/\W+/g, "-") || "account";
    const made: Account = {
      id,
      name: draft.name || "Personal",
      who: draft.who,
      github: "pierreprudh",
      folders: ["~/Documents/Private"],
      recents: [],
    };
    setAccounts((list) => [...list, made]);
    setActive(id);
    setAdding(false);
    setStep(0);
    setDraft({ name: "", who: "Pierre" });
  }

  if (!adding && current) {
    return (
      <HomeLayout
        accounts={accounts}
        active={active}
        onPick={setActive}
        onAdd={() => setAdding(true)}
      />
    );
  }

  return (
    <div className="klide-welcome wa" style={{ height: "100vh", display: "flex", background: "var(--bg-elevated)" }}>
      {/* ── Left: the film card. Steps on first run, accounts afterwards. ── */}
      <div className="wa-stage">
        <div className="klide-welcome-card is-nature">
          <PixelNature className="klide-nature-canvas" />
          <div className="wa-veil" />
          <div className="wa-overlay">
            <div className="wa-mark"><KlideMark size={16} /> Klide</div>
            {adding ? (
              <>
                <div className="wa-head">
                  <h1 className="wa-title">{first ? <>Get started<br />with Klide</> : <>Add an<br />account</>}</h1>
                  <p className="wa-sub">
                    Each account keeps its own GitHub, agent logins and projects.
                  </p>
                </div>
                <div className="wa-cards">
                  {STEPS.map((label, i) => (
                    <button
                      key={label}
                      type="button"
                      className="wa-card"
                      data-on={i === step || undefined}
                      data-done={i < step || undefined}
                      onClick={() => i < step && setStep(i)}
                    >
                      <span className="wa-num">{i < step ? "✓" : i + 1}</span>
                      <span className="wa-card-label">{label}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h1 className="wa-title">Welcome back</h1>
                <p className="wa-sub">Choose who you are working as.</p>
                <div className="wa-cards">
                  {accounts.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="wa-card"
                      data-on={a.id === active || undefined}
                      onClick={() => setActive(a.id)}
                    >
                      <span className="wa-avatar">{a.name[0]}</span>
                      <span className="wa-card-label">
                        {a.name}
                        <span className="wa-card-detail">@{a.github}</span>
                      </span>
                    </button>
                  ))}
                  <button type="button" className="wa-card wa-card-add" onClick={() => setAdding(true)}>
                    <span className="wa-num">+</span>
                    <span className="wa-card-label">Add account</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Right: the step's form, or the chosen account's Welcome. ── */}
      <div className="klide-welcome-pane">
        <div className="wa-right">
          {adding ? (
            <SetupStep
              step={step}
              draft={draft}
              setDraft={setDraft}
              onBack={step > 0 ? () => setStep(step - 1) : undefined}
              onCancel={first ? undefined : () => setAdding(false)}
              onNext={() => (step < 2 ? setStep(step + 1) : finish())}
            />
          ) : current ? (
            <AccountHome account={current} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* Returning: the film on the left, who's working on the right (?film=right puts it back). */
const FILM_RIGHT = params.get("film") === "right";

function HomeLayout({
  accounts,
  active,
  onPick,
  onAdd,
}: {
  accounts: Account[];
  active: string;
  onPick: (id: string) => void;
  onAdd: () => void;
}) {
  // Roving focus over the circles: accounts first, then "+".
  const slots = accounts.length + 1;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusIx, setFocusIx] = useState(() => Math.max(0, accounts.findIndex((a) => a.id === active)));
  const [opening, setOpening] = useState<Account | null>(null);

  function open(a: Account) {
    onPick(a.id);
    setOpening(a);
    window.setTimeout(() => setOpening(null), 1600); // preview only: the app would enter here
  }

  function move(to: number) {
    const ix = (to + slots) % slots;
    setFocusIx(ix);
    refs.current[ix]?.focus();
    if (ix < accounts.length) onPick(accounts[ix].id);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (opening) return;
      // Physical keys (e.code), so ⌘1 works on AZERTY too.
      if (e.metaKey && /^Digit[1-9]$/.test(e.code)) {
        const a = accounts[Number(e.code.slice(5)) - 1];
        if (a) { e.preventDefault(); open(a); }
        return;
      }
      if (e.metaKey && e.code === "KeyN") { e.preventDefault(); onAdd(); return; }
      if (e.metaKey && e.code === "Comma") { e.preventDefault(); return; }
      if (e.metaKey || e.altKey || e.ctrlKey) return;
      const cols = 3;
      if (e.key === "ArrowRight") { e.preventDefault(); move(focusIx + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); move(focusIx - 1); }
      else if (e.key === "ArrowDown" && focusIx + cols < slots) { e.preventDefault(); move(focusIx + cols); }
      else if (e.key === "ArrowUp" && focusIx - cols >= 0) { e.preventDefault(); move(focusIx - cols); }
      else if (e.key === "Enter" && document.activeElement === document.body) {
        e.preventDefault();
        if (focusIx < accounts.length) open(accounts[focusIx]); else onAdd();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stage = (
    <div className={`klide-welcome-stage ${FILM_RIGHT ? "" : "wh-stage-left"}`}>
      <div className="klide-welcome-card is-nature">
        <PixelNature className="klide-nature-canvas" />
      </div>
    </div>
  );

  return (
    <div className="klide-welcome klide-welcome--split" style={{ height: "100vh", background: "var(--bg-elevated)" }}>
      {!FILM_RIGHT && stage}
      <div className="klide-welcome-pane wh-pane">
        <div className="wh" data-opening={opening ? true : undefined}>
          <div className="wh-mark" role="img" aria-label="Klide" />
          <h1 className="klide-welcome-title wh-title">Choose your space</h1>

          <div className="wh-people" role="radiogroup" aria-label="Accounts" data-two-rows={accounts.length >= 3 || undefined}>
            {accounts.map((a, i) => (
              <button
                key={a.id}
                ref={(el) => { refs.current[i] = el; }}
                type="button"
                role="radio"
                aria-checked={a.id === active}
                aria-keyshortcuts={i < 9 ? `Meta+${i + 1}` : undefined}
                tabIndex={i === focusIx ? 0 : -1}
                className="wh-person"
                data-on={a.id === active || undefined}
                onFocus={() => setFocusIx(i)}
                onClick={() => open(a)}
              >
                <Face account={a} />
                <span className="wh-name">{a.name}</span>
                <span className="wh-detail">@{a.github}</span>
              </button>
            ))}
            <button
              ref={(el) => { refs.current[accounts.length] = el; }}
              type="button"
              className="wh-person"
              tabIndex={focusIx === accounts.length ? 0 : -1}
              aria-keyshortcuts="Meta+N"
              onFocus={() => setFocusIx(accounts.length)}
              onClick={onAdd}
            >
              <span className="wh-face wh-face-add" aria-hidden>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              </span>
              <span className="wh-name">Add account</span>
              <span className="wh-detail">&nbsp;</span>
            </button>
          </div>

          <p className="wh-status" aria-live="polite">
            {opening ? <>Opening {opening.name}…</> : null}
          </p>

        </div>
        <footer className="wh-foot">
          <button type="button" className="wh-settings" aria-keyshortcuts="Meta+Comma">
            <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" aria-hidden><path d="M128 80a48 48 0 1 0 48 48 48.05 48.05 0 0 0-48-48Zm0 88a40 40 0 1 1 40-40 40 40 0 0 1-40 40Zm109.94-52.79a4 4 0 0 0-1.89-2.68l-30.46-17.36-.12-34.33a4 4 0 0 0-1.41-3 108 108 0 0 0-35.06-19.74 4 4 0 0 0-3.27.31L128 31.82 95.27 13.4a4 4 0 0 0-3.27-.31 108 108 0 0 0-35.06 19.76 4 4 0 0 0-1.41 3l-.12 34.33-30.46 17.35a4 4 0 0 0-1.89 2.68 102.25 102.25 0 0 0 0 39.58 4 4 0 0 0 1.89 2.68l30.46 17.36.12 34.33a4 4 0 0 0 1.41 3 108 108 0 0 0 35.06 19.76 4 4 0 0 0 3.27-.31L128 224.18l32.73 18.42a4 4 0 0 0 3.27.31 108 108 0 0 0 35.06-19.76 4 4 0 0 0 1.41-3l.12-34.33 30.46-17.35a4 4 0 0 0 1.89-2.68 102.25 102.25 0 0 0 0-39.58Zm-7.65 36.35-31.39 17.86a4 4 0 0 0-1.53 1.54c-.61 1.08-1.26 2.17-1.92 3.22a4 4 0 0 0-.62 2.13l-.12 35.46a100.06 100.06 0 0 1-30 16.92l-33.7-18.94a4 4 0 0 0-2-.51h-3.85a4 4 0 0 0-2.08.52l-33.75 18.94a100.27 100.27 0 0 1-30.06-16.89l-.12-35.39a4 4 0 0 0-.62-2.13c-.66-1.05-1.31-2.14-1.91-3.22a4 4 0 0 0-1.54-1.54L25.71 151.56a94.43 94.43 0 0 1 0-31.12l31.39-17.86a4 4 0 0 0 1.53-1.54c.61-1.08 1.26-2.17 1.92-3.22a4 4 0 0 0 .62-2.13l.12-35.46a100.06 100.06 0 0 1 30-16.92l33.7 18.94a4 4 0 0 0 2.08.51h3.85a4 4 0 0 0 2.08-.52l33.75-18.94a100.27 100.27 0 0 1 30.06 16.89l.12 35.39a4 4 0 0 0 .62 2.13c.66 1.05 1.31 2.14 1.91 3.22a4 4 0 0 0 1.54 1.54l31.39 17.86a94.43 94.43 0 0 1 .01 31.12Z"/></svg>
            Settings
          </button>
          <span className="wh-keys">
            <kbd className="klide-welcome-kbd">←</kbd><kbd className="klide-welcome-kbd">→</kbd> choose
          </span>
        </footer>
      </div>
      {FILM_RIGHT && stage}
    </div>
  );
}

/** The GitHub picture when the login has one; the initial otherwise. */
function Face({ account }: { account: Account }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="wh-face">
      {failed ? (
        account.name[0]
      ) : (
        <img
          className="wh-face-img"
          src={`https://github.com/${account.github}.png?size=272`}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function SetupStep({
  step,
  draft,
  setDraft,
  onBack,
  onCancel,
  onNext,
}: {
  step: number;
  draft: { name: string; who: string };
  setDraft: (d: { name: string; who: string }) => void;
  onBack?: () => void;
  onCancel?: () => void;
  onNext: () => void;
}) {
  return (
    <div className="wa-form">
      <header className="wa-form-head">
        <h2 className="wa-h2">{STEP_COPY[step].title}</h2>
        <p className="wa-lede">{STEP_COPY[step].sub}</p>
      </header>

      {step === 0 && (
        <>
          <button type="button" className="wa-oauth">
            <GitHubMark /> Continue with GitHub
          </button>
          <div className="wa-or"><span>Or</span></div>
          <div className="wa-group">
            <div className="wa-pair">
              <label className="wa-field">
                <span>Account name</span>
                <input
                  autoFocus
                  className="wa-input"
                  placeholder="eg. Work"
                  autoComplete="off"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="wa-field">
                <span>Your name</span>
                <input
                  className="wa-input"
                  placeholder="eg. Pierre"
                  autoComplete="off"
                  value={draft.who}
                  onChange={(e) => setDraft({ ...draft, who: e.target.value })}
                />
              </label>
            </div>
            <label className="wa-field">
              <span>Email</span>
              <input className="wa-input" type="email" autoComplete="off" placeholder="eg. pierre@company.com" />
              <small>Used on the commits this account makes.</small>
            </label>
          </div>
        </>
      )}

      {step === 1 && (
        <div className="wa-panel">
          <Login logo={<GitHubMark />} name="GitHub" state="pierreprudh" action="Change" />
          <Login logo={<ProviderLogo id="claude-code" size={18} />} name="Claude Code" state="pierre@…  ·  Max" action="Use this login" />
          <Login logo={<ProviderLogo id="codex" size={18} />} name="Codex" state="Signed in · Plus" action="Use this login" />
          <Login logo={<ProviderLogo id="opencode" size={18} />} name="OpenCode" state="Not signed in" action="Sign in" />
          <p className="wa-hint">
            Switching accounts swaps these logins — never while one of those agents is running.
          </p>
        </div>
      )}

      {step === 2 && (
        <div className="wa-panel">
          <div className="wa-row">
            <span className="wa-row-main">
              <span className="wa-row-name">~/Work</span>
              <span className="wa-row-detail">Projects here open in this account</span>
            </span>
            <button type="button" className="wa-link">Remove</button>
          </div>
          <div className="wa-row">
            <button type="button" className="wa-link">Add folder…</button>
          </div>
        </div>
      )}

      <button type="button" className="wa-primary" onClick={onNext}>
        {step < 2 ? "Continue" : "Create account"}
      </button>
      <p className="wa-alt">
        {onBack ? (
          <button type="button" className="wa-alt-link" onClick={onBack}>Back</button>
        ) : onCancel ? (
          <>Already set up? <button type="button" className="wa-alt-link" onClick={onCancel}>Choose an account</button></>
        ) : (
          <>You can add a second account later.</>
        )}
      </p>
    </div>
  );
}

function Login({ logo, name, state, action }: { logo: React.ReactNode; name: string; state: string; action: string }) {
  return (
    <div className="wa-row">
      <span className="wa-row-logo">{logo}</span>
      <span className="wa-row-main">
        <span className="wa-row-name">{name}</span>
        <span className="wa-row-detail">{state}</span>
      </span>
      <button type="button" className="wa-link">{action}</button>
    </div>
  );
}

function AccountHome({ account }: { account: Account }) {
  return (
    <>
      <div className="wa-step">{account.name} · @{account.github}</div>
      <h2 className="wa-h2">Open a project</h2>
      <div className="wa-actions">
        <button type="button" className="klide-welcome-glass-btn" data-primary="true">
          Open folder <kbd className="klide-welcome-kbd" style={{ marginLeft: "auto" }}>⌘O</kbd>
        </button>
        <button type="button" className="klide-welcome-glass-btn">
          New project <kbd className="klide-welcome-kbd" style={{ marginLeft: "auto" }}>⌘N</kbd>
        </button>
        <button type="button" className="klide-welcome-glass-btn">
          Clone <kbd className="klide-welcome-kbd" style={{ marginLeft: "auto" }}>⌘⇧N</kbd>
        </button>
        <button type="button" className="klide-welcome-glass-btn" data-quiet="true">Account settings</button>
      </div>
      <div className="klide-welcome-rlabel" style={{ marginTop: 40 }}>
        Recent <span className="line" />
      </div>
      {account.recents.length === 0 ? (
        <p className="wa-hint">Nothing opened in this account yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {account.recents.map((p, i) => (
            <div key={p} className="klide-welcome-rrow">
              <span className="klide-welcome-rrow-index">{String(i + 1).padStart(2, "0")}</span>
              <span className="klide-welcome-rrow-name">{p.split("/").pop()}</span>
              <span className="klide-welcome-rrow-path">{p.split("/").slice(0, -1).join("/")}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const css = `
.wa-stage { flex: 1.1 1 0; min-width: 0; display: flex; padding: clamp(20px, 2.4vw, 40px); padding-right: 0; }
.wa-veil { position: absolute; inset: 0; background: linear-gradient(180deg, transparent 35%, rgba(8,10,12,.62) 100%); pointer-events: none; }
.wa-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: flex-end; padding: clamp(24px, 3vw, 44px); color: #fff; }
.wa-mark { position: absolute; top: clamp(24px, 3vw, 40px); left: clamp(24px, 3vw, 44px); display: flex; gap: 8px; align-items: center;
  font-family: var(--font-brand); font-size: 12px; letter-spacing: .18em; text-transform: uppercase; color: rgba(255,255,255,.8); }
.wa-head { display: grid; grid-template-columns: auto 1fr; gap: 32px; align-items: center; }
.wa-head .wa-sub { margin: 0; justify-self: end; max-width: 28ch; font-size: 15px; }
.wa-title { margin: 0; font-size: clamp(36px, 4vw, 56px); line-height: 1.04; font-weight: 600; letter-spacing: -0.04em; }
.wa-sub { margin: 12px 0 0; max-width: 42ch; font-size: 14px; line-height: 1.55; color: rgba(255,255,255,.72); }
.wa-cards { margin-top: 40px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.wa-card { all: unset; box-sizing: border-box; cursor: pointer; min-height: 168px; padding: 22px; border-radius: 22px;
  display: flex; flex-direction: column; justify-content: space-between; gap: 18px;
  background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.14); color: rgba(255,255,255,.86);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
.wa-card:hover { background: rgba(255,255,255,.18); }
.wa-card[data-on] { background: #fff; color: #16181b; border-color: #fff; }
.wa-card:focus-visible { box-shadow: 0 0 0 3px rgba(255,255,255,.5); }
.wa-card-add { border-style: dashed; background: rgba(255,255,255,.06); }
.wa-num, .wa-avatar { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 600;
  background: rgba(255,255,255,.18); color: #fff; }
.wa-card[data-on] .wa-num, .wa-card[data-on] .wa-avatar { background: #16181b; color: #fff; }
.wa-avatar { font-size: 13px; }
.wa-card-label { font-size: 18px; font-weight: 500; line-height: 1.3; letter-spacing: -0.01em; display: flex; flex-direction: column; gap: 2px; }
.wa-card-detail { font-size: 12px; font-weight: 400; opacity: .62; }

.wa-form { display: flex; flex-direction: column; }
.wa-form-head { text-align: center; margin-bottom: 44px; }
.wa .wa-h2 { margin: 0; font-size: 40px; }
.wa-lede { margin: 12px 0 0; font-size: 16.5px; color: var(--w-dim); }
.wa-oauth { all: unset; box-sizing: border-box; cursor: pointer; height: 58px; border-radius: 12px; border: 1px solid var(--w-border);
  display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 16px; font-weight: 500; color: var(--w-fg); }
.wa-oauth:hover { background: var(--w-glass); border-color: var(--w-border-strong); }
.wa-or { display: flex; align-items: center; gap: 14px; margin: 30px 0; color: var(--w-dim); font-size: 14px; }
.wa-or::before, .wa-or::after { content: ""; flex: 1; height: 1px; background: var(--w-border); }
.wa-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.wa .wa-group { gap: 24px; }
.wa .wa-input { box-sizing: border-box; width: 100%; min-width: 0; height: 56px; font-size: 16px; padding: 0 16px; }
.wa .wa-field { font-size: 15px; gap: 10px; }
.wa .wa-field small { font-size: 13px; }
.wa-primary { all: unset; box-sizing: border-box; cursor: pointer; margin-top: 36px; height: 58px; border-radius: 12px; text-align: center;
  background: var(--w-fg); color: var(--w-primary-fg); font-size: 16px; font-weight: 600; line-height: 58px; }
.wa-primary:hover { background: var(--w-primary-hover); }
.wa-primary:focus-visible, .wa-oauth:focus-visible { box-shadow: 0 0 0 3px var(--w-ring); }
.wa-alt { margin: 22px 0 0; text-align: center; font-size: 15px; color: var(--w-dim); }
.wa-alt-link { all: unset; cursor: pointer; color: var(--w-fg); font-weight: 600; }
.wa-alt-link:hover { text-decoration: underline; }
.wa .wa-row { min-height: 72px; }
.wa .wa-row-name { font-size: 16px; }
.wa .wa-row-detail { font-size: 13.5px; }
.wa .wa-link { font-size: 14px; }
.wa .wa-hint { font-size: 13.5px; }
.wa-right { width: min(600px, 100%); margin: 0 auto; padding: clamp(40px, 6vh, 96px) clamp(28px, 4vw, 64px); }
.wa-step { font-size: 12px; color: var(--w-dim); letter-spacing: .01em; }
.wa-h2 { margin: 8px 0 28px; font-size: 26px; font-weight: 600; letter-spacing: -0.03em; color: var(--w-fg); }
.wa-group { display: flex; flex-direction: column; gap: 20px; }
.wa-field { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: var(--w-fg); font-weight: 500; }
.wa-field small { font-size: 12px; font-weight: 400; color: var(--w-dim); }
.wa-input { height: 42px; padding: 0 14px; border-radius: 12px; border: 1px solid var(--w-border); background: var(--w-glass);
  color: var(--w-fg); font: inherit; font-weight: 400; outline: none; }
.wa-input:focus { border-color: var(--w-border-strong); box-shadow: 0 0 0 3px var(--w-ring); }
.wa-panel { border: 1px solid var(--w-border); border-radius: 20px; padding: 6px 18px; }
.wa-row { display: flex; align-items: center; gap: 12px; min-height: 56px; border-bottom: 1px solid var(--w-border); }
.wa-row:last-of-type { border-bottom: none; }
.wa-row-logo { width: 22px; display: grid; place-items: center; color: var(--w-fg); }
.wa-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wa-row-name { font-size: 13.5px; font-weight: 500; color: var(--w-fg); }
.wa-row-detail { font-size: 12px; color: var(--w-dim); }
.wa-link { all: unset; cursor: pointer; font-size: 12.5px; font-weight: 500; color: var(--w-fg); padding: 6px 10px; border-radius: 12px; }
.wa-link:hover { background: var(--w-glass-hover); }
.wa-hint { margin: 10px 0 12px; font-size: 12px; line-height: 1.5; color: var(--w-dim); }
.wa-panel .wa-hint { border-top: 1px solid var(--w-border); padding-top: 12px; }
.wa-foot { margin-top: 32px; display: flex; justify-content: space-between; }
.wa-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.wa-actions .klide-welcome-glass-btn { width: 100%; justify-content: flex-start; }
/* One centred axis: mark, title, people, then the account's work beneath. */
.wh-pane { flex: 1.15 1 0; position: relative; padding-bottom: 12vh; box-sizing: border-box; }
/* Footer: a hairline and one row, sitting on the film card's bottom edge. */
.wh-foot { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(clamp(20px, 2.4vw, 40px) + 6vh);
  width: min(calc(3 * 148px + 2 * 36px), calc(100% - 64px)); border-top: 1px solid var(--w-border); padding-top: 14px;
  display: flex; align-items: center; justify-content: space-between; }
.wh-keys { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--w-dim); }
.wh-keys kbd + kbd { margin-left: -2px; }
/* Hover lights the hint: keys and word take the full ink. */
.wh-keys { border-radius: 12px; padding: 6px 10px; margin-right: -10px; cursor: default;
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
.wh-keys .klide-welcome-kbd { transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
.wh-keys:hover { background: var(--w-glass); color: var(--w-fg); }
.wh-keys:hover .klide-welcome-kbd { background: var(--w-fg); color: var(--w-primary-fg); }
.wh { width: min(720px, 100%); margin: 0 auto; padding: clamp(40px, 6vh, 80px) clamp(40px, 4.5vw, 80px); text-align: center; }
/* The lockup is a white-on-clear PNG used as a mask, so it wears the theme's ink. */
.wh-mark { margin: 0 auto; height: 52px; aspect-ratio: 465 / 209; background: var(--w-fg);
  -webkit-mask: url(/preview/assets/klide-lockup.png) center / contain no-repeat; mask: url(/preview/assets/klide-lockup.png) center / contain no-repeat; }
.wh .wh-title { margin-top: 32px; font-size: clamp(40px, 4.4vw, 68px); white-space: nowrap; }
/* Three per row; a short last row (the + on its own) sits centred under the row above. */
.wh-people { margin: 56px auto 0; width: calc(3 * 148px + 2 * 36px); display: flex; flex-wrap: wrap; justify-content: center; column-gap: 36px; row-gap: 28px; }
.wh-person { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 6px; width: 148px; border-radius: 24px; padding: 8px 0 10px; }
.wh-person:focus-visible { box-shadow: 0 0 0 3px var(--w-ring); }
.wh-face { width: 136px; height: 136px; border-radius: 50%; display: grid; place-items: center; margin-bottom: 10px;
  font-size: 46px; font-weight: 600; letter-spacing: -0.02em;
  background: var(--w-glass); border: 1px solid var(--w-border); color: var(--w-fg);
  transition: box-shadow var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
.wh-person:hover .wh-face { background: var(--w-glass-hover); }
/* Hover/focus: the circle grows a touch — eased, no bounce. */
.wh-face { transition: transform var(--motion-med) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out); }
.wh-person:hover .wh-face, .wh-person:focus-visible .wh-face { transform: scale(1.06); }
.wh-person:active .wh-face { transform: scale(1.02); }
@media (prefers-reduced-motion: reduce) { .wh-face { transition: none; } .wh-person:hover .wh-face, .wh-person:focus-visible .wh-face { transform: none; } }
.wh-person[data-on] .wh-face { background: var(--w-fg); color: var(--w-primary-fg); border-color: var(--w-fg);
  box-shadow: 0 0 0 5px var(--bg-elevated), 0 0 0 6px var(--w-border-strong); }
/* A second row (3+ accounts, + underneath): smaller circles so the page still fits. */
.wh-people[data-two-rows] { margin: 40px auto 0; width: calc(3 * 128px + 2 * 36px); row-gap: 20px; }
.wh-people[data-two-rows] .wh-person { width: 128px; padding: 4px 0 6px; }
.wh-people[data-two-rows] .wh-face { width: 104px; height: 104px; font-size: 36px; margin-bottom: 6px; }
.wh-people[data-two-rows] .wh-face-add svg { width: 32px; height: 32px; }
.wh-people[data-two-rows] + .wh-rule { margin: 36px 0 24px; }
.wh-people[data-two-rows] ~ .wh-recents .klide-welcome-rrow { height: 44px; }
.wh-face-add { background: transparent; border-style: dashed; color: var(--w-dim); }
.wh-face-add svg { width: 40px; height: 40px; }
.wh-name { font-size: 17px; font-weight: 500; color: var(--w-fg); }
.wh-person:not([data-on]) .wh-name { color: var(--w-dim); }
.wh-detail { font-size: 13px; color: var(--w-dim); }
.wh-rule { height: 1px; background: var(--w-border); margin: 52px 0 32px; }
.wh-recents { display: flex; flex-direction: column; gap: 6px; text-align: left; }
.wh-recents .klide-welcome-rrow { height: 52px; }
.wh-recents .klide-welcome-rrow-name { font-size: 15px; }
.wh-recents .klide-welcome-rrow-path { font-size: 12.5px; }
.wh-stage-left { padding-left: clamp(20px, 2.4vw, 40px); padding-right: 0; }
.wh-face { overflow: hidden; position: relative; }
.wh-face-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wh-person[data-on] .wh-face:has(.wh-face-img) { background: var(--w-glass); }
.wh-person:not([data-on]) .wh-face-img { filter: saturate(.6); opacity: .82; }
.wh-status { margin: 24px 0 0; font-size: 14px; color: var(--w-dim); min-height: 20px; }
.wh[data-opening] .wh-person:not([data-on]) { opacity: .35; transition: opacity var(--motion-med) var(--ease-out); }
.wh[data-opening] .wh-status { color: var(--w-fg); }
.wh-settings .klide-welcome-kbd { margin-left: 4px; }
.wh-settings { all: unset; cursor: pointer; margin-left: -14px; display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-radius: 12px; font-size: 14px; color: var(--w-dim); }
.wh-settings:hover { background: var(--w-glass); color: var(--w-fg); }
.wh-settings:focus-visible { box-shadow: 0 0 0 3px var(--w-ring); }
.wh-buttons { margin-top: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.wh-buttons .klide-welcome-glass-btn { width: 100%; justify-content: flex-start; height: 52px; font-size: 15px; padding: 0 20px; border-radius: 12px; }
@media (max-width: 880px) {
  .wa { flex-direction: column; overflow-y: auto; }
  .wa-stage { flex: 0 0 auto; min-height: 420px; padding: 16px 16px 0; }
  .wa-cards { grid-template-columns: 1fr 1fr; }
}
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
