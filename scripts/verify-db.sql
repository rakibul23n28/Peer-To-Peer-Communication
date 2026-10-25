DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*) INTO invalid_count
    FROM conversations
   WHERE user_a >= user_b;
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'ordered conversation pair check failed: %', invalid_count;
  END IF;

  SELECT count(*) INTO invalid_count
    FROM messages
   WHERE (deleted_at IS NOT NULL AND (ciphertext IS NOT NULL OR iv IS NOT NULL))
      OR (deleted_at IS NULL AND (
        ciphertext IS NULL OR octet_length(ciphertext) NOT BETWEEN 1 AND 65536
        OR iv IS NULL OR octet_length(iv) NOT BETWEEN 1 AND 32
      ));
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'message tombstone/payload check failed: %', invalid_count;
  END IF;

  SELECT count(*) INTO invalid_count
    FROM file_transfers
   WHERE octet_length(sha256) <> 32
      OR octet_length(name_enc) NOT BETWEEN 1 AND 65536
      OR octet_length(name_iv) NOT BETWEEN 1 AND 32
      OR (thumb_enc IS NOT NULL AND octet_length(thumb_enc) NOT BETWEEN 1 AND 4096)
      OR (thumb_iv IS NOT NULL AND octet_length(thumb_iv) NOT BETWEEN 1 AND 32)
      OR ((thumb_enc IS NULL) <> (thumb_iv IS NULL));
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'file metadata size check failed: %', invalid_count;
  END IF;

  SELECT count(*) INTO invalid_count
    FROM refresh_tokens
   WHERE octet_length(token_hash) <> 32;
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'refresh token hash check failed: %', invalid_count;
  END IF;

  SELECT count(*) INTO invalid_count
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN (
       'users', 'user_keys', 'refresh_tokens', 'conversations', 'messages',
       'message_receipts', 'reactions', 'file_transfers', 'blocks'
     )
     AND column_name IN (
       'plaintext', 'message_text', 'body', 'file_bytes', 'file_name',
       'thumbnail', 'password'
     );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'plaintext/file byte columns found: %', invalid_count;
  END IF;

  RAISE NOTICE 'Database verification passed';
END
$$;
