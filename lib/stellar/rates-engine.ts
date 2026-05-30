import { AnchorRate, RateComparison } from '@/types'
import { getAnchorsByCorridorId } from './anchors'

export interface RatesEngineOptions {
  onQuoteArrived?: (quote: AnchorRate) => void;
  timeoutMs?: number;
}

export async function fetchRates(
  corridorId: string,
  amount: string,
  options?: RatesEngineOptions
): Promise<RateComparison> {
  const anchors = getAnchorsByCorridorId(corridorId)
  const timeoutMs = options?.timeoutMs ?? 1500; // 1.5s MVP timeout
  
  const pending: { anchorId: string; anchorName: string }[] = []
  const quotes: AnchorRate[] = []
  
  const promises = anchors.map(async (anchor, index) => {
    pending.push({ anchorId: anchor.id, anchorName: anchor.name })
    
    // Simulate varying network delays for demonstration (Mock friendly)
    // Anchor 0 is fast, Anchor 1 is slow, others in between
    const delay = index === 0 ? 500 : index === 1 ? 3000 : 1000;
    
    // Create a mock realistic quote
    const feeNum = 2.5 + (index * 0.5);
    const amountNum = Number(amount);
    const exchangeRate = 1580 + (index * 5);
    const totalReceived = (amountNum - feeNum) * exchangeRate;
    
    const rate: AnchorRate = {
      anchorId: anchor.id,
      anchorName: anchor.name,
      corridorId,
      fee: feeNum,
      feeType: 'flat',
      exchangeRate,
      totalReceived: totalReceived > 0 ? totalReceived : 0,
      source: index % 2 === 0 ? 'sep38' : 'sep24-fee',
      // Firm quotes get a 30s expiration
      expiresAt: index % 2 === 0 ? new Date(Date.now() + 30000) : undefined,
      updatedAt: new Date(),
    }
    
    const fetchPromise = new Promise<AnchorRate>((resolve) => {
      setTimeout(() => {
        resolve(rate)
      }, delay);
    })
    
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, timeoutMs)
    });
    
    const result = await Promise.race([fetchPromise, timeoutPromise]);
    
    if (result) {
      // Arrived before timeout
      const pIdx = pending.findIndex(p => p.anchorId === anchor.id);
      if (pIdx > -1) pending.splice(pIdx, 1);
      quotes.push(result);
    } else {
      // Timeout reached, wait in background
      fetchPromise.then((r) => {
        options?.onQuoteArrived?.(r);
      }).catch(console.error);
    }
  });

  await Promise.allSettled(promises);

  let bestRateId = '';
  if (quotes.length > 0) {
    const best = quotes.reduce((a, b) => ((b.totalReceived ?? 0) > (a.totalReceived ?? 0) ? b : a));
    bestRateId = best.anchorId;
  }

  return {
    corridorId,
    rates: quotes,
    pending,
    bestRateId
  }
}
