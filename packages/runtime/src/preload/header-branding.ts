const STYLE_ID = "codexdc-header-branding";

// The current product-mode caption is an SVG wordmark inside a flex span.
// Add the suffix to that same flex row while leaving the menu and accessible label intact.
export const HEADER_BRANDING_CSS = `
[aria-haspopup="menu"][aria-label^="Switch mode, current mode:"] span:has(> svg[data-no-autosize])::after {
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
