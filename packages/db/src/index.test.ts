import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@platform/db', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@platform/db');
  });
});
