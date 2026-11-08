# Orbit

![Orbit favicon](./public/favicon.svg)

**Orbit is a privacy-focused, one-to-one messaging application** for conversations that feel personal without sacrificing control over your data. Send end-to-end encrypted text messages, share files directly between peers, and start audio calls in a compact workspace with several distinct visual themes.

The project is a full-stack TypeScript application: a React web client communicates with a NestJS API over HTTP and WebSockets, while PostgreSQL and Prisma persist accounts, conversations, and encrypted message data.

## Screenshots

The images below are served from the repository's `public/` directory and show the available sign-in, chat appearance, and audio-call experiences.

| Screen / appearance | Preview |
| --- | --- |
| Sign in | ![Orbit sign-in page](./public/login.png) |
| Storybook | ![Orbit Storybook chat appearance](./public/StoryBook.jpeg) |
| Minimal | ![Orbit Minimal chat appearance](./public/Minimal.jpeg) |
| Watercolor | ![Orbit Watercolor chat appearance](./public/Watercolor.jpeg) |
| Anime | ![Orbit Anime chat appearance](./public/Anime.jpeg) |
| Midnight | ![Orbit Midnight chat appearance](./public/Midnight.jpeg) |
| Audio call | ![Orbit audio call in the chat workspace](./public/audiocall.jpeg) |

## Features

- **End-to-end encrypted messages:** the browser derives a shared conversation key from the participants' public keys using ECDH and HKDF, then encrypts message content with AES-GCM before sending it to the API.
- **Real-time conversations:** a WebSocket connection carries message and conversation events, with session authentication and reconnect behavior.
- **Peer-to-peer file sharing:** files are transferred using WebRTC data channels rather than uploaded as message attachments to the API. Transfers include encrypted chunks, progress reporting, and integrity checks.
- **Folder sharing (Step 1):** share an encrypted folder/file-name structure in a conversation. Names, relative paths, sizes, and modification times are encrypted end-to-end; file contents are never read, transferred, or uploaded. Chromium uses the read-only directory picker; Safari and Firefox use a directory-input fallback (which cannot expose empty folders). Shares are limited to 50,000 entries, depth 64, names up to 255 characters, paths up to 1,024 characters, and 4 MiB of encrypted manifest data. The receiver can search and browse the shared tree; file transfer is not part of this step.
- **Audio calls:** start and receive one-to-one calls, with call signaling over the WebSocket connection and audio carried by WebRTC.
- **Message controls:** edit and delete messages, reply, react, and track delivery/read receipts.
- **Conversation and account controls:** search for people, create conversations, manage blocked users, and refresh authenticated sessions.
- **Distinct chat appearances:** choose Storybook, Minimal, Watercolor, Anime, or Midnight themes. Each changes the workspace palette, decorative details, and message presentation.
- **Responsive workspace:** compact conversation navigation, message history, and composer are designed to adapt across screen sizes.
- **Local-first support:** browser-side storage supports device identity and local message caching; private keys are handled in the client.

### File-transfer network requirements

The API stores the encrypted file offer and coordinates the connection; the file bytes travel between the two browsers over an encrypted WebRTC data channel. STUN alone cannot connect peers on every mobile carrier, office, school, or restrictive Wi-Fi network. If the file card says the peer connection failed and no TURN relay is configured, add a TURN relay on the Render API service:

- `TURN_URLS`: comma-separated relay URLs, for example `turn:turn.example.net:3478?transport=udp,turn:turn.example.net:3478?transport=tcp,turns:turn.example.net:5349?transport=tcp` (use the actual URLs and ports supplied by your relay provider).
- For coturn REST/shared-secret authentication, set `TURN_SHARED_SECRET` to the private relay secret. Orbit generates short-lived credentials; `TURN_CREDENTIAL_TTL_SECONDS` optionally controls their lifetime (default `600`).
- For a provider that supplies a username and password, set `TURN_USERNAME` and `TURN_CREDENTIAL` to those values instead. Configure only one credential mode. Keep them out of source control and frontend build variables.

The authenticated API endpoint supplies the configured TURN credentials to the WebRTC clients for both file transfers and audio calls. After setting the variables, redeploy/restart the API and retry. TURN may relay encrypted WebRTC traffic when a direct peer path is unavailable; the application server still does not receive file contents or call audio.

Large-file receiving uses browser disk-backed storage when available. Browsers without that storage support are limited to 64 MiB per received file; available storage quota and the recipient device's resources can impose a lower practical limit. The sender and recipient both need a working WebRTC route, and the recipient must keep the conversation open until verification completes.

