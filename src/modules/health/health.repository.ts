import { Inject, Injectable } from "@nestjs/common"

import { PrismaService } from "../prisma/prisma.service.js"

@Injectable()
export class HealthRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async checkDatabase(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`
  }
}
