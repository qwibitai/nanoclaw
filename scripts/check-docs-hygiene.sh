#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

node - "$ROOT_DIR" <<'NODE'
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = process.argv[2];
const errors = [];
const warnings = [];

const requiredSections = [
  "## Purpose",
  "## Doc Type",
  "## Canonical Owner",
  "## Use When",
  "## Do Not Use When",
  "## Verification",
  "## Related Docs",
];

const activePrefixes = [
  "docs/workflow/",
  "docs/operations/",
  "docs/architecture/",
  "docs/reference/",
  "docs/troubleshooting/",
];

function gitStatusLines() {
  const output = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  );
  return output.split("\n").filter(Boolean);
}

function isDocPath(relPath) {
  return relPath.startsWith("docs/") && relPath.endsWith(".md");
}

function isActiveDoc(relPath) {
  return activePrefixes.some((prefix) => relPath.startsWith(prefix));
}

function readText(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function hasSection(text, section) {
  return text.includes(section);
}

function parseStatusLine(line) {
  const status = line.slice(0, 2);
  const payload = line.slice(3);

  if (status === "??") {
    return { kind: "add", newPath: payload };
  }

  if (payload.includes(" -> ") && /[RC]/.test(status)) {
    const [oldPath, newPath] = payload.split(" -> ");
    return { kind: "rename", oldPath, newPath };
  }

  if (status.includes("D")) {
    return { kind: "delete", oldPath: payload };
  }

  if (status.includes("A")) {
    return { kind: "add", newPath: payload };
  }

  return { kind: "modify", newPath: payload };
}

function searchOldPath(oldPath) {
  try {
    const output = execFileSync(
      "rg",
      [
        "-n",
        "-F",
        oldPath,
        ".",
        "--glob",
        "!docs/research/**",
        "--glob",
        "!docs/archives/**",
        "--glob",
        "!.git/**",
      ],
      { cwd: root, encoding: "utf8" },
    );
    return output
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.startsWith(`${oldPath}:`));
  } catch (err) {
    if (err.status === 1) {
      return [];
    }
    throw err;
  }
}

const changes = gitStatusLines().map(parseStatusLine);
const touched = new Set();
const pathMutations = [];

for (const change of changes) {
  if (change.oldPath) touched.add(change.oldPath);
  if (change.newPath) touched.add(change.newPath);
  if (["add", "delete", "rename"].includes(change.kind)) {
    if ((change.oldPath && isDocPath(change.oldPath)) || (change.newPath && isDocPath(change.newPath))) {
      pathMutations.push(change);
    }
  }
}

const changedDocs = changes.filter((change) => {
  return (
    (change.oldPath && isDocPath(change.oldPath)) ||
    (change.newPath && isDocPath(change.newPath))
  );
});

if (changedDocs.length === 0) {
  console.log("docs-hygiene-check: PASS (no docs changes)");
  process.exit(0);
}

if (pathMutations.length > 0 && !touched.has("DOCS.md")) {
  errors.push(
    "DOCS.md must be updated when docs are added, renamed, or deleted.",
  );
}

const activePathMutation = pathMutations.some(
  (change) =>
    (change.oldPath && isActiveDoc(change.oldPath)) ||
    (change.newPath && isActiveDoc(change.newPath)),
);

if (activePathMutation && !touched.has("docs/README.md")) {
  warnings.push(
    "docs/README.md was not touched during active-doc path changes; verify the curated landing page still reflects the best entry points.",
  );
}

for (const change of changedDocs) {
  if (change.kind === "delete") {
    continue;
  }

  const relPath = change.newPath;
  if (!relPath || !isActiveDoc(relPath) || !fs.existsSync(path.join(root, relPath))) {
    continue;
  }

  const text = readText(relPath);
  const present = requiredSections.filter((section) => hasSection(text, section));
  const missing = requiredSections.filter((section) => !hasSection(text, section));

  if (change.kind === "add" || change.kind === "rename") {
    if (missing.length > 0) {
      errors.push(
        `${relPath} is a new active doc and must include the required contract sections: ${missing.join(", ")}`,
      );
    }
    continue;
  }

  if (present.length > 0 && missing.length > 0) {
    errors.push(
      `${relPath} partially adopted the docs contract; complete the missing sections: ${missing.join(", ")}`,
    );
  } else if (present.length === 0) {
    warnings.push(
      `${relPath} is a legacy doc without contract metadata; if you materially expand it, migrate it to the docs contract template.`,
    );
  }
}

for (const change of pathMutations) {
  const oldPath = change.oldPath;
  if (!oldPath) continue;
  const matches = searchOldPath(oldPath).filter((line) => {
    return !line.startsWith(`./${oldPath}:`) && !line.startsWith(`${oldPath}:`);
  });
  if (matches.length > 0) {
    errors.push(`stale references remain for moved/deleted doc path ${oldPath}:`);
    for (const line of matches.slice(0, 10)) {
      errors.push(`  ${line}`);
    }
    if (matches.length > 10) {
      errors.push(`  ... and ${matches.length - 10} more`);
    }
  }
}

if (warnings.length > 0) {
  console.log("docs-hygiene-check: WARN");
  for (const warning of warnings) {
    console.log(`warning: ${warning}`);
  }
}

if (errors.length > 0) {
  console.log("docs-hygiene-check: FAIL");
  for (const error of errors) {
    console.log(error);
  }
  process.exit(1);
}

console.log("docs-hygiene-check: PASS");
NODE
