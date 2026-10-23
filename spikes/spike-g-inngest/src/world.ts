/**
 * In-process stand-ins for the database row, the email provider and the dead-letter table. The serve
 * handler runs inside the vitest process, so the tests can observe exactly what the function did.
 * The product version reads the row through `withWorkspace` (RLS) and calls the ADR-012 provider.
 */

export interface NotificationRow {
  workspaceId: string;
  notificationId: string;
  /** PII lives in the database row only; it never enters an event payload. */
  recipient: string;
  template: 'invite' | 'lead';
  status: 'pending' | 'sent';
}

export interface Scenario {
  /** Provider throws a transient error on the first N send attempts. */
  failTimes?: number;
  /** Provider throws on every attempt (drives the run to the dead-letter path). */
  alwaysFail?: boolean;
  /** Provider accepts the message, then the step crashes once before its result is recorded. */
  crashAfterSendOnce?: boolean;
  /** Time the provider call takes, to observe concurrency. */
  holdMs?: number;
}

export interface DeadLetter {
  functionId: string;
  runId: string;
  workspaceId: string | undefined;
  notificationId: string | undefined;
  error: string;
  at: string;
}

export class World {
  rows = new Map<string, NotificationRow>();
  scenarios = new Map<string, Scenario>();
  loadCalls = new Map<string, number>();
  sendAttempts = new Map<string, { at: number; attempt: number }[]>();
  /** Messages the provider actually accepted, keyed by idempotency key. */
  delivered = new Map<string, { to: string; template: string; at: number }>();
  duplicateSendsSuppressed = new Map<string, number>();
  deadLetters: DeadLetter[] = [];
  alerts: string[] = [];
  completedRuns = new Map<string, string>();
  inflightByWorkspace = new Map<string, number>();
  maxInflightByWorkspace = new Map<string, number>();
  inflightGlobal = 0;
  maxInflightGlobal = 0;
  /** Wall-clock interval of every provider call, to measure overlap. */
  sendIntervals: { workspaceId: string; notificationId: string; start: number; end: number }[] = [];
  private crashed = new Set<string>();

  seed(row: Omit<NotificationRow, 'status'>, scenario: Scenario = {}) {
    this.rows.set(row.notificationId, { ...row, status: 'pending' });
    this.scenarios.set(row.notificationId, scenario);
  }

  load(workspaceId: string, notificationId: string): NotificationRow {
    this.loadCalls.set(notificationId, (this.loadCalls.get(notificationId) ?? 0) + 1);
    const row = this.rows.get(notificationId);
    // Mirrors RLS: a row from another workspace is simply not visible.
    if (!row || row.workspaceId !== workspaceId) throw new Error('notification not found');
    return row;
  }

  /** Fake provider. Like real providers (Resend/Postmark), it de-duplicates on an idempotency key. */
  async send(row: NotificationRow, idempotencyKey: string, attempt: number) {
    const id = row.notificationId;
    const scenario = this.scenarios.get(id) ?? {};
    const attempts = this.sendAttempts.get(id) ?? [];
    attempts.push({ at: Date.now(), attempt });
    this.sendAttempts.set(id, attempts);

    this.enter(row.workspaceId);
    const start = Date.now();
    try {
      if (scenario.holdMs) await new Promise((r) => setTimeout(r, scenario.holdMs));
      if (scenario.alwaysFail) throw new Error('provider unavailable (simulated 503)');
      if (scenario.failTimes && attempts.length <= scenario.failTimes) {
        throw new Error(`provider unavailable (simulated 503, attempt ${attempts.length})`);
      }
      if (this.delivered.has(idempotencyKey)) {
        this.duplicateSendsSuppressed.set(id, (this.duplicateSendsSuppressed.get(id) ?? 0) + 1);
      } else {
        this.delivered.set(idempotencyKey, { to: row.recipient, template: row.template, at: Date.now() });
      }
      if (scenario.crashAfterSendOnce && !this.crashed.has(id)) {
        this.crashed.add(id);
        throw new Error('worker crashed after the provider accepted the message (simulated)');
      }
      return { providerMessageId: `msg_${idempotencyKey}` };
    } finally {
      this.sendIntervals.push({ workspaceId: row.workspaceId, notificationId: id, start, end: Date.now() });
      this.leave(row.workspaceId);
    }
  }

  markSent(notificationId: string) {
    const row = this.rows.get(notificationId);
    if (row) row.status = 'sent';
  }

  private enter(ws: string) {
    const n = (this.inflightByWorkspace.get(ws) ?? 0) + 1;
    this.inflightByWorkspace.set(ws, n);
    this.maxInflightByWorkspace.set(ws, Math.max(n, this.maxInflightByWorkspace.get(ws) ?? 0));
    this.inflightGlobal += 1;
    this.maxInflightGlobal = Math.max(this.maxInflightGlobal, this.inflightGlobal);
  }

  private leave(ws: string) {
    this.inflightByWorkspace.set(ws, (this.inflightByWorkspace.get(ws) ?? 1) - 1);
    this.inflightGlobal -= 1;
  }
}
