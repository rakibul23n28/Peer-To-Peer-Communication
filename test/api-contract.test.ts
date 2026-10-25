import { describe, expect, it } from 'vitest';
import { app } from '../src/server/index.js';

describe('Orbit API contract', () => {
  it('serves health and reports database readiness', async () => {
    const health = await app.inject({ method: 'GET', url: '/v1/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const readiness = await app.inject({ method: 'GET', url: '/v1/readyz' });
    expect([200, 503]).toContain(readiness.statusCode);
    if (readiness.statusCode === 503) {
      expect(readiness.json().error.code).toBe('DATABASE_UNAVAILABLE');
    }
  });

  it('rejects invalid registration payloads with the structured error envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { username: 'a', password: 'weak' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'FST_ERR_VALIDATION',
    });
    expect(response.json().error.requestId).toBeTruthy();
  });

  it('does not claim success for authentication routes that are not implemented', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { username: 'alice', password: 'a-valid-password' },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json().error).toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
    expect(response.json().error.requestId).toBeTruthy();
  });
});
