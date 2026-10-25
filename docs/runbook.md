# Orbit development runbook

## Local configuration

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to the Supabase Postgres pooler URL. The Supabase publishable and secret API keys are not substitutes for this URL.
3. Replace both development signing secrets with distinct random values of at least 32 characters. Rotate any key previously shared outside a secret manager.
4. Keep `.env` local; it is ignored by Git.

## Database migration

Apply SQL files under `supabase/migrations` with the Supabase CLI linked to the intended project. Review the target project before applying migrations. Never put user data, message plaintext, file bytes, SDP, or ICE candidates in seed fixtures or migration content.

## Readiness and debugging

- `GET /v1/healthz` confirms the HTTP process is responding.
- `GET /v1/readyz` confirms the configured database can be queried. A structured 503 means the URL, network, or database needs attention.
- Do not enable live frontend mode while auth, conversation, or WebSocket routes are placeholders.
- File bytes must travel only over the peer-to-peer data channel. The backend is not a file upload/download service.
- Never log request bodies, access tokens, refresh cookies, ciphertext, encrypted file metadata, SDP, or ICE candidates.

## Current limitation

The route and UI integration is incomplete. This runbook documents configuration and safety boundaries; it does not claim that auth, messaging, or file transfer are production-ready.
