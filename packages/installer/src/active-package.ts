import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { userPaths } from "./paths.js";

/** Old Setup files and shortcuts continue to use the currently activated package. */
export function forwardToActivePackage(root: string): void {
  if (process.env.CODEXDC_ACTIVATING === "1" || existsSync(join(root, ".git")) ||
      !existsSync(join(root, "codexdc-release.json"))) return;
  const selectionFile = join(userPaths().root, "maintenance-selection.json");
  if (!existsSync(selectionFile)) return;
  const { active } = JSON.parse(readFileSync(selectionFile, "utf8"));
  if (typeof active !== "string") throw new Error("Invalid active maintenance package. Run Repair from a freshly extracted package.");
  if (resolve(active) === resolve(root)) return;
  const node = join(active, "node", process.platform === "win32" ? "node.exe" : "node");
  const cli = join(active, "packages", "installer", "dist", "cli.js");
  if (!existsSync(node) || !existsSync(cli)) throw new Error("Active maintenance package is missing. Restore its folder before running Setup.");
  const result = spawnSync(node, [cli, ...process.argv.slice(2)], { cwd: active, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
