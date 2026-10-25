import {
  Body,
  Controller,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common"

import { FileTransferStatus } from "@prisma/client"

import { z } from "zod"

import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"

import { decodeBase64 } from "../messages/messages.repository.js"

import { FilesService } from "./files.service.js"

const offerSchema = z
  .object({
    fileId: z.string().uuid(),

    clientMsgId: z.string().uuid(),

    ciphertext: z.string().min(1).max(90_000),

    iv: z.string().min(1).max(128),

    keyVersion: z.number().int().positive(),

    nameEnc: z.string().min(1).max(90_000),

    nameIv: z.string().min(1).max(128),

    size: z.string().regex(/^\d{1,18}$/),

    mime: z.string().min(1).max(255),

    sha256: z.string().min(43).max(44),

    thumbEnc: z.string().min(1).max(6000).optional(),

    thumbIv: z.string().min(1).max(128).optional(),

    width: z.number().int().positive().optional(),

    height: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (input) => (input.thumbEnc === undefined) === (input.thumbIv === undefined),
    {
      message: "Thumbnail ciphertext and IV must be provided together",
    },
  )

const statusSchema = z
  .object({ status: z.nativeEnum(FileTransferStatus) })
  .strict()

@Controller("v1/conversations/:conversationId/files")
@UseGuards(AuthGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post("offer")
  offer(
    @Req() request: AuthRequest,

    @Param("conversationId") conversationId: string,

    @Body() body: unknown,
  ) {
    z.string().uuid().parse(conversationId)

    const input = offerSchema.parse(body)

    return this.files.offer(conversationId, request.userId, {
      fileId: input.fileId,

      clientMsgId: input.clientMsgId,

      ciphertext: decodeBase64(input.ciphertext, 1, 65_536, "Ciphertext"),

      iv: decodeBase64(input.iv, 1, 32, "IV"),

      keyVersion: input.keyVersion,

      nameEnc: decodeBase64(input.nameEnc, 1, 65_536, "Encrypted file name"),

      nameIv: decodeBase64(input.nameIv, 1, 32, "File name IV"),

      size: BigInt(input.size),

      mime: input.mime,

      sha256: decodeBase64(input.sha256, 32, 32, "SHA-256 digest"),

      thumbEnc: input.thumbEnc
        ? decodeBase64(input.thumbEnc, 1, 4096, "Encrypted thumbnail")
        : undefined,

      thumbIv: input.thumbIv
        ? decodeBase64(input.thumbIv, 1, 32, "Thumbnail IV")
        : undefined,

      width: input.width,

      height: input.height,
    })
  }

  @Patch(":fileId")
  updateStatus(
    @Req() request: AuthRequest,

    @Param("conversationId") conversationId: string,

    @Param("fileId") fileId: string,

    @Body() body: unknown,
  ) {
    z.string().uuid().parse(conversationId)

    z.string().uuid().parse(fileId)

    return this.files.updateStatus(
      conversationId,

      fileId,

      request.userId,

      statusSchema.parse(body).status,
    )
  }
}
