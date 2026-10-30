import type { NodeStatusEntry } from "../../lib/api";
import { formatSpan } from "../../lib/dashboard-data";
import { formatRelativeTime } from "../../lib/format";
import { Panel } from "./Panel";
import { StatusBadge } from "./NodeStatusGrid";

/**
 * Every pharmacy node on one line: its health as a word, when MedLink last processed an event for it, and what is waiting. Pharmacies are named by
 * code here (the full name is in the tooltip and on the node card in the Pharmacy network section), so the table stays narrow.
 */
export function NodeGlance({ nodes, now }: { nodes: NodeStatusEntry[]; now: Date }) {
  return (
    <Panel index={0} base={300} className="flex-1" title="Pharmacy nodes at a glance" description="Node health, as a word as well as a colour. Details are in the Pharmacy network section.">
      <div className="min-h-0 flex-1 overflow-x-auto">
        <table className="w-full text-left text-xs sm:text-sm">
          <caption className="sr-only">Health of each pharmacy node</caption>
          <thead className="text-xs text-muted">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-semibold">Pharmacy</th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">Health</th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">Last event</th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">Since then</th>
              <th scope="col" className="py-1.5 text-right font-semibold">Waiting</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {nodes.map((n) => (
              <tr key={n.pharmacyCode}>
                <th scope="row" className="py-1.5 pr-2 sm:pr-3 font-semibold" title={n.name}>{n.pharmacyCode}</th>
                <td className="py-1.5 pr-2 sm:pr-3"><StatusBadge status={n.status} /></td>
                <td className="py-1.5 pr-2 sm:pr-3 tabular-nums">{n.lastSyncedAt ? <time dateTime={n.lastSyncedAt}>{formatRelativeTime(n.lastSyncedAt, now)}</time> : <span className="text-muted">Never / unknown</span>}</td>
                <td className="py-1.5 pr-2 sm:pr-3 tabular-nums">{n.syncLagMs === null ? <span className="text-muted">Unknown</span> : formatSpan(n.syncLagMs)}</td>
                <td className="py-2 text-right tabular-nums">{n.unpublishedOutbox === null ? <span className="text-muted">Not available</span> : n.unpublishedOutbox}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
