// Settings section icons — thin stroke glyphs for the section nav.
// Extracted from SettingsPanel.tsx.

import { type ReactNode } from "react";

export function IconBase({ children }: { children: ReactNode }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function ArrowLeftIcon() {
  return (
    <IconBase>
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </IconBase>
  );
}

export function SearchIcon() {
  return (
    <IconBase>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-3.6-3.6" />
    </IconBase>
  );
}

export function GearIcon() {
  return (
    <IconBase>
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
      <path d="M19.4 15a1.8 1.8 0 0 0 .4 2l.1.1-2 3.4-.2-.1a1.8 1.8 0 0 0-2 .4l-.2.2-3.5-2-.1-.3a1.8 1.8 0 0 0-1.8-1.1 1.8 1.8 0 0 0-1.7 1.2l-.1.2-3.6-2 .1-.2a1.8 1.8 0 0 0-.4-2l-.2-.2 2-3.4.3.1a1.8 1.8 0 0 0 2-.5l.1-.1 3.5 2" />
    </IconBase>
  );
}

export function SunIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2.2" />
      <path d="M12 19.3v2.2" />
      <path d="M4.6 4.6l1.6 1.6" />
      <path d="M17.8 17.8l1.6 1.6" />
      <path d="M2.5 12h2.2" />
      <path d="M19.3 12h2.2" />
      <path d="M4.6 19.4l1.6-1.6" />
      <path d="M17.8 6.2l1.6-1.6" />
    </IconBase>
  );
}

export function SparkIcon() {
  return (
    <IconBase>
      <path d="M12 3.5l1.6 4.4L18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5z" />
      <path d="M18 16l.7 1.8 1.8.7-1.8.7L18 21l-.7-1.8-1.8-.7 1.8-.7L18 16z" />
    </IconBase>
  );
}

export function KeyIcon() {
  return (
    <IconBase>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H21" />
      <path d="M17 12v3" />
      <path d="M14 12v2" />
    </IconBase>
  );
}

export function CloudIcon() {
  return (
    <IconBase>
      <path d="M7.5 18h9.2a4 4 0 0 0 .5-7.9 5.5 5.5 0 0 0-10.5 1.4A3.3 3.3 0 0 0 7.5 18z" />
    </IconBase>
  );
}

export function GridIcon() {
  return (
    <IconBase>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </IconBase>
  );
}

export function CodeIcon() {
  return (
    <IconBase>
      <path d="M8 9l-3 3 3 3" />
      <path d="M16 9l3 3-3 3" />
      <path d="M14 5l-4 14" />
    </IconBase>
  );
}

export function TerminalIcon() {
  return (
    <IconBase>
      <path d="M4 6.5h16v11H4z" />
      <path d="M7 10l2 2-2 2" />
      <path d="M12 14h4" />
    </IconBase>
  );
}

export function BarChartIcon() {
  return (
    <IconBase>
      <rect x="3.5" y="13" width="3" height="8" rx="0.8" />
      <rect x="8.5" y="9" width="3" height="12" rx="0.8" />
      <rect x="13.5" y="5" width="3" height="16" rx="0.8" />
      <rect x="18.5" y="8" width="3" height="13" rx="0.8" />
    </IconBase>
  );
}

export function ServerIcon() {
  return (
    <IconBase>
      <rect x="3.5" y="4.5" width="17" height="5" rx="1.2" />
      <rect x="3.5" y="14.5" width="17" height="5" rx="1.2" />
      <circle cx="7" cy="7" r="1" />
      <circle cx="7" cy="17" r="1" />
    </IconBase>
  );
}

