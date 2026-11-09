import { Injectable } from "@nestjs/common"

export interface AccessRequestEvent {
  type: "access_request.created" | "access_request.updated"
  requestId: string
  conversationId: string
  shareId: string | null
  requesterId: string
  ownerId: string
  kind: string
  status: string
}

@Injectable()
export class AccessRequestEvents {
  private readonly listeners = new Set<(event: AccessRequestEvent) => void>()

  subscribe(listener: (event: AccessRequestEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(event: AccessRequestEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
