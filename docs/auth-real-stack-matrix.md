# Orbit auth real-stack test matrix

Run this matrix only against a disposable PostgreSQL database after applying Prisma migrations and confirming `GET /v1/readyz` returns `200`. Use throwaway accounts and record only scenario IDs, status codes, counts, and booleans; never copy passwords, cookies, access tokens, or private keys into test notes.

**Status:** Acceptance criteria; rerun against the NestJS/Prisma server after the browser chat UI is connected. The table is not evidence that these browser scenarios have passed.

| # | Scenario | Expected browser result | Expected Postgres result | SQL check |
|---|---|---|---|---|
| 1 | First visit with no refresh cookie | Splash remains until checked, then login appears | No account or refresh row is created | C1 |
| 2 | Boot with a valid refresh cookie | Splash transitions to the signed-in account view | The token family has an active, unexpired token | C2 |
| 3 | Backend/database unavailable during boot | “Can’t reach Orbit”; do not redirect as signed out or clear device data | No auth rows are changed | C1; verify readiness is `503` |
| 4 | Open a protected deep link while signed out | Redirect to login and retain the same-origin return path | No rows are created | C1 |
| 5 | Supply an external or protocol-relative return path | Unsafe path is rejected; login still works and redirects only within Orbit | No rows are created | C1 |
| 6 | Register with valid new credentials | One account is created, key is saved, and account view opens | One user, one active key, and one active refresh family | C3, C4 |
| 7 | Double-submit registration | Controls prevent duplicate submission; user lands in one account | Exactly one user for the username | C3 |
| 8 | Lose the registration response, then retry with the same credentials | Retry signs into the original account and retains its generated key | No second user or additional active key is created | C3, C4 |
| 9 | Register an existing username with an incorrect password | Generic account-creation error; no account enumeration details | Existing user and key counts do not change | C3 |
| 10 | Submit malformed username | Inline validation or structured request error; no success state | No user, key, or refresh row is created | C1 |
| 11 | Submit weak/short password | Inline validation or structured request error | No user, key, or refresh row is created | C1 |
| 12 | Submit mismatching password confirmation | Inline error; no registration request is sent | No user, key, or refresh row is created | C1 |
| 13 | Sign in with valid credentials on a device with its matching key | Account view opens after `/users/me` verification | A new active refresh token is created; existing account/key remain unchanged | C2, C4 |
| 14 | Sign in with an unknown username or wrong password | Same generic “Username or password is incorrect” message | No account or key is created | C1 |
| 15 | Exceed the login-failure limit | Generic rate-limit message with retry guidance | No account/key changes; refresh rows remain unchanged | C1 |
| 16 | Refresh once | Session remains signed in and browser receives a replacement httpOnly cookie | Old token is rotated; successor hash is stored, with a 10-second grace deadline | C5 |
| 17 | Refresh simultaneously from two tabs within the grace period | Both tabs stay signed in and converge on the same successor cookie | Only one successor is created; both responses correspond to that successor | C5 |
| 18 | Reuse the prior refresh token after the grace period | Session is rejected and user returns to login | Every still-active token in the family is revoked | C6 |
| 19 | Sign out with a reachable backend | Current and other tabs show signed-out state; refresh cookie is cleared | The refresh-token family is revoked | C6 |
| 20 | Sign out while the backend is unavailable | Show an explicit error; do not claim server revocation succeeded | No database mutation is possible while unavailable; verify revocation after reconnect if the request was retried | C6 |
| 21 | Sign in again on the device with its matching key | No recovery warning; account view opens | No key version is added or revoked | C4 |
| 22 | Sign in on a new device or with a mismatched local key | Explicit key-recovery warning is shown; no silent continuation or key replacement | No key changes until the user confirms recovery | C4 |
| 23 | Confirm key recovery and inspect browser storage | Warning precedes replacement; a new key is saved and user is signed in. No password/access/refresh token is in localStorage or sessionStorage | Previous key is revoked, one new active key/version exists; refresh token table contains only 32-byte hashes | C4, C5 |

## SQL checks

Replace `orbit-matrix-user` below with the disposable test username. Run each query after its corresponding scenario; the queries intentionally return counts and booleans rather than password hashes or token material.

### C1 — No account/refresh side effect

```sql
SELECT
  (SELECT count(*) FROM users WHERE username = 'orbit-matrix-user') AS users,
  (SELECT count(*) FROM refresh_tokens r JOIN users u ON u.id = r.user_id
    WHERE u.username = 'orbit-matrix-user') AS refresh_tokens;
```

Expected for scenarios 1, 3–5, 10–12, and 14–15: `users = 0` and `refresh_tokens = 0` for a fresh test username. For existing-account error scenarios, compare counts with the pre-test baseline instead.

### C2 — Active refresh session

```sql
SELECT
  count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now()) AS active,
  count(*) FILTER (WHERE octet_length(token_hash) = 32) AS hash_length_ok
FROM refresh_tokens r
JOIN users u ON u.id = r.user_id
WHERE u.username = 'orbit-matrix-user';
```

Expected: at least one active token and `hash_length_ok` equal to the number of rows.

### C3 — Unique account count

```sql
SELECT count(*) AS users
FROM users
WHERE username = 'orbit-matrix-user';
```

Expected after successful registration/retry: exactly one.

### C4 — Device key state

```sql
SELECT
  count(*) AS key_versions,
  count(*) FILTER (WHERE revoked_at IS NULL) AS active_keys,
  count(DISTINCT key_version) AS distinct_versions
FROM user_keys k
JOIN users u ON u.id = k.user_id
WHERE u.username = 'orbit-matrix-user';
```

Expected: exactly one active key at all times. A new device alone does not alter key rows; explicit recovery adds one version and revokes the previous version.

### C5 — Refresh rotation and grace

```sql
SELECT
  count(*) FILTER (WHERE rotated_at IS NOT NULL) AS rotated,
  count(*) FILTER (WHERE successor_enc IS NOT NULL AND grace_expires_at IS NOT NULL) AS grace_recorded,
  count(*) FILTER (WHERE octet_length(token_hash) <> 32) AS invalid_hashes
FROM refresh_tokens r
JOIN users u ON u.id = r.user_id
WHERE u.username = 'orbit-matrix-user';
```

Expected after rotation: the previous row is rotated and has an encrypted successor plus grace deadline; `invalid_hashes = 0`. Concurrent refresh should not create multiple successor rows for the same prior token.

### C6 — Revoked family

```sql
SELECT
  count(*) FILTER (WHERE revoked_at IS NULL) AS unrevoked,
  count(*) AS family_tokens
FROM refresh_tokens
WHERE family_id = '<captured-test-family-uuid>';
```

Expected after expired-token reuse or successful sign-out: `unrevoked = 0`. Capture the test family UUID from a controlled test fixture; do not capture or expose the raw refresh token.

## Browser-only privacy checks

In browser DevTools, inspect **Application → Local Storage** and **Session Storage** after registration, login, refresh, and sign-out. Neither store may contain a password, access token, or refresh token. The refresh token must be an `HttpOnly` cookie; the device private key is held as a non-extractable `CryptoKey` in IndexedDB. Do not export or paste key material into the test report.
