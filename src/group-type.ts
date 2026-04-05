import type { GroupType, RegisteredGroup } from './types.js';

/** グループの type を解決する。未指定時は 'chat' */
export function resolveGroupType(group: RegisteredGroup): GroupType {
  return group.type ?? 'chat';
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
  }
}