> **Privacy note:** Orbit is designed so message plaintext is encrypted in the browser before it is sent to the server. Keep account credentials and device identity material private, use HTTPS/WSS in production, and review the implementation and deployment configuration before relying on the application for sensitive communications.

## Technology

| Area | Tools |
| --- | --- |
| Web client | React 19, TypeScript, Vite 8, Tailwind CSS 4 |
| API | NestJS 11, Node.js, Express, WebSockets (`@nestjs/platform-ws`, `ws`) |
| Database | PostgreSQL, Prisma 6 |
| Authentication | JWT (`jose`), Argon2 password hashing, secure HTTP-only cookie sessions |
| Client cryptography | Web Crypto API (ECDH, HKDF, AES-GCM) and `@noble/hashes` for file integrity |
| Peer-to-peer media and files | WebRTC (`RTCPeerConnection`, data channels) |
| Browser persistence | IndexedDB via Dexie, with browser key storage |
| Validation | Zod |
| Hosting configuration | Render Blueprint for the combined Node API and frontend service |

## Architecture at a glance

1. The React client signs in through the versioned HTTP API and keeps session credentials in secure cookies.
2. The browser establishes or loads a device identity and derives conversation keys locally. Plaintext is encrypted before a message is sent.
3. NestJS validates authenticated HTTP and WebSocket requests and stores encrypted message payloads and conversation metadata in PostgreSQL through Prisma.
4. The WebSocket gateway forwards real-time conversation events to connected participants.
5. For file sharing and calls, WebSocket messages coordinate WebRTC peers; media and file data are exchanged directly between browsers when the network allows it. TURN settings can be configured for deployments that need a relay.

## Learning and project goals

Orbit is also a practical study in building a privacy-aware full-stack product. Areas to explore include:

- Designing a typed React application with reusable conversation, message, and call components.
- Building modular NestJS controllers, services, repositories, WebSocket gateways, and request validation.
- Applying public-key agreement, key derivation, authenticated encryption, and secure handling of private keys in the browser.
- Coordinating real-time messaging, reconnection, message acknowledgements, and WebRTC signaling.
- Modeling relational data with Prisma and PostgreSQL while treating existing databases and migrations carefully.
- Configuring environment validation, CORS, health checks, graceful shutdown, and production frontend/API origins.
- Testing responsive layouts, accessibility, browser storage, and peer connections across different network conditions.

## Getting started

### Requirements

- Node.js 22 (recommended; used by the Render Blueprint)
- npm
- A PostgreSQL database for local development

### Install and configure

```bash
npm ci
```

Copy `.env.example` to `.env` and set `DATABASE_URL` to a **local or disposable development database**. Keep real credentials out of source control. The example file also documents server settings and optional frontend and TURN configuration.

Generate the Prisma client:

```bash
npm run prisma:generate
```

For a new local development database, review the checked-in migrations and apply them using:

```bash
npm run db:migrate:dev
```

