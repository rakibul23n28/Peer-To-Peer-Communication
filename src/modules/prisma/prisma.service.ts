import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common"

import { PrismaClient } from "@prisma/client"

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name)

  constructor() {
    super({ log: [] })
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect()
    } catch (error) {
      this.logger.error(
        "Could not connect to the configured PostgreSQL database",
      )

      throw error
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
