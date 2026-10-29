import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("..", import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
const rel = (p: string) => relative(SRC, p);
const read = (p: string) => readFileSync(p, "utf8");

describe("the calendar's server code stays on the server, and its data is never kept in the browser", () => {
  const all = files(SRC);
  const clientFiles = all.filter((f) => /^['"]use client['"]/.test(read(f).trimStart()));

  it("no client component imports the database, the repository, the API layer or `pg`", () => {
    const offenders = clientFiles.filter((f) => /from ["'][^"']*(server\/db|server\/calendar\/(repo|api)|\/repo|^pg$)["']|from ["']pg["']/.test(read(f)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("only the route handlers, the auth module and the server folder itself touch the database layer", () => {
    const users = all.filter((f) => /server\/(db|calendar\/(repo|api))/.test(read(f)) && !f.startsWith(join(SRC, "server")));
    expect(users.map(rel).sort()).toEqual(["app/calendar-api/entries/[id]/route.ts", "app/calendar-api/entries/route.ts", "auth.ts"]);
  });

  it("the calendar screens keep nothing in localStorage, sessionStorage or cookies, and hold no sample data", () => {
    const calendar = [...all.filter((f) => /calendar/i.test(rel(f)) && !f.startsWith(join(SRC, "server")))];
    expect(calendar.length).toBeGreaterThan(3);
    for (const f of calendar) {
      const text = read(f);
      expect(text, rel(f)).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|readStorage|writeStorage/);
      expect(text, rel(f)).not.toMatch(/mock|fixture|dummy|lorem|sampleEntries|DEMO_ENTRIES/i);
    }
  });

  it("the calendar's API is not under /api (which development proxies to another service) and never trusts a client-supplied owner", () => {
    expect(all.some((f) => rel(f).startsWith("app/calendar-api/"))).toBe(true);
    expect(all.some((f) => rel(f).startsWith("app/api/"))).toBe(false);
    const server = all.filter((f) => f.startsWith(join(SRC, "server/calendar")));
    for (const f of server) expect(read(f), rel(f)).not.toMatch(/body\.(userId|patientId|user_id|patient_id)|searchParams\.get\(["'](userId|patientId)/);
  });

  it("every statement that changes or removes an entry is scoped to its owner in the same statement", () => {
    const repo = read(join(SRC, "server/calendar/repo.ts"));
    const at = [...repo.matchAll(/(UPDATE|DELETE FROM) medicine_calendar_entries/g)].map((m) => m.index!);
    expect(at).toHaveLength(2);
    for (const i of at) expect(repo.slice(i, i + 200)).toMatch(/patient_id = \$/);
  });

  it("the calendar never goes near the restock pipeline, subscriptions or notification sending", () => {
    for (const f of all.filter((f) => /calendar/i.test(rel(f)))) expect(read(f), rel(f)).not.toMatch(/restock|subscri|nodemailer|SMTP|notif/i);
  });
});
