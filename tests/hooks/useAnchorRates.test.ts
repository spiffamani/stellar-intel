import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { SWRConfig } from 'swr'
import { useAnchorRates } from '@/hooks/useAnchorRates'
import type { RateComparison } from '@/types'
import { fetchRates } from '@/lib/stellar/rates-engine'

vi.mock('@/lib/stellar/rates-engine', () => ({
  fetchRates: vi.fn(),
}))

// Fresh SWR cache per test — prevents cross-test cache pollution
const wrapper = ({ children }: { children: React.ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children)

const mockRates: RateComparison = {
  corridorId: 'usdc-ngn',
  bestRateId: 'cowrie',
  pending: [],
  rates: [
    {
      anchorId: 'cowrie',
      anchorName: 'Cowrie Exchange',
      corridorId: 'usdc-ngn',
      fee: 2,
      feeType: 'flat',
      exchangeRate: 1580,
      totalReceived: 153660,
      source: 'sep24-fee' as const,
      updatedAt: new Date(),
    },
  ],
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useAnchorRates', () => {
  it('is loading on initial render', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { result } = renderHook(() => useAnchorRates('usdc-ngn', '100'), { wrapper })
    expect(result.current.isLoading).toBe(true)
  })

  it('returns rates with bestRateId once data loads', async () => {
    vi.mocked(fetchRates).mockResolvedValueOnce({
      corridorId: 'usdc-ngn',
      bestRateId: 'cowrie',
      pending: [],
      rates: [
        { anchorId: 'cowrie', anchorName: 'Cowrie', corridorId: 'usdc-ngn', fee: 2, feeType: 'flat', exchangeRate: 1580, totalReceived: 154840, source: 'sep24-fee', updatedAt: new Date() },
        { anchorId: 'moneygram', anchorName: 'MoneyGram', corridorId: 'usdc-ngn', fee: 3, feeType: 'flat', exchangeRate: 1570, totalReceived: 153860, source: 'sep24-fee', updatedAt: new Date() },
      ]
    })

    const { result } = renderHook(() => useAnchorRates('usdc-ngn', '100'), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 })
    expect(result.current.rates?.bestRateId).toBe('cowrie')
    expect(result.current.error).toBeUndefined()
  })

  it('exposes an error string when the fetch fails', async () => {
    vi.mocked(fetchRates).mockRejectedValueOnce(new Error('All anchors failed'))

    const { result } = renderHook(() => useAnchorRates('usdc-ngn', '100'), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 2000 })
    expect(result.current.error).toBe('All anchors failed')
    expect(result.current.rates).toBeUndefined()
  })
})
