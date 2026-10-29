import { inventoryFor, MEDICINES, PHARMACIES, type Db } from "@medlink/db";
import type { InventoryStateHandler } from "@medlink/inventory-sync";
import { medicineByCode, medicineLabel, pharmacyByCode, resolveMedicine, resolvePharmacy, SimulatorError } from "./catalogue.js";
import { compareStock, waitUntilInSync, type Comparison } from "./compare.js";
import type { ChangeResult, PharmacySimulator } from "./simulator.js";
import type { EventTrace, FlowTracer, FollowOptions, Stage } from "./tracer.js";

export interface ShellDeps {
  simulator: PharmacySimulator;
  tracer: FlowTracer;
  /** Reads MedLink's synced state back from Redis. */
  state: InventoryStateHandler;
  /** The central database: needed to subscribe users and to see notifications. */
  central?: Db;
  out: (line: string) => void;
  /** How long to follow an event before giving up, and the rest of the tracer timing. */
  timing?: Pick<FollowOptions, "timeoutMs" | "pollMs" | "hintAfterMs">;
}

export interface RunResult {
  /** False if the command failed, or a change did not make it through the whole pipeline. */
  ok: boolean;
  quit?: boolean;
}

const STAGE_TEXT: Record<Stage, string> = {
  RECORDED: "recorded in the pharmacy's outbox",
  PUBLISHED: "published to the Redis stream",
  SYNCED: "applied to MedLink's Redis state",
  NOTIFIED: "notification sent",
};

const rupees = (n: number) => `₹${n.toFixed(2)}`;
const units = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;

export const HELP = `Commands (pharmacy: P001..P005, medicine: a code like M001 or a brand like crocin):
  sell     <pharmacy> <medicine> <qty>            sell units
  restock  <pharmacy> <medicine> <qty>            receive a delivery
  price    <pharmacy> <medicine> <price>          change the price
  add      <pharmacy> <medicine> <qty> <price>    start stocking a medicine the pharmacy does not carry
  remove   <pharmacy> <medicine>                  stop stocking a medicine
  notify   <email> <medicine>                     a user asks to be told when it is back in stock
  show     [pharmacy]                             the pharmacy's stock next to MedLink's synced copy
  verify   [pharmacy]                             wait until the two agree and say so
  list                                            the medicine catalogue
  demo                                            a scripted walk through the whole flow
  help | exit`;

/**
 * The simulator's commands. Each change is made in the pharmacy's own database, then followed live through the
 * pipeline: outbox, Redis stream, Redis state and, for a restock, the notifications.
 */
export class Shell {
  constructor(private readonly deps: ShellDeps) {}

  private get out() {
    return this.deps.out;
  }

  async run(line: string): Promise<RunResult> {
    const words = line.trim().split(/\s+/).filter(Boolean);
    const command = words.shift()?.toLowerCase();
    if (!command) return { ok: true };
    try {
      switch (command) {
        case "help":
        case "?":
          this.out(HELP);
          return { ok: true };
        case "exit":
        case "quit":
          return { ok: true, quit: true };
        case "list":
          this.list();
          return { ok: true };
        // `return await`, not `return`: a refusal must be caught by this try/catch and printed, not escape it.
        case "sell":
          return await this.change(words, 3, (p, m, [q]) => this.deps.simulator.sell(p, m, num(q, "quantity")));
        case "restock":
          return await this.change(words, 3, (p, m, [q]) => this.deps.simulator.restock(p, m, num(q, "quantity")));
        case "price":
          return await this.change(words, 3, (p, m, [x]) => this.deps.simulator.changePrice(p, m, num(x, "price")));
        case "add":
          return await this.change(words, 4, (p, m, [q, x]) => this.deps.simulator.addMedicine(p, m, num(q, "quantity"), num(x, "price")));
        case "remove":
          return await this.change(words, 2, (p, m) => this.deps.simulator.removeMedicine(p, m));
        case "notify":
          return await this.notify(words);
        case "show":
          return { ok: await this.show(words[0]) };
        case "verify":
          return { ok: await this.verify(words[0]) };
        case "demo":
          return { ok: await this.demo() };
        default:
          this.out(`Unknown command "${command}". Type "help".`);
          return { ok: false };
      }
    } catch (err) {
      if (err instanceof SimulatorError) {
        this.out(`  ✗ ${err.message}`);
        return { ok: false };
      }
      throw err;
    }
  }

