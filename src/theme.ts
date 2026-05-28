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
    swatches: ["#FBFBFA", "#F4F4F2", "#4263EB", "#555552"],
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

type MonacoLike = {
  editor: {
    defineTheme: (themeName: string, themeData: any) => void;
  };
};

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
        "editor.background": "#FBFBFA",
        "editor.foreground": "#555552",
        "editorLineNumber.foreground": "#A1A19B",
        "editorLineNumber.activeForeground": "#555552",
        "editorCursor.foreground": "#4263EB",
        "editor.selectionBackground": "#DCE3FF",
        "editor.inactiveSelectionBackground": "#EAEDFA",
        "editor.lineHighlightBackground": "#F4F4F2",
        "editorGutter.background": "#FBFBFA",
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
