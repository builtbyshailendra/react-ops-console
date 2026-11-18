// Demo sign-in and the Connect transport that carries the token.

import type { Interceptor } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-web'

export const DEMO_USERS = [
  { token: 'demo-asha', name: 'asha', role: 'responder' },
  { token: 'demo-ravi', name: 'ravi', role: 'responder' },
  { token: 'demo-viewer', name: 'guest', role: 'viewer' },
] as const

export type DemoUser = (typeof DEMO_USERS)[number]

// sessionStorage, not localStorage: each tab can be a different person,
// which is how you try the two-responder conflict by hand.
const KEY = 'ops-console-user'

export function loadUser(): DemoUser | undefined {
  try {
    const token = sessionStorage.getItem(KEY)
    return DEMO_USERS.find((u) => u.token === token)
  } catch {
    return undefined
  }
}

export function saveUser(user: DemoUser | undefined): void {
  try {
    if (user) sessionStorage.setItem(KEY, user.token)
    else sessionStorage.removeItem(KEY)
  } catch {
    /* storage blocked: the choice lasts until reload */
  }
}

export function makeTransport(token: string) {
  const auth: Interceptor = (next) => (req) => {
    req.header.set('authorization', `Bearer ${token}`)
    return next(req)
  }
  return createConnectTransport({
    baseUrl: window.location.origin,
    interceptors: [auth],
    // Methods marked NO_SIDE_EFFECTS in the contract go out as GET.
    useHttpGet: true,
  })
}
