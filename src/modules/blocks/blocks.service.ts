import { Injectable } from "@nestjs/common"

import { badRequest } from "../shared/http-error.filter.js"

import { BlocksRepository } from "./blocks.repository.js"

@Injectable()
export class BlocksService {
  constructor(
    private readonly repository: BlocksRepository,
  ) {}

  list(userId: string) {
    return this.repository.list(userId)
  }

  add(userId: string, blockedId: string) {
    if (userId === blockedId)
      throw badRequest("INVALID_BLOCK", "You cannot block yourself")

    return this.repository.add(userId, blockedId)
  }

  remove(userId: string, blockedId: string) {
    return this.repository.remove(userId, blockedId)
  }
}
