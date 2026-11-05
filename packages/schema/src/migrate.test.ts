import { describe, expect, it } from 'vitest';
import { createMigrator, migrateConfig, parseSiteConfig, type MigrationStep } from './index';
import { validConfig } from './fixtures';

const m01to11: MigrationStep = {
  from: '1.0',
  to: '1.1',
  up: (c) => ({ ...c, added: true }),
  down: (c) => {
    const { added: _added, ...rest } = c;
    return rest;
  },
};
const m11to12: MigrationStep = { from: '1.1', to: '1.2', up: (c) => ({ ...c, second: 1 }) };

describe('migration framework (FR-TPL-07)', () => {
  it('current version is a no-op and never mutates its input', () => {
    const input = validConfig();
    const r = migrateConfig(input);
    expect(r.ok && r.steps).toBe(0);
    expect(r.ok && r.config).toEqual(input);
  });
  it('refuses unknown, future and missing versions', () => {
    for (const v of ['0.9', '2.0', '1.1', 1, undefined]) {
      expect(migrateConfig({ ...validConfig(), schemaVersion: v }).ok).toBe(false);
    }
    expect(migrateConfig('x').ok).toBe(false);
    const p = parseSiteConfig({ ...validConfig(), schemaVersion: '2.0' });
    expect(p.ok).toBe(false);
  });
  it('chains steps in order, deterministically, without mutating the source document', () => {
    const { migrateUp } = createMigrator([m01to11, m11to12], '1.2');
    const source = { schemaVersion: '1.0', a: 1 };
    const a = migrateUp(source);
    const b = migrateUp(source);
    expect(a).toEqual(b);
    expect(a.ok && a.config).toEqual({ schemaVersion: '1.2', a: 1, added: true, second: 1 });
    expect(a.ok && a.steps).toBe(2);
    expect(source).toEqual({ schemaVersion: '1.0', a: 1 });
  });
  it('reverses a reversible step and refuses a one-way step', () => {
    const { migrateDown } = createMigrator([m01to11, m11to12], '1.2');
    const back = migrateDown({ schemaVersion: '1.1', a: 1, added: true }, '1.0');
    expect(back.ok && back.config).toEqual({ schemaVersion: '1.0', a: 1 });
    const oneWay = migrateDown({ schemaVersion: '1.2' }, '1.1');
    expect(oneWay.ok).toBe(false);
    expect(!oneWay.ok && oneWay.reason).toMatch(/one-way/);
  });
  it('a throwing step is a refusal, not an exception; cycles are detected', () => {
    const boom = createMigrator(
      [
        {
          from: '1.0',
          to: '1.1',
          up: () => {
            throw new Error('x');
          },
        },
      ],
      '1.1',
    );
    expect(boom.migrateUp({ schemaVersion: '1.0' }).ok).toBe(false);
    const loop = createMigrator(
      [
        { from: '1.0', to: '1.1', up: (c) => c },
        { from: '1.1', to: '1.0', up: (c) => c },
      ],
      '9.9',
    );
    expect(loop.migrateUp({ schemaVersion: '1.0' }).ok).toBe(false);
  });
  it('old versions are migrated on read and reported', () => {
    const { migrateUp } = createMigrator([m01to11], '1.1');
    const r = migrateUp(validConfig());
    expect(r.ok && r.from).toBe('1.0');
    expect(r.ok && r.to).toBe('1.1');
  });
});
