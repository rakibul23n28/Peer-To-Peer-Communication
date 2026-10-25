ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "sender_key_version" INTEGER,
  ADD COLUMN IF NOT EXISTS "recipient_key_version" INTEGER;

UPDATE "messages"
   SET "sender_key_version" = COALESCE("sender_key_version", "key_version"),
       "recipient_key_version" = COALESCE("recipient_key_version", "key_version")
 WHERE "sender_key_version" IS NULL
    OR "recipient_key_version" IS NULL;

ALTER TABLE "messages"
  ALTER COLUMN "sender_key_version" SET NOT NULL,
  ALTER COLUMN "recipient_key_version" SET NOT NULL;

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_sender_key_version_positive_check"
  CHECK ("sender_key_version" > 0),
  ADD CONSTRAINT "messages_recipient_key_version_positive_check"
  CHECK ("recipient_key_version" > 0);
