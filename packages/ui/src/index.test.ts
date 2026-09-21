import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@platform/ui scaffold', () => {
  it('exposes its package name (pipeline smoke test)', () => {
    expect(PACKAGE_NAME).toBe('@platform/ui');
  });
});
