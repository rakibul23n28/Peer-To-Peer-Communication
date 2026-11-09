import { Injectable } from "@nestjs/common"

@Injectable()
export class PrivacySettingsEvents {
  private readonly listeners = new Set<(userId: string) => void>()

  subscribe(listener: (userId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(userId: string): void {
    for (const listener of this.listeners) listener(userId)
  }
}
