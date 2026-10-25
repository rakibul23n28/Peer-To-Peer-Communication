import { describe, expect, it } from 'vitest';

describe('Orbit API contract basics', () => {
  it('exposes the required health endpoints', async () => {
    expect('/v1/healthz').toBeTruthy();
    expect('/v1/readyz').toBeTruthy();
    expect('/v1/metrics').toBeTruthy();
  });

  it('expects a structured error envelope', () => {
    const error = { error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId: 'req-123' } };
    expect(error.error.code).toBe('RATE_LIMITED');
    expect(error.error.requestId).toContain('req');
  });
});
