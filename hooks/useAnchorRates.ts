import useSWR, { useSWRConfig } from "swr";
import type { RateComparison, AnchorRate } from "@/types";
import { useState, useCallback } from "react";
import { fetchRates } from "@/lib/stellar/rates-engine";

export interface UseAnchorRatesResult {
  rates: RateComparison | undefined;
  isLoading: boolean;
  error: string | undefined;
  mutate: () => Promise<void>;
  refreshInflight: boolean;
}

export function useAnchorRates(
  corridorId: string,
  amount: string
): UseAnchorRatesResult {
  const [refreshInflight, setRefreshInflight] = useState(false);
  const { mutate: globalMutate } = useSWRConfig();

  const key = corridorId && amount ? ["rates", corridorId, amount] : null;

  const { data, error, isLoading, mutate } = useSWR<
    RateComparison,
    Error
  >(
    key,
    async ([, cid, amt]) => {
      return fetchRates(cid, amt, {
        onQuoteArrived: (quote: AnchorRate) => {
          globalMutate(
            key,
            (current: RateComparison | undefined) => {
              if (!current) return current;
              const newPending = current.pending.filter((p) => p.anchorId !== quote.anchorId);
              // Avoid duplicates
              if (current.rates.some((r) => r.anchorId === quote.anchorId)) {
                return current;
              }
              const newRates = [...current.rates, quote];
              const best = newRates.reduce((a, b) =>
                (b.totalReceived ?? 0) > (a.totalReceived ?? 0) ? b : a
              );
              return {
                ...current,
                pending: newPending,
                rates: newRates,
                bestRateId: best.anchorId,
              };
            },
            { revalidate: false }
          );
        },
      });
    },
    {
      refreshInterval: 30_000,
      revalidateOnFocus: true,
      dedupingInterval: 5_000,
    }
  );

  const refresh = useCallback(async () => {
    if (refreshInflight) return;

    setRefreshInflight(true);

    try {
      // clear stale UI immediately
      await mutate(undefined, { revalidate: false });

      // fetch fresh data
      await mutate();
    } finally {
      setRefreshInflight(false);
    }
  }, [mutate, refreshInflight]);

  return {
    rates: data,
    isLoading,
    error: error?.message,
    mutate: refresh,
    refreshInflight,
  };
}