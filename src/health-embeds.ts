import type { DiscordEmbed } from "./types.js";
import type { HealthEvent, HealthStatus } from "./health-monitor.js";

// Color constants
export const COLOR_GREEN = 0x00c853;
export const COLOR_RED = 0xff1744;
export const COLOR_ORANGE = 0xff9100;
export const COLOR_BLUE = 0x2979ff;

const EVENT_TYPE_COLORS: Record<string, number> = {
  error_occurred: COLOR_RED,
  phase_completed: COLOR_GREEN,
  postflight_completed: COLOR_GREEN,
  preflight_completed: COLOR_GREEN,
  bootstrap_completed: COLOR_GREEN,
  retry_scheduled: COLOR_ORANGE,
  vm_provisioned: COLOR_BLUE,
  vm_released: COLOR_BLUE,
  dispatch_received: COLOR_BLUE,
  phase_started: COLOR_BLUE,
};

export function formatHealthStatusEmbed(
  status: HealthStatus,
  previousHealthy: boolean | null,
): DiscordEmbed {
  let title: string;
  if (status.healthy) {
    title = previousHealthy === false ? `${status.source}: Recovered` : `${status.source}: Healthy`;
  } else {
    title = `${status.source}: Unhealthy`;
  }

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  if (status.details) {
    for (const [key, value] of Object.entries(status.details)) {
      fields.push({ name: key, value: String(value), inline: true });
    }
  }

  return {
    title,
    description: status.message,
    color: status.healthy ? COLOR_GREEN : COLOR_RED,
    fields: fields.length > 0 ? fields : undefined,
    timestamp: status.checkedAt.toISOString(),
  };
}

export function formatEventEmbed(event: HealthEvent): DiscordEmbed {
  const color = EVENT_TYPE_COLORS[event.type] ?? COLOR_BLUE;

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  for (const [key, value] of Object.entries(event.data)) {
    fields.push({ name: key, value: String(value), inline: true });
  }

  return {
    title: event.title,
    color,
    fields: fields.length > 0 ? fields : undefined,
    footer: { text: `${event.source} / ${event.type}` },
    timestamp: event.timestamp,
  };
}

export function renderEmbedAsText(embed: DiscordEmbed): string {
  const lines: string[] = [];
  if (embed.title) lines.push(`**${embed.title}**`);
  if (embed.description) lines.push(embed.description);
  if (embed.fields) {
    for (const field of embed.fields) {
      lines.push(`${field.name}: ${field.value}`);
    }
  }
  if (embed.footer) lines.push(embed.footer.text);
  return lines.join("\n");
}
