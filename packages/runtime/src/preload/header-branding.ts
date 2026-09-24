const STYLE_ID = "codexdc-header-branding";

// The product-mode trigger has an explicit accessible label. Its nested caption span
// is the visible caption; menu items are rendered separately in a portal.
// Generated content leaves React's text, the accessible label, and menu items intact.
export const HEADER_BRANDING_CSS = `
[aria-haspopup="menu"][aria-label^="Switch mode, current mode:"] span.truncate::after {
  content: " DC";
}
`;

export function installHeaderBranding(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HEADER_BRANDING_CSS;
  document.head.appendChild(style);
}
