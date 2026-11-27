import type { SignalizedIntersection } from './mapData';

export function getIntersectionSignal(
  _ix: SignalizedIntersection,
  _elapsed: number
): { pedCrossNS: boolean; pedCrossEW: boolean; nsGreen: boolean; ewGreen: boolean } {
  return { pedCrossNS: true, pedCrossEW: false, nsGreen: true, ewGreen: false };
}
