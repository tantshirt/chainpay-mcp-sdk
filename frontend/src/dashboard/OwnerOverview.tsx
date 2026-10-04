import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Mandate } from "@chainpay/sdk";
import { ArrowRight, Bot, Clock3, CreditCard, Inbox, ShieldCheck } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { TokenIcon } from "../ui/TokenIcon";
import { chainpayClient, connectionSeenLabel, mandateDisplayName, type AgentConnection, type AgentInboxItem, type StablecoinOption } from "../owner/runtime";
import type { RecentActivityRow } from "../owner/recentActivity";
import { shortAddress } from "../ui/marks";
import { publicReceiptPath } from "../receipts/model";
import { useSlotEstimate } from "../owner/useSlotEstimate";
import { estimatedSlotsForDays } from "../owner/slotEstimate";
import { Amount } from "../ui/amount/Amount";
import { useMintMetadataMany } from "../ui/amount/useMintMetadata";
import { formatDisplayAmount } from "../ui/amount/formatDisplayAmount";
import { SectionHeader } from "../ui/workspace/SectionHeader";
import { CollectionState } from "../ui/workspace/CollectionState";
import { knownCount, type CollectionStateKind } from "../ui/workspace/collectionModel";
import { Status, statusFor, type StatusProps } from "../ui/workspace/Status";
import { activityStatus, connectionStatusProps, requestStageStatus } from "./workspaceStatus";
import { totalsByMint, usageRing } from "./overview/spending";
import { UsageRing } from "./overview/UsageRing";
import type { CardsSummaryState } from "./overview/useCardsSummary";

/*
  Overview (EXPERIENCE.md, 2026-10-04):
  1. Spending by token: spent, remaining allowance and limit beside the one ring.
  2. Operational counts: permissions, agents, requests, cards.
  3. Attention items when real (promoted to the top); otherwise one slim line,
     and "clear" only when every input was actually checked.
  4. Recent activity beside agents and cards.
*/
export type OwnerOverviewProps = {
  mandates: Mandate[];
  connections: AgentConnection[];
  connectionState: CollectionStateKind;
  attention: AgentInboxItem[];
  activity: RecentActivityRow[];
  assets: StablecoinOption[];
  cards: CardsSummaryState & { retry: () => void };
  onRetryConnections: () => void;
  onRequests: () => void;
  onAgents: () => void;
  onCards: () => void;
  onPermissions: () => void;
  onPermission: (address: string) => void;
  onPayments: () => void;
};

const CARD_STATUS: Record<string, StatusProps["icon"]> = {
  active: "check-circle", frozen: "pause", freeze_pending: "clock", setting_up: "clock", freeze_failed: "x-circle", needs_restore: "alert-triangle",
};
const CARD_TONE: Record<string, StatusProps["tone"]> = {
  active: "positive", frozen: "neutral", freeze_pending: "info", setting_up: "info", freeze_failed: "critical", needs_restore: "warning",
};

