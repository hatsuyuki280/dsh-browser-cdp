import { describe, expect, it } from 'vitest'
import { DiagnosticsStore } from '../src/worker/diagnostics.ts'
import type { CdpClient } from '../src/worker/cdp-client.ts'

type Handler = (params: unknown, sessionId?: string) => void

class FakeCdp {
  handlers = new Map<string, Set<Handler>>()

  on(method: string, handler: Handler): () => void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set())
    this.handlers.get(method)!.add(handler)
    return () => this.handlers.get(method)?.delete(handler)
  }

  emit(method: string, params: unknown, sessionId = 'S1'): void {
    for (const handler of this.handlers.get(method) ?? []) handler(params, sessionId)
  }
}

const known = (): { fake: FakeCdp; store: DiagnosticsStore } => {
  const fake = new FakeCdp()
  const store = new DiagnosticsStore(fake as unknown as CdpClient)
  store.bind('S1', 'T1')
  return { fake, store }
}

describe('DiagnosticsStore', () => {
  it('captures console arguments and page exceptions per target', () => {
    const { fake, store } = known()
    fake.emit('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ value: 'first' }, { value: 42 }],
    })
    fake.emit('Runtime.exceptionThrown', {
      exceptionDetails: { text: 'boom', url: 'https://example.test/app.js', lineNumber: 7 },
    })
    fake.emit('Log.entryAdded', {
      entry: { level: 'info', text: 'browser log', source: 'network', url: 'https://example.test/' },
    })

    const entries = store.snapshot('T1', 'console', 10)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ level: 'warning', text: 'first 42' })
    expect(entries[1]).toMatchObject({ level: 'error', text: 'boom', line: 7 })
    expect(entries[2]).toMatchObject({ level: 'info', text: 'browser log', source: 'network' })
  })

  it('joins network request, response, and finish time without duplicating the request', () => {
    const { fake, store } = known()
    fake.emit('Network.requestWillBeSent', {
      requestId: 'R1',
      timestamp: 10,
      type: 'XHR',
      request: { method: 'POST', url: 'https://api.example.test/data' },
    })
    fake.emit('Network.responseReceived', {
      requestId: 'R1',
      timestamp: 10.25,
      response: { status: 201, statusText: 'Created', mimeType: 'application/json' },
    })
    fake.emit('Network.loadingFinished', { requestId: 'R1', timestamp: 10.5 })

    const entries = store.snapshot('T1', 'network', 10) as unknown as Array<Record<string, unknown>>
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      requestId: 'R1',
      method: 'POST',
      url: 'https://api.example.test/data',
      status: 201,
      statusText: 'Created',
      mimeType: 'application/json',
      resourceType: 'XHR',
      durationMs: 500,
    })
  })

  it('records a failed request and honors the snapshot limit', () => {
    const { fake, store } = known()
    for (let i = 0; i < 5; i++) {
      fake.emit('Network.requestWillBeSent', {
        requestId: `R${i}`,
        timestamp: 1,
        request: { method: 'GET', url: `https://example.test/${i}` },
      })
      if (i < 4) {
        fake.emit('Network.responseReceived', {
          requestId: `R${i}`,
          timestamp: 1.05,
          response: { status: 200, statusText: 'OK', mimeType: 'text/html' },
        })
        fake.emit('Network.loadingFinished', { requestId: `R${i}`, timestamp: 1.1 })
      }
    }
    fake.emit('Network.loadingFailed', {
      requestId: 'R4',
      timestamp: 1.1,
      errorText: 'ERR_CONNECTION_RESET',
    })

    const entries = store.snapshot('T1', 'network', 2) as unknown as Array<Record<string, unknown>>
    expect(entries).toHaveLength(2)
    expect(entries[1]).toMatchObject({
      requestId: 'R4',
      failed: true,
      errorText: 'ERR_CONNECTION_RESET',
      durationMs: 100,
    })
  })

  it('ignores events without a bound target and clears a target on teardown', () => {
    const { fake, store } = known()
    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'unknown' }] }, 'S-other')
    expect(store.snapshot('T1', 'console', 10)).toHaveLength(0)

    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'bound' }] })
    expect(store.snapshot('T1', 'console', 10)).toHaveLength(1)
    store.clear('T1')
    expect(store.snapshot('T1', 'console', 10)).toHaveLength(0)
  })
})
