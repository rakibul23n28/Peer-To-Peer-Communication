import { Injectable } from "@nestjs/common"

import { ConversationsRepository } from "./conversations.repository.js"

@Injectable()
export class ConversationsService {
  constructor(
    private readonly repository: ConversationsRepository,
  ) {}

  async list(userId: string) {
    return { conversations: await this.repository.list(userId) }
  }

  async create(userId: string, peerId: string) {
    return { conversation: await this.repository.create(userId, peerId) }
  }

  memberIds(conversationId: string, userId: string) {
    return this.repository.memberIds(conversationId, userId)
  }
}
