export type ThemeId =
  | "klide-light"
  | "cursor-dark"
  | "vscode-dark"
  | "github-light"
  | "solarized-dark";

export type ThemeMeta = {
  id: ThemeId;
  name: string;
  description: string;
  isDark: boolean;
  swatches: string[];
};

export const THEMES: ThemeMeta[] = [
  {
    id: "klide-light",
    name: "Klide Light",
    description: "Warm, quiet, and low-contrast for daylight work.",
    isDark: false,
    swatches: ["#f7f4ed", "#fcfbf8", "#5A7B4C", "#1c1c1c"],
  },
  {
    id: "cursor-dark",
    name: "Midnight",
    description: "Soft black surfaces with a blue-violet assistant accent.",
    isDark: true,
    swatches: ["#11110F", "#1B1B18", "#8EA2FF", "#C8C6BE"],
  },
  {
    id: "vscode-dark",
    name: "VS Code Dark",
    description: "Classic editor contrast with familiar blue selection.",
    isDark: true,
    swatches: ["#1E1E1E", "#252526", "#007ACC", "#CCCCCC"],
  },
  {
    id: "github-light",
    name: "GitHub Light",
    description: "Clean white workspace with crisp blue UI states.",
    isDark: false,
    swatches: ["#FFFFFF", "#F6F8FA", "#0969DA", "#24292F"],
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    description: "Muted blue-green terminal energy for long sessions.",
    isDark: true,
    swatches: ["#002B36", "#073642", "#B58900", "#93A1A1"],
  },
];

