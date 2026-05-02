export interface TelemetryConfig {
  telemetryUrl: string;
  token: string;
}

export function getTelemetryConfig(): TelemetryConfig {
  const telemetryUrl = process.env.TELEMETRY_API_URL;
  const token = process.env.TELEMETRY_REGISTRATION_TOKEN;
  if (!telemetryUrl || !token) {
    throw new Error('Missing env vars: TELEMETRY_API_URL and TELEMETRY_REGISTRATION_TOKEN are required.');
  }
  return { telemetryUrl: telemetryUrl.replace(/\/$/, ''), token };
}

export function getTelemetryConfigOptional(): TelemetryConfig | null {
  try {
    return getTelemetryConfig();
  } catch {
    return null;
  }
}
