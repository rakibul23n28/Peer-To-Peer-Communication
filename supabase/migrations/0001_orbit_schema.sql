CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  avatar_seed text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS user_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  fingerprint text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS user_keys_one_active_per_user
  ON user_keys(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_keys_user_id_idx ON user_keys(user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  user_agent_hash bytea
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_id_idx ON refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS conversations_user_b_idx ON conversations(user_b);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_msg_id uuid NOT NULL,
  seq bigint NOT NULL,
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 65536),
  iv bytea NOT NULL CHECK (octet_length(iv) BETWEEN 1 AND 32),
  key_version integer NOT NULL CHECK (key_version > 0),
  reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('text', 'file')),
  whisper_mode text CHECK (whisper_mode IN ('view_once', 'timed')),
  whisper_ttl_s integer CHECK (whisper_ttl_s IS NULL OR whisper_ttl_s BETWEEN 1 AND 604800),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (sender_id, client_msg_id),
  UNIQUE (conversation_id, seq),
  CHECK ((whisper_mode IS NULL) = (whisper_ttl_s IS NULL))
);
CREATE INDEX IF NOT EXISTS messages_conversation_seq_idx ON messages(conversation_id, seq DESC);
CREATE INDEX IF NOT EXISTS messages_sender_id_idx ON messages(sender_id);
CREATE INDEX IF NOT EXISTS messages_reply_to_id_idx ON messages(reply_to_id);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('delivered', 'read')),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, status)
);
CREATE INDEX IF NOT EXISTS message_receipts_user_id_idx ON message_receipts(user_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction_enc bytea NOT NULL CHECK (octet_length(reaction_enc) BETWEEN 1 AND 4096),
  iv bytea NOT NULL CHECK (octet_length(iv) BETWEEN 1 AND 32),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS reactions_user_id_idx ON reactions(user_id);

CREATE TABLE IF NOT EXISTS file_transfers (
  file_id uuid PRIMARY KEY,
  message_id uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_enc bytea NOT NULL CHECK (octet_length(name_enc) BETWEEN 1 AND 65536),
  name_iv bytea NOT NULL CHECK (octet_length(name_iv) BETWEEN 1 AND 32),
  size bigint NOT NULL CHECK (size >= 0),
  mime text NOT NULL CHECK (length(mime) BETWEEN 1 AND 255),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  thumb_enc bytea CHECK (thumb_enc IS NULL OR octet_length(thumb_enc) <= 4096),
  thumb_iv bytea CHECK (thumb_iv IS NULL OR octet_length(thumb_iv) BETWEEN 1 AND 32),
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  status text NOT NULL CHECK (status IN ('offered', 'accepted', 'transferring', 'received', 'declined', 'cancelled', 'expired', 'failed')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS file_transfers_message_id_idx ON file_transfers(message_id);
CREATE INDEX IF NOT EXISTS file_transfers_conversation_id_idx ON file_transfers(conversation_id);
CREATE INDEX IF NOT EXISTS file_transfers_sender_id_idx ON file_transfers(sender_id);
CREATE INDEX IF NOT EXISTS file_transfers_expiry_idx ON file_transfers(updated_at) WHERE status = 'offered';

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked_id_idx ON blocks(blocked_id);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users', 'user_keys', 'refresh_tokens', 'conversations', 'messages',
    'message_receipts', 'reactions', 'file_transfers', 'blocks'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
  END LOOP;
END
$$;
