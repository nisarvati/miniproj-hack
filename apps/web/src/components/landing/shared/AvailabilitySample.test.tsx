// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { medicine, mockApi, offer, pharmacy, renderWithProviders } from "../../../test/utils";
import { AvailabilitySample } from "./AvailabilitySample";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noNotifications = { "GET /api/notifications": () => ({ body: { data: [] } }) };

describe("AvailabilitySample", () => {
  it("searches for Paracetamol and shows what the API returned, with the returned strength and form", async () => {
    const api = mockApi({
      ...noNotifications,
      "GET /api/search": () => ({
        body: {
          data: [
            offer({ medicine: medicine({ brandName: "Dolo", dosage: "650mg", form: "tablet" }), pharmacy: pharmacy({ name: "Pharmacy B", code: "P002" }), price: 29.44, distanceKm: 2.6, quantity: 54 }),
            offer({ rank: 2, medicine: medicine({ id: 2, brandName: "Calpol", dosage: "250mg", form: "syrup" }), stockStatus: "LOW_STOCK", quantity: 3, source: "catalogue", updatedAt: "2026-10-05T12:00:00Z" }),
          ],
          meta: { live: true },
        },
      }),
    });
    renderWithProviders(<AvailabilitySample />);
    const table = await screen.findByRole("table");
    expect(api.calls.find((c) => c.path === "/api/search")!.search.get("q")).toBe("Paracetamol");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]!.textContent).toMatch(/Dolo 650mg/);
    expect(rows[1]!.textContent).toMatch(/tablet/);
    expect(rows[1]!.textContent).toMatch(/Pharmacy B/);
    expect(rows[1]!.textContent).toMatch(/In stock · 54/);
    expect(rows[1]!.textContent).toMatch(/₹29\.44/);
    expect(rows[1]!.textContent).toMatch(/Live · updated/);
    expect(rows[2]!.textContent).toMatch(/Calpol 250mg/);
    expect(rows[2]!.textContent).toMatch(/Low stock · 3/);
    expect(rows[2]!.textContent).toMatch(/Last known · updated/);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("says so when live stock is unavailable instead of presenting the figures as live", async () => {
    mockApi({ ...noNotifications, "GET /api/search": () => ({ body: { data: [offer({ source: "catalogue" })], meta: { live: false } } }) });
    renderWithProviders(<AvailabilitySample />);
    expect((await screen.findByText(/Live stock is unavailable right now/)).textContent).toMatch(/last known/);
  });

  it("shows an honest error, never mock rows, and lets the reviewer retry or choose the illustrative preview", async () => {
    let fail = true;
    mockApi({ ...noNotifications, "GET /api/search": () => (fail ? { status: 503, body: {} } : { body: { data: [offer()], meta: { live: true } } }) });
    renderWithProviders(<AvailabilitySample />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be loaded/);
    expect(screen.queryByRole("table")).toBeNull();

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows invented rows only when the illustrative preview is chosen, and labels them as invented", async () => {
    const api = mockApi({ ...noNotifications, "GET /api/search": () => ({ status: 503, body: {} }) });
    renderWithProviders(<AvailabilitySample />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("table")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Show illustrative preview" }));
    expect(screen.getByRole("note").textContent).toMatch(/not live data/);
    expect(screen.getAllByText(/Example Pharmacy/).length).toBe(3);
    expect(screen.getAllByText(/^Example: updated/).length).toBe(3);
    expect(screen.getByRole("button", { name: "Illustrative preview" }).getAttribute("aria-pressed")).toBe("true");
    const before = api.count("GET", "/api/search");

    await userEvent.click(screen.getByRole("button", { name: "Live data" }));
    expect(screen.queryByText(/Example Pharmacy/)).toBeNull();
    expect(api.count("GET", "/api/search")).toBeGreaterThan(before);
  });

  it("says when no pharmacy matched", async () => {
    mockApi({ ...noNotifications, "GET /api/search": () => ({ body: { data: [], meta: { live: true } } }) });
    renderWithProviders(<AvailabilitySample />);
    expect((await screen.findByText(/No participating pharmacy returned a match/)).textContent).toMatch(/Paracetamol/);
    expect(screen.queryByRole("table")).toBeNull();
  });
});
