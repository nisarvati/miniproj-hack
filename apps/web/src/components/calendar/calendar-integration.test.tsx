// @vitest-environment jsdom
/**
 * The calendar screens against the real API handlers and the real (isolated `<db>_test`) PostgreSQL: the browser's fetch is the only
 * thing replaced, and it hands every /calendar-api request to the same code the Next.js route files run. So what these tests see on
 * screen was really written to, and read back from, the database. Not covered, because it needs a browser and a real Google account:
 * Next.js routing and the Auth.js cookie itself (the identity below stands in for the verified session).
 */
import type { Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCalendarApi } from "../../server/calendar/api";
import { resolvePatientId, type PatientIdentity } from "../../server/calendar/repo";
import { AuthProvider } from "../providers/auth";
import { AddToCalendar } from "./AddToCalendar";
import { CalendarPage } from "./CalendarPage";

let db: Db;
let who: PatientIdentity | null;
let hasDb = true;
const hooks: { failNextWrite: boolean; gate: Promise<void> | null; readGate: Promise<void> | null; sessionBody: unknown } = { failNextWrite: false, gate: null, readGate: null, sessionBody: null };
const person = (subject: string): PatientIdentity => ({ provider: "google", subject, email: `${subject}@example.com`, name: subject });

const api = createCalendarApi({ identity: async () => who, db: () => (hasDb ? db : null) });

async function route(url: URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (url.pathname.startsWith("/calendar-api/entries")) {
    if (hooks.gate && method !== "GET") await hooks.gate;
    if (hooks.readGate && method === "GET") await hooks.readGate;
    if (hooks.failNextWrite && method !== "GET") {
      hooks.failNextWrite = false;
      return Response.json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } }, { status: 500 });
    }
    const request = new Request(url, { method, headers: { ...(init.headers as Record<string, string>), "sec-fetch-site": "same-origin" }, body: init.body });
    const id = url.pathname.split("/")[3];
    if (!id) return method === "GET" ? api.list(request) : api.create(request);
    return method === "PATCH" ? api.update(request, id) : method === "DELETE" ? api.remove(request, id) : api.get(request, id);
  }
  if (url.pathname === "/api/medicines/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const { rows } = await db.query("SELECT id, code, brand_name, generic_name, dosage, form FROM medicines WHERE lower(brand_name) LIKE $1 OR lower(generic_name) LIKE $1 ORDER BY id LIMIT 5", [`%${q}%`]);
    return Response.json({ data: rows.map((r) => ({ id: Number(r.id), code: r.code, brandName: r.brand_name, genericName: r.generic_name, dosage: r.dosage, form: r.form })) });
  }
  if (url.pathname === "/auth/session") return Response.json(hooks.sessionBody);
  return new Response("unrouted", { status: 500 });
}

beforeAll(async () => {
  db = await freshSeededDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query("TRUNCATE medicine_calendar_entries, patients RESTART IDENTITY CASCADE");
  who = person("alice");
  hasDb = true;
  hooks.failNextWrite = false;
  hooks.gate = null;
  hooks.readGate = null;
  hooks.sessionBody = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 10, 12, 0, 0)); // Tuesday 10 November 2026, on the person's own clock
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => route(new URL(String(input), "http://localhost:3000"), init)));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rows = async () => (await db.query<{ medicine_name: string; entry_type: string; entry_date: string; status: string; medicine_id: string | null; subject: string }>(
  `SELECT e.medicine_name, e.entry_type, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.status, e.medicine_id, p.provider_subject AS subject
   FROM medicine_calendar_entries e JOIN patients p ON p.id = e.patient_id ORDER BY e.created_at`)).rows;
const seed = async (subject: string, name: string, date = "2026-11-10") => {
  const id = await resolvePatientId(db, person(subject));
  await db.query("INSERT INTO medicine_calendar_entries (patient_id, medicine_name, entry_type, entry_date) VALUES ($1, $2, 'REMINDER', $3)", [id, name, date]);
};
const opened = async () => {
  render(<CalendarPage />);
  await screen.findByRole("heading", { level: 1, name: "Medicine Calendar" });
  await waitFor(() => expect(screen.queryByText("Loading your entries…")).toBeNull());
};
/** Open a day (its date button, by label) and return queries scoped to the day dialog: where an entry's details and actions live. */
const openDay = async (label: RegExp = /10 November 2026/) => {
  await userEvent.click(screen.getByRole("button", { name: label }));
  return within(await screen.findByRole("dialog"));
};
const chip = (name: string) => screen.findByRole("button", { name: new RegExp(`: ${name}(, done)?\\. Open to edit`) });
const addEntry = async (name: string, type?: string) => {
  await userEvent.click(screen.getByRole("button", { name: "Add medicine" }));
  await userEvent.type(screen.getByLabelText("Medicine"), name);
  if (type) await userEvent.selectOptions(screen.getByLabelText("What is it?"), type);
};

