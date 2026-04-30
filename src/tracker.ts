import type { RouteMeta, RouterStats, Tier } from './types.js';

export class CostTracker {
  private calls: RouteMeta[] = [];

  record(meta: RouteMeta): void {
    this.calls.push(meta);
  }

  stats(): RouterStats {
    const breakdown: Record<Tier, number> = { haiku: 0, sonnet: 0, opus: 0 };
    let totalCost = 0;
    let totalSaved = 0;

    for (const call of this.calls) {
      breakdown[call.tier]++;
      totalCost += call.costCents;
      totalSaved += call.savedCents;
    }

    return {
      totalCostCents: Math.round(totalCost * 1000) / 1000,
      totalSavedCents: Math.round(totalSaved * 1000) / 1000,
      callCount: this.calls.length,
      tierBreakdown: breakdown,
    };
  }

  reset(): void {
    this.calls = [];
  }
}
