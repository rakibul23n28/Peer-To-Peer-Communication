import { Inject, Injectable } from "@nestjs/common"

import { PrismaService } from "../prisma/prisma.service.js"

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  search(query: string) {
    return this.prisma.user.findMany({
      where: {
        deletedAt: null,

        username: { contains: query.toLowerCase(), mode: "insensitive" },
      },

      select: { id: true, username: true, displayName: true },

      orderBy: { username: "asc" },

      take: 25,
    })
  }

  async publicKey(userId: string, keyVersion?: number) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },

      select: {
        id: true,

        keys: {
          where: keyVersion === undefined
            ? { revokedAt: null }
            : { keyVersion },

          select: { publicKey: true, fingerprint: true, keyVersion: true },

          take: 1,
        },
      },
    })

    const key = user?.keys[0]

    if (!user || !key) return null

    return {
      id: user.id,

      publicKey: Buffer.from(key.publicKey).toString("base64"),

      fingerprint: key.fingerprint,

      keyVersion: key.keyVersion,
    }
  }
}

Inject(PrismaService)(UsersRepository, undefined, 0)
