import { describe, it, expect, vi, beforeEach } from 'vitest'
import { authenticate, invalidateSep10Token } from '@/lib/stellar/sep10'
import { requestFirmQuote, deleteFirmQuote } from '@/lib/stellar/sep38'
import { SepError } from '@/lib/stellar/errors'
import type { ResolvedAnchor, Sep10Auth } from '@/types'

// sep38 obtains/refreshes JWTs through sep10 + the shared jwt cache. We mock the
// SEP-10 orchestrator so the auth/re-auth path can be driven without a real
// Freighter sign flow, leaving sep38's own 401 logic under test.
vi.mock('@/lib/stellar/sep10', () => ({
  authenticate: vi.fn(),
  invalidateSep10Token: vi.fn(),
}))

const QUOTE_SERVER = 'https://cowrie.exchange/sep38'
const PUBLIC_KEY = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234567890123456789'

const ANCHOR: ResolvedAnchor = {
  id: 'cowrie',
  name: 'Cowrie',
  homeDomain: 'cowrie.exchange',
  domain: 'cowrie.exchange',
  corridors: ['usdc-ngn'],
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  TRANSFER_SERVER_SEP0024: 'https://cowrie.exchange/sep24',
  ANCHOR_QUOTE_SERVER: QUOTE_SERVER,
  WEB_AUTH_ENDPOINT: 'https://cowrie.exchange/auth',
  SIGNING_KEY: 'GSIGN',
  NETWORK_PASSPHRASE: null,
  CURRENCIES: [],
  capabilities: { sep10: true, sep24: true, sep38: true, sep12: false },
}

const QUOTE_PARAMS = {
  sellAsset: 'stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  buyAsset: 'iso4217:NGN',
  sellAmount: '100',
  context: 'sep24' as const,
}

const QUOTE_BODY = {
  id: 'quote-abc',
  expires_at: '2030-01-01T00:00:00Z',
  price: '1600',
  total_price: '1605',
  sell_asset: QUOTE_PARAMS.sellAsset,
  sell_amount: '100',
  buy_asset: QUOTE_PARAMS.buyAsset,
  buy_amount: '160000',
  fee: { total: '5', asset: QUOTE_PARAMS.sellAsset },
}

