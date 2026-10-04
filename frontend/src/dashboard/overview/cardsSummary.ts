import type { CardView } from "@chainpay/sdk";
import { cardStatus, stateAppearance } from "../cards/lifecycle";
import type { StatusIcon, StatusTone } from "../../ui/workspace/Status";

/*
  Wallet-scoped Cards summary for Overview (EXPERIENCE.md, Cards row).

  Reads only the public card list through the Cards source interface and
  reduces it to counts per lifecycle state. Nothing private leaves here: no
  budget, balance, statement or credit figure is read or returned. Private
  amounts stay behind the Cards unlock.
*/
/** Tone and icon come from the same state map the Cards area uses, so a state looks the same on both. */
export type CardsLifecycleCount = { key: string; label: string; tone: StatusTone; icon: StatusIcon; count: number };
export type CardsSummary = { total: number; lifecycle: CardsLifecycleCount[] };

export function summarizeCards(cards: readonly CardView[]): CardsSummary {
  const counts = new Map<string, CardsLifecycleCount>();
  for (const card of cards) {
    const status = cardStatus(card);
    const existing = counts.get(status.key);
    if (existing) existing.count += 1;
    else counts.set(status.key, { key: status.key, label: status.label, ...stateAppearance(status.key), count: 1 });
  }
  return { total: cards.length, lifecycle: [...counts.values()] };
}
