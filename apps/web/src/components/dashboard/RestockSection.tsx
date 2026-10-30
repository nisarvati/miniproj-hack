"use client";

import type { PortalAnalytics } from "../../lib/portal";
import { Alert, Button, Skeleton } from "../ui/primitives";
import { COLORS, Donut } from "./charts";
import { privateMessage, type Access, type Loadable } from "./InventorySection";
import { Panel, PrivateNote, Section } from "./Panel";

/** Restock plans are one pharmacy's private notes, so this is staff-only. It only reads: nothing here creates, changes or completes a plan. */
export function RestockSection({ access, mine }: { access: Access; mine: Loadable<PortalAnalytics> }) {
  const m = mine.data;
  const staff = access.kind === "staff" ? access.session : null;
  return (
    <Section id="restock" title="Restock planning" intro="Plans are notes about what a pharmacy intends to reorder. They never change stock.">
      {access.kind === "loading" ? (
        <Skeleton className="h-24" />
      ) : !staff ? (
        <PrivateNote title="Restock plans">{privateMessage(access, "Plans")}</PrivateNote>
      ) : mine.status === "error" && !m ? (
        <Alert tone="bad" title="We couldn't load your restock plans" action={<Button size="sm" onClick={mine.reload}>Try again</Button>}>{mine.error?.message}</Alert>
      ) : !m ? (
        <Skeleton className="h-48" />
      ) : !m.plans.available ? (
        <Panel title="Plan status" className="max-w-xl" description={`${staff.pharmacy.name} (${staff.pharmacy.code})`}><p className="text-sm text-muted">Restock plans can&apos;t be read right now. Nothing is shown rather than a zero.</p></Panel>
      ) : (
        <div className="grid min-h-min grid-cols-1 content-start gap-3 md:grid-cols-2 lg:grid-cols-12">
          <Panel index={0} className="lg:col-span-7" title="Plan status" description={`${staff.pharmacy.name} (${staff.pharmacy.code}). All plans, as they stand today.`}>
            {Object.values(m.plans.byStatus).reduce((a, b) => a + b, 0) === 0 ? (
              <p className="text-sm text-muted">No restock plans yet. Plan one from a low-stock alert in the portal.</p>
            ) : (
              <div className="max-w-lg py-2">
                <Donut size={176} label="Restock plans by status" centre={{ value: m.plans.open, caption: "open" }}
                  segments={[{ label: "Planned", value: m.plans.byStatus.PLANNED, color: COLORS.brandSoft }, { label: "In progress", value: m.plans.byStatus.IN_PROGRESS, color: COLORS.brand }, { label: "Completed", value: m.plans.byStatus.COMPLETED, color: COLORS.ok }, { label: "Cancelled", value: m.plans.byStatus.CANCELLED, color: COLORS.neutral }]} />
              </div>
            )}
          </Panel>
          <Panel index={1} className="lg:col-span-5" title="Open and overdue" description="Plans that still need doing.">
            <div className="grid grid-cols-2 gap-3">
              <p className="rounded-xl bg-brand-soft px-4 py-3 text-sm text-ink"><span className="block text-4xl font-bold leading-none tabular-nums">{m.plans.open}</span>{" "}open <span className="mt-1 block text-muted">(planned or in progress)</span></p>
              <p className={`rounded-xl px-4 py-3 text-sm text-ink ${m.plans.overdue > 0 ? "bg-warn-soft" : "bg-brand-soft"}`}><span className="block text-4xl font-bold leading-none tabular-nums">{m.plans.overdue}</span>{" "}overdue <span className="mt-1 block text-muted">(open plans whose target date has passed)</span></p>
            </div>
            <p className="text-xs text-muted">A plan is a note. It never changes stock; stock changes only when staff record a restock.</p>
          </Panel>
        </div>
      )}
    </Section>
  );
}
