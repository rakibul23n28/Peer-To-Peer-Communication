CREATE TABLE "shared_folders" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "format_version" INTEGER NOT NULL,
    "compressed" BOOLEAN NOT NULL DEFAULT false,
    "payload_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "shared_folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shared_folders_conversation_id_created_at_idx"
    ON "shared_folders"("conversation_id", "created_at");

ALTER TABLE "shared_folders"
    ADD CONSTRAINT "shared_folders_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "shared_folders"
    ADD CONSTRAINT "shared_folders_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
