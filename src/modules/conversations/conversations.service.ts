import { Inject, Injectable } from "@nestjs/common"

import { ConversationsRepository } from "./conversations.repository.js"
import { RelationshipEvents } from "../presence/relationship-events.js"

@Injectable()
export class ConversationsService {
  constructor(
    private readonly repository: ConversationsRepository,
    private readonly relationshipEvents: RelationshipEvents,
  ) {}

  async list(userId: string) {
    return { conversations: await this.repository.list(userId) }
  }

  async create(userId: string, peerId: string) {
    const conversation = await this.repository.create(userId, peerId)
    this.relationshipEvents.publish({ userA: userId, userB: peerId })
    return { conversation }
  }

  memberIds(conversationId: string, userId: string) {
    return this.repository.memberIds(conversationId, userId)
  }
}

Inject(ConversationsRepository)(ConversationsService, undefined, 0)
Inject(RelationshipEvents)(ConversationsService, undefined, 1)
