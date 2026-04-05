import type { GroupType, RegisteredGroup } from './types.js';

export const VALID_GROUP_TYPES: ReadonlySet<string> = new Set([
  'override',
  'main',
  'chat',
  'thread',
]);

/** グループの type を解決する。未指定時や不正値は 'chat' にフォールバック */
export function resolveGroupType(group: RegisteredGroup): GroupType {
  const type = group.type;
  if (type == null) return 'chat';
  if (VALID_GROUP_TYPES.has(type)) return type as GroupType;
  console.warn(
    `[group-type] Invalid group.type "${String(type)}"; falling back to "chat".`,
  );
  return 'chat';
}

/** main または override の特権を持つかどうか */
export function hasPrivilege(group: RegisteredGroup): boolean {
  const t = resolveGroupType(group);
  return t === 'main' || t === 'override';
}

/** type ごとのデフォルト allowedTools。undefined は制限なし（全許可） */
export function getDefaultAllowedTools(type: GroupType): string[] | undefined {
  switch (type) {
    case 'override':
    case 'main':
      return undefined; // 制限なし
    case 'chat':
    case 'thread':
      return ['Read'];
    default:
      // 将来 GroupType に新しい値が追加されてもフォールバックで安全側に倒す
      return ['Read'];
  }
}
