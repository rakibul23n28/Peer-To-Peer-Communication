import { Injectable } from "@nestjs/common"

export interface RelationshipChange {
  userA: string
  userB: string
}

@Injectable()
export class RelationshipEvents {
  private readonly listeners = new Set<(change: RelationshipChange) => void>()

  subscribe(listener: (change: RelationshipChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(change: RelationshipChange): void {
    for (const listener of this.listeners) listener(change)
  }
}
