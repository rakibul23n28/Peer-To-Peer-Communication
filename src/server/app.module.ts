import { Module } from "@nestjs/common"

import { AuthModule } from "../modules/auth/auth.module.js"

import { BlocksModule } from "../modules/blocks/blocks.module.js"

import { ConversationsModule } from "../modules/conversations/conversations.module.js"

import { FilesModule } from "../modules/files/files.module.js"

import { GatewayModule } from "../modules/gateway/gateway.module.js"

import { HealthModule } from "../modules/health/health.module.js"

import { MessagesModule } from "../modules/messages/messages.module.js"

import { PrismaModule } from "../modules/prisma/prisma.module.js"

import { UsersModule } from "../modules/users/users.module.js"

import { TurnModule } from "../modules/turn/turn.module.js"

@Module({
  imports: [
    PrismaModule,

    AuthModule,

    UsersModule,

    TurnModule,

    BlocksModule,

    ConversationsModule,

    MessagesModule,

    FilesModule,

    GatewayModule,

    HealthModule,
  ],
})
export class AppModule {}
