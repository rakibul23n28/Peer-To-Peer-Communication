# Orbit development and deployment runbook

## Environment

1. Copy `.env.example` to the ignored `.env`.
2. Set `DATABASE_URL` to the PostgreSQL runtime connection value. If it points to a pooler, also configure `DIRECT_URL` to the provider's direct TLS endpoint for migrations.
3. Set unique random `JWT_SECRET` and `COOKIE_SECRET` values. Do not reuse or share database credentials.
4. Keep database values in the server environment only. Do not prefix them with `VITE_`, expose them through browser configuration, or commit `.env`.

## Schema changes

- Edit `prisma/schema.prisma` and create migrations with `npm run db:migrate:dev` against a development database.
- Deploy reviewed migrations with `npm run db:migrate:deploy`.
- Do not run migration reset commands against a hosted or production database. The integration runner resets only the isolated Docker database defined in `docker-compose.test.yml`.
- For the pre-Prisma Orbit schema, back up and verify the target first, then run `npm run db:migrate:baseline:legacy` followed by `npm run db:migrate:deploy`. The baseline command records migration history only; the forward-only `20261025170000_legacy_schema_transition` migration performs the schema transition. Do not run this baseline command against an empty or different database.
- The transition preserves active rows, initializes `last_seq` from existing messages, normalizes deleted usernames to the 32-character limit, and removes content attached to tombstones. It disables row-level security and removes policies on the nine application tables. Review these changes and the target before deploying.
- Raw SQL checks Prisma cannot express belong in the generated migration SQL. Do not create manual runtime DDL.

## Tests and database verification

- `npm test` runs fast unit tests.
- `npm run test:integration` starts a throwaway PostgreSQL container, runs `prisma migrate reset`, executes the repository integration suite, then runs `scripts/verify-db.sql` and removes only that test container/volume.
- A successful `GET /v1/healthz` confirms the HTTP process is responding. `GET /v1/readyz` also checks database connectivity.
- Production deployment requires private network access, TLS, a least-privilege database role, zero seeded rows, and passing integration plus browser E2E verification.
- Use a least-privilege runtime database identity for NestJS; reserve DDL privileges for the controlled migration connection.

## Data handling

- Only encrypted message ciphertext, encrypted filenames/thumbnails/reactions, and opaque hashes may be persisted. No plaintext body, filename, thumbnail, or file bytes belong in columns or logs.
- Prisma query logging is disabled, so parameters are never printed.
- File bytes travel only over the peer-to-peer data channel; the backend stores offer metadata only.
