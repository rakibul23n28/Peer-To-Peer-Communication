import { Inject, Injectable } from "@nestjs/common"

import { PrismaService } from "../prisma/prisma.service.js"

@Injectable()
export class HealthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async checkDatabase(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`
  }
}

Inject(PrismaService)(HealthRepository, undefined, 0)
