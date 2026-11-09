import { Inject, Injectable } from "@nestjs/common"

import { badRequest } from "../shared/http-error.filter.js"

import { BlocksRepository } from "./blocks.repository.js"
import { RelationshipEvents } from "../presence/relationship-events.js"

@Injectable()
export class BlocksService {
  constructor(
    private readonly repository: BlocksRepository,
    private readonly relationshipEvents: RelationshipEvents,
  ) {}

  list(userId: string) {
    return this.repository.list(userId)
  }

  add(userId: string, blockedId: string) {
    if (userId === blockedId)
      throw badRequest("INVALID_BLOCK", "You cannot block yourself")

    return this.repository.add(userId, blockedId).then(() => {
      this.relationshipEvents.publish({ userA: userId, userB: blockedId })
    })
  }

  remove(userId: string, blockedId: string) {
    return this.repository.remove(userId, blockedId).then(() => {
      this.relationshipEvents.publish({ userA: userId, userB: blockedId })
    })
  }
}

Inject(BlocksRepository)(BlocksService, undefined, 0)
Inject(RelationshipEvents)(BlocksService, undefined, 1)