export function getThemeMeta(id: ThemeId): ThemeMeta {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

// The 16 ANSI colors xterm.js uses to render program output (ls, git, prompts,
// etc.) plus the text-selection highlight. background/foreground/cursor stay in
// tokens.css so the panel chrome and the terminal surface never drift; this map
// only covers the ANSI palette, which nothing else in the app needs.
export type TerminalAnsi = {
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

const TERMINAL_ANSI: Record<ThemeId, TerminalAnsi> = {
  // Muted + warm to match Klide Light's "quiet, low-contrast" brief — earthy
  // brick/olive/denim rather than primary red/green/blue, so program output
  // sits calmly on the cream surface instead of fighting it.
  "klide-light": {
    selectionBackground: "#E2E0D8",
    black: "#403E3A",
    red: "#A8514A",
    green: "#6A7B45",
    yellow: "#9A7A33",
    blue: "#4E6CA8",
    magenta: "#8A5F9E",
    cyan: "#3F8389",
    white: "#6E6C66",
    brightBlack: "#94918A",
    brightRed: "#BC6258",
    brightGreen: "#7E9158",
    brightYellow: "#AE8B41",
    brightBlue: "#6280BC",
    brightMagenta: "#9C75AE",
    brightCyan: "#52969C",
    brightWhite: "#3A3833",
  },
  "cursor-dark": {
    selectionBackground: "#303A64",
    black: "#2A2824",
    red: "#E67C73",
    green: "#8EC07C",
    yellow: "#DFA56B",
    blue: "#8EA2FF",
    magenta: "#C6A0F6",
    cyan: "#88C0D0",
    white: "#C8C6BE",
    brightBlack: "#65635D",
    brightRed: "#F09487",
    brightGreen: "#A3D295",
    brightYellow: "#EAB987",
    brightBlue: "#A6B6FF",
    brightMagenta: "#D4B8F9",
    brightCyan: "#9FD0DE",
    brightWhite: "#ECEAE1",
  },
  "vscode-dark": {
    selectionBackground: "#264F78",
    black: "#2A2A2A",
    red: "#CD3131",
    green: "#0DBC79",
    yellow: "#E5E510",
    blue: "#2472C8",
    magenta: "#BC3FBC",
    cyan: "#11A8CD",
    white: "#E5E5E5",
    brightBlack: "#666666",
    brightRed: "#F14C4C",
    brightGreen: "#23D18B",
    brightYellow: "#F5F543",
    brightBlue: "#3B8EEA",
    brightMagenta: "#D670D6",
    brightCyan: "#29B8DB",
    brightWhite: "#F5F5F5",
  },
  "github-light": {
    selectionBackground: "#B6E3FF",
    black: "#24292E",
    red: "#D73A49",
    green: "#1A7F37",
    yellow: "#9A6700",
    blue: "#0969DA",
    magenta: "#8250DF",
    cyan: "#0598BC",
    white: "#6A737D",
    brightBlack: "#959DA5",
    brightRed: "#CB2431",
    brightGreen: "#22863A",
    brightYellow: "#B08800",
    brightBlue: "#005CC5",
    brightMagenta: "#5A32A3",
    brightCyan: "#3192AA",
    brightWhite: "#24292F",
  },
  // Canonical Solarized palette.
  "solarized-dark": {
    selectionBackground: "#164B55",
    black: "#073642",
    red: "#DC322F",
    green: "#859900",
    yellow: "#B58900",
    blue: "#268BD2",
    magenta: "#D33682",
    cyan: "#2AA198",
    white: "#EEE8D5",
    brightBlack: "#002B36",
    brightRed: "#CB4B16",
    brightGreen: "#586E75",
    brightYellow: "#657B83",
    brightBlue: "#839496",
    brightMagenta: "#6C71C4",
    brightCyan: "#93A1A1",
    brightWhite: "#FDF6E3",
  },
};

export function getTerminalAnsi(id: ThemeId): TerminalAnsi {
  return TERMINAL_ANSI[id] ?? TERMINAL_ANSI["klide-light"];
}

export function normalizeThemeId(value: string | null): ThemeId {
  if (value === "light") return "klide-light";
  if (value === "dark") return "cursor-dark";
  return THEMES.some((theme) => theme.id === value)
    ? (value as ThemeId)
    : "klide-light";
}

export function getNextThemeId(id: ThemeId): ThemeId {
  const index = THEMES.findIndex((theme) => theme.id === id);
  return THEMES[(index + 1) % THEMES.length].id;
}

export const MONACO_THEME_IDS: Record<ThemeId, string> = {
  "klide-light": "klide-monaco-light",
  "cursor-dark": "klide-monaco-midnight",
  "vscode-dark": "klide-monaco-vscode-dark",
  "github-light": "klide-monaco-github-light",
  "solarized-dark": "klide-monaco-solarized-dark",
};

type DiagnosticsDefaultsLike = {
  setDiagnosticsOptions: (options: {
    noSemanticValidation?: boolean;
    noSyntaxValidation?: boolean;
  }) => void;
};

type MonacoLike = {
  editor: {
    defineTheme: (themeName: string, themeData: any) => void;
  };
  languages?: {
    typescript?: {
      typescriptDefaults?: DiagnosticsDefaultsLike;
      javascriptDefaults?: DiagnosticsDefaultsLike;
    };
  };
};

/** Standalone Monaco runs its TS worker with no project context — it can't
 *  see node_modules or tsconfig.json, so semantic validation flags every
 *  import with "Cannot find module" (the red underlines). Real resolution
 *  needs a tsserver, which the webview doesn't run; until Klide has an LSP
 *  story we keep syntax errors and drop semantic validation. */
export function configureMonacoDiagnostics(monaco: MonacoLike) {
  const ts = monaco.languages?.typescript;
  for (const defaults of [ts?.typescriptDefaults, ts?.javascriptDefaults]) {
    defaults?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  }
}

/** The one `beforeMount` every Monaco surface should use: themes + language
 *  diagnostics config. */
export function prepareMonaco(monaco: MonacoLike) {
  defineKlideMonacoThemes(monaco);
  configureMonacoDiagnostics(monaco);
}

let monacoThemesDefined = false;

export function getMonacoThemeId(id: ThemeId): string {
  return MONACO_THEME_IDS[id];
}

export function defineKlideMonacoThemes(monaco: MonacoLike) {
  if (monacoThemesDefined) return;

  const sharedRules = [
    { token: "comment", foreground: "7A7A76", fontStyle: "italic" },
    { token: "keyword", foreground: "4263EB" },
    { token: "string", foreground: "0F7B6C" },
    { token: "number", foreground: "B56300" },
    { token: "type", foreground: "7C5CDA" },
    { token: "function", foreground: "0969DA" },
    { token: "variable", foreground: "555552" },
  ];

  const themes: Record<ThemeId, any> = {
    "klide-light": {
      base: "vs",
      inherit: true,
      rules: sharedRules,
      colors: {
        "editor.background": "#fcfbf8",
        "editor.foreground": "#555552",
        "editorLineNumber.foreground": "#A1A19B",
        "editorLineNumber.activeForeground": "#555552",
        "editorCursor.foreground": "#5A7B4C",
        "editor.selectionBackground": "#D4D9CA",
        "editor.inactiveSelectionBackground": "#E4E5D9",
        "editor.lineHighlightBackground": "#F4F4F2",
        "editorGutter.background": "#fcfbf8",
        "editorIndentGuide.background1": "#E8E7E3",
        "editorIndentGuide.activeBackground1": "#D9D8D2",
      },
    },
    "cursor-dark": {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "65635D", fontStyle: "italic" },
        { token: "keyword", foreground: "8EA2FF" },
        { token: "string", foreground: "8EC07C" },
        { token: "number", foreground: "DFA56B" },
        { token: "type", foreground: "C6A0F6" },
        { token: "function", foreground: "A6C8FF" },
        { token: "variable", foreground: "C8C6BE" },
      ],
      colors: {
        "editor.background": "#11110F",
        "editor.foreground": "#C8C6BE",
        "editorLineNumber.foreground": "#65635D",
        "editorLineNumber.activeForeground": "#C8C6BE",
        "editorCursor.foreground": "#8EA2FF",
        "editor.selectionBackground": "#303A64",
        "editor.inactiveSelectionBackground": "#242B45",
        "editor.lineHighlightBackground": "#171715",
        "editorGutter.background": "#11110F",
        "editorIndentGuide.background1": "#292824",
        "editorIndentGuide.activeBackground1": "#36342F",
      },
    },
    "vscode-dark": {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6A9955", fontStyle: "italic" },
        { token: "keyword", foreground: "569CD6" },
        { token: "string", foreground: "CE9178" },
        { token: "number", foreground: "B5CEA8" },
        { token: "type", foreground: "4EC9B0" },
        { token: "function", foreground: "DCDCAA" },
        { token: "variable", foreground: "9CDCFE" },
      ],
      colors: {
        "editor.background": "#1E1E1E",
        "editor.foreground": "#CCCCCC",
        "editorLineNumber.foreground": "#858585",
        "editorLineNumber.activeForeground": "#C6C6C6",
        "editorCursor.foreground": "#AEAFAD",
        "editor.selectionBackground": "#264F78",
        "editor.inactiveSelectionBackground": "#3A3D41",
        "editor.lineHighlightBackground": "#2A2D2E",
        "editorGutter.background": "#1E1E1E",
        "editorIndentGuide.background1": "#404040",
        "editorIndentGuide.activeBackground1": "#707070",
      },
    },
    "github-light": {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6A737D", fontStyle: "italic" },
        { token: "keyword", foreground: "D73A49" },
        { token: "string", foreground: "032F62" },
        { token: "number", foreground: "005CC5" },
        { token: "type", foreground: "6F42C1" },
        { token: "function", foreground: "6F42C1" },
        { token: "variable", foreground: "24292F" },
      ],
      colors: {
        "editor.background": "#FFFFFF",
        "editor.foreground": "#24292F",
        "editorLineNumber.foreground": "#8C959F",
        "editorLineNumber.activeForeground": "#24292F",
        "editorCursor.foreground": "#0969DA",
        "editor.selectionBackground": "#B6E3FF",
        "editor.inactiveSelectionBackground": "#DDF4FF",
        "editor.lineHighlightBackground": "#F6F8FA",
        "editorGutter.background": "#FFFFFF",
        "editorIndentGuide.background1": "#D8DEE4",
        "editorIndentGuide.activeBackground1": "#C9D1D9",
      },
    },
    "solarized-dark": {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "657B83", fontStyle: "italic" },
        { token: "keyword", foreground: "859900" },
        { token: "string", foreground: "2AA198" },
        { token: "number", foreground: "D33682" },
        { token: "type", foreground: "B58900" },
        { token: "function", foreground: "268BD2" },
        { token: "variable", foreground: "EEE8D5" },
      ],
      colors: {
        "editor.background": "#002B36",
        "editor.foreground": "#EEE8D5",
        "editorLineNumber.foreground": "#657B83",
        "editorLineNumber.activeForeground": "#93A1A1",
        "editorCursor.foreground": "#B58900",
        "editor.selectionBackground": "#164B55",
        "editor.inactiveSelectionBackground": "#073642",
        "editor.lineHighlightBackground": "#073642",
        "editorGutter.background": "#002B36",
        "editorIndentGuide.background1": "#174652",
        "editorIndentGuide.activeBackground1": "#315D66",
      },
    },
  };

  for (const theme of THEMES) {
    monaco.editor.defineTheme(MONACO_THEME_IDS[theme.id], themes[theme.id]);
  }
  monacoThemesDefined = true;
}
