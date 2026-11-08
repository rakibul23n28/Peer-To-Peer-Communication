import { HttpException, Inject, Injectable } from "@nestjs/common"

import { SharedFoldersEvents } from "./shared-folders-events.js"
import { SharedFoldersRepository, type NewSharedFolder } from "./shared-folders.repository.js"

@Injectable()
export class SharedFoldersService {
  private readonly createWindows = new Map<string, number[]>()

  constructor(
    private readonly repository: SharedFoldersRepository,
    private readonly events: SharedFoldersEvents,
  ) {}

  async create(conversationId: string, userId: string, input: NewSharedFolder) {
    this.enforceCreateRateLimit(userId)
    const record = await this.repository.create(conversationId, userId, input)
    this.events.publish({
      type: "shared_folder.created",
      id: record.id,
      conversationId,
      ownerId: userId,
      createdAt: record.createdAt.toISOString(),
    })
    return record
  }

  list(conversationId: string, userId: string) {
    return this.repository.list(conversationId, userId)
  }

  get(id: string, userId: string) {
    return this.repository.get(id, userId)
  }

  async revoke(id: string, userId: string) {
    const result = await this.repository.revoke(id, userId)
    this.events.publish({
      type: "shared_folder.revoked",
      ...result,
      ownerId: userId,
    })
    return result
  }

  private enforceCreateRateLimit(userId: string): void {
    const now = Date.now()
    const recent = (this.createWindows.get(userId) ?? []).filter(
      (createdAt) => now - createdAt < 60_000,
    )
    if (recent.length >= 20) {
      throw new HttpException(
        {
          code: "SHARED_FOLDER_RATE_LIMITED",
          message: "Too many folder shares. Try again in a minute.",
          retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - recent[0])) / 1000)),
        },
        429,
      )
    }
    recent.push(now)
    this.createWindows.set(userId, recent)
    if (this.createWindows.size > 10_000) {
      for (const [key, timestamps] of this.createWindows) {
        if (!timestamps.some((createdAt) => now - createdAt < 60_000)) {
          this.createWindows.delete(key)
        }
      }
    }
  }
}

Inject(SharedFoldersRepository)(SharedFoldersService, undefined, 0)
Inject(SharedFoldersEvents)(SharedFoldersService, undefined, 1)
