import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import { envSchema } from '../config/env.js';
import { errorResponse } from '../shared/http.js';

const env = envSchema.parse(process.env);

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'refreshToken', 'accessToken'],
  },
});

await app.register(cookie, {
  hook: 'onRequest',
  parseOptions: {},
});

await app.register(websocket);

await app.register(swagger, {
  openapi: {
    openapi: '3.1.0',
    info: { title: 'Orbit API', version: '1.0.0' },
    servers: [{ url: '/v1' }],
  },
});

await app.register(swaggerUi, {
  routePrefix: '/docs',
});

app.get('/healthz', async () => ({ status: 'ok' }));
app.get('/readyz', async () => ({ status: 'ready' }));
app.get('/metrics', async () => ({ status: 'internal-only' }));

app.get('/v1/healthz', async () => ({ status: 'ok' }));
app.get('/v1/readyz', async () => ({ status: 'ready' }));
app.get('/v1/metrics', async () => ({ status: 'internal-only' }));

app.post('/v1/auth/register', {
  schema: {
    body: z.object({
      username: z.string().min(3).max(30),
      displayName: z.string().min(1).max(80),
      password: z.string().min(10).max(128),
    }).strict(),
    response: {
      200: z.object({ ok: z.literal(true) }),
      400: z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }) }),
    },
  },
}, async (_request, reply) => {
  return reply.code(200).send({ ok: true });
});

app.post('/v1/auth/login', async (_request, reply) => {
  return reply.code(200).send({
    accessToken: 'demo-access-token',
    refreshToken: 'demo-refresh-token',
    user: { id: 'demo-user', username: 'demo', displayName: 'Demo User' },
  });
});

app.post('/v1/auth/refresh', async (_request, reply) => {
  return reply.code(200).send({ accessToken: 'demo-access-token' });
});

app.post('/v1/auth/logout', async (_request, reply) => {
  return reply.code(200).send({ ok: true });
});

app.get('/v1/users/search', async () => ({ users: [] }));
app.get('/v1/users/:id/public-key', async () => ({ id: 'demo-user', publicKey: '', fingerprint: '' }));
app.get('/v1/users/me/blocks', async () => ({ blocks: [] }));
app.post('/v1/users/:id/block', async () => ({ ok: true }));
app.delete('/v1/users/:id/block', async () => ({ ok: true }));
app.get('/v1/users/me/sessions', async () => ({ sessions: [] }));
app.delete('/v1/users/me/sessions/:id', async () => ({ ok: true }));
app.put('/v1/users/me/public-key', async () => ({ ok: true }));
app.get('/v1/conversations', async () => ({ conversations: [] }));
app.post('/v1/conversations', async () => ({ conversation: { id: 'demo-conversation' } }));
app.get('/v1/conversations/:id/messages', async () => ({ messages: [], nextCursor: null }));
app.get('/v1/rtc/ice-config', async () => ({ iceServers: [] }));

app.get('/v1/ws', { websocket: true }, (connection) => {
  connection.socket.on('message', (raw) => {
    const text = raw.toString();
    void text;
    connection.socket.send(JSON.stringify({ type: 'error', id: 'server', ts: Date.now(), payload: { code: 'NOT_AUTHENTICATED', message: 'Auth required' } }));
    connection.socket.close();
  });
});

app.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode ?? 500;
  const requestId = request.id ?? 'req-' + Date.now();
  const payload = errorResponse(statusCode, String(error.code ?? 'INTERNAL_ERROR'), error.message ?? 'Internal server error', requestId);
  reply.code(statusCode).send(payload);
});

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`Orbit API listening on ${env.PORT}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

await start();
