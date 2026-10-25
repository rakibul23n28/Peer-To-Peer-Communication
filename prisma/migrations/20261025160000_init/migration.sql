CREATE TYPE "message_kind" AS ENUM ('text', 'file');
CREATE TYPE "whisper_mode" AS ENUM ('view_once', 'timed');
CREATE TYPE "ReceiptStatus" AS ENUM ('delivered', 'read');
CREATE TYPE "file_transfer_status" AS ENUM ('offered', 'accepted', 'transferring', 'received', 'declined', 'cancelled', 'expired', 'failed');

CREATE TABLE "users" (
  "id" UUID NOT NULL,
  "username" VARCHAR(32) NOT NULL,
  "password_hash" TEXT NOT NULL,
  "display_name" VARCHAR(80) NOT NULL,
  "avatar_seed" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "users_username_lowercase_check" CHECK ("username" = lower("username"))
);

CREATE TABLE "user_keys" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "public_key" BYTEA NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "key_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  CONSTRAINT "user_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_keys_key_version_check" CHECK ("key_version" > 0)
);

CREATE TABLE "refresh_tokens" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "family_id" UUID NOT NULL,
  "token_hash" BYTEA NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "rotated_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "user_agent_hash" BYTEA,
  "successor_enc" BYTEA,
  "grace_expires_at" TIMESTAMPTZ(6),
  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refresh_tokens_token_hash_length_check" CHECK (octet_length("token_hash") = 32)
);

CREATE TABLE "conversations" (
  "id" UUID NOT NULL,
  "user_a" UUID NOT NULL,
  "user_b" UUID NOT NULL,
  "last_seq" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversations_ordered_pair_check" CHECK ("user_a" < "user_b")
);

CREATE TABLE "messages" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "sender_id" UUID NOT NULL,
  "client_msg_id" UUID NOT NULL,
  "seq" BIGINT NOT NULL,
  "ciphertext" BYTEA,
  "iv" BYTEA,
  "key_version" INTEGER NOT NULL,
  "reply_to_id" UUID,
  "kind" "message_kind" NOT NULL,
  "whisper_mode" "whisper_mode",
  "whisper_ttl_s" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "edited_at" TIMESTAMPTZ(6),
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "messages_payload_or_tombstone_check" CHECK (
    ("deleted_at" IS NULL AND "ciphertext" IS NOT NULL AND octet_length("ciphertext") BETWEEN 1 AND 65536
      AND "iv" IS NOT NULL AND octet_length("iv") BETWEEN 1 AND 32)
    OR ("deleted_at" IS NOT NULL AND "ciphertext" IS NULL AND "iv" IS NULL)
  ),
  CONSTRAINT "messages_whisper_pair_check" CHECK (
    ("whisper_mode" IS NULL) = ("whisper_ttl_s" IS NULL)
  ),
  CONSTRAINT "messages_whisper_ttl_check" CHECK ("whisper_ttl_s" IS NULL OR "whisper_ttl_s" BETWEEN 1 AND 604800),
  CONSTRAINT "messages_key_version_check" CHECK ("key_version" > 0)
);

CREATE TABLE "message_receipts" (
  "message_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "status" "ReceiptStatus" NOT NULL,
  "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "message_receipts_pkey" PRIMARY KEY ("message_id", "user_id", "status")
);

CREATE TABLE "reactions" (
  "message_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "reaction_enc" BYTEA NOT NULL,
  "iv" BYTEA NOT NULL,
  CONSTRAINT "reactions_pkey" PRIMARY KEY ("message_id", "user_id"),
  CONSTRAINT "reactions_payload_size_check" CHECK (octet_length("reaction_enc") BETWEEN 1 AND 4096 AND octet_length("iv") BETWEEN 1 AND 32)
);

CREATE TABLE "file_transfers" (
  "file_id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "sender_id" UUID NOT NULL,
  "name_enc" BYTEA NOT NULL,
  "name_iv" BYTEA NOT NULL,
  "size" BIGINT NOT NULL,
  "mime" VARCHAR(255) NOT NULL,
  "sha256" BYTEA NOT NULL,
  "thumb_enc" BYTEA,
  "thumb_iv" BYTEA,
  "width" INTEGER,
  "height" INTEGER,
  "status" "file_transfer_status" NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_transfers_pkey" PRIMARY KEY ("file_id"),
  CONSTRAINT "file_transfers_ciphertext_sizes_check" CHECK (
    octet_length("name_enc") BETWEEN 1 AND 65536
    AND octet_length("name_iv") BETWEEN 1 AND 32
    AND octet_length("sha256") = 32
    AND ("thumb_enc" IS NULL OR octet_length("thumb_enc") BETWEEN 1 AND 4096)
    AND ("thumb_iv" IS NULL OR octet_length("thumb_iv") BETWEEN 1 AND 32)
    AND (("thumb_enc" IS NULL) = ("thumb_iv" IS NULL))
  ),
  CONSTRAINT "file_transfers_metadata_check" CHECK (
    "size" >= 0 AND length("mime") BETWEEN 1 AND 255
    AND ("width" IS NULL OR "width" > 0)
    AND ("height" IS NULL OR "height" > 0)
  )
);

CREATE TABLE "blocks" (
  "blocker_id" UUID NOT NULL,
  "blocked_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "blocks_pkey" PRIMARY KEY ("blocker_id", "blocked_id"),
  CONSTRAINT "blocks_no_self_check" CHECK ("blocker_id" <> "blocked_id")
);

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE INDEX "user_keys_user_id_idx" ON "user_keys"("user_id");
CREATE UNIQUE INDEX "user_keys_user_id_key_version_key" ON "user_keys"("user_id", "key_version");
CREATE UNIQUE INDEX "user_keys_one_active_per_user" ON "user_keys"("user_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");
CREATE UNIQUE INDEX "conversations_user_a_user_b_key" ON "conversations"("user_a", "user_b");
CREATE INDEX "conversations_user_b_idx" ON "conversations"("user_b");
CREATE UNIQUE INDEX "messages_sender_id_client_msg_id_key" ON "messages"("sender_id", "client_msg_id");
CREATE UNIQUE INDEX "messages_conversation_id_seq_key" ON "messages"("conversation_id", "seq");
CREATE INDEX "messages_conversation_id_seq_idx" ON "messages"("conversation_id", "seq" DESC);
CREATE INDEX "messages_sender_id_idx" ON "messages"("sender_id");
CREATE INDEX "messages_reply_to_id_idx" ON "messages"("reply_to_id");
CREATE INDEX "message_receipts_user_id_idx" ON "message_receipts"("user_id");
CREATE INDEX "reactions_user_id_idx" ON "reactions"("user_id");
CREATE UNIQUE INDEX "file_transfers_message_id_key" ON "file_transfers"("message_id");
CREATE INDEX "file_transfers_conversation_id_idx" ON "file_transfers"("conversation_id");
CREATE INDEX "file_transfers_sender_id_idx" ON "file_transfers"("sender_id");
CREATE INDEX "file_transfers_updated_at_idx" ON "file_transfers"("updated_at");
CREATE INDEX "blocks_blocked_id_idx" ON "blocks"("blocked_id");

ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_a_fkey" FOREIGN KEY ("user_a") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_b_fkey" FOREIGN KEY ("user_b") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_fkey" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
