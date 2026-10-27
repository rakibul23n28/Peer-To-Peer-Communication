import { Inject, Injectable } from "@nestjs/common"

import { PrismaService } from "../prisma/prisma.service.js"

import { notFound } from "../shared/http-error.filter.js"

@Injectable()
export class BlocksRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(blockerId: string) {
    const rows = await this.prisma.block.findMany({
      where: { blockerId },

      select: {
        blocked: { select: { id: true, username: true, displayName: true } },
      },

      orderBy: { createdAt: "desc" },
    })

    return rows.map(({ blocked }) => blocked)
  }

  async add(blockerId: string, blockedId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: blockedId, deletedAt: null },

      select: { id: true },
    })

    if (!user) throw notFound("User not found")

    await this.prisma.block.createMany({
      data: [{ blockerId, blockedId }],

      skipDuplicates: true,
    })
  }

  async remove(blockerId: string, blockedId: string): Promise<void> {
    await this.prisma.block.deleteMany({ where: { blockerId, blockedId } })
  }
}

Inject(PrismaService)(BlocksRepository, undefined, 0)
