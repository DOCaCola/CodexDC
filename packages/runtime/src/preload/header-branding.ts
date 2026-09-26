const STYLE_ID = "codexdc-header-branding";

// Product captions may be text or SVG wordmarks. Select one layout per trigger.
// Decorate the caption without changing React content or the menu label.
export const HEADER_BRANDING_CSS = `
[aria-haspopup="menu"][aria-label^="Switch mode, current mode:"]:has(svg[data-no-autosize]) span:has(> svg[data-no-autosize])::after,
[aria-haspopup="menu"][aria-label^="Switch mode, current mode:"]:not(:has(svg[data-no-autosize])) span.truncate::after {
  content: "DC";
  flex: none;
  margin-inline-start: 0.35em;
  white-space: nowrap;
}
`;

export function installHeaderBranding(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HEADER_BRANDING_CSS;
  document.head.appendChild(style);
}
