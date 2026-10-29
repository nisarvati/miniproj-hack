import { createPool, PHARMACIES } from "@medlink/db";
import { hashPassword } from "./auth.js";

// Development accounts: one per pharmacy, p001@pharmacy.test ... with a shared development password.
const password = process.env.PORTAL_DEV_PASSWORD ?? "medlink-dev";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const db = createPool(url);
try {
  for (const p of PHARMACIES) {
    const email = `${p.code.toLowerCase()}@pharmacy.test`;
    await db.query(
      `INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ($1, $2, $3)
       ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash, pharmacy_code = EXCLUDED.pharmacy_code`,
      [email, await hashPassword(password), p.code],
    );
    console.log(`${email}  ->  ${p.code} (${p.name})`);
  }
  console.log(`password: ${password}`);
} finally {
  await db.end();
}
