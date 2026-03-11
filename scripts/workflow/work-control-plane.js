#!/usr/bin/env node

const VALID_PLANES = new Set(['linear']);

function normalizePlane(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_PLANES.has(normalized) ? normalized : '';
}

export function hasLinearConfiguration() {
  return Boolean(
    process.env.LINEAR_API_KEY &&
      (process.env.NANOCLAW_LINEAR_TEAM_KEY ||
        process.env.LINEAR_TEAM_KEY ||
        process.env.NANOCLAW_LINEAR_PROJECT_NAME ||
        process.env.NANOCLAW_LINEAR_PROJECT_ID),
  );
}

export function resolveWorkControlPlane(env = process.env) {
  const explicit = normalizePlane(
    env.NANOCLAW_WORK_CONTROL_PLANE || env.WORK_CONTROL_PLANE,
  );
  if (explicit) {
    return explicit;
  }
  if (hasLinearConfiguration()) {
    return 'linear';
  }
  throw new Error(
    'Missing Linear work-control-plane configuration. Set LINEAR_API_KEY and a NanoClaw Linear team/project selector.',
  );
}

const isMainModule =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  try {
    process.stdout.write(`${resolveWorkControlPlane()}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
