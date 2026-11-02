/**
 * Worker-side bounded diagnostics store.
 *
 * The CDP worker is the only long-lived connection to the browser. A tool call
 * is a separate process, so console/network history must be captured here, on
 * the live sessions, rather than reconstructed after the fact from the page.
 *
 * Everything is bounded per target: these buffers are diagnostic aids, not a
 * proxy for a full DevTools recording, and they must never grow without limit.
 */

import type { CdpClient } from './cdp-client.ts'

export type DiagnosticsKind = 'network' | 'console'

export interface ConsoleEntry {
  ts: number
  targetId: string
  level: string
  text: string
  source?: string
  url?: string
  line?: number
}

export interface NetworkEntry {
  ts: number
  targetId: string
  requestId: string
  method: string
  url: string
  resourceType?: string
  status?: number
  statusText?: string
  mimeType?: string
  durationMs?: number
  failed?: boolean
  errorText?: string
}

interface PendingNetwork {
  targetId: string
  startedAt: number
  method: string
  url: string
  resourceType?: string
}

const MAX_ENTRIES = 300
const MAX_TEXT = 4000

const clampLimit = (value: unknown, fallback = 50): number => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_ENTRIES, Math.max(1, Math.floor(n)))
}

const clip = (value: unknown, max = MAX_TEXT): string => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text
}

/** Best-effort readable text for a Runtime.RemoteObject. */
function remoteObjectText(value: unknown): string {
  if (value == null || typeof value !== 'object') return clip(value)
  const object = value as {
    value?: unknown
    unserializableValue?: unknown
    description?: unknown
    type?: unknown
  }
  if (object.value !== undefined) return clip(object.value)
  if (object.unserializableValue !== undefined) return clip(object.unserializableValue)
  if (object.description !== undefined) return clip(object.description)
  return clip(object.type)
}

function pushBounded<T>(map: Map<string, T[]>, targetId: string, entry: T): void {
  const list = map.get(targetId) ?? []
  list.push(entry)
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES)
  map.set(targetId, list)
}

export class DiagnosticsStore {
  #cdp: CdpClient
  #sessionTargets = new Map<string, string>()
  #console = new Map<string, ConsoleEntry[]>()
  #network = new Map<string, NetworkEntry[]>()
  #pending = new Map<string, PendingNetwork>()

  constructor(cdp: CdpClient) {
    this.#cdp = cdp

    cdp.on('Runtime.consoleAPICalled', (params, sessionId) => {
      const targetId = this.#targetOf(sessionId)
      if (!targetId) return
      const p = params as { type?: unknown; args?: unknown[]; timestamp?: unknown }
      const level = typeof p.type === 'string' ? p.type : 'log'
      const text = Array.isArray(p.args) ? p.args.map(remoteObjectText).join(' ') : ''
      pushBounded(this.#console, targetId, {
        ts: Date.now(),
        targetId,
        level,
        text,
      })
    })

    cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
      const targetId = this.#targetOf(sessionId)
      if (!targetId) return
      const p = params as {
        timestamp?: unknown
        exceptionDetails?: {
          text?: unknown
          url?: unknown
          lineNumber?: unknown
          exception?: { description?: unknown }
        }
      }
      const details = p.exceptionDetails ?? {}
      const text =
        details.exception?.description ??
        details.text ??
        'Uncaught exception'
      pushBounded(this.#console, targetId, {
        ts: Date.now(),
        targetId,
        level: 'error',
        text: clip(text),
        ...(typeof details.url === 'string' ? { url: details.url } : {}),
        ...(typeof details.lineNumber === 'number' ? { line: details.lineNumber } : {}),
      })
    })

    cdp.on('Log.entryAdded', (params, sessionId) => {
      const targetId = this.#targetOf(sessionId)
      if (!targetId) return
      const p = params as {
        entry?: {
          level?: unknown
          text?: unknown
          source?: unknown
          url?: unknown
          lineNumber?: unknown
        }
      }
      const entry = p.entry ?? {}
      pushBounded(this.#console, targetId, {
        ts: Date.now(),
        targetId,
        level: typeof entry.level === 'string' ? entry.level : 'log',
        text: clip(entry.text),
        ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
        ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
        ...(typeof entry.lineNumber === 'number' ? { line: entry.lineNumber } : {}),
      })
    })

    cdp.on('Network.requestWillBeSent', (params, sessionId) => {
      const targetId = this.#targetOf(sessionId)
      if (!targetId) return
      const p = params as {
        requestId?: unknown
        timestamp?: unknown
        type?: unknown
        request?: { method?: unknown; url?: unknown }
      }
      const requestId = typeof p.requestId === 'string' ? p.requestId : ''
      if (requestId === '') return
      const request = p.request ?? {}
      const startedAt = typeof p.timestamp === 'number' ? p.timestamp : Date.now() / 1000
      this.#pending.set(requestId, {
        targetId,
        startedAt,
        method: typeof request.method === 'string' ? request.method : 'GET',
        url: clip(request.url),
        ...(typeof p.type === 'string' ? { resourceType: p.type } : {}),
      })
    })

    cdp.on('Network.responseReceived', (params, sessionId) => {
      const targetId = this.#targetOf(sessionId)
      if (!targetId) return
      const p = params as {
        requestId?: unknown
        timestamp?: unknown
        response?: { status?: unknown; statusText?: unknown; mimeType?: unknown }
      }
      const requestId = typeof p.requestId === 'string' ? p.requestId : ''
      if (requestId === '') return
      const pending = this.#pending.get(requestId)
      const response = p.response ?? {}
      const entry: NetworkEntry = {
        ts: Date.now(),
        targetId,
        requestId,
        method: pending?.method ?? 'GET',
        url: pending?.url ?? '',
        ...(pending?.resourceType ? { resourceType: pending.resourceType } : {}),
        ...(typeof response.status === 'number' ? { status: response.status } : {}),
        ...(typeof response.statusText === 'string' ? { statusText: response.statusText } : {}),
        ...(typeof response.mimeType === 'string' ? { mimeType: response.mimeType } : {}),
        ...(typeof p.timestamp === 'number'
          ? { durationMs: Math.max(0, Math.round((p.timestamp - (pending?.startedAt ?? p.timestamp)) * 1000)) }
          : {}),
      }
      pushBounded(this.#network, targetId, entry)
    })

    cdp.on('Network.loadingFinished', (params, sessionId) => {
      const targetId = this.#targetOf(sessionId)
      if (!targetId) return
      const p = params as { requestId?: unknown; timestamp?: unknown }
      const requestId = typeof p.requestId === 'string' ? p.requestId : ''
      if (requestId === '') return
      const pending = this.#pending.get(requestId)
      if (!pending) return
      // The response entry already carries status; only the duration is added
      // here so a normal request is not duplicated.
      const list = this.#network.get(targetId) ?? []
      const entry = [...list].reverse().find((item) => item.requestId === requestId)
      if (entry && typeof p.timestamp === 'number') {
        entry.durationMs = Math.max(0, Math.round((p.timestamp - pending.startedAt) * 1000))
      }
      this.#pending.delete(requestId)
    })

    cdp.on('Network.loadingFailed', (params, sessionId) => {
      const targetId = this.#targetOf(sessionId)
      if (!targetId) return
      const p = params as { requestId?: unknown; timestamp?: unknown; errorText?: unknown; canceled?: unknown }
      const requestId = typeof p.requestId === 'string' ? p.requestId : ''
      if (requestId === '') return
      const pending = this.#pending.get(requestId)
      this.#pending.delete(requestId)
      pushBounded(this.#network, targetId, {
        ts: Date.now(),
        targetId,
        requestId,
        method: pending?.method ?? 'GET',
        url: pending?.url ?? '',
        ...(pending?.resourceType ? { resourceType: pending.resourceType } : {}),
        failed: true,
        errorText: clip(p.errorText ?? (p.canceled === true ? 'canceled' : 'request failed')),
        ...(typeof p.timestamp === 'number' && pending
          ? { durationMs: Math.max(0, Math.round((p.timestamp - pending.startedAt) * 1000)) }
          : {}),
      })
    })
  }

  #targetOf(sessionId: string | undefined): string | undefined {
    return sessionId === undefined ? undefined : this.#sessionTargets.get(sessionId)
  }

  bind(sessionId: string, targetId: string): void {
    this.#sessionTargets.set(sessionId, targetId)
  }

  clear(targetId: string): void {
    this.#console.delete(targetId)
    this.#network.delete(targetId)
    for (const [requestId, pending] of this.#pending) {
      if (pending.targetId === targetId) this.#pending.delete(requestId)
    }
  }

  snapshot(targetId: string, kind: DiagnosticsKind, limit = 50): ConsoleEntry[] | NetworkEntry[] {
    const count = clampLimit(limit)
    const source = kind === 'console' ? this.#console.get(targetId) : this.#network.get(targetId)
    return (source ?? []).slice(-count)
  }
}
