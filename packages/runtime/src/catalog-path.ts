export function normalizeTweakPath(input: unknown): string {
  if (input === undefined || input === ".") return ".";
  if (typeof input !== "string" || !input || input.includes("\\") || input.includes(":") ||
      input.startsWith("/") || input.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Catalog path must be an exact relative directory");
  }
  return input;
}
