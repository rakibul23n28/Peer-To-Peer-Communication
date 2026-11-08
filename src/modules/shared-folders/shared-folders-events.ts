import { Injectable } from "@nestjs/common"

export type SharedFolderEvent =
  | { type: "shared_folder.created"; id: string; conversationId: string; ownerId: string; createdAt: string }
  | { type: "shared_folder.revoked"; id: string; conversationId: string; ownerId: string }

@Injectable()
export class SharedFoldersEvents {
  private readonly listeners = new Set<(event: SharedFolderEvent) => void>()

  subscribe(listener: (event: SharedFolderEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(event: SharedFolderEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
