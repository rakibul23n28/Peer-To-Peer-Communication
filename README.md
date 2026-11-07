# Orbit

Orbit is an encrypted peer-to-peer messaging app with a NestJS API, PostgreSQL/Prisma persistence, and a React/Vite web client.

## Deployment (Render)

The root `render.yaml` defines an `orbit-api` Node web service and an `orbit-web` static site. The API build runs `prisma migrate deploy`; review pending migrations and take a database backup before the first deployment. Do not use `prisma migrate reset` or force-reset commands on an existing database.

### Environment variables

| Service | Variable | Value format / source |
| --- | --- | --- |
| `orbit-api` | `DATABASE_URL` | PostgreSQL connection URL from your database provider; use TLS (`sslmode=require`) and its pooled URL if that is the app connection URL. |
| `orbit-api` | `DIRECT_URL` | Direct/non-pooled PostgreSQL URL from the same provider for Prisma migrations; use the direct URL also if the provider has no pooler. |
| `orbit-api` | `JWT_SECRET` | Random, private value with at least 32 characters. Generate independently; never reuse a development or cookie secret. |
| `orbit-api` | `COOKIE_SECRET` | A second, independent random private value with at least 32 characters. |
| `orbit-api` | `CORS_ORIGIN` | Exact frontend origin, e.g. `https://orbit-web.onrender.com`; multiple origins may be comma-separated. No paths or `*`. |
| `orbit-api` | `NODE_ENV` | Set by the Blueprint to `production`. |
| `orbit-api` | `AUTH_COOKIE_PATH` | Set by the Blueprint to `/v1/auth`; this matches the direct API URL used by the Render web client. |
| `orbit-api` | `NODE_VERSION` | Set by the Blueprint to `22`. |
| `orbit-web` | `VITE_API_URL` | Public API origin, e.g. `https://orbit-api.onrender.com` (no trailing slash; `/v1` is added automatically). |
| `orbit-web` | `VITE_WS_URL` | Public WebSocket URL, e.g. `wss://orbit-api.onrender.com/v1/ws`. Production requires `wss://`. |

Set secrets and provider URLs in the Render dashboard; do not put real values in `render.yaml`, `.env.example`, or source control. Optional `TURN_URLS` and `TURN_SHARED_SECRET` can be set on the API for TURN relay credentials; configure both together. `TURN_CREDENTIAL_TTL_SECONDS` defaults to 600.

### Existing database and deployment order

1. Confirm the target database and take a provider-managed backup. Inspect the existing `_prisma_migrations` history and compare the schema with `prisma/schema.prisma` and the checked-in migrations. The app does not automatically verify that a database has the expected schema.
2. **Baseline only when required:** if this existing database already contains the schema from `20261025160000_init` but has no Prisma migration history, and you have confirmed the schema matches that migration, run `npm run db:migrate:baseline:legacy` against that database once. It records the initial migration as applied; it does not create the schema. Skip this step if migration history already exists. Never baseline an empty or mismatched database.
3. Before allowing the API Blueprint build to run, review each pending migration and the effects it will have on the existing data. The legacy transition migration includes cleanup of reactions and file transfers for already-deleted messages, among other schema/data transitions. `npm run db:verify` checks stored-data invariants after migration; it is not a full schema introspection tool. This project did not connect to or alter your database as part of this setup.
4. Enter the API and frontend environment values in Render before building either service; production Vite builds intentionally fail if API or WebSocket URLs are missing or insecure. Create/deploy `orbit-api` first with the database URLs, generated secrets, initial `CORS_ORIGIN`, and `AUTH_COOKIE_PATH=/v1/auth`. The Blueprint build executes `npm run db:migrate:deploy` after generating Prisma and compiling the API.
5. After the API is healthy, deploy `orbit-web` with `VITE_API_URL` and `VITE_WS_URL`. The static site rewrites `/*` to `/index.html` for client-side routing.
6. Copy the final public `orbit-web` origin into the API's `CORS_ORIGIN` (comma-separated if needed) and redeploy/restart the API. Confirm `/health` is healthy and test sign-in, refresh, and an authenticated WebSocket connection.

To run the one-time baseline manually, use the same carefully verified `DATABASE_URL`/`DIRECT_URL` environment that targets the existing database; do not paste credentials into shell history or commit them.

### Troubleshooting

- API fails during startup with environment validation: check the required server variables, PostgreSQL URL/TLS settings, and that both secrets are independent random values of at least 32 characters.
- API health returns `503`: inspect Render API logs and database availability/connection limits. `/health` executes `SELECT 1`.
- Browser reports CORS errors: set `CORS_ORIGIN` to the exact web origin (scheme and host only), then restart the API.
- WebSocket fails: ensure `VITE_WS_URL` is the API's `wss://.../v1/ws` endpoint, its origin is included in `CORS_ORIGIN`, and the browser has a valid signed-in session.
- Static routes return `404`: confirm the `/*` to `/index.html` rewrite is present and the publish directory is `dist`.
