// Copies the self-contained CLI bundle, config templates and skill into the Claude Code plugin.
// Plugins are installed without `npm install`, so the plugin ships the bundle (no node_modules needed).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "plugins", "jev-decision-harness");
mkdirSync(join(plugin, "dist"), { recursive: true });
cpSync(join(root, "dist", "jev-agent.mjs"), join(plugin, "dist", "jev-agent.mjs"));
cpSync(join(root, "templates"), join(plugin, "templates"), { recursive: true });
cpSync(join(root, "skill", "jev-harness"), join(plugin, "skills", "jev-harness"), { recursive: true });
console.log("plugin synced:", plugin);
