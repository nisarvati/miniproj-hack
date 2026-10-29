import { randomBytes } from "node:crypto";
import { createPool } from "@medlink/db";
import { hashPassword } from "../apps/pharmacy-portal/src/auth.js";

/**
 * npm run perf:measure -- --yes [--pharmacy P005] [--medicine M006] [--pairs 10]
 *
 * Measures, on the running local stack, with real requests:
 *   transaction   how long POST /portal/sales or /portal/restocks takes to answer (the 500 ms target is for this)
 *   search        from that answer until GET /api/search shows the new stock (the pipeline: outbox, connector, Redis, sync, live stock)
 *   stream        from that answer until GET /api/stream announces the change (the ~5 s target is for the pipeline end to end)
 *
 * What it changes: nothing that lasts. It makes `pairs` pairs of "sell 1" then "restock 1" of one medicine, so stock ends where it began (it checks, and
 * says if not). It uses a throwaway staff account that it creates and deletes, removes the movement-history rows it made, and refuses to run if anyone is
 * waiting for a restock of that medicine (a restock would notify them). The sales and restocks themselves went through the pipeline, so their events stay in
 * the pharmacy's outbox and the streams, like any other change. It needs the portal, search API, connector and sync service running (npm run dev:all).
 */
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => args[args.indexOf(`--${name}`) + 1] && args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1]! : fallback;
if (!args.includes("--yes")) {
  console.error("This makes real (net-zero) sales and restocks on the running stack. Run again with --yes to go ahead. See the comment at the top of scripts/measure-latency.ts.");
  process.exit(2);
}
const PHARMACY = opt("pharmacy", "P005");
const MEDICINE = opt("medicine", "M006");
const PAIRS = Math.min(50, Math.max(1, Number(opt("pairs", "10"))));
const PORTAL = process.env.PORTAL_URL ?? "http://localhost:4200";
const API = process.env.API_URL ?? "http://localhost:4000";
const WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))]!;
const summary = (label: string, xs: number[], target?: number) => {
  const under = target === undefined ? "" : `  under ${target} ms: ${xs.filter((x) => x < target).length}/${xs.length}`;
  console.log(`${label.padEnd(14)} n=${String(xs.length).padStart(3)}  min ${Math.round(Math.min(...xs))}  p50 ${Math.round(pct(xs, 50))}  p95 ${Math.round(pct(xs, 95))}  max ${Math.round(Math.max(...xs))} ms${under}`);
};

const central = createPool();
const pharmacyUrl = process.env[`PHARMACY_${PHARMACY}_DATABASE_URL`];
if (!pharmacyUrl) throw new Error(`PHARMACY_${PHARMACY}_DATABASE_URL is not set`);
const local = createPool(pharmacyUrl);
const password = randomBytes(12).toString("base64url");
const email = `perf-${randomBytes(4).toString("hex")}@example.invalid`;
let userId: string | null = null;

try {
  const waiting = await central.query("SELECT count(*) AS n FROM restock_subscriptions s JOIN medicines m ON m.id = s.medicine_id WHERE m.code = $1 AND s.status = 'ACTIVE'", [MEDICINE]);
  if (Number(waiting.rows[0].n) > 0) throw new Error(`${waiting.rows[0].n} shoppers are waiting for ${MEDICINE}: a restock would notify them. Pick another medicine.`);
  userId = (await central.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ($1, $2, $3) RETURNING id", [email, await hashPassword(password), PHARMACY])).rows[0].id as string;
  const login = await fetch(`${PORTAL}/portal/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (login.status !== 200) throw new Error(`sign-in answered ${login.status}`);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const post = async (path: string, body: unknown) => {
    const t0 = now();
    const res = await fetch(`${PORTAL}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    const ms = now() - t0;
    if (res.status !== 201) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
    return { ms, done: now(), data: ((await res.json()) as { data: { eventId: string; quantityAfter: number } }).data };
  };

  const stock = (await (await fetch(`${PORTAL}/portal/stock`, { headers: { cookie } })).json()) as { data: { medicineCode: string; brandName: string; quantity: number }[] };
  const item = stock.data.find((i) => i.medicineCode === MEDICINE);
  if (!item || item.quantity < 5) throw new Error(`${PHARMACY} needs at least 5 of ${MEDICINE} for this measurement`);
  const start = item.quantity;

  // Everything the stream announces, with the moment it arrived.
  const seen = new Map<string, number>();
  const ctl = new AbortController();
  void (async () => {
    const res = await fetch(`${API}/api/stream`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop()!;
      for (const b of blocks) {
        if (!b.includes("event: stock")) continue;
        const id = /"eventId":"([^"]+)"/.exec(b)?.[1];
        if (id && !seen.has(id)) seen.set(id, now());
      }
    }
  })().catch(() => undefined);
  await sleep(500);

  const inSearch = async (expected: number) => {
    const res = (await (await fetch(`${API}/api/search?q=${encodeURIComponent(item.brandName)}&lat=19.12&lng=72.9`)).json()) as { data: { pharmacy: { code: string }; medicine: { code: string }; quantity: number }[] };
    return res.data.find((r) => r.pharmacy.code === PHARMACY && r.medicine.code === MEDICINE)?.quantity === expected;
  };

  const tx: number[] = [], viaSearch: number[] = [], viaStream: number[] = [];
  let timeouts = 0;
  for (let i = 0; i < PAIRS; i++) {
    for (const [path, expected] of [["/portal/sales", start - 1], ["/portal/restocks", start]] as const) {
      const r = await post(path, { medicineCode: MEDICINE, quantity: 1 });
      tx.push(r.ms);
      let searchAt: number | null = null;
      for (let t = now(); now() - t < WAIT_MS; ) {
        if (searchAt === null && (await inSearch(expected))) searchAt = now();
        if (searchAt !== null && seen.has(r.data.eventId)) break;
        await sleep(20);
      }
      if (searchAt === null || !seen.has(r.data.eventId)) timeouts++;
      if (searchAt !== null) viaSearch.push(searchAt - r.done);
      if (seen.has(r.data.eventId)) viaStream.push(seen.get(r.data.eventId)! - r.done);
    }
  }
  ctl.abort();

  const after = (await local.query("SELECT quantity FROM inventory WHERE medicine_code = $1", [MEDICINE])).rows[0].quantity as number;
  console.log(`\nMeasured on ${process.platform}, node ${process.version}, everything on this machine (portal, API, connector, sync, Postgres and Redis in local processes or Docker).`);
  console.log(`${PHARMACY} ${MEDICINE}: ${PAIRS} x (sell 1, restock 1) = ${tx.length} transactions, one after another.\n`);
  summary("transaction", tx, 500);
  if (viaSearch.length) summary("in search", viaSearch, 5000);
  if (viaStream.length) summary("on the stream", viaStream, 5000);
  console.log(`\nnot seen within ${WAIT_MS / 1000} s: ${timeouts}    stock at start ${start}, at end ${after}${after === start ? " (restored)" : "  <-- NOT RESTORED"}`);
  if (after !== start) process.exitCode = 1;
} finally {
  if (userId) {
    const moved = await local.query("DELETE FROM inventory_movements WHERE actor_user_id = $1", [userId]);
    await central.query("DELETE FROM pharmacy_users WHERE id = $1", [userId]);
    console.log(`cleanup: removed the throwaway account and ${moved.rowCount} of its movement-history rows`);
  }
  await Promise.all([central.end(), local.end()]);
}
