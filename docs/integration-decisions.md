# Integration decisions and status

## Decisions

| Decision | Reason | Owner |
| --- | --- | --- |
| Keep the existing Fastify server instead of converting the repository to NestJS. | The repository's configured server and routes are Fastify; replacing the framework is a separate migration with no behavioral benefit for this integration pass. | Orbit maintainers |
| Keep Supabase Postgres as the intended persistence layer and do not use Supabase Auth, Storage, or Realtime. | This preserves the zero-knowledge backend contract supplied for Orbit. | Orbit maintainers |
| Treat binary REST/WS fields as standard base64 and timestamps as ISO-8601. | This follows the supplied integration contract and is the selected wire convention pending shared schema generation. | Orbit maintainers |
| Keep the browser in mock mode until authenticated API and WebSocket flows are implemented and verified. | The current React screen has no session flow, HTTP adapter, encryption store, or contract-validated WebSocket client. | Orbit maintainers |

## Current implementation status

| Surface | Expected contract | Current repository status |
| --- | --- | --- |
| `GET /v1/healthz` | Health check | Implemented; route smoke tested |
| `GET /v1/readyz` | Database readiness | Checks the configured PostgreSQL URL and returns a structured 503 when unavailable |
| Auth routes | Register, login, refresh, logout | Routes are placeholders; do not use for real accounts |
| Users, blocks, key rotation | Persisted authenticated operations | Routes are placeholders |
| Conversations and history | Persisted membership-checked data | Routes are placeholders |
| WebSocket events | Authenticated, validated, authorized relay | Current handler rejects the first incoming message; no live messaging |
| React UI | `mock` and `live` adapters | UI still uses local sample data and local-only message state |
| File transfer | WebRTC-only bytes with encrypted metadata | Not implemented |

## Remaining prerequisites

- Set `DATABASE_URL` to the Supabase Postgres pooler URL in the local ignored `.env`; the supplied API keys are not a database connection string.
- Rotate the server secret key that was shared in chat. Do not put the rotated value in source control or send it in chat.
- Apply `supabase/migrations/0001_orbit_schema.sql` using the Supabase migration workflow before enabling any database-backed routes.
- Do not set `VITE_BACKEND_MODE=live` until all listed placeholders have been replaced by tested implementations.
