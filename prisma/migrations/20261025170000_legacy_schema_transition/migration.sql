DO $$
BEGIN
  CREATE TYPE "message_kind" AS ENUM ('text', 'file');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "whisper_mode" AS ENUM ('view_once', 'timed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "ReceiptStatus" AS ENUM ('delivered', 'read');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "file_transfer_status" AS ENUM (
    'offered', 'accepted', 'transferring', 'received',
    'declined', 'cancelled', 'expired', 'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "refresh_tokens"
  ADD COLUMN IF NOT EXISTS "successor_enc" BYTEA,
  ADD COLUMN IF NOT EXISTS "grace_expires_at" TIMESTAMPTZ(6);

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "last_seq" BIGINT NOT NULL DEFAULT 0;

UPDATE "conversations" AS c
   SET "last_seq" = GREATEST(
     c."last_seq",
     COALESCE((SELECT MAX(m."seq") FROM "messages" AS m WHERE m."conversation_id" = c."id"), 0)
   );

ALTER TABLE "messages"
  ALTER COLUMN "ciphertext" DROP NOT NULL,
  ALTER COLUMN "iv" DROP NOT NULL;

ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_kind_check";
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_whisper_mode_check";
ALTER TABLE "message_receipts" DROP CONSTRAINT IF EXISTS "message_receipts_status_check";
ALTER TABLE "file_transfers" DROP CONSTRAINT IF EXISTS "file_transfers_status_check";
DROP INDEX IF EXISTS "file_transfers_expiry_idx";

DO $$
BEGIN
  IF (
    SELECT a.atttypid::regtype::text
      FROM pg_attribute AS a
     WHERE a.attrelid = 'public.messages'::regclass
       AND a.attname = 'kind'
       AND NOT a.attisdropped
  ) <> 'message_kind' THEN
    ALTER TABLE "messages"
      ALTER COLUMN "kind" TYPE "message_kind" USING "kind"::text::"message_kind";
  END IF;

  IF (
    SELECT a.atttypid::regtype::text
      FROM pg_attribute AS a
     WHERE a.attrelid = 'public.messages'::regclass
       AND a.attname = 'whisper_mode'
       AND NOT a.attisdropped
  ) <> 'whisper_mode' THEN
    ALTER TABLE "messages"
      ALTER COLUMN "whisper_mode" TYPE "whisper_mode"
      USING "whisper_mode"::text::"whisper_mode";
  END IF;

  IF (
    SELECT a.atttypid::regtype::text
      FROM pg_attribute AS a
     WHERE a.attrelid = 'public.message_receipts'::regclass
       AND a.attname = 'status'
       AND NOT a.attisdropped
  ) <> 'ReceiptStatus' THEN
    ALTER TABLE "message_receipts"
      ALTER COLUMN "status" TYPE "ReceiptStatus"
      USING "status"::text::"ReceiptStatus";
  END IF;

  IF (
    SELECT a.atttypid::regtype::text
      FROM pg_attribute AS a
     WHERE a.attrelid = 'public.file_transfers'::regclass
       AND a.attname = 'status'
       AND NOT a.attisdropped
  ) <> 'file_transfer_status' THEN
    ALTER TABLE "file_transfers"
      ALTER COLUMN "status" TYPE "file_transfer_status"
      USING "status"::text::"file_transfer_status";
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "file_transfers_expiry_idx"
  ON "file_transfers"("updated_at")
  WHERE "status" = 'offered'::"file_transfer_status";

UPDATE "users"
   SET "username" = 'deleted-' || substr(md5("id"::text), 1, 24)
 WHERE "deleted_at" IS NOT NULL
   AND length("username"::text) > 32;

ALTER TABLE "users"
  ALTER COLUMN "username" TYPE VARCHAR(32) USING lower("username"::text)::VARCHAR(32),
  ALTER COLUMN "display_name" TYPE VARCHAR(80) USING "display_name"::VARCHAR(80);

ALTER TABLE "file_transfers"
  ALTER COLUMN "mime" TYPE VARCHAR(255) USING "mime"::VARCHAR(255);

UPDATE "messages"
   SET "ciphertext" = NULL, "iv" = NULL
 WHERE "deleted_at" IS NOT NULL;

DELETE FROM "reactions" AS r
 USING "messages" AS m
 WHERE r."message_id" = m."id"
   AND m."deleted_at" IS NOT NULL;

DELETE FROM "file_transfers" AS f
 USING "messages" AS m
 WHERE f."message_id" = m."id"
   AND m."deleted_at" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "user_keys_user_id_key_version_key"
  ON "user_keys"("user_id", "key_version");
CREATE UNIQUE INDEX IF NOT EXISTS "user_keys_one_active_per_user"
  ON "user_keys"("user_id") WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "file_transfers_updated_at_idx"
  ON "file_transfers"("updated_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass
       AND conname = 'users_username_lowercase_check'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_username_lowercase_check"
      CHECK ("username" = lower("username"));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.refresh_tokens'::regclass
       AND conname = 'refresh_tokens_token_hash_length_check'
  ) THEN
    ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_token_hash_length_check"
      CHECK (octet_length("token_hash") = 32);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.messages'::regclass
       AND conname = 'messages_payload_or_tombstone_check'
  ) THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_payload_or_tombstone_check"
      CHECK (
        ("deleted_at" IS NULL AND "ciphertext" IS NOT NULL
          AND octet_length("ciphertext") BETWEEN 1 AND 65536
          AND "iv" IS NOT NULL AND octet_length("iv") BETWEEN 1 AND 32)
        OR ("deleted_at" IS NOT NULL AND "ciphertext" IS NULL AND "iv" IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.messages'::regclass
       AND conname = 'messages_whisper_pair_check'
  ) THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_whisper_pair_check"
      CHECK (("whisper_mode" IS NULL) = ("whisper_ttl_s" IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.file_transfers'::regclass
       AND conname = 'file_transfers_thumbnail_pair_check'
  ) THEN
    ALTER TABLE "file_transfers" ADD CONSTRAINT "file_transfers_thumbnail_pair_check"
      CHECK (("thumb_enc" IS NULL) = ("thumb_iv" IS NULL));
  END IF;
END
$$;

DO $$
DECLARE
  policy_record RECORD;
  table_name TEXT;
BEGIN
  FOR policy_record IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN (
         'users', 'user_keys', 'refresh_tokens', 'conversations', 'messages',
         'message_receipts', 'reactions', 'file_transfers', 'blocks'
       )
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'users', 'user_keys', 'refresh_tokens', 'conversations', 'messages',
    'message_receipts', 'reactions', 'file_transfers', 'blocks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$$;
