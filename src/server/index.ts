import Fastify, { type FastifyError, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { z } from 'zod';
import { env } from '../config/env.js';
import { checkDatabase, DatabaseUnavailableError } from './db.js';
import { errorResponse } from '../shared/http.js';

export const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'refreshToken', 'accessToken'],
  },
});

app.setValidatorCompiler(({ schema }) => (data) => {
  const result = (schema as z.ZodType).safeParse(data);
  if (!result.success) {
    return { error: result.error };
  }
  return { value: result.data };
});

app.setSerializerCompiler(() => (data) => JSON.stringify(data));

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

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

const healthSchema = z.object({ status: z.string() });
const notImplemented = (reply: FastifyReply) =>
  reply.code(501).send(errorResponse('NOT_IMPLEMENTED', 'This API operation is not implemented yet', reply.request.id));
const authRegisterSchema = z.object({
  username: z.string().min(3).max(30),
  displayName: z.string().min(1).max(80),
  password: z.string().min(10).max(128),
  publicKey: z.string().min(32).max(4096),
}).strict();

const responseSchema = {
  200: z.object({ ok: z.literal(true) }),
  400: errorEnvelope,
};

app.get('/healthz', {
  schema: {
    response: {
      200: healthSchema,
    },
  },
}, async () => ({ status: 'ok' }));

app.get('/readyz', {
  schema: {
    response: {
      200: healthSchema,
      503: errorEnvelope,
    },
  },
}, async (_request, reply) => {
  try {
    await checkDatabase();
    return { status: 'ready' };
  } catch {
    return reply.code(503).send(errorResponse('DATABASE_UNAVAILABLE', 'Database is not ready', reply.request.id));
  }
});

app.get('/metrics', {
  schema: {
    response: {
      200: healthSchema,
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.get('/v1/healthz', {
  schema: {
    response: {
      200: healthSchema,
    },
  },
}, async () => ({ status: 'ok' }));

app.get('/v1/readyz', {
  schema: {
    response: {
      200: healthSchema,
      503: errorEnvelope,
    },
  },
}, async (_request, reply) => {
  try {
    await checkDatabase();
    return { status: 'ready' };
  } catch {
    return reply.code(503).send(errorResponse('DATABASE_UNAVAILABLE', 'Database is not ready', reply.request.id));
  }
});

app.get('/v1/metrics', {
  schema: {
    response: {
      200: healthSchema,
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.post('/v1/auth/register', {
  schema: {
    body: authRegisterSchema,
    response: responseSchema,
  },
}, async (_request, reply) => notImplemented(reply));

app.post('/v1/auth/login', {
  schema: {
    body: z.object({
      username: z.string().min(3).max(30),
      password: z.string().min(10).max(128),
    }).strict(),
    response: {
      200: z.object({
        accessToken: z.string(),
        refreshToken: z.string(),
        user: z.object({
          id: z.string(),
          username: z.string(),
          displayName: z.string(),
        }),
      }),
      400: errorEnvelope,
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.post('/v1/auth/refresh', {
  schema: {
    body: z.object({ refreshToken: z.string().min(1) }).strict(),
    response: {
      200: z.object({ accessToken: z.string() }),
      400: errorEnvelope,
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.post('/v1/auth/logout', {
  schema: {
    response: {
      200: z.object({ ok: z.literal(true) }),
      400: errorEnvelope,
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.get('/v1/users/search', {
  schema: {
    querystring: z.object({ q: z.string().min(3).max(64) }),
    response: {
      200: z.object({ users: z.array(z.object({ id: z.string(), username: z.string(), displayName: z.string() })) }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.get('/v1/users/:id/public-key', {
  schema: {
    params: z.object({ id: z.string() }),
    response: {
      200: z.object({ id: z.string(), publicKey: z.string(), fingerprint: z.string() }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.get('/v1/users/me', {
  schema: {
    response: {
      200: z.object({ id: z.string(), username: z.string(), displayName: z.string() }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.get('/v1/users/me/blocks', {
  schema: {
    response: {
      200: z.object({ blocks: z.array(z.object({ id: z.string(), username: z.string(), displayName: z.string() })) }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.put('/v1/users/me/blocks/:userId', {
  schema: {
    params: z.object({ userId: z.string() }),
    response: {
      200: z.object({ ok: z.literal(true) }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.delete('/v1/users/me/blocks/:userId', {
  schema: {
    params: z.object({ userId: z.string() }),
    response: {
      200: z.object({ ok: z.literal(true) }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.get('/v1/users/me/sessions', async (_request, reply) => notImplemented(reply));
app.delete('/v1/users/me/sessions/:id', async (_request, reply) => notImplemented(reply));
app.put('/v1/users/me/public-key', {
  schema: {
    body: z.object({ publicKey: z.string().min(32).max(4096) }).strict(),
    response: {
      200: z.object({ ok: z.literal(true) }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.get('/v1/conversations', {
  schema: {
    response: {
      200: z.object({ conversations: z.array(z.object({ id: z.string(), peer: z.object({ id: z.string(), username: z.string(), displayName: z.string(), publicKey: z.string(), fingerprint: z.string(), keyVersion: z.number() }) })) }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.post('/v1/conversations', {
  schema: {
    body: z.object({ peerId: z.string() }).strict(),
    response: {
      200: z.object({ conversation: z.object({ id: z.string() }) }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.get('/v1/conversations/:id/messages', {
  schema: {
    params: z.object({ id: z.string() }),
    querystring: z.object({ cursor: z.string().nullable().optional() }),
    response: {
      200: z.object({ messages: z.array(z.object({ id: z.string() })), nextCursor: z.string().nullable() }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.get('/v1/rtc/ice-config', async (_request, reply) => notImplemented(reply));

app.get('/v1/rtc/ice-servers', {
  schema: {
    response: {
      200: z.object({ iceServers: z.array(z.object({ urls: z.array(z.string()) })) }),
    },
  },
}, async (_request, reply) => notImplemented(reply));

app.get('/v1/ws', { websocket: true }, (socket) => {
  socket.on('message', () => {
    socket.send(JSON.stringify({ type: 'error', id: 'server', ts: Date.now(), payload: { code: 'NOT_AUTHENTICATED', message: 'Auth required' } }));
    socket.close();
  });
});

app.setErrorHandler((error: FastifyError, request, reply) => {
  const statusCode = error instanceof DatabaseUnavailableError ? 503 : error.statusCode ?? 500;
  const requestId = request.id ?? 'req-' + Date.now();
  const code = error instanceof DatabaseUnavailableError ? 'DATABASE_UNAVAILABLE' : String(error.code ?? 'INTERNAL_ERROR');
  const message = error instanceof DatabaseUnavailableError ? error.message : error.message ?? 'Internal server error';
  const payload = errorResponse(code, message, requestId);
  reply.code(statusCode).send(payload);
});

const start = async () => {
  try {
    await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
    app.log.info(`Orbit API listening on ${env.API_PORT}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

if (process.env.VITEST !== 'true') {
  await start();
}
