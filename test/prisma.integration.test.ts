import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AuthRepository } from "../src/modules/auth/auth.repository.js"

import { BlocksRepository } from "../src/modules/blocks/blocks.repository.js"

import { ConversationsRepository } from "../src/modules/conversations/conversations.repository.js"

import { FilesRepository } from "../src/modules/files/files.repository.js"

import { MessagesRepository } from "../src/modules/messages/messages.repository.js"

import { PrismaService } from "../src/modules/prisma/prisma.service.js"

const prisma = new PrismaService()

describe("Prisma PostgreSQL integration", () => {
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error("TEST_DATABASE_URL is required")

    await prisma.$connect()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("persists chat, receipt, reaction, block, file offer, and account deletion atomically", async () => {
    const userA = await prisma.user.create({
      data: {
        username: "integration_a",

        passwordHash: "test-only-hash",

        displayName: "Integration A",

        avatarSeed: randomUUID(),

        keys: {
          create: {
            publicKey: Buffer.from("test-public-key-a"),

            fingerprint: "test-fingerprint-a",

            keyVersion: 1,
          },
        },
      },
    })

    const userB = await prisma.user.create({
      data: {
        username: "integration_b",

        passwordHash: "test-only-hash",

        displayName: "Integration B",

        avatarSeed: randomUUID(),

        keys: {
          create: {
            publicKey: Buffer.from("test-public-key-b"),

            fingerprint: "test-fingerprint-b",

            keyVersion: 1,
          },
        },
      },
    })

    const conversations = new ConversationsRepository(prisma)

    const messages = new MessagesRepository(prisma, conversations)

    const files = new FilesRepository(prisma)

    const blocks = new BlocksRepository(prisma)

    const auth = new AuthRepository(prisma)

    const conversation = await conversations.create(userA.id, userB.id)

    const clientMsgId = randomUUID()

    const input = {
      clientMsgId,

      ciphertext: Buffer.from("encrypted-message-fixture"),

      iv: Buffer.from("fixture-iv"),

      keyVersion: 1,

      kind: "text" as const,
    }

    const message = await messages.create(conversation.id, userA.id, input)

    const retry = await messages.create(conversation.id, userA.id, input)

    expect(retry.id).toBe(message.id)

    expect(retry.seq).toBe("1")

    await messages.addReceipt(
      conversation.id,
      message.id,
      userB.id,
      "delivered",
    )

    await messages.setReaction(
      conversation.id,

      message.id,

      userB.id,

      Buffer.from("encrypted-reaction"),

      Buffer.from("reaction-iv"),
    )

    await blocks.add(userA.id, userB.id)

    expect(await blocks.list(userA.id)).toHaveLength(1)

    await blocks.remove(userA.id, userB.id)

    const fileId = randomUUID()

    const fileOffer = await files.offer(conversation.id, userA.id, {
      fileId,

      clientMsgId: randomUUID(),

      ciphertext: Buffer.from("encrypted-file-chat-item"),

      iv: Buffer.from("file-message-iv"),

      keyVersion: 1,

      nameEnc: Buffer.from("encrypted-file-name"),

      nameIv: Buffer.from("file-name-iv"),

      size: 1234n,

      mime: "application/octet-stream",

      sha256: Buffer.alloc(32, 7),

      thumbEnc: Buffer.from("encrypted-thumbnail"),

      thumbIv: Buffer.from("thumbnail-iv"),

      width: 20,

      height: 20,
    })

    expect(fileOffer.fileId).toBe(fileId)

    expect(fileOffer.seq).toBe("2")

    await files.updateStatus(conversation.id, fileId, userB.id, "accepted")

    await messages.tombstone(conversation.id, message.id, userA.id)

    const tombstone = await prisma.message.findUniqueOrThrow({
      where: { id: message.id },
    })

    expect(tombstone.deletedAt).not.toBeNull()

    expect(tombstone.ciphertext).toBeNull()

    expect(tombstone.iv).toBeNull()

    await auth.createRefreshToken({
      userId: userA.id,

      familyId: randomUUID(),

      tokenHash: Buffer.alloc(32, 9),

      userAgentHash: Buffer.alloc(32, 8),

      expiresAt: new Date(Date.now() + 60_000),
    })

    await auth.deleteAccount(userA.id)

    const deletedUser = await prisma.user.findUniqueOrThrow({
      where: { id: userA.id },
    })

    expect(deletedUser.deletedAt).not.toBeNull()

    expect(deletedUser.username).toMatch(/^deleted-/)

    expect(
      await prisma.fileTransfer.count({ where: { senderId: userA.id } }),
    ).toBe(0)

    expect(
      await prisma.refreshToken.count({
        where: { userId: userA.id, revokedAt: null },
      }),
    ).toBe(0)
  })
})
