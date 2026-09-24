import { existsSync, readdirSync, lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { normalizeTweakPath } from "./catalog-path";

export function selectTweakSource(extracted: string, subdirectory: string = "."): string {
  const roots = readdirSync(extracted).filter((name) => lstatSync(join(extracted, name)).isDirectory());
  if (roots.length !== 1) throw new Error("Expected exactly one repository root in the archive");
  const repo = join(extracted, roots[0]);
  const path = normalizeTweakPath(subdirectory);
  const target = resolve(repo, path);
  const rel = relative(repo, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Catalog path escapes repository");
  let current = repo;
  for (const part of path === "." ? [] : path.split("/")) {
    current = join(current, part);
    if (!existsSync(current) || !lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) {
      throw new Error(`Catalog directory is missing or is a link: ${path}`);
    }
  }
  if (!existsSync(join(target, "manifest.json"))) throw new Error(`No manifest at catalog path: ${path}`);
  return target;
}
