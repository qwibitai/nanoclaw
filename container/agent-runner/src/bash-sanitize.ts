export function resolveSanitizedSecretEnvVars(
  secrets?: Record<string, string>,
): string[] {
  if (!secrets) {
    return [];
  }

  const secretEnvVars = new Set<string>();
  for (const key of Object.keys(secrets)) {
    const trimmedKey = key.trim();
    if (trimmedKey) {
      secretEnvVars.add(trimmedKey);
    }
  }

  return [...secretEnvVars];
}

export function prependUnsetForSecretEnv(
  command: string,
  secretEnvVars: readonly string[],
): string {
  if (secretEnvVars.length === 0) {
    return command;
  }

  return `unset ${secretEnvVars.join(' ')} 2>/dev/null; ${command}`;
}
