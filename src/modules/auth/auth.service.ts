import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto"

import { HttpException, Inject, Injectable } from "@nestjs/common"

import argon2 from "argon2"

import { SignJWT, jwtVerify } from "jose"

import { env } from "../../config/env.js"

import { badRequest, unauthorized } from "../shared/http-error.filter.js"

import { AuthRepository } from "./auth.repository.js"

const accessTokenTtlSeconds = 15 * 60

const refreshTokenTtlDays = 30

const signingKey = new TextEncoder().encode(env.JWT_SECRET)

const encryptionKey = createHash("sha256").update(env.COOKIE_SECRET).digest()

const passwordHashOptions = {
  type: argon2.argon2id,

  memoryCost: 19_456,

  timeCost: 2,

  parallelism: 1,
}

const dummyPasswordHash = argon2.hash(
  randomBytes(32).toString("hex"),
  passwordHashOptions,
)

const refreshCookieName = "orbit_refresh"

const loginAttempts = new Map<string, { failures: number; resetAt: number }>()

const loginFailureLimit = 10

const loginWindowMs = 15 * 60_000

export interface RequestMetadata {
  ip: string

  userAgent: string
}

export interface AuthenticatedIdentity {
  id: string

  username: string

  displayName: string

  publicKey: string

  fingerprint: string

  keyVersion: number
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AuthRepository) private readonly repository: AuthRepository,
  ) {}

  async register(
    input: {
      username: string
      displayName?: string
      password: string
      publicKey: string
    },

    metadata: RequestMetadata,
  ) {
    const username = input.username.toLowerCase()

    if (!/^[a-z0-9_.]{3,32}$/.test(username)) {
      throw badRequest(
        "INVALID_USERNAME",
        "Username must be 3–32 lowercase letters, numbers, dots, or underscores",
      )
    }

    if (
      input.password.length < 10 ||
      /^(password|password123|1234567890|qwerty12345)$/i.test(input.password)
    ) {
      throw badRequest("WEAK_PASSWORD", "Choose a stronger password")
    }

    const publicKey = validatePublicKey(input.publicKey)

    const passwordHash = await argon2.hash(input.password, passwordHashOptions)

    const displayName = input.displayName?.trim() || username

    if (displayName.length < 1 || displayName.length > 80) {
      throw badRequest(
        "INVALID_DISPLAY_NAME",
        "Display name must be 1–80 characters",
      )
    }

    const refreshToken = randomBytes(32).toString("base64url")

    let user

    try {
      user = await this.repository.createAccount({
        username,

        passwordHash,

        displayName,

        avatarSeed: randomUUID(),

        publicKey,

        fingerprint: fingerprint(publicKey),

        tokenHash: hashToken(refreshToken),

        userAgentHash: hashUserAgent(metadata.userAgent),

        familyId: randomUUID(),

        expiresAt: new Date(
          Date.now() + refreshTokenTtlDays * 24 * 60 * 60_000,
        ),
      })
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        throw new HttpException(
          {
            code: "USERNAME_UNAVAILABLE",
            message: "Unable to create account with those details",
          },

          409,
        )
      }

      throw error
    }

    const key = user.keys[0]

    if (!key) throw new Error("New account key was not persisted")

    return {
      refreshToken,

      accessToken: await this.issueAccessToken(user.id),

      user: mapIdentity(
        user.id,
        user.username,
        user.displayName,
        key.publicKey,
        key.fingerprint,
        key.keyVersion,
      ),
    }
  }

  async login(
    input: { username: string; password: string },
    metadata: RequestMetadata,
  ) {
    const rateKeys = [
      createHash("sha256").update(`ip:${metadata.ip}`).digest("hex"),

      createHash("sha256")
        .update(`username:${input.username.toLowerCase()}`)
        .digest("hex"),
    ]

    const now = Date.now()

    for (const key of rateKeys) {
      const attempt = loginAttempts.get(key)

      if (
        attempt &&
        attempt.resetAt > now &&
        attempt.failures >= loginFailureLimit
      ) {
        throw new HttpException(
          {
            code: "RATE_LIMITED",

            message: "Too many attempts. Try again later.",

            retryAfterSeconds: Math.max(
              1,
              Math.ceil((attempt.resetAt - now) / 1000),
            ),
          },

          429,
        )
      }
    }

    const user = await this.repository.findActiveUserByUsername(
      input.username.toLowerCase(),
    )

    const passwordHash = await dummyPasswordHash

    const valid = await argon2.verify(
      user?.passwordHash ?? passwordHash,
      input.password,
    )

    if (!user || !valid || !user.keys[0]) {
      let maxFailures = 0

      for (const key of rateKeys) {
        const current = loginAttempts.get(key)

        const next =
          !current || current.resetAt <= now
            ? { failures: 1, resetAt: now + loginWindowMs }
            : { ...current, failures: current.failures + 1 }

        loginAttempts.set(key, next)

        maxFailures = Math.max(maxFailures, next.failures)
      }

      if (loginAttempts.size > 10_000) {
        for (const [key, value] of loginAttempts) {
          if (value.resetAt <= now) loginAttempts.delete(key)
        }
      }

      if (maxFailures >= loginFailureLimit) {
        throw new HttpException(
          {
            code: "RATE_LIMITED",

            message: "Too many attempts. Try again later.",

            retryAfterSeconds: 60,
          },

          429,
        )
      }

      throw new HttpException(
        {
          code: "INVALID_CREDENTIALS",
          message: "Username or password is incorrect",
        },

        401,
      )
    }

    for (const key of rateKeys) loginAttempts.delete(key)

    const refreshToken = randomBytes(32).toString("base64url")

    await this.repository.createRefreshToken({
      userId: user.id,

      familyId: randomUUID(),

      tokenHash: hashToken(refreshToken),

      userAgentHash: hashUserAgent(metadata.userAgent),

      expiresAt: new Date(Date.now() + refreshTokenTtlDays * 24 * 60 * 60_000),
    })

    const key = user.keys[0]

    return {
      refreshToken,

      accessToken: await this.issueAccessToken(user.id),

      user: mapIdentity(
        user.id,
        user.username,
        user.displayName,
        key.publicKey,
        key.fingerprint,
        key.keyVersion,
      ),
    }
  }

  async refresh(token: string | undefined, metadata: RequestMetadata) {
    if (!token) throw unauthorized("Refresh session is unavailable")

    const successor = randomBytes(32).toString("base64url")

    const result = await this.repository.rotateRefreshToken({
      tokenHash: hashToken(token),

      successorHash: hashToken(successor),

      successorEncrypted: encryptSuccessor(successor),

      userAgentHash: hashUserAgent(metadata.userAgent),

      expiresAt: new Date(Date.now() + refreshTokenTtlDays * 24 * 60 * 60_000),
    })

    if (result.kind !== "rotated") {
      throw unauthorized(
        result.kind === "reused"
          ? "Session revoked for your security"
          : "Refresh session is unavailable",
      )
    }

    const refreshToken = decryptSuccessor(result.encryptedSuccessor)

    return {
      refreshToken,
      accessToken: await this.issueAccessToken(result.userId),
    }
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.repository.revokeByTokenHash(hashToken(token))
  }

  async verifyAccessToken(token: string | undefined): Promise<string> {
    if (!token) throw unauthorized()

    try {
      const result = await jwtVerify(token, signingKey, {
        algorithms: ["HS256"],
      })

      if (typeof result.payload.sub !== "string")
        throw new Error("Token subject missing")

      return result.payload.sub
    } catch {
      throw unauthorized()
    }
  }

  async getIdentity(userId: string): Promise<AuthenticatedIdentity> {
    const user = await this.repository.getCurrentUser(userId)

    const key = user?.keys[0]

    if (!user || !key) throw unauthorized()

    return mapIdentity(
      user.id,
      user.username,
      user.displayName,
      key.publicKey,
      key.fingerprint,
      key.keyVersion,
    )
  }

  async replacePublicKey(userId: string, encoded: string): Promise<{
    ok: true
  }> {
    const key = validatePublicKey(encoded)

    await this.repository.replacePublicKey(userId, key, fingerprint(key))

    return { ok: true }
  }

  deleteAccount(userId: string): Promise<void> {
    return this.repository.deleteAccount(userId)
  }

  issueAccessToken(userId: string): Promise<string> {
    return new SignJWT({})

      .setProtectedHeader({ alg: "HS256" })

      .setSubject(userId)

      .setIssuedAt()

      .setExpirationTime(`${accessTokenTtlSeconds}s`)

      .sign(signingKey)
  }
}

