import { Inject, Injectable } from "@nestjs/common"

import { AuthService } from "../auth/auth.service.js"

import { notFound } from "../shared/http-error.filter.js"

import { UsersRepository } from "./users.repository.js"

@Injectable()
export class UsersService {
  constructor(
    @Inject(UsersRepository)
    private readonly users: UsersRepository,

    @Inject(AuthService)
    private readonly auth: AuthService,
  ) {}

  search(query: string) {
    return this.users.search(query)
  }

  async publicKey(userId: string) {
    const result = await this.users.publicKey(userId)

    if (!result) throw notFound("User or public key not found")

    return result
  }

  me(userId: string) {
    return this.auth.getIdentity(userId)
  }

  replacePublicKey(userId: string, publicKey: string) {
    return this.auth.replacePublicKey(userId, publicKey)
  }

  deleteAccount(userId: string) {
    return this.auth.deleteAccount(userId)
  }
}
