// Brand marks Simple Icons doesn't carry, kept as the company's own picture —
// several colours, or a raster app icon — so they render as an image rather
// than a single-colour path (`connectorBrands.ts`). Sources: each company's
// own site (Playwright's logo, the favicon or touch icon of monday.com,
// Granola, Canva and Jam, the mark from Context7's logo). Matched the same
// way, by whole tokens of a connector's id, label, URL host or command.

import canva from "./assets/connector-logos/canva.png";
import context7 from "./assets/connector-logos/context7.svg";
import granola from "./assets/connector-logos/granola.png";
import jam from "./assets/connector-logos/jam.svg";
import monday from "./assets/connector-logos/monday.png";
import playwright from "./assets/connector-logos/playwright.svg";

export type ConnectorPicture = {
  key: string;
  title: string;
  src: string;
  /** An app icon fills its square, so it gets the app-icon corner. */
  tile?: boolean;
  keywords: readonly string[];
};

export const CONNECTOR_PICTURES: readonly ConnectorPicture[] = [
  { key: "playwright", title: "Playwright", src: playwright, keywords: ["playwright"] },
  { key: "context7", title: "Context7", src: context7, tile: true, keywords: ["context7", "upstash"] },
  { key: "monday", title: "monday.com", src: monday, keywords: ["monday"] },
  { key: "granola", title: "Granola", src: granola, tile: true, keywords: ["granola"] },
  { key: "canva", title: "Canva", src: canva, tile: true, keywords: ["canva"] },
  { key: "jam", title: "Jam", src: jam, keywords: ["jam"] },
];