function makeAuth(jwt: string): Sep10Auth {
  return {
    jwt,
    anchorDomain: ANCHOR.homeDomain,
    publicKey: PUBLIC_KEY,
    expiresAt: new Date(Date.now() + 3_600_000),
  }
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

type FetchMock = ReturnType<typeof vi.fn>

function callArgs(fetchMock: FetchMock, i: number): [string, RequestInit] {
  return fetchMock.mock.calls[i] as unknown as [string, RequestInit]
}

function authHeaderAt(fetchMock: FetchMock, i: number): string {
  const [, opts] = callArgs(fetchMock, i)
  return (opts.headers as Record<string, string>)['Authorization'] as string
}

beforeEach(() => {
  vi.mocked(authenticate).mockReset()
  vi.mocked(invalidateSep10Token).mockReset()
  vi.mocked(authenticate).mockResolvedValue(makeAuth('jwt-1'))
})

// ─── requestFirmQuote ─────────────────────────────────────────────────────────

describe('requestFirmQuote — POST /quote', () => {
  it('returns a parsed firm quote and POSTs to {quoteServer}/quote with Bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, QUOTE_BODY))
    vi.stubGlobal('fetch', fetchMock)

    const quote = await requestFirmQuote(ANCHOR, PUBLIC_KEY, QUOTE_PARAMS)

    expect(quote.id).toBe('quote-abc')
    expect(quote.expiresAt).toEqual(new Date('2030-01-01T00:00:00Z'))
    expect(quote.price).toBe('1600')
    expect(quote.buyAmount).toBe('160000')
    expect(quote.fee).toEqual({ total: '5', asset: QUOTE_PARAMS.sellAsset })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = callArgs(fetchMock, 0)
    expect(url).toBe(`${QUOTE_SERVER}/quote`)
    expect(opts.method).toBe('POST')
    expect(authHeaderAt(fetchMock, 0)).toBe('Bearer jwt-1')
  })

  it('maps request params to snake_case SEP-38 body fields', async () => {
    let sent: Record<string, unknown> = {}
    const fetchMock = vi.fn(async (_url: string, opts: RequestInit) => {
      sent = JSON.parse(opts.body as string) as Record<string, unknown>
      return jsonResponse(200, QUOTE_BODY)
    })
    vi.stubGlobal('fetch', fetchMock)

    await requestFirmQuote(ANCHOR, PUBLIC_KEY, QUOTE_PARAMS)

    expect(sent['sell_asset']).toBe(QUOTE_PARAMS.sellAsset)
    expect(sent['buy_asset']).toBe('iso4217:NGN')
    expect(sent['sell_amount']).toBe('100')
    expect(sent['context']).toBe('sep24')
    expect(sent).not.toHaveProperty('buy_amount')
  })

  it('on 401, invalidates the token, re-authenticates once, and retries with the fresh JWT', async () => {
    vi.mocked(authenticate)
      .mockResolvedValueOnce(makeAuth('jwt-stale'))
      .mockResolvedValueOnce(makeAuth('jwt-fresh'))

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'token expired' }))
      .mockResolvedValueOnce(jsonResponse(200, QUOTE_BODY))
    vi.stubGlobal('fetch', fetchMock)

    const quote = await requestFirmQuote(ANCHOR, PUBLIC_KEY, QUOTE_PARAMS)

    expect(quote.id).toBe('quote-abc')
    expect(authenticate).toHaveBeenCalledTimes(2)
    expect(invalidateSep10Token).toHaveBeenCalledTimes(1)
    expect(invalidateSep10Token).toHaveBeenCalledWith(ANCHOR.homeDomain, PUBLIC_KEY)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(authHeaderAt(fetchMock, 0)).toBe('Bearer jwt-stale')
    expect(authHeaderAt(fetchMock, 1)).toBe('Bearer jwt-fresh')
  })

  it('re-authenticates at most once — a second 401 surfaces as a SepError', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: 'still unauthorized' }))
    vi.stubGlobal('fetch', fetchMock)

    const caught = await requestFirmQuote(ANCHOR, PUBLIC_KEY, QUOTE_PARAMS).catch((e: unknown) => e)

    expect(caught).toBeInstanceOf(SepError)
    expect((caught as SepError).httpStatus).toBe(401)
    expect(authenticate).toHaveBeenCalledTimes(2)
    expect(invalidateSep10Token).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not re-authenticate on non-401 errors', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: 'bad asset' }))
    vi.stubGlobal('fetch', fetchMock)

    const caught = await requestFirmQuote(ANCHOR, PUBLIC_KEY, QUOTE_PARAMS).catch((e: unknown) => e)

    expect(caught).toBeInstanceOf(SepError)
    expect((caught as SepError).httpStatus).toBe(400)
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(invalidateSep10Token).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws without calling fetch when the anchor has no SEP-38 quote server', async () => {
    const noSep38 = { ...ANCHOR, capabilities: { ...ANCHOR.capabilities, sep38: false } }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestFirmQuote(noSep38, PUBLIC_KEY, QUOTE_PARAMS)).rejects.toThrow(/does not support SEP-38/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('throws when the quote response is missing an id', async () => {
    const noId: Record<string, unknown> = { ...QUOTE_BODY }
    delete noId['id']
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, noId)))

    await expect(requestFirmQuote(ANCHOR, PUBLIC_KEY, QUOTE_PARAMS)).rejects.toThrow(/"id"/)
  })
})

// ─── deleteFirmQuote ──────────────────────────────────────────────────────────

describe('deleteFirmQuote — DELETE /quote/:id', () => {
  it('issues a DELETE to {quoteServer}/quote/:id with Bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(204, null))
    vi.stubGlobal('fetch', fetchMock)

    await deleteFirmQuote(ANCHOR, PUBLIC_KEY, 'quote-abc')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = callArgs(fetchMock, 0)
    expect(url).toBe(`${QUOTE_SERVER}/quote/quote-abc`)
    expect(opts.method).toBe('DELETE')
    expect(authHeaderAt(fetchMock, 0)).toBe('Bearer jwt-1')
  })

  it('on 401, re-authenticates once and retries the delete with the fresh JWT', async () => {
    vi.mocked(authenticate)
      .mockResolvedValueOnce(makeAuth('jwt-stale'))
      .mockResolvedValueOnce(makeAuth('jwt-fresh'))

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'token expired' }))
      .mockResolvedValueOnce(jsonResponse(200, null))
    vi.stubGlobal('fetch', fetchMock)

    await deleteFirmQuote(ANCHOR, PUBLIC_KEY, 'quote-abc')

    expect(authenticate).toHaveBeenCalledTimes(2)
    expect(invalidateSep10Token).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(authHeaderAt(fetchMock, 1)).toBe('Bearer jwt-fresh')
  })

  it('url-encodes the quote id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(204, null))
    vi.stubGlobal('fetch', fetchMock)

    await deleteFirmQuote(ANCHOR, PUBLIC_KEY, 'quote/with space')

    const [url] = callArgs(fetchMock, 0)
    expect(url).toBe(`${QUOTE_SERVER}/quote/quote%2Fwith%20space`)
  })

  it('throws a SepError on a failed delete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'unknown quote' })))

    const caught = await deleteFirmQuote(ANCHOR, PUBLIC_KEY, 'missing').catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(SepError)
    expect((caught as SepError).httpStatus).toBe(404)
  })
})
