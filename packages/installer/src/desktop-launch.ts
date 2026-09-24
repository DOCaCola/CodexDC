import { fileURLToPath } from "node:url";

// Keep desktop arguments separate from maintenance CLI options, including when
// an older shortcut forwards to a newer maintenance package.
process.env.CODEXDC_DESKTOP_ARGS = JSON.stringify(process.argv.slice(2));
process.argv = [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "launch"];
await import("./cli.js");
