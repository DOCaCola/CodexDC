import { ipcRenderer } from "electron";

const STYLE_ID = "codexdc-header-branding";

// Product captions may be text or SVG wordmarks. Select one layout per trigger.
// Decorate the caption without changing React content or the menu label.
const CAPTION_SUFFIX = `
[aria-haspopup="menu"][aria-label^="Switch mode, current mode:"]:has(svg[data-no-autosize]) span:has(> svg[data-no-autosize])::after,
[aria-haspopup="menu"][aria-label^="Switch mode, current mode:"]:not(:has(svg[data-no-autosize])) span.truncate::after`;

const UAC_SHIELD = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <path fill="#ffd653" d="M2 2h12v5c0 3.5-2.2 6-6 7.5C4.2 13 2 10.5 2 7z"/>
  <path fill="#2074d4" d="M2 2h6v5H2zm6 5h6c0 3.5-2.2 6-6 7.5z"/>
  <path fill="none" stroke="#173b66" d="M2 2h12v5c0 3.5-2.2 6-6 7.5C4.2 13 2 10.5 2 7z"/>
</svg>`)}`;

const HEADER_BRANDING_CSS = `
${CAPTION_SUFFIX} {
  content: "DC";
  flex: none;
  margin-inline-start: 0.35em;
  white-space: nowrap;
}
`;

export async function installHeaderBranding(): Promise<void> {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HEADER_BRANDING_CSS;
  document.head.appendChild(style);

  if (process.platform !== "win32") return;
  if (await ipcRenderer.invoke("codexdc:desktop-elevated") !== true) return;

  style.textContent += `
${CAPTION_SUFFIX} {
  content: "DC" / "DC, running as administrator";
  padding-right: 1.2em;
  background: url("${UAC_SHIELD}") right center / 1em 1em no-repeat;
}
`;
}
