import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
const output = fileURLToPath(new URL("../assets/mac-launcher", import.meta.url));
rmSync(output, { force: true });
if (process.platform === "darwin") {
  mkdirSync(fileURLToPath(new URL("../assets", import.meta.url)), { recursive: true });
  execFileSync("xcrun", ["clang", "-fobjc-arc", "-framework", "Foundation", "-framework", "AppKit",
    fileURLToPath(new URL("../native/mac-launcher.m", import.meta.url)), "-o", output], { stdio: "inherit" });
}
