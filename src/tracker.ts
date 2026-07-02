import type { RouteMeta, RouterStats, Tier } from './types.js';

export class CostTracker {
  private totalCost = 0;
  private totalSaved = 0;
  private count = 0;
  private breakdown: Record<Tier, number> = { haiku: 0, sonnet: 0, opus: 0 };

  record(meta: RouteMeta): void {
    this.totalCost += meta.costCents;
    this.totalSaved += meta.savedCents;
    this.count++;
    this.breakdown[meta.tier]++;
  }

  stats(): RouterStats {
    return {
      totalCostCents: Math.round(this.totalCost * 1000) / 1000,
      totalSavedCents: Math.round(this.totalSaved * 1000) / 1000,
      callCount: this.count,
      tierBreakdown: { ...this.breakdown },
    };
  }

  reset(): void {
    this.totalCost = 0;
    this.totalSaved = 0;
    this.count = 0;
    this.breakdown = { haiku: 0, sonnet: 0, opus: 0 };
  }
}
