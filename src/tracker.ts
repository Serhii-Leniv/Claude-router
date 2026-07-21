import type { RouteMeta, RouterStats } from './types.js';
import { TIER_ORDER } from './models.js';
import { emptyTotals, foldOutcome, tierBreakdown, type RouteTotals } from './totals.js';

export class CostTracker {
  private totals: RouteTotals = emptyTotals();

  record(meta: RouteMeta): void {
    foldOutcome(this.totals, meta);
  }

  stats(): RouterStats {
    const t = this.totals;
    return {
      totalCostCents: Math.round(t.costCents * 1000) / 1000,
      totalSavedCents: Math.round(t.savedCents * 1000) / 1000,
      callCount: t.requests,
      // Public shape always carries all three tiers, zero-filled.
      tierBreakdown: tierBreakdown(t, TIER_ORDER),
      unpricedModels: { ...t.unpricedModels },
    };
  }

  reset(): void {
    this.totals = emptyTotals();
  }
}
