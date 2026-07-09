import { emptyTotals, foldOutcome, tierBreakdown } from '../totals.js';
import type { RouteEvent } from './handler.js';
import type { LifetimeStats } from './history.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderDashboard(history: RouteEvent[], lifetime?: LifetimeStats): string {
  const totals = emptyTotals();
  for (const e of history) foldOutcome(totals, e);

  const totalRequests = totals.requests;
  const totalCost = totals.costCents;
  const totalSaved = totals.savedCents;
  const retried = totals.retried;

  const tierCounts = tierBreakdown(totals, ['haiku', 'sonnet', 'opus', 'passthrough'] as const);

  const total = tierCounts.haiku + tierCounts.sonnet + tierCounts.opus + tierCounts.passthrough || 1;
  const haikuPct = ((tierCounts.haiku / total) * 100).toFixed(1);
  const sonnetPct = ((tierCounts.sonnet / total) * 100).toFixed(1);
  const opusPct = ((tierCounts.opus / total) * 100).toFixed(1);
  const passPct = ((tierCounts.passthrough / total) * 100).toFixed(1);

  const recent = history.slice(-50).reverse();

  const rows = recent
    .map(
      (e) => `
      <tr>
        <td>${esc(e.timestamp.replace('T', ' ').slice(0, 19))}</td>
        <td><span class="badge badge-${esc(String(e.tier))}">${esc(String(e.tier))}</span></td>
        <td>${esc(e.model)}</td>
        <td>$${(e.costCents / 100).toFixed(4)}</td>
        <td class="${e.savedCents >= 0 ? 'positive' : 'negative'}">$${(e.savedCents / 100).toFixed(4)}</td>
        <td>${e.confidence.toFixed(2)}</td>
        <td>${e.inputTokens}</td>
        <td>${e.outputTokens}</td>
        <td>${e.retried ? `<span class="badge badge-retry">${esc(e.retryReason ?? '')}</span>` : '-'}</td>
      </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="10">
  <title>claude-router dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
    h1 { font-size: 20px; margin-bottom: 24px; color: #58a6ff; }
    .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 24px; min-width: 160px; }
    .stat-card .label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-card .value { font-size: 28px; font-weight: 600; margin-top: 4px; }
    .stat-card .value.green { color: #3fb950; }
    .stat-card .value.blue { color: #58a6ff; }
    .stat-card .value.orange { color: #d29922; }
    .tier-bar { display: flex; height: 32px; border-radius: 6px; overflow: hidden; margin-bottom: 24px; }
    .tier-bar div { display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; }
    .tier-haiku { background: #3fb950; color: #0d1117; }
    .tier-sonnet { background: #58a6ff; color: #0d1117; }
    .tier-opus { background: #bc8cff; color: #0d1117; }
    .tier-passthrough { background: #484f58; color: #c9d1d9; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; }
    th { background: #21262d; text-align: left; padding: 10px 12px; font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 8px 12px; border-top: 1px solid #21262d; font-size: 13px; font-family: 'SF Mono', monospace; }
    .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge-haiku { background: #238636; color: #fff; }
    .badge-sonnet { background: #1f6feb; color: #fff; }
    .badge-opus { background: #8957e5; color: #fff; }
    .badge-passthrough { background: #484f58; color: #c9d1d9; }
    .badge-retry { background: #d29922; color: #0d1117; }
    .positive { color: #3fb950; }
    .negative { color: #f85149; }
    .footer { margin-top: 16px; font-size: 12px; color: #484f58; }
  </style>
</head>
<body>
  <h1>claude-router dashboard</h1>

  <div class="stats">
    <div class="stat-card">
      <div class="label">Session Requests</div>
      <div class="value blue">${totalRequests}</div>
    </div>
    <div class="stat-card">
      <div class="label">Session Cost</div>
      <div class="value orange">$${(totalCost / 100).toFixed(4)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Session Saved</div>
      <div class="value green">$${(totalSaved / 100).toFixed(4)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Auto-retried</div>
      <div class="value">${retried}</div>
    </div>
    ${lifetime ? `
    <div class="stat-card">
      <div class="label">Lifetime Saved</div>
      <div class="value green">$${(lifetime.savedCents / 100).toFixed(2)}</div>
    </div>
    <div class="stat-card">
      <div class="label">Lifetime Requests</div>
      <div class="value blue">${lifetime.requests}</div>
    </div>` : ''}
  </div>

  <div class="tier-bar">
    ${Number(haikuPct) > 0 ? `<div class="tier-haiku" style="width:${haikuPct}%">Haiku ${haikuPct}%</div>` : ''}
    ${Number(sonnetPct) > 0 ? `<div class="tier-sonnet" style="width:${sonnetPct}%">Sonnet ${sonnetPct}%</div>` : ''}
    ${Number(opusPct) > 0 ? `<div class="tier-opus" style="width:${opusPct}%">Opus ${opusPct}%</div>` : ''}
    ${Number(passPct) > 0 ? `<div class="tier-passthrough" style="width:${passPct}%">Pass ${passPct}%</div>` : ''}
  </div>

  <table>
    <thead>
      <tr>
        <th>Time</th>
        <th>Tier</th>
        <th>Model</th>
        <th>Cost</th>
        <th>Saved</th>
        <th>Confidence</th>
        <th>In Tokens</th>
        <th>Out Tokens</th>
        <th>Retry</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="9" style="text-align:center;padding:24px;color:#484f58">No requests yet. Send requests to the proxy to see data here.</td></tr>'}
    </tbody>
  </table>

  <div class="footer">Auto-refreshes every 10 seconds. Showing last 50 of ${totalRequests} requests.</div>
</body>
</html>`;
}