  private list(): void {
    for (const m of MEDICINES) this.out(`  ${m.code}  ${m.brand} ${m.dosage}  (${m.generic}, ${m.form})  base ${rupees(m.basePrice)}`);
  }

  /** Shared shape of sell / restock / price / add: arguments, the change, then the live trace. */
  private async change(
    words: string[],
    arity: number,
    act: (pharmacy: string, medicine: string, rest: string[]) => Promise<ChangeResult>,
  ): Promise<RunResult> {
    if (words.length !== arity) throw new SimulatorError("INVALID", `expected ${arity} arguments, see "help"`);
    const pharmacy = resolvePharmacy(words[0]!);
    const medicine = resolveMedicine(words[1]!);
    // Who is waiting must be counted BEFORE a restock: the pipeline may notify them within milliseconds.
    const waiting = await this.deps.tracer.waitingFor(medicine);
    const result = await act(pharmacy, medicine, words.slice(2));
    return { ok: await this.trace(result, waiting) };
  }

  /** Prints what changed, then each stage as it happens. True if every event made it through. */
  private async trace(change: ChangeResult, waiting: number): Promise<boolean> {
    const { before, after } = change;
    const what =
      change.action === "remove"
        ? `no longer stocked (had ${units(before!.quantity)} at ${rupees(before!.price)})`
        : change.action === "add"
          ? `new item: ${units(after!.quantity)} at ${rupees(after!.price)}`
          : change.action === "price"
            ? `price ${rupees(before!.price)} → ${rupees(after!.price)}`
            : `${before!.quantity} → ${after!.quantity} units`;
    this.out(`  ${change.pharmacyName} · ${change.medicineName}: ${what}`);

    if (change.events.length === 0) {
      this.out(`  – no change, so the pharmacy database recorded no event`);
      return true;
    }
    const label = (eventId: string) => (change.events.length > 1 ? ` [${eventId.slice(0, 8)}]` : "");
    const traces = await this.deps.tracer.follow(change, {
      ...this.deps.timing,
      waiting,
      onStage: (u) => {
        const type = u.stage === "RECORDED" ? `  ${u.eventType}` : "";
        const detail = u.stage === "NOTIFIED" && u.detail ? `: ${u.detail}` : "";
        this.out(`  ✓ ${(STAGE_TEXT[u.stage] + detail).padEnd(46)} +${u.atMs} ms${type}${label(u.eventId)}`);
      },
      onHint: (h) => this.out(`  … ${h.message}`),
    });

    const ok = traces.every((t) => t.complete);
    if (!ok) for (const t of traces.filter((x) => !x.complete)) this.out(`  ✗ ${describeStuck(t)}`);
    if (ok && change.action === "restock" && waiting === 0) this.out(`  – nobody was waiting for this medicine, so no notification`);
    return ok;
  }

