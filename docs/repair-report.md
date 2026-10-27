# Messaging repair report

## Confirmed causes

- The earlier redacted WebSocket trace showed `message.send` requests followed by `message.error`. Those requests did not include `senderKeyVersion` or `recipientKeyVersion`, although the gateway's strict request schema requires both. The client now adds both fields and fills them for legacy outbox entries before retrying. Plaintext is cached locally and is not part of the WebSocket payload.
- The current database schema introspection does not include `conversations.last_seq`, `messages.sender_key_version`, or `messages.recipient_key_version`. Prisma migration status also reported all three repository migrations as pending. The application schema and database therefore do not match: message queries can fail with P2022, and the current send transaction cannot write the required sequence/key-version columns.
- The Nest WebSocket gateway uses the supported `{ event, data }` envelope. The frontend normalizes both that form and direct Nest response envelopes; the available evidence does not justify replacing Nest's event router with a separate raw-frame router.
- Conversation sequence numbers are local to each conversation and cannot order different conversations. The sidebar now orders conversations by the latest message timestamp, and inbound message events update the sidebar without using incomparable sequence values.

## Changes and verification

- The client retains sender plaintext only in the local Dexie cache, sends ciphertext plus key versions, shows specific failed-send messages with Retry, and flushes queued messages when connected. The server persists by sender/client-message ID for deduplication and allocates a sequence in the same transaction as the message insert.
- The current browser opened at the sign-in page, so no authenticated two-user send/receive, database ciphertext inspection, or one-second delivery check was possible.
- `npm run typecheck` passes.
- File transfer is not end-to-end implemented: the application has metadata offer and peer-request signaling, but no `RTCPeerConnection`, RTC signaling relay, encrypted chunk transport, preview, or save flow. The picker does not send file contents.

## Required next action

Back up and verify the existing PostgreSQL target, then use the repository's documented legacy baseline and reviewed forward migrations. Do not run `migrate dev` or reset the hosted database. After the schema is aligned, test messaging with two authenticated browsers and inspect only ciphertext/IV/key versions in the database. Implement and verify the RTC data-channel transfer before describing file sharing as working.
