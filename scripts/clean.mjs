import { rmSync, readdirSync } from "node:fs";
for (const name of readdirSync("packages")) rmSync(`packages/${name}/dist`, { recursive: true, force: true });
for (const path of ["packages/installer/assets/runtime", "packages/installer/assets/loader.cjs", "packages/installer/assets/mac-launcher", "dist"]) {
  rmSync(path, { recursive: true, force: true });
}