export function OwnerOverview({ mandates, connections, connectionState, attention, activity, assets, cards, onRetryConnections, onRequests, onAgents, onCards, onPermissions, onPermission, onPayments }: OwnerOverviewProps) {
  const [slot, setSlot] = useState<{ status: "loading" | "ready" | "error"; value: bigint | null }>({ status: "loading", value: null });
  const { estimate, status: estimateStatus } = useSlotEstimate();
  useEffect(() => {
    let active = true;
    void chainpayClient.getCurrentSlot()
      .then((value) => { if (active) setSlot({ status: "ready", value }); })
      .catch(() => { if (active) setSlot({ status: "error", value: null }); });
    return () => { active = false; };
  }, []);

  const totals = useMemo(() => totalsByMint(mandates), [mandates]);
  const metadata = useMintMetadataMany(totals.map((total) => total.mint));
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const selected = totals.find((total) => total.mint === selectedMint) ?? totals.find((total) => total.active.count > 0) ?? totals[0];
  const symbol = (mint: string) => assets.find((asset) => asset.mint === mint)?.label ?? shortAddress(mint);

  const activePermissions = mandates.filter((mandate) => mandate.status === "active");
  const soon = estimate ? estimatedSlotsForDays(1, estimate) : null;
  const expiryChecked = activePermissions.length === 0 || (slot.status === "ready" && soon !== null);
  const expiryPending = activePermissions.length > 0 && (slot.status === "loading" || (slot.status === "ready" && estimateStatus === "loading"));
  const expiring = expiryChecked && slot.value !== null && soon !== null
    ? activePermissions.filter((mandate) => mandate.expiresAtSlot > slot.value! && mandate.expiresAtSlot - slot.value! <= soon)
    : [];
  const attentionCount = attention.length + expiring.length;

  const attentionSection = attentionCount > 0 && (
    <section className="cp-surface cp-overview-attention" aria-labelledby="overview-attention-title">
      <SectionHeader id="overview-attention-title" title="Needs your attention" action={<Status {...statusFor("review", `${attentionCount} ${attentionCount === 1 ? "item" : "items"}`)} />} />
      <ul className="cp-row-list">
        {attention.slice(0, 5).map((item) => (
          <li key={item.id}>
            <button type="button" className="cp-row" onClick={onRequests}>
              <span className="cp-row-icon is-info" aria-hidden="true"><Inbox size={18} /></span>
              <span className="cp-row-main"><strong>{item.title || "Payment request"}</strong><small>{item.stage === "waiting_for_approval" ? "Ready for your review" : item.stage === "blocked" ? "Needs attention before it can continue" : "More details needed"}</small></span>
              <Status {...requestStageStatus(item.stage)} />
              <span className="cp-row-action">Review <ArrowRight size={16} aria-hidden="true" /></span>
            </button>
          </li>
        ))}
        {expiring.map((mandate) => (
          <li key={mandate.address}>
            <button type="button" className="cp-row" onClick={() => onPermission(mandate.address)}>
              <span className="cp-row-icon is-warning" aria-hidden="true"><Clock3 size={18} /></span>
              <span className="cp-row-main"><strong>{mandateDisplayName(mandate, mandates, assets)}</strong><small>Expires within about a day · estimated from slot timing</small></span>
              <Status {...statusFor("review", "Expires soon")} />
              <span className="cp-row-action">Review <ArrowRight size={16} aria-hidden="true" /></span>
            </button>
          </li>
        ))}
      </ul>
      {attention.length > 5 && <Button label={`View all ${attention.length} requests`} variant="ghost" onClick={onRequests} />}
    </section>
  );

  const clearLine = attentionCount === 0 && (
    expiryPending ? (
      <div className="cp-overview-clear" data-state="loading" aria-busy="true"><Skeleton width={220} height={16} /><span className="sr-only">Checking what needs your attention…</span></div>
    ) : expiryChecked ? (
      <div className="cp-overview-clear" data-state="clear" role="status">
        <Status {...statusFor("verified", "Nothing needs your attention")} />
        <span>No requests are waiting{activePermissions.length ? " and no active permission expires within a day" : ""}.</span>
      </div>
    ) : (
      <div className="cp-overview-clear" data-state="partial" role="status">
        <Status {...statusFor("unknown", "Expiry not checked")} />
        <span>No requests are waiting in this browser. Permission expiry couldn’t be checked right now, so this isn’t a full all-clear.</span>
      </div>
    )
  );

  const ring = selected ? usageRing({ spent: selected.active.spent, limit: selected.active.limit, decimalsKnown: metadata.states[selected.mint]?.status === "verified" }) : null;
  const selectedState = selected ? metadata.states[selected.mint] : undefined;
  const ringLabel = !selected || !ring ? "" : ring.kind === "unavailable"
    ? ring.reason === "zero-limit" ? `${symbol(selected.mint)}: no active limit to measure against` : `${symbol(selected.mint)}: usage unavailable until token details load`
    : `${symbol(selected.mint)}: ${ring.percent}% of the active limit spent (${selectedState?.status === "verified" ? `${formatDisplayAmount(selected.active.spent, selectedState.decimals)} of ${formatDisplayAmount(selected.active.limit, selectedState.decimals)}` : ""})`;

  const agentCount = knownCount(connectionState, connections.length);
  const liveAgents = connections.filter((connection) => Boolean(connection.lastSeenAt)).length;
  const cardTotal = cards.state === "loaded" || cards.state === "empty" ? cards.summary.total : null;

  return (
    <div className="owner-overview cp-overview">
      {attentionSection}

      {selected && ring && (
        <section className="cp-surface cp-overview-spending" aria-labelledby="overview-spending-title">
          <SectionHeader id="overview-spending-title" title="Spending by token" description="Across loaded permissions. Each token is totalled on its own." action={<Button label="Manage permissions" variant="ghost" onClick={onPermissions} />} />
          {totals.length > 1 && (
            <SegmentedControl className="cp-segmented" label="Token" value={selected.mint} onChange={setSelectedMint}>
              {totals.map((total) => <SegmentedControlItem key={total.mint} value={total.mint} label={symbol(total.mint)} />)}
            </SegmentedControl>
          )}
          <div className="cp-overview-spending-body">
            <UsageRing state={ring} label={ringLabel} />
            <dl className="cp-figures">
              <div className="cp-figure is-lead">
                <dt><TokenIcon mint={selected.mint} size={18} /> Spent</dt>
                <dd><Amount baseUnits={selected.active.spent} mint={selected.mint} symbol={symbol(selected.mint)} size="lead" /></dd>
              </div>
              <div className="cp-figure">
                <dt>Remaining allowance</dt>
                <dd><Amount baseUnits={selected.active.remaining} mint={selected.mint} symbol={symbol(selected.mint)} showRetry={false} /></dd>
              </div>
              <div className="cp-figure">
                <dt>Limit</dt>
                <dd><Amount baseUnits={selected.active.limit} mint={selected.mint} symbol={symbol(selected.mint)} showRetry={false} /></dd>
              </div>
            </dl>
          </div>
          <p className="cp-caption">
            {selected.active.count} of {selected.permissionCount} {symbol(selected.mint)} {selected.permissionCount === 1 ? "permission is" : "permissions are"} active and counted here; paused, expired and revoked ones are left out. Remaining allowance is what agents may still spend, not a wallet balance or a card budget.
          </p>
        </section>
      )}

      <section className="cp-overview-counts" aria-label="Workspace counts">
        <CountTile icon={<ShieldCheck size={18} />} label="Active permissions" value={activePermissions.length} detail={`${mandates.length} loaded`} onClick={onPermissions} />
        <CountTile
          icon={<Bot size={18} />} label="Connected agents" value={agentCount} onClick={onAgents}
          loading={connectionState === "loading"}
          detail={connectionState === "signed-out" ? "Sign in to see" : connectionState === "failed" || connectionState === "partial" ? "Couldn’t load" : `${liveAgents} active`}
        />
        <CountTile icon={<Inbox size={18} />} label="Open requests" value={attention.length} detail="Waiting on you, in this browser" onClick={onRequests} />
        <CountTile
          icon={<CreditCard size={18} />} label="Cards" value={cardTotal} onClick={onCards}
          loading={cards.state === "loading"}
          detail={cards.state === "signed-out" ? "Sign in to see" : cards.state === "not-enabled" ? "Not switched on" : cards.state === "failed" ? "Couldn’t load" : cards.state === "loaded" ? cards.summary.lifecycle.map((row) => `${row.count} ${row.label.toLowerCase()}`).join(" · ") : cards.state === "empty" ? "None yet" : ""}
        />
      </section>

      {clearLine}

      <div className="cp-overview-columns">
        <section className="cp-surface" aria-labelledby="overview-activity-title">
          <SectionHeader id="overview-activity-title" title="Recent activity" description="Requests and payments from this browser." action={<Button label="View payments" variant="ghost" onClick={onPayments} />} />
          <CollectionState state={activity.length ? "loaded" : "empty"} noun="activity" title="No activity yet" description="Requests and payments will appear here as your agents work." compact>
            <ul className="cp-row-list">
              {activity.slice(0, 6).map((row) => (
                <li key={`${row.source}:${row.id}`} className="cp-row is-static">
                  <span className="cp-row-main"><strong>{row.label}</strong></span>
                  <Status {...activityStatus(row)} />
                  {row.receiptAddress
                    ? <a className="cp-row-action" href={publicReceiptPath(row.receiptAddress)}>Receipt <ArrowRight size={16} aria-hidden="true" /></a>
                    : <button type="button" className="cp-row-action" onClick={onRequests}>View request <ArrowRight size={16} aria-hidden="true" /></button>}
                </li>
              ))}
            </ul>
          </CollectionState>
        </section>

        <div className="cp-overview-stack">
          <section className="cp-surface" aria-labelledby="overview-agents-title">
            <SectionHeader id="overview-agents-title" title="Agents" action={<Button label="View agents" variant="ghost" onClick={onAgents} />} />
            <CollectionState
              state={connectionState} noun="agents" compact rows={2}
              description={connectionState === "signed-out" ? "Agent connections load after you sign in. Signing in is not a spending approval." : connectionState === "failed" ? "Agent connections couldn’t be refreshed." : "Connect an agent to use your spending permissions."}
              title={connectionState === "empty" ? "No agents connected" : undefined}
              action={connectionState === "empty" ? <Button label="Connect agent" variant="secondary" onClick={onAgents} /> : undefined}
              onRetry={onRetryConnections}
            >
              <ul className="cp-row-list">
                {connections.slice(0, 4).map((connection) => (
                  <li key={connection.id}>
                    <button type="button" className="cp-row" onClick={onAgents}>
                      <span className="cp-row-icon" aria-hidden="true"><Bot size={18} /></span>
                      <span className="cp-row-main"><strong>{connection.agentName}</strong><small>{connectionSeenLabel(connection.lastSeenAt)}</small></span>
                      <Status {...connectionStatusProps(connection)} />
                    </button>
                  </li>
                ))}
              </ul>
            </CollectionState>
          </section>

          <section className="cp-surface" aria-labelledby="overview-cards-title">
            <SectionHeader id="overview-cards-title" title="Cards" action={<Button label="View cards" variant="ghost" onClick={onCards} />} />
            {cards.state === "loaded" ? (
              <ul className="cp-row-list">
                {cards.summary.lifecycle.map((row) => (
                  <li key={row.key} className="cp-row is-static is-compact">
                    <span className="cp-row-main"><Status tone={CARD_TONE[row.key] ?? "unknown"} icon={CARD_STATUS[row.key] ?? "help-circle"} label={row.label} /></span>
                    <span className="cp-row-count">{row.count} {row.count === 1 ? "card" : "cards"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <CollectionState
                state={cards.state === "not-enabled" ? "empty" : cards.state} noun="cards" compact rows={2}
                title={cards.state === "not-enabled" ? "Cards aren’t switched on" : cards.state === "empty" ? "No cards yet" : undefined}
                description={cards.state === "signed-out" ? "Cards load after you sign in." : cards.state === "not-enabled" ? "This workspace doesn’t have agent cards yet." : cards.state === "failed" ? "The card list couldn’t be read." : "Give an agent a card with its own private limits."}
                action={cards.state === "empty" ? <Button label="Create a card" variant="secondary" onClick={onCards} /> : undefined}
                onRetry={cards.retry}
              />
            )}
            <p className="cp-caption">Counts only. Card limits and spending stay private until you unlock them in Cards.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

function CountTile({ icon, label, value, detail, loading = false, onClick }: { icon: ReactNode; label: string; value: number | null; detail: string; loading?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="cp-count" onClick={onClick} data-known={value !== null && !loading}>
      <span className="cp-count-label"><span aria-hidden="true">{icon}</span>{label}</span>
      {loading
        ? <span className="cp-count-value" aria-busy="true"><Skeleton width={40} height={28} /><span className="sr-only">Loading</span></span>
        : <strong className="cp-count-value">{value === null ? <span aria-label="Not available">—</span> : value}</strong>}
      <span className="cp-count-detail">{detail}</span>
    </button>
  );
}