describe("the calendar page, with the real API and database behind it", () => {
  it("opens on today and says plainly that it holds the person's own notes, not orders or availability", async () => {
    await opened();
    expect(screen.getByRole("heading", { level: 2, name: "November 2026" })).toBeTruthy();
    expect(screen.getByText(/MedLink does not place orders, confirm purchases or check that a medicine is available/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /10 November 2026/ }).getAttribute("aria-current")).toBe("date");
    expect(screen.queryByRole("dialog")).toBeNull(); // the month, not a panel, is what is on screen
  });

  it("saves an entry to PostgreSQL, shows it only after the server confirms, and finds it again after a full reload", async () => {
    await opened();
    await addEntry("Vitamin D3", "PURCHASED");
    await userEvent.type(screen.getByLabelText(/Notes/), "one a day");
    await userEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    expect(await screen.findByText(/Added to your calendar \(10 Nov 2026\)/)).toBeTruthy();
    expect(await chip("Vitamin D3")).toBeTruthy();
    expect(await rows()).toEqual([{ medicine_name: "Vitamin D3", entry_type: "PURCHASED", entry_date: "2026-11-10", status: "OPEN", medicine_id: null, subject: "alice" }]);

    cleanup(); // the browser is closed and opened again
    await opened();
    expect(await chip("Vitamin D3")).toBeTruthy();
    expect((await openDay()).getByText("one a day")).toBeTruthy();
  });

  it("links a catalogue medicine by its id, and the name comes from the catalogue", async () => {
    await opened();
    await addEntry("para");
    const choice = await screen.findAllByRole("button", { name: /mg/ });
    await userEvent.click(choice[0]!);
    expect(screen.getByText("Matched to the MedLink catalogue.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    await screen.findByText(/Added to your calendar/);
    const [row] = await rows();
    expect(row!.medicine_id).not.toBeNull();
    const catalogue = (await db.query<{ name: string }>("SELECT brand_name || ' ' || dosage || ' ' || form AS name FROM medicines WHERE id = $1", [row!.medicine_id])).rows[0]!;
    expect(row!.medicine_name).toBe(catalogue.name);
  });

  it("edits, completes, reopens and deletes, each confirmed by the database", async () => {
    await seed("alice", "Metformin");
    await opened();
    await chip("Metformin");
    let day = await openDay();
    await userEvent.click(day.getByRole("button", { name: "Edit: Metformin" }));
    await userEvent.clear(screen.getByLabelText("Medicine"));
    await userEvent.type(screen.getByLabelText("Medicine"), "Metformin 500");
    await userEvent.selectOptions(screen.getByLabelText("What is it?"), "ORDERED");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Changes saved/);
    expect(await rows()).toMatchObject([{ medicine_name: "Metformin 500", entry_type: "ORDERED", status: "OPEN" }]);

    await chip("Metformin 500");
    day = await openDay();
    await userEvent.click(await day.findByRole("button", { name: "Mark done: Metformin 500" }));
    await screen.findByText("Marked as done.");
    expect((await rows())[0]!.status).toBe("DONE");
    await userEvent.click(await day.findByRole("button", { name: "Reopen: Metformin 500" }));
    await screen.findByText("Reopened.");
    expect((await rows())[0]!.status).toBe("OPEN");

    await userEvent.click(await day.findByRole("button", { name: "Delete: Metformin 500" }));
    await userEvent.click(day.getByRole("button", { name: "Yes, delete" }));
    await screen.findByText("Entry deleted.");
    expect(await rows()).toEqual([]);
    await waitFor(() => expect(day.getByText("Nothing recorded for this day.")).toBeTruthy());
  });

  it("moves to the entry's own day, and month, when it is saved for another date", async () => {
    await opened();
    await addEntry("Insulin");
    const date = screen.getByLabelText("Date") as HTMLInputElement;
    await userEvent.clear(date);
    await userEvent.type(date, "2026-12-24");
    await userEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    await screen.findByText(/Added to your calendar \(24 Dec 2026\)/);
    expect(screen.getByRole("heading", { level: 2, name: "December 2026" })).toBeTruthy();
    expect(screen.getByRole("gridcell", { selected: true }).textContent).toContain("24");
    expect(await chip("Insulin")).toBeTruthy();
  });

  it("when a save fails, nothing is shown as saved, the input is kept, and trying again works", async () => {
    await opened();
    await addEntry("Aspirin", "WANT_TO_GET");
    hooks.failNextWrite = true;
    await userEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/That was not saved/);
    expect(screen.queryByText(/Added to your calendar/)).toBeNull();
    expect((screen.getByLabelText("Medicine") as HTMLInputElement).value).toBe("Aspirin");
    expect(await rows()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    await screen.findByText(/Added to your calendar/);
    expect(await rows()).toHaveLength(1);
  });

  it("shows no success while a write is still in flight, and a double press makes one entry", async () => {
    let release: () => void = () => undefined;
    hooks.gate = new Promise<void>((r) => (release = r));
    await opened();
    await addEntry("Ibuprofen");
    const submit = screen.getByRole("button", { name: "Add to calendar" });
    await userEvent.click(submit);
    await userEvent.click(screen.getByRole("button", { name: /Saving/ }));
    expect(screen.queryByText(/Added to your calendar/)).toBeNull();
    expect(await rows()).toEqual([]);
    await act(async () => release());
    await screen.findByText(/Added to your calendar/);
    expect(await rows()).toHaveLength(1);
  });

  it("an entry that does not validate is explained next to its field and nothing is written", async () => {
    await opened();
    await userEvent.click(screen.getByRole("button", { name: "Add medicine" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    expect(await screen.findByText("Enter or choose a medicine.")).toBeTruthy();
    expect(await rows()).toEqual([]);
  });

  it("only ever shows the signed-in person's own entries", async () => {
    await seed("bob", "Bob's private medicine");
    await seed("alice", "Alice's medicine");
    await opened();
    expect(await screen.findByText("Alice's medicine")).toBeTruthy();
    expect(screen.queryByText(/Bob's private medicine/)).toBeNull();
    cleanup();
    who = person("bob"); // a different account on the same browser
    await opened();
    expect(await screen.findByText("Bob's private medicine")).toBeTruthy();
    expect(screen.queryByText(/Alice's medicine/)).toBeNull();
  });

  it("when the session ends, the private entries leave the screen and sign-in is offered", async () => {
    await seed("alice", "Private entry");
    await opened();
    expect(await screen.findByText("Private entry")).toBeTruthy();
    who = null; // signed out in another tab, or expired
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByText("Your session has ended")).toBeTruthy();
    expect(screen.queryByText("Private entry")).toBeNull();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/signin?callbackUrl=%2Fcalendar");
  });

  it("a change attempted after the session ended is refused, written nowhere, and the person is told", async () => {
    await opened();
    await addEntry("Too late");
    who = null;
    await userEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    expect(await screen.findByText("Your session has ended")).toBeTruthy();
    expect(await rows()).toEqual([]);
  });

  it("says so when the calendar database is not set up, instead of showing an empty calendar", async () => {
    hasDb = false;
    render(<CalendarPage />);
    expect(await screen.findByText("Your calendar could not be loaded")).toBeTruthy();
    expect(screen.getByText("The calendar is not set up on this server yet.")).toBeTruthy();
  });

  it("offers a retry when loading fails, and recovers", async () => {
    hasDb = false;
    render(<CalendarPage />);
    await screen.findByText("Your calendar could not be loaded");
    hasDb = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText("Your calendar could not be loaded")).toBeNull());
    expect((await openDay()).getByText("Nothing recorded for this day.")).toBeTruthy();
  });

  it("marks days that have entries, with an accessible count", async () => {
    await seed("alice", "A");
    await seed("alice", "B");
    await opened();
    await waitFor(() => expect(screen.getByRole("button", { name: /10 November 2026, 2 entries/ })).toBeTruthy());
    expect(screen.getByRole("button", { name: /11 November 2026, no entries/ })).toBeTruthy();
  });
});

describe("the page: header, toolbar, month and day dialog", () => {
  it("is the calendar alone: no header, sidebar, menu or theme switch of its own (the shared app header is drawn by the shell)", async () => {
    await opened();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByText("Calendar actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: /theme|dark|light mode|appearance/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull(); // sign-out lives in the shared header
  });

  it("is one page: a single main landmark and one level-one heading", async () => {
    await opened();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("has previous, next and Today controls and a visible month and year", async () => {
    await opened();
    expect(screen.getByRole("heading", { level: 2, name: "November 2026" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("heading", { level: 2, name: "December 2026" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByRole("heading", { level: 2, name: "October 2026" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByRole("heading", { level: 2, name: "November 2026" })).toBeTruthy();
    expect(screen.getByRole("gridcell", { selected: true }).textContent).toContain("10");
  });

  it("selecting a date opens that day with its own count and entries, taken from what the server returned", async () => {
    await seed("alice", "On the tenth", "2026-11-10");
    await seed("alice", "On the twelfth", "2026-11-12");
    await seed("alice", "Also the twelfth", "2026-11-12");
    await opened();
    await chip("On the tenth");

    let day = await openDay(/10 November 2026/);
    expect(screen.getByRole("dialog", { name: /10 November 2026/ })).toBeTruthy();
    expect(day.getByText("1 medicine on this day")).toBeTruthy();
    expect(day.getByText("On the tenth")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    day = await openDay(/12 November 2026/);
    expect(screen.getByRole("dialog", { name: /12 November 2026/ })).toBeTruthy();
    expect(day.getByText("2 medicines on this day")).toBeTruthy();
    expect(day.getByText("On the twelfth")).toBeTruthy();
    expect(day.getByText("Also the twelfth")).toBeTruthy();
    expect(day.queryByText("On the tenth")).toBeNull();
    expect(screen.getByRole("gridcell", { selected: true }).textContent).toContain("12");
  });

  it("clicking anywhere in a day's cell opens it, and a day from the next month moves the calendar to that month", async () => {
    await opened();
    await userEvent.click(screen.getAllByRole("gridcell")[40]!); // the 41st cell of the November grid, which starts on Sunday 1 November: Friday 11 December
    expect(screen.getByRole("heading", { level: 2, name: "December 2026" })).toBeTruthy();
    expect(await screen.findByRole("dialog", { name: /\b11 December 2026/ })).toBeTruthy();
  });

  it("moves the selected date with the arrow keys, keeps focus on it, and does not open a dialog while doing so", async () => {
    await opened();
    screen.getByRole("button", { name: /10 November 2026/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /11 November 2026/ }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /18 November 2026/ }));
    expect(screen.getByRole("gridcell", { selected: true }).textContent).toContain("18");
    await userEvent.keyboard("{ArrowLeft}{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /10 November 2026/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.keyboard("{Enter}"); // Enter on the focused date opens it
    expect(await screen.findByRole("dialog", { name: /10 November 2026/ })).toBeTruthy();
  });

  it("walks across the end of the month into the next one", async () => {
    await opened();
    screen.getByRole("button", { name: /30 November 2026/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("heading", { level: 2, name: "December 2026" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /\b1 December 2026/ }));
  });

  it("shows entries in their day as chips whose type is in words, and a status that is not just colour", async () => {
    const id = await resolvePatientId(db, person("alice"));
    await db.query("INSERT INTO medicine_calendar_entries (patient_id, medicine_name, entry_type, entry_date, status, completed_at) VALUES ($1, 'Finished one', 'PURCHASED', '2026-11-10', 'DONE', now())", [id]);
    await db.query("INSERT INTO medicine_calendar_entries (patient_id, medicine_name, entry_type, entry_date) VALUES ($1, 'Waiting one', 'ORDERED', '2026-11-10')", [id]);
    await opened();
    expect(await screen.findByRole("button", { name: "Purchased: Finished one, done. Open to edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ordered: Waiting one. Open to edit" })).toBeTruthy();
    const day = await openDay();
    expect(day.getByText("Purchased")).toBeTruthy();
    expect(day.getByText("Done")).toBeTruthy();
    expect(day.getByText("2 medicines on this day · 1 done")).toBeTruthy();
  });

  it("clicking an entry in the grid opens it for editing, and a day with too many entries says how many more there are", async () => {
    for (const n of [1, 2, 3, 4, 5]) await seed("alice", `Entry ${n}`);
    await opened();
    await chip("Entry 1");
    expect(screen.queryByRole("button", { name: /Reminder: Entry 3/ })).toBeNull(); // 3 lines fit: two chips and the overflow line
    await userEvent.click(screen.getByRole("button", { name: /^3 more entries on/ }));
    expect((await screen.findByRole("dialog")).textContent).toContain("5 medicines on this day");
    expect(within(screen.getByRole("dialog")).getAllByRole("listitem")).toHaveLength(5);
    await userEvent.keyboard("{Escape}");

    await userEvent.click(screen.getByRole("button", { name: /Reminder: Entry 2/ }));
    const dialog = screen.getByRole("dialog", { name: "Edit entry" });
    expect((within(dialog).getByLabelText("Medicine") as HTMLInputElement).value).toBe("Entry 2");
  });

  it("shows a loading state until the entries arrive, and a day opened meanwhile does not claim to be empty", async () => {
    let release: () => void = () => undefined;
    hooks.readGate = new Promise<void>((r) => (release = r));
    await seed("alice", "Slow entry");
    render(<CalendarPage />);
    await screen.findByRole("heading", { level: 1, name: "Medicine Calendar" });
    expect(await screen.findByText("Loading your entries…")).toBeTruthy();
    const day = await openDay();
    expect(day.getByText("Loading…")).toBeTruthy();
    expect(day.queryByText("Nothing recorded for this day.")).toBeNull();
    await act(async () => release());
    expect(await day.findByText("Slow entry")).toBeTruthy();
    expect(screen.queryByText("Loading your entries…")).toBeNull();
  });

  it("shows a concise empty state with the way to add something", async () => {
    await opened();
    const day = await openDay();
    expect(day.getByText("Nothing recorded for this day.")).toBeTruthy();
    expect(day.getByText("No medicines on this day")).toBeTruthy();
    expect(day.getByRole("button", { name: "Add to this day" })).toBeTruthy();
  });

  it("adds for the opened day, goes back to the day on Cancel, and the toolbar adds for the selected day", async () => {
    await opened();
    const day = await openDay(/12 November 2026/);
    await userEvent.click(day.getByRole("button", { name: "Add to this day" }));
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("2026-11-12");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: /12 November 2026/ })).toBeTruthy(); // back to the day
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add medicine" }));
    expect(screen.getByRole("dialog", { name: "Add medicine" })).toBeTruthy();
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("2026-11-12");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull(); // opened from the month: Cancel and Escape close it
  });

  it("asks before deleting, and keeping the entry changes nothing", async () => {
    await seed("alice", "Keep me");
    await opened();
    await chip("Keep me");
    const day = await openDay();
    await userEvent.click(await day.findByRole("button", { name: "Delete: Keep me" }));
    expect(day.getByText("Delete this entry?")).toBeTruthy();
    await userEvent.click(day.getByRole("button", { name: "Keep it" }));
    expect(day.queryByText("Delete this entry?")).toBeNull();
    expect(await rows()).toHaveLength(1);
  });
});

describe("green shades for entries", () => {
  const shadeOfChip = (el: HTMLElement) => [...el.classList].filter((c) => /shade\d/.test(c)).join(" ");

  it("the same entry keeps the same shade across re-renders, months, reloads and views, and every entry gets one", async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) await seed("alice", `Shade ${n}`, `2026-11-0${n}`);
    await opened();
    const before = new Map<string, string>();
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const el = await chip(`Shade ${n}`);
      expect(shadeOfChip(el), `Shade ${n}`).toMatch(/shade\d/);
      before.set(`Shade ${n}`, shadeOfChip(el));
    }
    // away to another month and back, then a full reload
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    cleanup();
    await opened();
    for (const [name, shade] of before) expect(shadeOfChip(await chip(name)), name).toBe(shade);
    // and the same entry in the day dialog wears the same shade as its chip
    const day = await openDay(/\b3 November 2026/);
    const row = day.getByText("Shade 3").closest("li")!;
    expect(shadeOfChip(row as HTMLElement)).toBe(before.get("Shade 3"));
  });
});

describe("the add/edit dialog", () => {
  it("moves focus into the dialog, keeps Tab inside it, and Escape closes it and gives focus back", async () => {
    await opened();
    const opener = screen.getByRole("button", { name: "Add medicine" });
    opener.focus();
    await userEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Add medicine" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByLabelText("Medicine")).toBe(document.activeElement);

    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    cancel.focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("does not close, or lose the entry, while a save is in flight", async () => {
    let release: () => void = () => undefined;
    hooks.gate = new Promise<void>((r) => (release = r));
    await opened();
    await addEntry("Slow save");
    await userEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    await userEvent.keyboard("{Escape}");
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => release());
    await screen.findByText(/Added to your calendar/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await rows()).toHaveLength(1);
  });

  it("closes on a click outside it, and Cancel discards without saving", async () => {
    await opened();
    await addEntry("Never saved");
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add medicine" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await rows()).toEqual([]);
  });

  it("keeps the person's input in the dialog when a save fails", async () => {
    await opened();
    await addEntry("Kept words", "ORDERED");
    await userEvent.type(screen.getByLabelText(/Notes/), "my note");
    hooks.failNextWrite = true;
    await userEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
    const dialog = screen.getByRole("dialog");
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/That was not saved/);
    expect((within(dialog).getByLabelText("Medicine") as HTMLInputElement).value).toBe("Kept words");
    expect((within(dialog).getByLabelText(/Notes/) as HTMLTextAreaElement).value).toBe("my note");
    expect((within(dialog).getByLabelText("What is it?") as HTMLSelectElement).value).toBe("ORDERED");
  });
});

describe("adding a medicine from search results", () => {
  const medicine = async () => {
    const { rows: found } = await db.query<{ id: string; brand_name: string; dosage: string; form: string }>("SELECT id, brand_name, dosage, form FROM medicines ORDER BY id LIMIT 1");
    const m = found[0]!;
    return { id: Number(m.id), brandName: m.brand_name, dosage: m.dosage, form: m.form };
  };
  const renderIt = async () => {
    const m = await medicine();
    render(
      <AuthProvider>
        <AddToCalendar medicine={m} />
      </AuthProvider>,
    );
    return m;
  };

  it("signed in: saves the catalogue medicine through the private API, then links to the calendar", async () => {
    hooks.sessionBody = { user: { name: "alice", email: "alice@example.com", image: null } };
    const m = await renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Add to calendar" }));
    await userEvent.selectOptions(screen.getByLabelText("What is it?"), "ORDERED");
    await userEvent.click(screen.getByRole("button", { name: "Save to calendar" }));
    const confirmation = await screen.findByRole("status");
    expect(confirmation.textContent).toMatch(/Added to your calendar for 10 Nov 2026/);
    expect(within(confirmation).getByRole("link", { name: "View calendar" }).getAttribute("href")).toBe("/calendar");
    const [row] = await rows();
    expect(row).toMatchObject({ medicine_id: String(m.id), entry_type: "ORDERED", entry_date: "2026-11-10", subject: "alice" });
    expect(row!.medicine_name).toContain(m.brandName);
  });

  it("a failed save keeps the form open with the person's choices, and shows no confirmation", async () => {
    hooks.sessionBody = { user: { name: "alice", email: "alice@example.com", image: null } };
    await renderIt();
    await userEvent.click(await screen.findByRole("button", { name: "Add to calendar" }));
    await userEvent.selectOptions(screen.getByLabelText("What is it?"), "PURCHASED");
    hooks.failNextWrite = true;
    await userEvent.click(screen.getByRole("button", { name: "Save to calendar" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Something went wrong/);
    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByLabelText("What is it?") as HTMLSelectElement).value).toBe("PURCHASED");
    expect(await rows()).toEqual([]);
  });

  it("signed out: offers sign-in and brings the person back to this page; nothing can be saved", async () => {
    hooks.sessionBody = null;
    await renderIt();
    const link = await screen.findByRole("link", { name: /Sign in to add to your calendar/ });
    expect(link.getAttribute("href")).toMatch(/^\/signin\?callbackUrl=/);
    expect(screen.queryByRole("button", { name: "Add to calendar" })).toBeNull();
  });

  it("with sign-in not set up, it is not shown at all", async () => {
    hooks.sessionBody = { configured: false };
    const { container } = render(
      <AuthProvider>
        <AddToCalendar medicine={{ id: 1, brandName: "X", dosage: "1mg", form: "tablet" }} />
      </AuthProvider>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => undefined);
    expect(container.textContent).toBe("");
  });
});