Never point a development migration command at a production or otherwise valuable database. For an existing database, follow the baseline and migration cautions in [Deployment (Render)](#deployment-render) instead.

### Run the application

Start the API in one terminal:

```bash
npm run dev:server
```

Start the Vite frontend in another terminal:

```bash
npm run dev
```

The Vite development server proxies API and WebSocket traffic to `API_PORT` (default `3000`). Open the local address printed by Vite (the current configuration defaults to port `8443`). For local development with a separately hosted API, set `VITE_API_URL` and `VITE_WS_URL`; the production Render build intentionally leaves them unset so the app, API, and WebSocket share one origin.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite frontend development server. |
| `npm run dev:server` | Start the NestJS API in watch mode. |
| `npm run typecheck` | Type-check the frontend and server TypeScript projects. |
| `npm run prisma:generate` | Generate the Prisma client. |
| `npm run build` | Build the frontend into `dist/`. |
| `npm run build:server` | Compile the API into `server-dist/`. |
| `npm run start:server` | Start the compiled API. |
| `npm run test:shared-folders` | Run folder-manifest, crypto, limits, and authorization tests. |
| `npm run check:no-demo` | Check the repository for disallowed demo content. |
| `npm run db:verify` | Run the database invariant checks in `scripts/verify-db.sql`. |

## Deployment (Render)

The root `render.yaml` defines one `orbit-api` Node web service that builds and serves both the API and frontend from the same origin. This avoids cross-site refresh-cookie restrictions in browsers such as iPhone Safari. The app is available at the API service URL (currently `https://orbit-api-pr3d.onrender.com`); the separate `orbit-web` static site is no longer used. The build runs `prisma migrate deploy`; review pending migrations and take a database backup before deploying. Do not use `prisma migrate reset` or force-reset commands on an existing database.

### Environment variables

| Service | Variable | Value format / source |
| --- | --- | --- |
| `orbit-api` | `DATABASE_URL` | PostgreSQL connection URL from your database provider; use TLS (`sslmode=require`) and its pooled URL if that is the app connection URL. |
| `orbit-api` | `DIRECT_URL` | Direct/non-pooled PostgreSQL URL from the same provider for Prisma migrations; use the direct URL also if the provider has no pooler. |
| `orbit-api` | `JWT_SECRET` | Random, private value with at least 32 characters. Generate independently; never reuse a development or cookie secret. |
| `orbit-api` | `COOKIE_SECRET` | A second, independent random private value with at least 32 characters. |
| `orbit-api` | `CORS_ORIGIN` | Exact app/API origin, e.g. `https://orbit-api-pr3d.onrender.com`; multiple origins may be comma-separated. No paths or `*`. |
| `orbit-api` | `NODE_ENV` | Set by the Blueprint to `production`. |
| `orbit-api` | `AUTH_COOKIE_PATH` | Set by the Blueprint to `/v1/auth`. |
| `orbit-api` | `NODE_VERSION` | Set by the Blueprint to `22`. |

Do not set `VITE_API_URL` or `VITE_WS_URL` on the Render service: production builds deliberately use relative same-origin `/v1` and `/v1/ws` endpoints. Set `CORS_ORIGIN` to the exact API/app origin. Set secrets and provider URLs in the Render dashboard; do not put real values in `render.yaml`, `.env.example`, or source control. Optional TURN uses `TURN_URLS` plus either `TURN_SHARED_SECRET` (coturn REST) or both `TURN_USERNAME` and `TURN_CREDENTIAL` (static provider credentials); do not configure both authentication modes. `TURN_CREDENTIAL_TTL_SECONDS` applies to coturn REST credentials and defaults to 600.

### Existing database and deployment order

1. Confirm the target database and take a provider-managed backup. Inspect the existing `_prisma_migrations` history and compare the schema with `prisma/schema.prisma` and the checked-in migrations. The app does not automatically verify that a database has the expected schema.
2. **Baseline only when required:** if this existing database already contains the schema from `20261025160000_init` but has no Prisma migration history, and you have confirmed the schema matches that migration, run `npm run db:migrate:baseline:legacy` against that database once. It records the initial migration as applied; it does not create the schema. Skip this step if migration history already exists. Never baseline an empty or mismatched database.
3. Before allowing the API Blueprint build to run, review each pending migration and the effects it will have on the existing data. The legacy transition migration includes cleanup of reactions and file transfers for already-deleted messages, among other schema/data transitions. `npm run db:verify` checks stored-data invariants after migration; it is not a full schema introspection tool.
4. Configure the `orbit-api` service with the database URLs, generated secrets, `CORS_ORIGIN` set to the API's public Render URL, and `AUTH_COOKIE_PATH=/v1/auth`. Remove any previously configured `VITE_API_URL` or `VITE_WS_URL` values from the API service. Deploy the Blueprint; its build generates Prisma, builds the frontend into `dist`, compiles the API, and runs `npm run db:migrate:deploy`.
5. Open the app at the `orbit-api` service URL (currently `https://orbit-api-pr3d.onrender.com`). The previous `orbit-web` static site URL is not the application URL for this same-origin setup; retire that service after confirming the combined API/app is healthy. Confirm sign-in, refresh, and an authenticated WebSocket connection on desktop and iPhone Safari.

To run the one-time baseline manually, use the same carefully verified `DATABASE_URL`/`DIRECT_URL` environment that targets the existing database; do not paste credentials into shell history or commit them.

### Troubleshooting

- API fails during startup with environment validation: check the required server variables, PostgreSQL URL/TLS settings, and that both secrets are independent random values of at least 32 characters.
- API health returns `503`: inspect Render API logs and database availability/connection limits. `/health` executes `SELECT 1`.
- Browser reports CORS errors: set `CORS_ORIGIN` to the exact API/app origin (scheme and host only), then restart the API.
- WebSocket fails: confirm the app and API are opened at the same service origin and the browser has a valid signed-in session.
- Static routes return `404`: confirm the API build completed `npm run build` and the `dist/` output was included in the deployed service.
