/**
 * IDOR harness (SEC-10: "IDOR tests for every resource type"), exported as `@platform/isolation-tests/idor` so
 * later slices reuse it for server actions and route handlers, not only for the data layer.
 *
 * The property: for every operation, an attacker who passes another tenant's id gets exactly the outcome they
 * would get for an id that never existed: same value, or same error codes. Anything else is an existence oracle
 * or a leak. A read operation must also succeed on the attacker's own resource, so a broken accessor (one that
 * returns "not found" for everything) cannot pass vacuously. The victim's state is compared before and after.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sqlStates } from '@platform/db/testing';

export type Outcome = { kind: 'value'; value: unknown } | { kind: 'error'; codes: string[] };

export interface IdorOperation<A> {
  name: string;
  /** `read` operations are also run against the attacker's own id as a positive control. */
  kind: 'read' | 'write';
  run(attacker: A, id: string): Promise<unknown>;
}

export interface IdorTarget<A> {
  resource: string;
  attacker: A;
  /** An existing resource of another tenant (or another user, for user-private resources). */
  foreignId: string;
  /** An existing resource the attacker legitimately owns. */
  ownId: string;
  operations: Array<IdorOperation<A>>;
  /** Snapshot of the victim's resource taken by its owner; must be identical before and after the probes. */
  victimState(): Promise<unknown>;
  /** Id that never existed. Defaults to a random v4 UUID. */
  missingId?: string;
}

export interface IdorResult {
  resource: string;
  operation: string;
  foreign: Outcome;
  missing: Outcome;
  own?: Outcome;
}

export async function outcome(op: () => Promise<unknown>): Promise<Outcome> {
  try {
    // JSON round trip: compare what a caller could observe, not object identity or class instances.
    const value: unknown = await op();
    return { kind: 'value', value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) };
  } catch (error) {
    return { kind: 'error', codes: [...new Set(sqlStates(error))].sort() };
  }
}

export interface IdorReport {
  results: IdorResult[];
  violations: string[];
}

export async function probeIdor<A>(target: IdorTarget<A>): Promise<IdorReport> {
  const missingId = target.missingId ?? randomUUID();
  const before = await target.victimState();
  const results: IdorResult[] = [];
  for (const op of target.operations) {
    const missing = await outcome(() => op.run(target.attacker, missingId));
    const foreign = await outcome(() => op.run(target.attacker, target.foreignId));
    const own = op.kind === 'read' ? await outcome(() => op.run(target.attacker, target.ownId)) : undefined;
    results.push({ resource: target.resource, operation: op.name, foreign, missing, ...(own && { own }) });
  }
  const after = await target.victimState();
  return { results, violations: violations(target.resource, results, isDeepStrictEqual(before, after)) };
}

function violations(resource: string, results: IdorResult[], victimUnchanged: boolean): string[] {
  const found: string[] = [];
  for (const r of results) {
    if (!isDeepStrictEqual(r.foreign, r.missing)) {
      found.push(
        `${resource}.${r.operation}: foreign id ${JSON.stringify(r.foreign)} differs from missing id ${JSON.stringify(r.missing)}`,
      );
    }
    if (r.own && (r.own.kind === 'error' || isDeepStrictEqual(r.own, r.missing))) {
      found.push(`${resource}.${r.operation}: positive control failed, own id gave ${JSON.stringify(r.own)}`);
    }
  }
  if (!victimUnchanged) found.push(`${resource}: the victim's resource changed`);
  return found;
}