  private async notify(words: string[]): Promise<RunResult> {
    const [email, medicineInput] = words;
    if (words.length !== 2 || !email || !medicineInput) throw new SimulatorError("INVALID", `expected: notify <email> <medicine>`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SimulatorError("INVALID", `"${email}" is not an email address`);
    const central = this.deps.central;
    if (!central) throw new SimulatorError("INVALID", "notifications need the central database: set DATABASE_URL");
    const medicine = resolveMedicine(medicineInput);

    // The simulator stands in for a user of the app, so it writes what the API would write.
    const address = email.toLowerCase();
    const { rows: user } = await central.query<{ id: string }>(
      `INSERT INTO users (name, email) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [address.split("@")[0], address],
    );
    const { rows: sub } = await central.query<{ id: string }>(
      `INSERT INTO restock_subscriptions (user_id, medicine_id)
       SELECT $1, id FROM medicines WHERE code = $2
       ON CONFLICT (user_id, medicine_id) WHERE status = 'ACTIVE' DO NOTHING
       RETURNING id`,
      [user[0]!.id, medicine],
    );
    const known = await central.query("SELECT 1 FROM medicines WHERE code = $1", [medicine]);
    if (!known.rowCount) throw new SimulatorError("UNKNOWN_MEDICINE", `${medicine} is not in the central MedLink database; run npm run db:seed`);
    this.out(sub[0] ? `  ✓ ${address} will be notified when ${medicineLabel(medicine)} is restocked` : `  – ${address} is already waiting for ${medicineLabel(medicine)}`);
    return { ok: true };
  }

  private async show(pharmacyInput?: string): Promise<boolean> {
    const codes = pharmacyInput ? [resolvePharmacy(pharmacyInput)] : PHARMACIES.map((p) => p.code);
    let all = true;
    for (const code of codes) {
      const c = await compareStock(this.deps.simulator, this.deps.state, code);
      this.printComparison(c);
      all &&= c.inSync;
    }
    return all;
  }

  private async verify(pharmacyInput?: string): Promise<boolean> {
    const codes = pharmacyInput ? [resolvePharmacy(pharmacyInput)] : PHARMACIES.map((p) => p.code);
    let all = true;
    for (const code of codes) {
      const c = await waitUntilInSync(this.deps.simulator, this.deps.state, code, this.deps.timing?.timeoutMs);
      const wrong = c.items.filter((i) => !i.inSync);
      this.out(c.inSync ? `  ✓ ${code}: all ${c.items.length} medicines agree (pharmacy database = MedLink's Redis state)` : `  ✗ ${code}: ${wrong.length} of ${c.items.length} differ`);
      if (!c.inSync) {
        this.printComparison({ ...c, items: wrong });
        const unknown = wrong.filter((i) => i.pharmacy !== null && i.synced === null).length;
        if (unknown > 0) {
          this.out(`  MedLink has no record at all of ${unknown} of them. Events published before the Redis state was (re)created are not sent again;`);
          this.out(`  "npm run pharmacies:reset" reloads the starting stock and sends it. Otherwise: are the sync service and connector running?`);
        }
      }
      all &&= c.inSync;
    }
    return all;
  }

  private printComparison(c: Comparison): void {
    const labels = c.items.map((i) => `${i.medicineCode} ${medicineLabel(i.medicineCode)}`);
    const width = Math.max("medicine".length, ...labels.map((l) => l.length));
    const cell = (x: { quantity: number; price: number | null } | null) => (x ? `${String(x.quantity).padStart(4)} @ ${x.price === null ? "?" : rupees(x.price)}` : "—");
    this.out(`  ${c.pharmacyCode} ${pharmacyByCode(c.pharmacyCode).name}`);
    this.out(`    ${"medicine".padEnd(width)}  ${"pharmacy database".padEnd(18)} MedLink (Redis)`);
    c.items.forEach((i, n) => this.out(`    ${labels[n]!.padEnd(width)}  ${cell(i.pharmacy).padEnd(18)} ${cell(i.synced).padEnd(18)} ${i.inSync ? "✓" : "✗ differs"}`));
  }

  /**
   * A scripted walk through every kind of change, on Pharmacy D, which starts with no Crocin 500mg.
   * Stops at the first change that does not make it through the whole pipeline and says which service to look at.
   */
  async demo(): Promise<boolean> {
    const P = "P004";
    const M = "M001";
    const EMAIL = "asha@example.com";
    const pharmacy = pharmacyByCode(P);
    const sim = this.deps.simulator;
    let step = 0;
    const heading = (text: string) => {
      this.out("");
      this.out(`${++step}. ${text}`);
    };
    const go = async (command: string): Promise<boolean> => {
      this.out(`  $ ${command}`);
      return (await this.run(command)).ok;
    };

    this.out(`MedLink pharmacy simulator: the whole event-driven flow, live`);
    this.out(`${pharmacy.name} (${P}) is a pharmacy with its own database. Every change below is made there, with plain SQL,`);
    this.out(`and then followed: outbox → connector → Redis stream → sync service → Redis state${this.deps.central ? " → notification service" : ""}.`);

    heading(`${medicineLabel(M)} is out of stock at ${pharmacy.name}`);
    const stock = (await sim.stock(P)).get(M);
    if (!stock) {
      if (!(await go(`add ${P} ${M} 0 ${rupees0(medicineByCode(M)!.basePrice * pharmacy.priceFactor)}`))) return this.abort();
    } else if (stock.quantity > 0) {
      if (!(await go(`sell ${P} ${M} ${stock.quantity}`))) return this.abort();
    } else {
      this.out(`  already out of stock`);
    }

    if (this.deps.central) {
      heading(`Asha asks to be told when it is back in stock`);
      if (!(await go(`notify ${EMAIL} ${M}`))) return this.abort();
    } else {
      this.out("");
      this.out("(No DATABASE_URL: skipping the notification part of the demo.)");
    }

    heading(`The pharmacy receives a delivery of 30 strips`);
    if (!(await go(`restock ${P} ${M} 30`))) return this.abort();

    heading(`A customer buys 2`);
    if (!(await go(`sell ${P} ${M} 2`))) return this.abort();

    heading(`The pharmacy raises the price by 10%`);
    const price = (await sim.stock(P)).get(M)!.price;
    if (!(await go(`price ${P} ${M} ${rupees0(Math.round(price * 110) / 100)}`))) return this.abort();

    heading(`The pharmacy starts stocking another medicine`);
    // The medicine this pharmacy was never given at the start. A previous run may have added it: then the pharmacy
    // first stops stocking it, so the demo can be run again and again.
    const startingCodes = new Set(inventoryFor(PHARMACIES.findIndex((x) => x.code === P)).map((r) => r.medicine.code));
    const gap = MEDICINES.find((m) => !startingCodes.has(m.code));
    if (!gap) {
      this.out(`  ${pharmacy.name} started with the whole catalogue, so there is nothing to add`);
    } else {
      if ((await sim.stock(P)).has(gap.code)) {
        this.out(`  (an earlier run added ${medicineLabel(gap.code)}: the pharmacy stops stocking it first)`);
        if (!(await go(`remove ${P} ${gap.code}`))) return this.abort();
      }
      if (!(await go(`add ${P} ${gap.code} 20 ${rupees0(Math.round(gap.basePrice * pharmacy.priceFactor * 100) / 100)}`))) return this.abort();
    }

    heading(`Is MedLink's copy the same as the pharmacy's own database?`);
    const same = await this.verify(P);
    this.out("");
    this.out(same ? `Done: every change went through the whole pipeline and MedLink agrees with the pharmacy.` : `The two did not agree: see the lines above.`);
    return same;
  }

  private abort(): boolean {
    this.out("");
    this.out(`Stopped: that change did not make it through the pipeline. Is everything running?`);
    this.out(`  npm run connector:start   npm run sync:start   npm run notify:start   (or run the simulator with --embedded)`);
    return false;
  }
}

const rupees0 = (n: number) => String(Math.round(n * 100) / 100);

function num(value: string | undefined, what: string): number {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isFinite(n)) throw new SimulatorError("INVALID", `${what} must be a number, got "${value ?? ""}"`);
  return n;
}

function describeStuck(t: EventTrace): string {
  if (t.failure) return `the connector could not publish it: ${t.failure}`;
  const where: Record<Stage, string> = {
    RECORDED: "recording",
    PUBLISHED: "publishing to the Redis stream (is the connector running?)",
    SYNCED: "applying to Redis (is the sync service running?)",
    NOTIFIED: "sending the notification (is the notification service running?)",
  };
  return `${t.eventType} did not get through: stuck before ${where[t.stuckBefore ?? "PUBLISHED"]}`;
}