export function cookieHeader(token: string): string {
  const maxAge = refreshTokenTtlDays * 24 * 60 * 60

  const secure = env.NODE_ENV === "production" ? "; Secure" : ""

  return `${refreshCookieName}=${token}; Path=${env.AUTH_COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`
}

export function clearCookieHeader(): string {
  const secure = env.NODE_ENV === "production" ? "; Secure" : ""

  return `${refreshCookieName}=; Path=${env.AUTH_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure}`
}

export function refreshCookie(request: {
  headers: { cookie?: string }
}): string | undefined {
  const prefix = `${refreshCookieName}=`

  return request.headers.cookie

    ?.split(";")

    .map((part) => part.trim())

    .find((part) => part.startsWith(prefix))

    ?.slice(prefix.length)
}

export function requireOrbitClient(request: {
  headers: Record<string, unknown>
}): void {
  if (request.headers["x-orbit-client"] !== "web") {
    throw new HttpException(
      {
        code: "CLIENT_HEADER_REQUIRED",
        message: "Orbit client header required",
      },

      403,
    )
  }
}

function validatePublicKey(encoded: string): Buffer {
  const publicKey = Buffer.from(encoded, "base64")

  if (
    publicKey.length < 32 ||
    publicKey.length > 4096 ||
    publicKey.toString("base64").replace(/=+$/, "") !==
      encoded.replace(/=+$/, "")
  ) {
    throw badRequest("INVALID_PUBLIC_KEY", "Public key is invalid")
  }

  return publicKey
}

function fingerprint(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex")
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest()
}

function hashUserAgent(userAgent: string): Buffer {
  return createHash("sha256").update(userAgent).digest()
}

function encryptSuccessor(token: string): Buffer {
  const iv = randomBytes(12)

  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv)

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ])

  return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}

function decryptSuccessor(encrypted: Uint8Array): string {
  const bytes = Buffer.from(encrypted)

  if (bytes.length < 29)
    throw new Error("Stored refresh token successor is invalid")

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    bytes.subarray(0, 12),
  )

  decipher.setAuthTag(bytes.subarray(12, 28))

  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8")
}

function mapIdentity(
  id: string,

  username: string,

  displayName: string,

  publicKey: Uint8Array,

  keyFingerprint: string,

  keyVersion: number,
): AuthenticatedIdentity {
  return {
    id,

    username,

    displayName,

    publicKey: Buffer.from(publicKey).toString("base64"),

    fingerprint: keyFingerprint,

    keyVersion,
  }
}
