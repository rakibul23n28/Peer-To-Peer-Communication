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
- **Audio calls:** start and receive one-to-one calls, with call signaling over the WebSocket connection and audio carried by WebRTC.
- **Message controls:** edit and delete messages, reply, react, and track delivery/read receipts.
- **Conversation and account controls:** search for people, create conversations, manage blocked users, and refresh authenticated sessions.
- **Distinct chat appearances:** choose Storybook, Minimal, Watercolor, Anime, or Midnight themes. Each changes the workspace palette, decorative details, and message presentation.
- **Responsive workspace:** compact conversation navigation, message history, and composer are designed to adapt across screen sizes.
- **Local-first support:** browser-side storage supports device identity and local message caching; private keys are handled in the client.

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
| Hosting configuration | Render Blueprint for a Node web service and static frontend |

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

The Vite development server proxies API and WebSocket traffic to `API_PORT` (default `3000`). Open the local address printed by Vite (the current configuration defaults to port `8443`). For a separately hosted API, set `VITE_API_URL` and `VITE_WS_URL` to its HTTP and WebSocket endpoints.

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
| `npm run check:no-demo` | Check the repository for disallowed demo content. |
| `npm run db:verify` | Run the database invariant checks in `scripts/verify-db.sql`. |

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
3. Before allowing the API Blueprint build to run, review each pending migration and the effects it will have on the existing data. The legacy transition migration includes cleanup of reactions and file transfers for already-deleted messages, among other schema/data transitions. `npm run db:verify` checks stored-data invariants after migration; it is not a full schema introspection tool.
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
