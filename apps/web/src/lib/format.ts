const inrWhole = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inrExact = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₹25 for a whole price, ₹23.50 (never ₹23.5) when there are paise. */
export const formatPrice = (price: number) => (Number.isInteger(price) ? inrWhole : inrExact).format(price);

export function formatDistance(km: number): string {
  if (km < 0.1) return "Less than 100 m away";
  if (km < 1) return `${Math.round(km * 10) * 100} m away`;
  return `${km.toFixed(1)} km away`;
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return "unknown";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** "12 s ago", "3 min ago": for live stock, where seconds matter. Falls back to formatRelativeTime for older times. */
export function formatAge(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) return "unknown";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  return formatRelativeTime(iso, now);
}

export const pluralise = (n: number, one: string, many = one === "pharmacy" ? "pharmacies" : `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A restock notification's text as the web shows it. The stored message can end with how many units the pharmacy has ("(12 available)");
 * the web only says that the medicine is back in stock, so that count is left off the page (the stored text is not changed).
 */
export const withoutStockCount = (message: string) => message.replace(/\s*\(\d+ available\)/g, "");

/** A duration with its unit: "850 ms", "1.2 s", "3 min 20 s", "2 hr 5 min". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} hr ${minutes - hours * 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} hr`;
}
