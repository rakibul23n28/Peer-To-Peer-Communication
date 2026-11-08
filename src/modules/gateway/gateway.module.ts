import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"

import { ConversationsModule } from "../conversations/conversations.module.js"

import { FilesModule } from "../files/files.module.js"
import { SharedFoldersModule } from "../shared-folders/shared-folders.module.js"

import { MessagesModule } from "../messages/messages.module.js"

import { OrbitGateway } from "./orbit.gateway.js"

@Module({
  imports: [
    AuthModule,
    ConversationsModule,
    MessagesModule,
    FilesModule,
    SharedFoldersModule,
  ],

  providers: [OrbitGateway],
})
export class GatewayModule {}
