import type { StockStatus } from "../../lib/api";
import { AlertIcon, CheckIcon, XIcon } from "../ui/icons";
import { Badge } from "../ui/primitives";

const STYLE = {
  IN_STOCK: { label: "In stock", tone: "ok", Icon: CheckIcon },
  LOW_STOCK: { label: "Low stock", tone: "warn", Icon: AlertIcon },
  OUT_OF_STOCK: { label: "Out of stock", tone: "bad", Icon: XIcon },
} as const;

/**
 * Whether a medicine is in stock, low in stock or out of stock, by text and icon as well as colour. The web never shows how many
 * units a pharmacy has: only this status. (The number stays in the API, which the pharmacy's own tools use.)
 */
export function StockBadge({ status, compact = false }: { status: StockStatus; compact?: boolean }) {
  const s = STYLE[status];
  return (
    <Badge tone={s.tone} className={compact ? "shrink-0" : undefined}>
      <s.Icon size={14} />
      {s.label}
    </Badge>
  );
}
