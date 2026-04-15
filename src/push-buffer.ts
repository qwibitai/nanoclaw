export type HoldType = 'meeting' | 'quiet_hours' | 'weekend' | 'rate_limit';

export interface HoldCondition {
  type: HoldType;
  label: string;
  expiresAt: number;
  escalateOverride?: boolean;
}

export class PushBuffer {
  private conditions: HoldCondition[] = [];

  addCondition(condition: HoldCondition): void {
    this.conditions = this.conditions.filter((c) => c.type !== condition.type);
    this.conditions.push(condition);
  }

  clearCondition(type: HoldType): void {
    this.conditions = this.conditions.filter((c) => c.type !== type);
  }

  shouldHold(trustTier: string): boolean {
    const now = Date.now();
    this.conditions = this.conditions.filter((c) => c.expiresAt > now);

    if (this.conditions.length === 0) return false;

    for (const condition of this.conditions) {
      if (condition.type === 'rate_limit') {
        return true;
      }
      if (trustTier === 'escalate' && condition.escalateOverride !== false) {
        continue;
      }
      return true;
    }

    return false;
  }

  getActiveConditions(): HoldCondition[] {
    const now = Date.now();
    this.conditions = this.conditions.filter((c) => c.expiresAt > now);
    return [...this.conditions];
  }
}
