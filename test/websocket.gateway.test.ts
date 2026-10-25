import { describe, expect, it, vi } from 'vitest'

import { normalizeOrbitMessage } from '../src/auth/orbitSocket.js'
import { OrbitGateway } from '../src/modules/gateway/orbit.gateway.js'

describe('Orbit websocket negotiation', () => {
  it('accepts the supported protocol and rejects unsupported ones', () => {
    const gateway = new OrbitGateway(
      { verifyAccessToken: async () => 'user-1' } as any,
      {} as any,
      {} as any,
      {} as any,
    )

    expect(gateway.handleProtocols(['orbit.v1', 'orbit.token.jwt-test'])).toBe('orbit.v1')
    expect(gateway.handleProtocols(['orbit.token.jwt-test'])).toBe('orbit.v1')
    expect(gateway.handleProtocols(['mqtt'])).toBe(false)
  })

  it('accepts direct Nest websocket ACK payloads as valid messages', () => {
    expect(normalizeOrbitMessage({ type: 'auth.ok', id: 'auth-1', payload: {} })).toEqual({
      event: 'auth.ok',
      data: { type: 'auth.ok', id: 'auth-1', payload: {} },
    })

    expect(normalizeOrbitMessage({ event: 'message.new', data: { type: 'message.new', payload: { id: 'm-1' } } })).toEqual({
      event: 'message.new',
      data: { type: 'message.new', payload: { id: 'm-1' } },
    })
  })

  it('closes unauthenticated sockets with the token-expired close code', async () => {
    const gateway = new OrbitGateway(
      { verifyAccessToken: async () => 'user-1' } as any,
      {} as any,
      {} as any,
      {} as any,
    )

    const close = vi.fn()
    const client = { close } as unknown as WebSocket

    await expect((gateway as any).authenticatedUser(client)).rejects.toThrow('Authentication required')
    expect(close).toHaveBeenCalledWith(4401, 'Authentication required')
  })
})
