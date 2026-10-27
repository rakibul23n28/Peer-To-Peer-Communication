import { randomUUID } from "node:crypto"

import { Inject, Injectable } from "@nestjs/common"

import type { RefreshToken } from "@prisma/client"

import { prismaBytes } from "../prisma/bytes.js"

import { PrismaService } from "../prisma/prisma.service.js"

export interface NewAccount {
  username: string

  passwordHash: string

  displayName: string

  avatarSeed: string

  publicKey: Buffer

  fingerprint: string

  tokenHash: Buffer

  userAgentHash: Buffer

  familyId: string

  expiresAt: Date
}

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActiveUserByUsername(username: string) {
    return this.prisma.user.findFirst({
      where: { username, deletedAt: null },

      include: { keys: { where: { revokedAt: null }, take: 1 } },
    })
  }

  async createAccount(input: NewAccount) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username: input.username,

          passwordHash: input.passwordHash,

          displayName: input.displayName,

          avatarSeed: input.avatarSeed,

          keys: {
            create: {
              publicKey: prismaBytes(input.publicKey),

              fingerprint: input.fingerprint,

              keyVersion: 1,
            },
          },

          refreshTokens: {
            create: {
              familyId: input.familyId,

              tokenHash: prismaBytes(input.tokenHash),

              userAgentHash: prismaBytes(input.userAgentHash),

              expiresAt: input.expiresAt,
            },
          },
        },

        include: { keys: { where: { revokedAt: null }, take: 1 } },
      })

      return user
    })
  }

  createRefreshToken(input: {
    userId: string

    familyId: string

    tokenHash: Buffer

    userAgentHash: Buffer

    expiresAt: Date
  }) {
    return this.prisma.refreshToken.create({
      data: {
        ...input,

        tokenHash: prismaBytes(input.tokenHash),

        userAgentHash: prismaBytes(input.userAgentHash),
      },
    })
  }

  rotateRefreshToken(input: {
    tokenHash: Buffer

    successorHash: Buffer

    successorEncrypted: Buffer

    userAgentHash: Buffer

    expiresAt: Date
  }): Promise<{
    kind: "rotated"
    userId: string
    encryptedSuccessor: Uint8Array
  } | { kind: "reused" } | { kind: "invalid" }> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<RefreshToken[]>`
        SELECT id, user_id AS "userId", family_id AS "familyId", token_hash AS "tokenHash",
               expires_at AS "expiresAt", rotated_at AS "rotatedAt", revoked_at AS "revokedAt",
               user_agent_hash AS "userAgentHash", successor_enc AS "successorEnc",
               grace_expires_at AS "graceExpiresAt"
          FROM refresh_tokens
         WHERE token_hash = ${prismaBytes(input.tokenHash)}
         FOR UPDATE
      `

      const current = locked[0]

      const now = new Date()

      if (!current || current.revokedAt || current.expiresAt <= now) {
        return { kind: "invalid" }
      }

      if (current.rotatedAt) {
        if (
          current.graceExpiresAt &&
          current.graceExpiresAt > now &&
          current.successorEnc
        ) {
          return {
            kind: "rotated",

            userId: current.userId,

            encryptedSuccessor: current.successorEnc,
          }
        }

        await tx.refreshToken.updateMany({
          where: { familyId: current.familyId, revokedAt: null },

          data: { revokedAt: now },
        })

        return { kind: "reused" }
      }

      await tx.refreshToken.update({
        where: { id: current.id },

        data: {
          rotatedAt: now,

          successorEnc: prismaBytes(input.successorEncrypted),

          graceExpiresAt: new Date(now.getTime() + 10_000),
        },
      })

      await tx.refreshToken.create({
        data: {
          userId: current.userId,

          familyId: current.familyId,

          tokenHash: prismaBytes(input.successorHash),

          userAgentHash: prismaBytes(input.userAgentHash),

          expiresAt: input.expiresAt,
        },
      })

      return {
        kind: "rotated",

        userId: current.userId,

        encryptedSuccessor: input.successorEncrypted,
      }
    })
  }

  async revokeByTokenHash(tokenHash: Buffer): Promise<void> {
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: prismaBytes(tokenHash) },

      select: { familyId: true },
    })

    if (!token) return

    await this.prisma.refreshToken.updateMany({
      where: { familyId: token.familyId, revokedAt: null },

      data: { revokedAt: new Date() },
    })
  }

  async getCurrentUser(userId: string) {
    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },

      include: { keys: { where: { revokedAt: null }, take: 1 } },
    })
  }

  replacePublicKey(userId: string, publicKey: Buffer, fingerprint: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.userKey.updateMany({
        where: { userId, revokedAt: null },

        data: { revokedAt: new Date() },
      })

      const latest = await tx.userKey.aggregate({
        where: { userId },

        _max: { keyVersion: true },
      })

      await tx.userKey.create({
        data: {
          userId,

          publicKey: prismaBytes(publicKey),

          fingerprint,

          keyVersion: (latest._max.keyVersion ?? 0) + 1,
        },
      })
    })
  }

  async deleteAccount(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date()

      await tx.user.update({ where: { id: userId }, data: { deletedAt: now } })

      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },

        data: { revokedAt: now },
      })

      await tx.userKey.updateMany({
        where: { userId, revokedAt: null },

        data: { revokedAt: now },
      })

      await tx.fileTransfer.deleteMany({ where: { senderId: userId } })

      await tx.reaction.deleteMany({ where: { userId } })

      await tx.messageReceipt.deleteMany({ where: { userId } })

      await tx.block.deleteMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
      })

      await tx.message.updateMany({
        where: { senderId: userId, deletedAt: null },

        data: { deletedAt: now, ciphertext: null, iv: null },
      })

      await tx.user.update({
        where: { id: userId },

        data: {
          username: `deleted-${randomUUID().replaceAll("-", "").slice(0, 24)}`,

          passwordHash: randomUUID(),

          displayName: "Deleted user",

          avatarSeed: randomUUID(),
        },
      })
    })
  }
}

Inject(PrismaService)(AuthRepository, undefined, 0)
