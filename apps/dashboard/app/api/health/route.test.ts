import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('dashboard health endpoint', () => {
  it('returns status ok with deploymentSurface and generates correlation ID if absent', async () => {
    const req = new Request('http://localhost:3000/api/health');
    const res = GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.app).toBe('dashboard');
    expect(data.deploymentSurface).toBeDefined();

    const corrId = res.headers.get('x-correlation-id');
    expect(corrId).toBeDefined();
    expect(corrId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('preserves valid client-supplied correlation ID in header', async () => {
    const req = new Request('http://localhost:3000/api/health', {
      headers: {
        'x-correlation-id': 'client-custom-corr-1234',
      },
    });
    const res = GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toBe('client-custom-corr-1234');
  });

  it('sanitizes malicious or invalid correlation ID headers', async () => {
    const req = new Request('http://localhost:3000/api/health', {
      headers: {
        'x-correlation-id': 'invalid id with spaces & semicolons; drop table',
      },
    });
    const res = GET(req);

    expect(res.status).toBe(200);
    const corrId = res.headers.get('x-correlation-id');
    expect(corrId).not.toContain('spaces');
    expect(corrId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
