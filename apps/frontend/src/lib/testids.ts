// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The `data-testid` registry, verbatim. The Playwright tours select by these ids and by role;
// component tests prefer roles and names. Dynamic menu items also carry `data-preset-id` /
// `data-injection-id`, and the recorder root carries `data-sim-now`.

// prettier-ignore
export const tid = {
  status: { clock: 'status-clock', state: 'status-state', link: 'status-lamp-link', telemetry: 'status-lamp-telemetry', decisions: 'status-lamp-decisions', backend: 'status-backend', theme: 'status-theme' },
  recorder: { root: 'recorder', lane: (col: string) => `recorder-lane-${col}`, window: 'recorder-window', overlays: 'recorder-overlays', band: (id: string) => `recorder-band-${id}`, marker: (id: string) => `recorder-marker-${id}`, empty: 'recorder-empty' },
  sim: { play: 'sim-play', speed: 'sim-speed', jump: 'sim-jump', jumpItem: (id: string) => `sim-jump-${id}`, inject: 'sim-inject', injectItem: (id: string) => `sim-inject-${id}`, active: 'sim-active', clear: 'sim-clear', reset: 'sim-reset' },
  alerts: { list: 'alerts-list', item: (key: string) => `alert-${key}`, newPill: 'alerts-new', banner: (kind: string) => `alert-banner-${kind}` },
  decision: { sheet: 'decision-sheet', confidence: 'decision-confidence', candidate: (faultId: string) => `decision-candidate-${faultId}`, severity: 'decision-severity', ticketLink: 'decision-ticket-link', input: 'decision-input' },
  tickets: { tab: 'tab-tickets', row: (id: string) => `ticket-row-${id}`, sheet: 'ticket-sheet', closeCorrect: 'ticket-close-correct', closeWrong: 'ticket-close-wrong', closeSubmit: 'ticket-close-submit' },
  review: { tab: 'tab-review', row: (id: string) => `review-row-${id}` },
  events: { tab: 'tab-events', row: (id: string) => `event-row-${id}` },
  cost: { tab: 'tab-cost', total: 'cost-total', prices: 'cost-prices', row: (id: string) => `cost-row-${id}` },
} as const;
