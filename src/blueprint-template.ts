import Mustache from 'mustache';

export interface TemplateContext {
  [key: string]: string | number | boolean;
}

export interface SystemVars {
  group_name: string;
  group_folder: string;
  chat_channel: string;
}

export interface RenderResult {
  rendered: string;
  missingParams: string[];
}

/**
 * Render a Blueprint prompt template using Mustache.
 * System variables (group_name, group_folder, chat_channel) are injected
 * automatically. HTML escaping is enabled by default.
 */
export function renderBlueprintTemplate(
  promptTemplate: string,
  params: TemplateContext,
  systemVars: SystemVars,
): RenderResult {
  const context = { ...systemVars, ...params };

  // Collect tags referenced in the template to detect missing params
  const parsed = Mustache.parse(promptTemplate);
  const referencedKeys = new Set<string>();
  for (const token of parsed) {
    // token[0] is the type: 'name' for {{key}}, '#' for {{#key}}, '^' for {{^key}}
    if (token[0] === 'name' || token[0] === '#' || token[0] === '^') {
      referencedKeys.add(token[1]);
    }
  }

  // System vars are always available — don't flag them as missing
  const systemKeys = new Set(['group_name', 'group_folder', 'chat_channel']);
  const missingParams: string[] = [];
  for (const key of referencedKeys) {
    if (systemKeys.has(key)) continue;
    if (!(key in params) || params[key] === undefined || params[key] === '') {
      missingParams.push(key);
    }
  }

  const rendered = Mustache.render(promptTemplate, context);
  return { rendered, missingParams };
}

/**
 * Validate that all required parameters are provided.
 * Returns list of missing required param keys.
 */
export function validateRequiredParams(
  parameters: Array<{ key: string; required: boolean }>,
  providedConfig: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const param of parameters) {
    if (!param.required) continue;
    const value = providedConfig[param.key];
    if (value === undefined || value === null || value === '') {
      missing.push(param.key);
    }
  }
  return missing;
}
