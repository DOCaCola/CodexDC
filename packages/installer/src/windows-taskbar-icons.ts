import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** Wrap stock PNG frames in an ICO directory without resizing or re-encoding. */
export function pngFramesToIco(frames: Buffer[]): Buffer {
  if (!frames.length) throw new Error("The stock package has no taskbar icon frames.");
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((png, index) => {
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("Invalid stock taskbar PNG.");
    }
    const size = png.readUInt32BE(16);
    if (size < 1 || size > 256 || png.readUInt32BE(20) !== size) throw new Error("Taskbar PNG must be square and at most 256 pixels.");
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames]);
}

/** Generate both taskbar themes locally from the installed official Store assets. */
export function stageWindowsTaskbarIcons(packageRoot: string, resourcesDir: string): void {
  const manifest = readFileSync(join(packageRoot, "AppxManifest.xml"), "utf8");
  const logo = /\bSquare44x44Logo\s*=\s*"([^"]+)"/i.exec(manifest)?.[1];
  if (!logo) throw new Error("The stock package does not declare a taskbar logo.");
  const logoPath = join(packageRoot, ...logo.replaceAll(String.fromCharCode(92), "/").split("/"));
  const assets = dirname(logoPath);
  const stem = basename(logoPath, extname(logoPath));
  const files = readdirSync(assets);
  const icons = [
    ["dark", "unplated"],
    ["light", "lightunplated"],
  ].map(([theme, variant]) => {
    const frames = files.filter((name) => name.startsWith(`${stem}.targetsize-`) && name.endsWith(`_altform-${variant}.png`))
      .map((name) => readFileSync(join(assets, name)))
      .sort((a, b) => a.readUInt32BE(16) - b.readUInt32BE(16));
    return { name: `taskbar-${theme}.ico`, bytes: pngFramesToIco(frames) };
  });
  const destination = join(resourcesDir, "codex-dc");
  mkdirSync(destination, { recursive: true });
  for (const icon of icons) {
    const path = join(destination, icon.name);
    if (!existsSync(path) || !readFileSync(path).equals(icon.bytes)) writeFileSync(path, icon.bytes);
  }
}

export function windowsTaskbarIconPath(resourcesDir: string): string {
  // SystemUsesLightTheme controls the shell; AppsUseLightTheme can differ.
  const theme = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    String.raw`[Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize', 'SystemUsesLightTheme', 1)`],
  { encoding: "utf8", windowsHide: true }).trim();
  return join(resourcesDir, "codex-dc", theme === "0" ? "taskbar-dark.ico" : "taskbar-light.ico");
}
