export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

export function stockStatus(quantity: number, lowThreshold: number): StockStatus {
  if (quantity <= 0) return "OUT_OF_STOCK";
  if (quantity <= lowThreshold) return "LOW_STOCK";
  return "IN_STOCK";
}
