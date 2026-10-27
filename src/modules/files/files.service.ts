import { Inject, Injectable } from "@nestjs/common"

import { FileTransferStatus } from "@prisma/client"

import { FilesRepository, type FileOffer } from "./files.repository.js"

@Injectable()
export class FilesService {
  constructor(private readonly repository: FilesRepository) {}

  offer(conversationId: string, userId: string, input: FileOffer) {
    return this.repository.offer(conversationId, userId, input)
  }

  updateStatus(
    conversationId: string,
    fileId: string,
    userId: string,
    status: FileTransferStatus,
  ) {
    return this.repository.updateStatus(conversationId, fileId, userId, status)
  }

  offerSender(conversationId: string, fileId: string) {
    return this.repository.offerSender(conversationId, fileId)
  }
}

Inject(FilesRepository)(FilesService, undefined, 0)
