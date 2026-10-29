/**
 * The simulator against the real pipeline, nothing mocked: pharmacy databases, connector, Redis streams, sync
 * service, notification service, central database.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { InventoryStateHandler } from "@medlink/inventory-sync";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { compareStock, waitUntilInSync } from "../src/compare.js";
import { startEmbeddedPipeline, type Component, type EmbeddedPipeline } from "../src/pipeline.js";
import { Shell } from "../src/shell.js";
import { PharmacySimulator } from "../src/simulator.js";
import { FlowTracer, type Hint, type Stage, type StageUpdate } from "../src/tracer.js";

vi.setConfig({ testTimeout: 30_000 });

const CODES = ["P001", "P002", "P003", "P004", "P005"];
let central: Db;
let urls: Record<string, string>;
let pools: Record<string, Db>;
let sim: PharmacySimulator;
let redis: Redis;
let state: InventoryStateHandler;
let tracer: FlowTracer;
let prefix: string;
let pipeline: EmbeddedPipeline | null = null;

beforeAll(async () => {
  central = await freshSeededDb();
  urls = await freshPharmacyDbs(central);
  pools = Object.fromEntries(CODES.map((c) => [c, createPool(urls[c]!)]));
  sim = new PharmacySimulator(pools);
});
afterAll(async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  await central.end();
});
beforeEach(async () => {
  prefix = `test-${randomUUID().slice(0, 8)}`;
  await central.query("TRUNCATE notifications, restock_subscriptions, users RESTART IDENTITY CASCADE");
  for (const code of CODES) {
    // Back to the starting stock; the 'added' events of that snapshot are what builds MedLink's copy.
    await pools[code]!.query("TRUNCATE outbox");
    await pools[code]!.query("DELETE FROM inventory");
    await pools[code]!.query("TRUNCATE outbox");
    await setupPharmacyDatabase(code, urls[code]!);
  }
  redis = createRedis({ ...redisOptionsFromEnv(), onError: () => undefined });
  state = new InventoryStateHandler(redis, { keyPrefix: prefix });
  tracer = new FlowTracer({ pharmacies: pools, redis, keyPrefix: prefix, central });
});
afterEach(async () => {
  await pipeline?.stop();
  pipeline = null;
  await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
  redis.disconnect();
});

async function startPipeline(start?: Component[], withCentral = true) {
  pipeline = await startEmbeddedPipeline({
    pharmacies: pools,
    central: withCentral ? central : undefined,
    keyPrefix: prefix,
    pollIntervalMs: 20,
    sweepIntervalMs: 100,
    sync: { blockMs: 100, minIdleMs: 300, claimIntervalMs: 100 },
    start,
  });
  return pipeline;
}
const caughtUp = async (code = "P001") => {
  const c = await waitUntilInSync(sim, state, code, 10_000, 25);
  expect(c.inSync).toBe(true);
};
const subscribe = async (email: string, medicine = "M001") => {
  const u = (await central.query("INSERT INTO users (name, email) VALUES ($1, $1) RETURNING id", [email])).rows[0].id;
  await central.query("INSERT INTO restock_subscriptions (user_id, medicine_id) SELECT $1, id FROM medicines WHERE code = $2", [u, medicine]);
};

describe("FlowTracer", () => {
  it("follows a sale through every stage, in order, with growing timestamps", async () => {
    await startPipeline();
    await caughtUp();
    const updates: StageUpdate[] = [];
    const change = await sim.sell("P001", "M001", 1);
    const [trace] = await tracer.follow(change, { onStage: (u) => updates.push(u) });

    expect(trace!.complete).toBe(true);
    expect(updates.map((u) => u.stage)).toEqual(["RECORDED", "PUBLISHED", "SYNCED"]);
    expect(updates.every((u) => u.eventType === "SALE" && u.eventId === change.events[0]!.eventId)).toBe(true);
    const times = updates.map((u) => u.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(trace!.reached.NOTIFIED).toBeUndefined();
    expect(trace!.failure).toBeUndefined();
  });

  it("follows a restock to the notification of the user who was waiting", async () => {
    await startPipeline();
    await caughtUp();
    await subscribe("asha@example.com");
    const waiting = await tracer.waitingFor("M001");
    expect(waiting).toBe(1);

    const stages: Stage[] = [];
    const details: (string | undefined)[] = [];
    const change = await sim.restock("P001", "M001", 12);
    const [trace] = await tracer.follow(change, { waiting, onStage: (u) => (stages.push(u.stage), details.push(u.detail)) });

    expect(trace!.complete).toBe(true);
    expect(stages).toContain("NOTIFIED");
    expect(details).toContain("asha@example.com");
    expect(trace!.notifications).toBe(1);
    expect(pipeline!.notifier!.sent.map((n) => n.to)).toEqual(["asha@example.com"]);
  });

  it("a restock nobody waits for is complete without a notification", async () => {
    await startPipeline();
    await caughtUp();
    const [trace] = await tracer.follow(await sim.restock("P001", "M001", 5), { waiting: 0 });
    expect(trace!.complete).toBe(true);
    expect(trace!.reached.NOTIFIED).toBeUndefined();
    expect(pipeline!.notifier!.sent).toEqual([]);
  });

  it("says the connector is probably not running when nothing is published, and the change is not lost: it arrives once the connector starts", async () => {
    await startPipeline(["sync", "notifications"]);
    const change = await sim.sell("P001", "M001", 1);
    const hints: Hint[] = [];
    const [stuck] = await tracer.follow(change, { timeoutMs: 700, hintAfterMs: 200, onHint: (h) => hints.push(h) });

    expect(stuck!.complete).toBe(false);
    expect(stuck!.stuckBefore).toBe("PUBLISHED");
    expect(stuck!.reached.PUBLISHED).toBeUndefined();
    expect(hints).toHaveLength(1);
    expect(hints[0]!.message).toMatch(/connector/);

    pipeline!.startComponent("connector");
    const [done] = await tracer.follow(change, { timeoutMs: 10_000 });
    expect(done!.complete).toBe(true);
  });

  it("says the sync service is probably not running when the event is published but not applied, and it catches up on restart", async () => {
    await startPipeline(["connector", "notifications"]);
    const change = await sim.sell("P001", "M001", 1);
    const hints: Hint[] = [];
    const [stuck] = await tracer.follow(change, { timeoutMs: 800, hintAfterMs: 200, onHint: (h) => hints.push(h) });

    expect(stuck!.reached.PUBLISHED).toBeDefined();
    expect(stuck!.stuckBefore).toBe("SYNCED");
    expect(hints.map((h) => h.waitingFor)).toEqual(["SYNCED"]);
    expect(hints[0]!.message).toMatch(/sync service/);

    pipeline!.startComponent("sync");
    expect((await tracer.follow(change, { timeoutMs: 10_000 }))[0]!.complete).toBe(true);
    await caughtUp();
  });

  it("says the notification service is probably not running when a waiting user is not notified", async () => {
    await startPipeline(["connector", "sync"]);
    await caughtUp();
    await subscribe("asha@example.com");
    const waiting = await tracer.waitingFor("M001");
    const hints: Hint[] = [];
    const [stuck] = await tracer.follow(await sim.restock("P001", "M001", 3), { waiting, timeoutMs: 1200, hintAfterMs: 300, onHint: (h) => hints.push(h) });
    expect(stuck!.reached.SYNCED).toBeDefined();
    expect(stuck!.stuckBefore).toBe("NOTIFIED");
    expect(hints.at(-1)!.message).toMatch(/notification service/);
  });

  it("reports an event the connector parked as invalid instead of waiting for it", async () => {
    await startPipeline(["sync"]);
    const change = await sim.sell("P001", "M001", 1);
    await pools.P001!.query("UPDATE outbox SET failed_at = now(), error = 'not a valid event' WHERE event_id = $1", [change.events[0]!.eventId]);
    const [trace] = await tracer.follow(change, { timeoutMs: 5000 });
    expect(trace).toMatchObject({ complete: false, failure: "not a valid event" });
  });
});

describe("proving the two sides agree", () => {
  it("MedLink's Redis copy equals the pharmacy's own database after a mix of changes", async () => {
    await startPipeline();
    await sim.sell("P001", "M001", 1);
    await sim.restock("P002", "M001", 7);
    await sim.changePrice("P003", "M001", 31.5);
    await sim.addMedicine("P004", "M015", 9, 140).catch(() => undefined); // may already be carried
    for (const code of CODES) await caughtUp(code);
    for (const code of CODES) {
      const c = await compareStock(sim, state, code);
      expect(c.items.length).toBeGreaterThan(5);
      expect(c.items.every((i) => i.inSync)).toBe(true);
    }
  });

  it("notices when they differ (the connector is down), and agrees again once it is back", async () => {
    await startPipeline();
    await caughtUp();
    await pipeline!.stopComponent("connector");
    await sim.sell("P001", "M001", 1);

    const during = await compareStock(sim, state, "P001");
    expect(during.inSync).toBe(false);
    const wrong = during.items.filter((i) => !i.inSync);
    expect(wrong.map((i) => i.medicineCode)).toEqual(["M001"]);
    expect(wrong[0]!.pharmacy!.quantity).toBe(wrong[0]!.synced!.quantity - 1);

    pipeline!.startComponent("connector");
    await caughtUp();
  });
});

describe("Shell", () => {
  const make = (over: Partial<ConstructorParameters<typeof Shell>[0]> = {}) => {
    const lines: string[] = [];
    const shell = new Shell({ simulator: sim, tracer, state, central, out: (l) => lines.push(l), timing: { timeoutMs: 8000 }, ...over });
    return { shell, lines, text: () => lines.join("\n") };
  };

  it("shows a sale and each stage as it happens", async () => {
    await startPipeline();
    await caughtUp();
    const { shell, text } = make();
    const r = await shell.run("sell p001 crocin 1");
    expect(r.ok).toBe(true);
    const out = text();
    expect(out).toMatch(/Crocin 500mg: 1 → 0 units/);
    expect(out).toMatch(/✓ recorded in the pharmacy's outbox\s+\+\d+ ms\s+SALE/);
    expect(out).toMatch(/✓ published to the Redis stream\s+\+\d+ ms/);
    expect(out).toMatch(/✓ applied to MedLink's Redis state\s+\+\d+ ms/);
    expect(out).not.toMatch(/notification/);
  });

  it("covers every kind of change, and MedLink agrees with the pharmacy afterwards", async () => {
    await startPipeline();
    await caughtUp("P002");
    const { shell, text } = make();
    for (const cmd of ["sell P002 crocin 3", "restock P002 crocin 10", "price P002 crocin 39.99", "remove P002 volini", "add P002 volini 20 140"]) {
      expect((await shell.run(cmd)).ok, cmd).toBe(true);
    }
    for (const type of ["SALE", "RESTOCK", "PRICE_UPDATED", "MEDICINE_REMOVED", "MEDICINE_ADDED"]) expect(text()).toContain(type);
    expect(text()).toMatch(/price ₹\d+\.\d\d → ₹39\.99/);
    expect(text()).toMatch(/no longer stocked \(had \d+ units? at ₹\d+\.\d\d\)/);
    expect(text()).toMatch(/new item: 20 units at ₹140\.00/);
    await caughtUp("P002");
    const removed = (await compareStock(sim, state, "P002")).items.find((i) => i.medicineCode === "M015")!;
    expect(removed).toMatchObject({ pharmacy: { quantity: 20, price: 140 }, synced: { quantity: 20, price: 140 }, inSync: true });
  });

  it("a removed medicine is gone from MedLink's copy too", async () => {
    await startPipeline();
    await caughtUp("P002");
    const { shell } = make();
    expect((await shell.run("remove P002 volini")).ok).toBe(true);
    await caughtUp("P002");
    const item = (await compareStock(sim, state, "P002")).items.find((i) => i.medicineCode === "M015");
    expect(item).toBeUndefined();
  });

  it("a price 'change' to the same price records nothing and says so", async () => {
    await startPipeline();
    await caughtUp();
    const price = (await sim.stock("P001")).get("M001")!.price;
    const { shell, text } = make();
    expect((await shell.run(`price P001 crocin ${price}`)).ok).toBe(true);
    expect(text()).toMatch(/no change, so the pharmacy database recorded no event/);
  });

  it("explains refusals and bad input without crashing", async () => {
    await startPipeline();
    const cases: [string, RegExp][] = [
      ["sell P001 crocin 999", /✗ .*only 1 of Crocin 500mg, cannot sell 999/],
      ["sell P999 crocin 1", /✗ Unknown pharmacy "P999"/],
      ["sell P001 nonsense 1", /✗ Unknown medicine "nonsense"/],
      ["sell P001 crocin", /✗ expected 3 arguments/],
      ["restock P001 crocin abc", /✗ quantity must be a number/],
      ["add P001 crocin 5 10", /✗ .*already carries Crocin 500mg/],
      ["price P001 crocin -4", /✗ price must be more than 0/],
      ["frobnicate", /Unknown command "frobnicate"/],
    ];
    for (const [cmd, expected] of cases) {
      const { shell, text } = make();
      const r = await shell.run(cmd);
      expect(r.ok, cmd).toBe(false);
      expect(text(), cmd).toMatch(expected);
    }
    expect((await pools.P001!.query("SELECT quantity FROM inventory WHERE medicine_code = 'M001'")).rows[0].quantity).toBe(1);
  });

  it("handles blank lines, help, list and exit", async () => {
    const { shell, text } = make();
    expect(await shell.run("   ")).toEqual({ ok: true });
    expect((await shell.run("help")).ok).toBe(true);
    expect((await shell.run("list")).ok).toBe(true);
    expect(text()).toMatch(/sell\s+<pharmacy>/);
    expect(text()).toMatch(/M001\s+Crocin 500mg/);
    expect(await shell.run("exit")).toEqual({ ok: true, quit: true });
  });

  it("notify + restock: the waiting user is notified, and the output says who", async () => {
    await startPipeline();
    await caughtUp();
    const { shell, text } = make();
    expect((await shell.run("notify Asha@Example.com crocin")).ok).toBe(true);
    expect(text()).toMatch(/asha@example.com will be notified when Crocin 500mg is restocked/);
    expect((await shell.run("notify asha@example.com crocin")).ok).toBe(true);
    expect(text()).toMatch(/already waiting/);
    expect((await shell.run("restock P001 crocin 10")).ok).toBe(true);
    expect(text()).toMatch(/✓ notification sent: asha@example.com\s+\+\d+ ms/);
  });

  it("a restock nobody was waiting for says so", async () => {
    await startPipeline();
    await caughtUp();
    const { shell, text } = make();
    await shell.run("restock P001 crocin 10");
    expect(text()).toMatch(/nobody was waiting for this medicine, so no notification/);
  });

  it("notify needs the central database and a sensible email", async () => {
    const { shell, text } = make({ central: undefined });
    expect((await shell.run("notify asha@example.com crocin")).ok).toBe(false);
    expect(text()).toMatch(/DATABASE_URL/);
    const again = make();
    expect((await again.shell.run("notify not-an-email crocin")).ok).toBe(false);
    expect(again.text()).toMatch(/not an email address/);
  });

  it("show prints the pharmacy next to MedLink's copy; verify says they agree", async () => {
    await startPipeline();
    await caughtUp();
    const { shell, text } = make();
    expect((await shell.run("show P001")).ok).toBe(true);
    expect(text()).toMatch(/pharmacy database\s+MedLink \(Redis\)/);
    expect(text()).toMatch(/M001 Crocin 500mg\s+1 @ ₹25\.00\s+1 @ ₹25\.00\s+✓/);
    expect((await shell.run("verify P001")).ok).toBe(true);
    expect(text()).toMatch(/✓ P001: all \d+ medicines agree/);
  });

  it("when MedLink has never heard of the stock (a fresh Redis), says so instead of calling it a sync bug", async () => {
    const { shell, text } = make({ timing: { timeoutMs: 300 } });
    expect((await shell.run("verify P001")).ok).toBe(false);
    expect(text()).toMatch(/✗ P001: 14 of 14 differ/);
    expect(text()).toMatch(/MedLink has no record at all of 14 of them/);
    expect(text()).toMatch(/npm run pharmacies:reset/);
  });

  it("lines the comparison table up even for long medicine names", async () => {
    await startPipeline();
    await caughtUp();
    const { shell, text } = make();
    await shell.run("show P001");
    const rows = text().split("\n").filter((l) => /^ {4}M\d{3} /.test(l));
    expect(rows.length).toBeGreaterThan(10);
    const column = (l: string) => l.indexOf(" @ "); // where the quantity column ends up
    expect(new Set(rows.map(column)).size).toBe(1);
  });

  it("with nothing running, says what to start, and the change is still in the pharmacy's database", async () => {
    const { shell, text } = make({ timing: { timeoutMs: 700, hintAfterMs: 150 } });
    const r = await shell.run("sell P001 crocin 1");
    expect(r.ok).toBe(false);
    expect(text()).toMatch(/… not published yet: is the inventory connector running\?/);
    expect(text()).toMatch(/✗ SALE did not get through: stuck before publishing to the Redis stream/);
    expect((await pools.P001!.query("SELECT quantity FROM inventory WHERE medicine_code = 'M001'")).rows[0].quantity).toBe(0);
  });
});

describe("the demo", () => {
  const run = async (shell: Shell) => shell.run("demo");
  const make = (over: Partial<ConstructorParameters<typeof Shell>[0]> = {}) => {
    const lines: string[] = [];
    const shell = new Shell({ simulator: sim, tracer, state, central, out: (l) => lines.push(l), timing: { timeoutMs: 8000 }, ...over });
    return { shell, text: () => lines.join("\n") };
  };

  it("shows the complete flow live: every kind of change goes through the whole pipeline and MedLink ends up equal to the pharmacy", async () => {
    await startPipeline();
    await caughtUp("P004");
    const { shell, text } = make();
    const result = await run(shell);
    const out = text();

    expect(result.ok).toBe(true);
    for (const type of ["SALE", "RESTOCK", "PRICE_UPDATED", "MEDICINE_ADDED"]) expect(out, type).toContain(type);
    expect(out).toMatch(/✓ notification sent: asha@example\.com/);
    expect(out).toMatch(/Done: every change went through the whole pipeline/);
    expect(out.match(/✓ applied to MedLink's Redis state/g)!.length).toBeGreaterThanOrEqual(4);
    expect(out).not.toMatch(/✗/);

    // the proof, independent of what the demo printed
    expect((await compareStock(sim, state, "P004")).inSync).toBe(true);
    expect((await sim.stock("P004")).get("M001")!.quantity).toBe(28); // 0 + 30 - 2
    expect(pipeline!.notifier!.sent.map((n) => n.to)).toEqual(["asha@example.com"]);
  });

  it("can be run again and again: it empties the shelf first, and removes what an earlier run added before adding it", async () => {
    await startPipeline();
    await caughtUp("P004");
    const first = make();
    expect((await run(first.shell)).ok).toBe(true);
    expect(first.text()).not.toMatch(/\$ remove/); // nothing to undo the first time
    expect(first.text()).toMatch(/\$ add P004 M008 20/);

    for (const n of [2, 3]) {
      const again = make();
      expect((await run(again.shell)).ok, `run ${n}`).toBe(true);
      expect(again.text()).toMatch(/\$ sell P004 M001 28/); // out of stock again before the story starts
      expect(again.text()).toMatch(/an earlier run added Cetzine 10mg: the pharmacy stops stocking it first/);
      expect(again.text()).toMatch(/\$ remove P004 M008/);
      expect(again.text()).toMatch(/\$ add P004 M008 20/);
      expect(again.text()).not.toMatch(/✗/);
    }
    expect((await compareStock(sim, state, "P004")).inSync).toBe(true);
    expect((await sim.stock("P004")).get("M008")).toMatchObject({ quantity: 20 });
    expect(pipeline!.notifier!.sent).toHaveLength(3); // Asha is told once per run
  });

  it("without the central database it skips the notification part and still works", async () => {
    await startPipeline(undefined, false);
    await caughtUp("P004");
    const { shell, text } = make({ central: undefined, tracer: new FlowTracer({ pharmacies: pools, redis, keyPrefix: prefix }) });
    expect((await run(shell)).ok).toBe(true);
    expect(text()).toMatch(/skipping the notification part/);
    expect(text()).not.toMatch(/notification sent/);
  });

  it("stops at the first change that does not get through and says what to start", async () => {
    const { shell, text } = make({ timing: { timeoutMs: 600, hintAfterMs: 150 } });
    expect((await run(shell)).ok).toBe(false);
    expect(text()).toMatch(/Stopped: that change did not make it through the pipeline/);
    expect(text()).toMatch(/npm run connector:start/);
    expect(text()).not.toMatch(/Done:/);
  });
});
