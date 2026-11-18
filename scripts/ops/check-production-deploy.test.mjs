// P3 S9a (DG-39 (a)): the decision of the production deployment check. Run: node --test scripts/ops/*.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from './check-production-deploy.mjs';

const dep = (...states) => ({
  statuses: states.map((state) => ({ state, environment_url: 'https://x.vercel.app' })),
});

test('no deployment for the commit (the 23c2b0d incident) is missing', () => {
  assert.equal(decide([]).state, 'missing');
});

test('a building deployment is pending', () => {
  assert.equal(decide([dep('in_progress', 'queued')]).state, 'pending');
  assert.equal(decide([dep()]).state, 'pending');
});

test('success counts, also after a later merge made it inactive', () => {
  assert.equal(decide([dep('success')]).state, 'ok');
  assert.equal(decide([dep('inactive', 'success', 'in_progress')]).state, 'ok');
});

test('a failed build fails, unless a redeploy of the same commit succeeded', () => {
  assert.equal(decide([dep('failure')]).state, 'failed');
  assert.equal(decide([dep('error')]).state, 'failed');
  assert.equal(decide([dep('success'), dep('failure')]).state, 'ok');
});
