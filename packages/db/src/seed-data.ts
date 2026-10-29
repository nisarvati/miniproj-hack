export interface SeedMedicine {
  code: string;
  brand: string;
  generic: string;
  dosage: string;
  form: string;
  basePrice: number;
}

export const MEDICINES: SeedMedicine[] = [
  { code: "M001", brand: "Crocin", generic: "Paracetamol", dosage: "500mg", form: "tablet", basePrice: 25 },
  { code: "M002", brand: "Dolo", generic: "Paracetamol", dosage: "650mg", form: "tablet", basePrice: 32 },
  { code: "M003", brand: "Calpol", generic: "Paracetamol", dosage: "250mg", form: "syrup", basePrice: 48 },
  { code: "M004", brand: "Combiflam", generic: "Ibuprofen + Paracetamol", dosage: "400mg/325mg", form: "tablet", basePrice: 42 },
  { code: "M005", brand: "Brufen", generic: "Ibuprofen", dosage: "400mg", form: "tablet", basePrice: 30 },
  { code: "M006", brand: "Augmentin", generic: "Amoxicillin + Clavulanic Acid", dosage: "625mg", form: "tablet", basePrice: 210 },
  { code: "M007", brand: "Azithral", generic: "Azithromycin", dosage: "500mg", form: "tablet", basePrice: 118 },
  { code: "M008", brand: "Cetzine", generic: "Cetirizine", dosage: "10mg", form: "tablet", basePrice: 22 },
  { code: "M009", brand: "Allegra", generic: "Fexofenadine", dosage: "120mg", form: "tablet", basePrice: 175 },
  { code: "M010", brand: "Pantop", generic: "Pantoprazole", dosage: "40mg", form: "tablet", basePrice: 95 },
  { code: "M011", brand: "Digene", generic: "Antacid", dosage: "200ml", form: "syrup", basePrice: 110 },
  { code: "M012", brand: "Glycomet", generic: "Metformin", dosage: "500mg", form: "tablet", basePrice: 28 },
  { code: "M013", brand: "Telma", generic: "Telmisartan", dosage: "40mg", form: "tablet", basePrice: 85 },
  { code: "M014", brand: "Ecosprin", generic: "Aspirin", dosage: "75mg", form: "tablet", basePrice: 6 },
  { code: "M015", brand: "Volini", generic: "Diclofenac", dosage: "30g", form: "gel", basePrice: 140 },
];

export interface SeedPharmacy {
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  /** Multiplier on base price, so pharmacies differ slightly. */
  priceFactor: number;
}

export const PHARMACIES: SeedPharmacy[] = [
  { code: "P001", name: "Pharmacy A - Andheri West", address: "Lokhandwala Complex, Andheri West, Mumbai", latitude: 19.1364, longitude: 72.8296, priceFactor: 1.0 },
  { code: "P002", name: "Pharmacy B - Andheri East", address: "Chakala, Andheri East, Mumbai", latitude: 19.1197, longitude: 72.8468, priceFactor: 0.92 },
  { code: "P003", name: "Pharmacy C - Juhu", address: "Juhu Tara Road, Juhu, Mumbai", latitude: 19.1075, longitude: 72.8263, priceFactor: 1.08 },
  { code: "P004", name: "Pharmacy D - Bandra West", address: "Linking Road, Bandra West, Mumbai", latitude: 19.0596, longitude: 72.8295, priceFactor: 1.04 },
  { code: "P005", name: "Pharmacy E - Powai", address: "Hiranandani Gardens, Powai, Mumbai", latitude: 19.1176, longitude: 72.906, priceFactor: 0.96 },
];

/** Fixed quantities for Crocin 500mg so the live demo is predictable (A has exactly one left). */
export const CROCIN_QUANTITIES = [1, 40, 3, 0, 25];

/** Deterministic quantity for every other medicine/pharmacy pair; null = pharmacy doesn't carry it. */
export function seedQuantity(medicineIdx: number, pharmacyIdx: number): number | null {
  const n = (medicineIdx * 7 + pharmacyIdx * 13) % 11;
  if (n === 0) return null;
  if (n <= 2) return 0;
  if (n <= 4) return n; // low stock
  return n * 6;
}

export interface SeedInventoryRow {
  medicine: SeedMedicine;
  quantity: number;
  price: number;
}

/** The starting stock for one pharmacy (by index into PHARMACIES). Used for both the central and local databases. */
export function inventoryFor(pharmacyIdx: number): SeedInventoryRow[] {
  const pharm = PHARMACIES[pharmacyIdx]!;
  const rows: SeedInventoryRow[] = [];
  for (const [mi, medicine] of MEDICINES.entries()) {
    const quantity = mi === 0 ? CROCIN_QUANTITIES[pharmacyIdx]! : seedQuantity(mi, pharmacyIdx);
    if (quantity === null) continue;
    rows.push({ medicine, quantity, price: Math.round(medicine.basePrice * pharm.priceFactor * 100) / 100 });
  }
  return rows;
}
