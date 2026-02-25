import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(
  __dirname,
  "../slack-app-manifest.json",
);

const name = process.argv[2];
if (!name) {
  console.error("Usage: tsx .claude/skills/add-slack/scripts/generate-manifest.ts <app-name>");
  console.error(
    'Example: tsx .claude/skills/add-slack/scripts/generate-manifest.ts "Andy Assistant"',
  );
  process.exit(1);
}

const template = readFileSync(TEMPLATE_PATH, "utf-8");
const manifest = JSON.parse(template.replace(/\{\{APP_NAME\}\}/g, name));
const json = JSON.stringify(manifest);
const encoded = encodeURIComponent(json);
const url = `https://api.slack.com/apps?new_app=1&manifest_json=${encoded}`;

console.log("=== Generated Slack App Manifest ===\n");
console.log(JSON.stringify(manifest, null, 2));
console.log("\n=== One-click creation URL ===\n");
console.log(url);
