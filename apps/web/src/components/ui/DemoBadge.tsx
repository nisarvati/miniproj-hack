import { Badge } from "./primitives";

/** The label every demo directory listing carries, word for word. */
export const DEMO_LISTING_LABEL = "Demo directory listing — not a confirmed MedLink partner.";

/** The longer note: stock, prices and availability are never the pharmacy's actual inventory. */
export const DEMO_NOTE =
  "The store details come from public directories. The stock, prices and availability shown here are synthetic demo data, not this pharmacy's actual inventory, and this pharmacy has not approved the use of its name.";

/** Marks a pharmacy as a demo directory listing. Renders nothing for a pharmacy that is not flagged. */
export function DemoBadge({ demo }: { demo?: boolean; independent?: boolean }) {
  if (!demo) return null;
  return (
    <Badge tone="warn" title={`${DEMO_LISTING_LABEL} ${DEMO_NOTE}`} className="!whitespace-normal">
      {DEMO_LISTING_LABEL}
    </Badge>
  );
}

/** The separate notice that stock is simulated: the named pharmacy has not reported it. */
export const simulatedInventoryNotice = (name: string) => `Inventory shown is simulated and not confirmed by ${name}.`;

export function SimulatedInventoryNotice({ pharmacy, className }: { pharmacy: { name: string; inventorySimulated?: boolean; demo?: boolean }; className?: string }) {
  if (!(pharmacy.inventorySimulated ?? pharmacy.demo)) return null;
  return <p className={className ?? "text-xs text-muted"}>{simulatedInventoryNotice(pharmacy.name)}</p>;
}
