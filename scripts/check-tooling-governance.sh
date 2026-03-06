#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

node - "$ROOT_DIR" <<'NODE'
const fs = require("fs");
const path = require("path");

const root = process.argv[2];

const errors = [];
const warnings = [];

const metrics = {
  allow_entries: 0,
  wildcard_allow_entries: 0,
  referenced_hooks: 0,
  local_hook_files: 0,
  codex_roles_declared: 0,
  codex_agent_config_files: 0,
  jarvis_ops_commands: 0
};

function addError(msg) {
  errors.push(msg);
}

function addWarning(msg) {
  warnings.push(msg);
}

function abs(rel) {
  return path.join(root, rel);
}

function exists(rel) {
  return fs.existsSync(abs(rel));
}

function readText(rel, label) {
  if (!exists(rel)) {
    addError(`${label} missing: ${rel}`);
    return "";
  }
  return fs.readFileSync(abs(rel), "utf8");
}

function readJson(rel, label) {
  if (!exists(rel)) {
    addError(`${label} missing: ${rel}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(abs(rel), "utf8"));
  } catch (err) {
    addError(`${label} invalid JSON: ${rel} (${err.message})`);
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExecBit(relPath) {
  const st = fs.statSync(abs(relPath));
  return (st.mode & 0o111) !== 0;
}

const budget = readJson("docs/operations/tooling-governance-budget.json", "tooling governance budget");
const settings = readJson(".claude/settings.local.json", "claude settings");
let allow = [];

if (settings) {
  allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  metrics.allow_entries = allow.length;
  metrics.wildcard_allow_entries = allow.filter((entry) => String(entry).includes(":*")).length;

  if (budget?.claude_settings) {
    const maxAllow = Number(budget.claude_settings.max_allow_entries);
    const maxWildcard = Number(budget.claude_settings.max_wildcard_allow_entries);
    if (Number.isFinite(maxAllow) && metrics.allow_entries > maxAllow) {
      addError(
        `permissions.allow entries exceeded budget (${metrics.allow_entries} > ${maxAllow}); prune or raise budget intentionally`
      );
    }
    if (Number.isFinite(maxWildcard) && metrics.wildcard_allow_entries > maxWildcard) {
      addError(
        `wildcard permissions exceeded budget (${metrics.wildcard_allow_entries} > ${maxWildcard}); prune or raise budget intentionally`
      );
    }
  }
}

const seenAllowEntries = new Set();
for (const rawEntry of allow) {
  const entry = String(rawEntry).trim();
  if (!entry) {
    continue;
  }

  if (seenAllowEntries.has(entry)) {
    addError(`duplicate permissions.allow entry: ${entry}`);
    continue;
  }
  seenAllowEntries.add(entry);

  // PID-pinned kill entries are stale-by-design and should not persist in project policy.
  if (/^Bash\(kill\s+[0-9]+:\*\)$/.test(entry)) {
    addError(`stale PID-scoped permission entry: ${entry}`);
  }

  const bashWildcardMatch = entry.match(/^Bash\((.*):\*\)$/);
  if (!bashWildcardMatch) {
    continue;
  }

  const commandExpr = bashWildcardMatch[1].trim();
  for (const match of commandExpr.matchAll(/(?:^|[\s|;&])(\.?\/[A-Za-z0-9._/-]+\.(?:sh|ts))(?=$|[\s|;&])/g)) {
    const localPathToken = match[1];
    const normalizedRelPath = localPathToken.replace(/^\.\//, "");
    if (!exists(normalizedRelPath)) {
      addError(
        `permissions.allow references missing local script path: ${localPathToken} (entry: ${entry})`
      );
    }
  }
}

const preToolHookPaths = new Set();
const postToolHookPaths = new Set();
const allReferencedHookPaths = new Set();

if (settings) {
  const hookRoot = settings.hooks || {};

  function collectHookPaths(sectionName) {
    const out = [];
    const entries = Array.isArray(hookRoot[sectionName]) ? hookRoot[sectionName] : [];
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const hook of hooks) {
        const command = String(hook?.command || "").trim();
        const match = command.match(/^bash\s+(\.claude\/hooks\/[A-Za-z0-9._/-]+\.sh)\s*$/);
        if (!match) {
          continue;
        }
        out.push(match[1]);
      }
    }
    return out;
  }

  for (const p of collectHookPaths("PreToolUse")) {
    preToolHookPaths.add(p);
    allReferencedHookPaths.add(p);
  }
  for (const p of collectHookPaths("PostToolUse")) {
    postToolHookPaths.add(p);
    allReferencedHookPaths.add(p);
  }
}

metrics.referenced_hooks = allReferencedHookPaths.size;

for (const hookPath of allReferencedHookPaths) {
  if (!exists(hookPath)) {
    addError(`referenced hook does not exist: ${hookPath}`);
    continue;
  }
  if (!hasExecBit(hookPath)) {
    addError(`referenced hook is not executable: ${hookPath}`);
  }
}

if (exists(".claude/hooks")) {
  const localHookFiles = fs
    .readdirSync(abs(".claude/hooks"))
    .filter((name) => name.endsWith(".sh"))
    .map((name) => `.claude/hooks/${name}`)
    .sort();
  metrics.local_hook_files = localHookFiles.length;

  for (const hookFile of localHookFiles) {
    if (!allReferencedHookPaths.has(hookFile)) {
      addError(`orphan hook file not registered in .claude/settings.local.json hooks: ${hookFile}`);
    }
    if (!hasExecBit(hookFile)) {
      addError(`hook file missing executable bit: ${hookFile}`);
    }
  }
}

if (budget?.claude_settings) {
  const requiredPre = Array.isArray(budget.claude_settings.required_pretool_hook_paths)
    ? budget.claude_settings.required_pretool_hook_paths
    : [];
  const requiredPost = Array.isArray(budget.claude_settings.required_posttool_hook_paths)
    ? budget.claude_settings.required_posttool_hook_paths
    : [];

  for (const required of requiredPre) {
    if (!preToolHookPaths.has(required)) {
      addError(`missing required PreToolUse hook registration: ${required}`);
    }
  }
  for (const required of requiredPost) {
    if (!postToolHookPaths.has(required)) {
      addError(`missing required PostToolUse hook registration: ${required}`);
    }
  }
}

const codexConfig = readText(".codex/config.toml", "codex config");
const codexRoleHeaders = new Set();
const codexConfigRefs = new Set();
if (codexConfig) {
  for (const match of codexConfig.matchAll(/\[agents\.([A-Za-z0-9_-]+)\]/g)) {
    codexRoleHeaders.add(match[1]);
  }
  for (const match of codexConfig.matchAll(/config_file\s*=\s*"([^"]+)"/g)) {
    codexConfigRefs.add(match[1]);
  }
}
metrics.codex_roles_declared = codexRoleHeaders.size;
metrics.codex_agent_config_files = codexConfigRefs.size;

if (budget?.codex_agents) {
  const requiredRoles = Array.isArray(budget.codex_agents.required_roles) ? budget.codex_agents.required_roles : [];
  for (const role of requiredRoles) {
    if (!codexRoleHeaders.has(role)) {
      addError(`required codex role missing in .codex/config.toml: ${role}`);
    }
  }
}

const referencedAgentFiles = new Set();
for (const rel of codexConfigRefs) {
  const normalized = rel.replace(/^\.\//, "");
  const resolvedRel = normalized.startsWith("agents/") ? `.codex/${normalized}` : `.codex/agents/${normalized}`;
  referencedAgentFiles.add(resolvedRel);
  if (!exists(resolvedRel)) {
    addError(`codex agent config referenced but missing: ${resolvedRel}`);
  }
}

if (exists(".codex/agents")) {
  const localAgentFiles = fs
    .readdirSync(abs(".codex/agents"))
    .filter((name) => name.endsWith(".toml"))
    .map((name) => `.codex/agents/${name}`)
    .sort();

  for (const agentFile of localAgentFiles) {
    if (!referencedAgentFiles.has(agentFile)) {
      addError(`orphan codex agent config not referenced by .codex/config.toml: ${agentFile}`);
    }
  }
}

const subagentCatalog = readText("docs/operations/subagent-catalog.md", "subagent catalog");
const adapterMatrix = readText("docs/operations/claude-codex-adapter-matrix.md", "adapter matrix");
if (budget?.subagents) {
  const requiredCatalog = Array.isArray(budget.subagents.required_catalog_entries)
    ? budget.subagents.required_catalog_entries
    : [];
  const requiredAdapter = Array.isArray(budget.subagents.required_adapter_entries)
    ? budget.subagents.required_adapter_entries
    : [];

  for (const name of requiredCatalog) {
    const re = new RegExp("`" + escapeRegExp(name) + "`");
    if (!re.test(subagentCatalog)) {
      addError(`subagent catalog missing required entry: ${name}`);
    }
  }

  for (const name of requiredAdapter) {
    const re = new RegExp("`" + escapeRegExp(name) + "`");
    if (!re.test(adapterMatrix)) {
      addError(`adapter matrix missing required subagent mapping: ${name}`);
    }
  }
}

const jarvisOps = readText("scripts/jarvis-ops.sh", "jarvis ops command registry");
const jarvisOpsCommands = new Set();
if (jarvisOps) {
  for (const line of jarvisOps.split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z-]+(?:\|[a-z-]+)*)\)\s*$/);
    if (!m) {
      continue;
    }
    for (const token of m[1].split("|")) {
      if (token === "help" || token === "-h" || token === "--help") {
        continue;
      }
      jarvisOpsCommands.add(token);
    }
  }
}
metrics.jarvis_ops_commands = jarvisOpsCommands.size;

if (budget?.builtins) {
  const requiredOpsCommands = Array.isArray(budget.builtins.required_jarvis_ops_commands)
    ? budget.builtins.required_jarvis_ops_commands
    : [];
  for (const cmd of requiredOpsCommands) {
    if (!jarvisOpsCommands.has(cmd)) {
      addError(`jarvis-ops missing required built-in command: ${cmd}`);
    }
  }
}

const skillsDocsMap = readText("docs/operations/skills-vs-docs-map.md", "skills-vs-docs map");
if (skillsDocsMap) {
  if (!skillsDocsMap.includes("Use MCP tools first")) {
    addError("skills-vs-docs map missing built-in-first MCP policy sentence");
  }
  if (budget?.builtins) {
    const requiredMcpEntries = Array.isArray(budget.builtins.required_mcp_router_entries)
      ? budget.builtins.required_mcp_router_entries
      : [];
    for (const mcpName of requiredMcpEntries) {
      const re = new RegExp("`" + escapeRegExp(mcpName) + "`");
      if (!re.test(skillsDocsMap)) {
        addError(`skills-vs-docs map missing required MCP router entry: ${mcpName}`);
      }
    }
  }
}

if (metrics.allow_entries > 0 && metrics.wildcard_allow_entries === metrics.allow_entries) {
  addWarning("all permissions.allow entries are wildcard-style; prefer narrower command scopes where possible");
}

if (errors.length > 0) {
  console.log("tooling-governance-check: FAIL");
  for (const err of errors) {
    console.log(err);
  }
  process.exit(1);
}

console.log("tooling-governance-check: PASS");
console.log(
  `allow=${metrics.allow_entries} wildcard_allow=${metrics.wildcard_allow_entries} hooks=${metrics.local_hook_files}/${metrics.referenced_hooks} codex_roles=${metrics.codex_roles_declared} codex_agent_configs=${metrics.codex_agent_config_files} jarvis_ops_commands=${metrics.jarvis_ops_commands}`
);
for (const warn of warnings) {
  console.log(`warn: ${warn}`);
}
NODE
