import { createHmac } from "node:crypto"

import { Injectable } from "@nestjs/common"

import { env } from "../../config/env.js"

@Injectable()
export class TurnService {
  getCredentials(userId: string) {
    const urls = env.TURN_URLS.split(",").map((url) => url.trim()).filter(Boolean)
    if (urls.length === 0) return { iceServers: [] }

    const expiresAt = Math.floor(Date.now() / 1000) + env.TURN_CREDENTIAL_TTL_SECONDS
    const username = `${expiresAt}:${userId}`
    const credential = createHmac("sha1", env.TURN_SHARED_SECRET)
      .update(username)
      .digest("base64")

    return {
      iceServers: [{ urls, username, credential }],
      expiresAt: expiresAt * 1000,
    }
  }
}
