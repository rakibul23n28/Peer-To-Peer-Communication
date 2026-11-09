import { Inject, Injectable } from "@nestjs/common"

import {
  AccessRequestsRepository,
  type AccessRequestRole,
  type CreateAccessRequest,
} from "./access-requests.repository.js"
import { AccessRequestEvents } from "./access-request-events.js"

@Injectable()
export class AccessRequestsService {
  constructor(
    private readonly repository: AccessRequestsRepository,
    private readonly events: AccessRequestEvents,
  ) {}

  async create(input: CreateAccessRequest) {
    const request = await this.repository.create(input)
    this.publish(request, "access_request.created")
    return serializeAccessRequest(request)
  }

  async list(userId: string, role: AccessRequestRole, status?: string) {
    const requests = await this.repository.list(userId, role, status)
    return requests.map(serializeAccessRequest)
  }

  async cancel(id: string, requesterId: string) {
    const request = await this.repository.cancel(id, requesterId)
    this.publish(request, "access_request.updated")
    return serializeAccessRequest(request)
  }

  async decline(id: string, ownerId: string) {
    const request = await this.repository.decline(id, ownerId)
    this.publish(request, "access_request.updated")
    return serializeAccessRequest(request)
  }

  async fulfill(id: string, ownerId: string) {
    const request = await this.repository.fulfill(id, ownerId)
    this.publish(request, "access_request.updated")
    return serializeAccessRequest(request)
  }

  private publish(request: {
    id: string
    conversationId: string
    shareId: string | null
    requesterId: string
    ownerId: string
    kind: string
    status: string
  }, type: "access_request.created" | "access_request.updated") {
    this.events.publish({
      type,
      requestId: request.id,
      conversationId: request.conversationId,
      shareId: request.shareId,
      requesterId: request.requesterId,
      ownerId: request.ownerId,
      kind: request.kind,
      status: request.status,
    })
  }
}

function serializeAccessRequest(request: {
  id: string
  conversationId: string
  shareId: string | null
  requesterId: string
  ownerId: string
  kind: string
  noteCiphertext?: Uint8Array | null
  noteIv?: Uint8Array | null
  status: string
  createdAt: Date
  resolvedAt: Date | null
  expiresAt: Date
}) {
  return {
    id: request.id,
    conversationId: request.conversationId,
    shareId: request.shareId,
    requesterId: request.requesterId,
    ownerId: request.ownerId,
    kind: request.kind,
    noteCiphertext: request.noteCiphertext
      ? Buffer.from(request.noteCiphertext).toString("base64")
      : null,
    noteIv: request.noteIv ? Buffer.from(request.noteIv).toString("base64") : null,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    resolvedAt: request.resolvedAt?.toISOString() ?? null,
    expiresAt: request.expiresAt.toISOString(),
  }
}

Inject(AccessRequestsRepository)(AccessRequestsService, undefined, 0)
Inject(AccessRequestEvents)(AccessRequestsService, undefined, 1)
