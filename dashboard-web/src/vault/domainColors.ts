/**
 * Domain color palette for the Vault graph. Ported verbatim from
 * the previous dashboard-vault-view.ts so the graph feels identical
 * after the rebuild. New domains are assigned from the rotating
 * extraColors pool on first sight.
 */

export interface DomainColor {
  fill: string;
  raw: string;
}

const seed: Record<string, DomainColor> = {
  root: { fill: "var(--color-foreground)", raw: "#888888" },
  people: { fill: "#f0a060", raw: "#f0a060" },
  school: { fill: "#60b8f0", raw: "#60b8f0" },
  health: { fill: "#f06080", raw: "#f06080" },
  household: { fill: "#80d080", raw: "#80d080" },
  finances: { fill: "#c090f0", raw: "#c090f0" },
  food: { fill: "#f0d060", raw: "#f0d060" },
};

const extra = ["#f090b0", "#90d0c0", "#b0a0f0", "#d0b080", "#80c0c0"];

export class DomainColorMap {
  private readonly map: Record<string, DomainColor> = { ...seed };
  private extraIdx = 0;

  get(domain: string): DomainColor {
    if (!this.map[domain]) {
      const c = extra[this.extraIdx++ % extra.length];
      this.map[domain] = { fill: c, raw: c };
    }
    return this.map[domain];
  }

  entries(): Array<[string, DomainColor]> {
    return Object.entries(this.map);
  }
}
