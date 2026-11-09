import { Injectable } from "@nestjs/common"

export interface PresenceDelivery {
  recipients: string[]
  event: "presence.update" | "share.availability" | "share.viewers"
  payload: Record<string, unknown>
}

@Injectable()
export class PresenceEvents {
  private readonly listeners = new Set<(delivery: PresenceDelivery) => void>()

  subscribe(listener: (delivery: PresenceDelivery) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(delivery: PresenceDelivery): void {
    for (const listener of this.listeners) listener(delivery)
  }
}
