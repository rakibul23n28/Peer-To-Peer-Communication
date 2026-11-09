CREATE TABLE "user_privacy_settings" (
  "user_id" UUID NOT NULL,
  "presence_visible" BOOLEAN NOT NULL DEFAULT true,
  "show_viewing_activity" BOOLEAN NOT NULL DEFAULT true,
  "accept_access_requests" VARCHAR(16) NOT NULL DEFAULT 'contacts',
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_privacy_settings_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "user_privacy_settings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "access_requests" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "share_id" UUID,
  "requester_id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "note_ciphertext" BYTEA,
  "note_iv" BYTEA,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "access_requests_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "access_requests_share_id_fkey"
    FOREIGN KEY ("share_id") REFERENCES "shared_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "access_requests_requester_id_fkey"
    FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "access_requests_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "access_requests_owner_id_status_created_at_idx"
  ON "access_requests"("owner_id", "status", "created_at");
CREATE INDEX "access_requests_requester_id_status_created_at_idx"
  ON "access_requests"("requester_id", "status", "created_at");
CREATE INDEX "access_requests_share_id_status_idx"
  ON "access_requests"("share_id", "status");
