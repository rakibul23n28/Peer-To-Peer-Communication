# Integration decisions and status

## Decisions

| Decision | Reason |
| --- | --- |
| Use NestJS with Prisma ORM and PostgreSQL. | Keep HTTP/controllers and repositories separated, with Prisma lifecycle managed by a Nest provider. |
| Keep credentials and database access in the Nest server environment. | The browser only calls same-origin API routes and never receives database connection values. |
| Store encrypted message/file metadata as PostgreSQL `Bytes`; do not store file bytes or plaintext content. | Preserve the end-to-end encryption boundary. |
| Assign message sequence numbers, persist file offers with their chat item, and delete accounts inside a single Prisma transaction per operation. | Avoid partially persisted domain operations. |
| Use migrations for production and a Docker-backed throwaway database for integration tests. | Validate an empty-database install without risking a configured hosted database. |

## Implementation status

| Area | Status |
| --- | --- |
| Prisma model | All nine requested models are defined in `prisma/schema.prisma`; binary values use `Bytes`. |
| Database constraints | The initial migration includes ordered conversation pairs, idempotency/pair uniqueness, encrypted tombstones, and binary-size checks. |
| Auth and users | Repository-backed register/login/refresh/logout, profile/key lookup and replacement, and transactional account deletion. |
| Conversations and messages | Membership-checked repository operations; message sequence allocation is transactionally serialized. |
| Receipts, reactions, blocks | Persisted through dedicated repositories and authenticated controllers. |
| File metadata | Encrypted filename/thumbnail metadata and hash persist; file bytes are never accepted by the API. Offer and chat item commit together. |
| WebSocket | Nest gateway authenticates through the auth service and delegates persistence to services/repositories. Prisma is not called from the gateway. |
| Browser UI | The current signed-in screen is still account-only; chat UI has not yet been connected to the new APIs. |
| Production verification | Not complete until deploy networking/least-privilege are configured and the Docker integration suite, verification SQL, and browser E2E matrix pass. |

## Required deployment settings

- Set `DATABASE_URL` only in the Nest server environment. If the provider's runtime URL is pooled, set `DIRECT_URL` to the provider's direct TLS endpoint for migrations.
- Configure database firewall/network rules so only the Nest server can reach PostgreSQL. Require TLS and a least-privilege application role; do not expose database ingress publicly.
- Rotate any credentials previously shared in chat. Never commit `.env` or put database values in `VITE_*` variables.
- Run `npm run db:migrate:deploy` during deployment. Use `npm run db:migrate:dev` only against development databases. Existing databases with tables but no Prisma migration history require a reviewed baseline/transition before deploy; never reset them to force the initial migration.
- For the known pre-Prisma Orbit schema, use `npm run db:migrate:baseline:legacy` once after a backup, then `npm run db:migrate:deploy` to apply the forward transition. Do not use this baseline against an empty database.
- Run `npm run test:integration` against the disposable Docker database. It resets only that throwaway database and runs `scripts/verify-db.sql` after the repository integration suite.
- Production databases must begin with zero rows. There is no production seed; any seed data must be explicitly restricted to development/test.
