// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, renderWithProviders } from "../../test/utils";
import { NotificationsPage } from "./NotificationsPage";

const note = (id: number, message = `Crocin 500mg is back in stock at Pharmacy ${id} (12 available).`) => ({ id, message, createdAt: new Date().toISOString(), deliveredAt: new Date().toISOString() });
const sub = (id: number, status: "ACTIVE" | "NOTIFIED" | "CANCELLED", name = "Crocin") => ({
  id,
  status,
  medicine: { id, brandName: name, dosage: "500mg" },
  createdAt: new Date().toISOString(),
  notifiedAt: status === "NOTIFIED" ? new Date().toISOString() : null,
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const signedIn = () => localStorage.setItem("medlink:notify-email", "asha@example.com");

describe("NotificationsPage without an email", () => {
  it("asks for the email, rejects a wrong one, and shows the notifications for a right one", async () => {
    const api = mockApi({ "GET /api/notifications": () => ({ body: { data: [note(1)] } }), "GET /api/restock-subscriptions": () => ({ body: { data: [] } }) });
    renderWithProviders(<NotificationsPage />);
    expect(screen.getByRole("heading", { name: "See your notifications" })).toBeTruthy();
    expect(api.calls).toEqual([]); // nothing is asked of the server before there is an email

    await userEvent.type(screen.getByLabelText("Your email"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Show my notifications" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/valid email/i);
    expect(api.calls).toEqual([]);

    await userEvent.clear(screen.getByLabelText("Your email"));
    await userEvent.type(screen.getByLabelText("Your email"), "Asha@Example.com");
    await userEvent.click(screen.getByRole("button", { name: "Show my notifications" }));
    expect(await screen.findByText(/back in stock at Pharmacy 1/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\(12 available\)|12 available/); // the stored text has the unit count; the page does not show it
    expect(api.calls.find((c) => c.path === "/api/notifications")!.search.get("email")).toBe("asha@example.com");
    expect(localStorage.getItem("medlink:notify-email")).toBe("asha@example.com");
  });
});

describe("NotificationsPage with an email", () => {
  it("lists notifications, newest first, marked New and as simulated", async () => {
    signedIn();
    mockApi({ "GET /api/notifications": () => ({ body: { data: [note(2), note(1)] } }), "GET /api/restock-subscriptions": () => ({ body: { data: [] } }) });
    renderWithProviders(<NotificationsPage />);
    const items = await screen.findAllByText(/is back in stock/);
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining("Pharmacy 2"), expect.stringContaining("Pharmacy 1")]);
    expect(screen.getAllByText("New")).toHaveLength(2);
    expect(screen.getAllByText(/simulated notification/).length).toBe(2);
    expect(screen.getByText("Notifications (2)")).toBeTruthy();
  });

  it("marks an individual new notification as read", async () => {
    signedIn();
    mockApi({ "GET /api/notifications": () => ({ body: { data: [note(9)] } }), "GET /api/restock-subscriptions": () => ({ body: { data: [] } }) });
    renderWithProviders(<NotificationsPage />);
    await screen.findByText(/back in stock at Pharmacy 9/);
    await userEvent.click(screen.getByRole("button", { name: /Mark Crocin .* as read/i }));
    expect(screen.queryByText("New")).toBeNull();
    expect(localStorage.getItem("medlink:seen:asha@example.com")).toBe("9");
  });

  it("says what to do when there are none", async () => {
    signedIn();
    mockApi({ "GET /api/notifications": () => ({ body: { data: [] } }), "GET /api/restock-subscriptions": () => ({ body: { data: [] } }) });
    renderWithProviders(<NotificationsPage />);
    expect(await screen.findByText("No notifications yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: /search for a medicine/i }).getAttribute("href")).toBe("/search");
  });

  it("shows a retry action when notifications cannot be refreshed", async () => {
    signedIn();
    mockApi({ "GET /api/notifications": () => ({ status: 503, body: {} }), "GET /api/restock-subscriptions": () => ({ body: { data: [] } }) });
    renderWithProviders(<NotificationsPage />);
    expect(await screen.findByText("We couldn't refresh your notifications")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("marks all shown notifications as read on request", async () => {
    signedIn();
    mockApi({ "GET /api/notifications": () => ({ body: { data: [note(5)] } }), "GET /api/restock-subscriptions": () => ({ body: { data: [] } }) });
    renderWithProviders(<NotificationsPage />);
    await screen.findByText(/back in stock/);
    await userEvent.click(await screen.findByRole("button", { name: "Mark all as read (1)" }));
    await waitFor(() => expect(localStorage.getItem("medlink:seen:asha@example.com")).toBe("5"));
  });

  it("lists what you are waiting for, and cancels it", async () => {
    signedIn();
    let subs = [sub(1, "ACTIVE", "Crocin"), sub(2, "ACTIVE", "Dolo")];
    const api = mockApi({
      "GET /api/notifications": () => ({ body: { data: [] } }),
      "GET /api/restock-subscriptions": () => ({ body: { data: subs } }),
      "DELETE /api/restock-subscriptions/*": (url) => {
        subs = subs.filter((s) => String(s.id) !== url.pathname.split("/").pop());
        return { body: { data: {} } };
      },
    });
    renderWithProviders(<NotificationsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Waiting \(2\)/ }));
    expect(await screen.findByText("Dolo 500mg")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /stop waiting for Dolo/i }));
    await waitFor(() => expect(screen.queryByText("Dolo 500mg")).toBeNull());
    const del = api.calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/api/restock-subscriptions/2");
    expect(del.search.get("email")).toBe("asha@example.com");
    expect(screen.getByText("Crocin 500mg")).toBeTruthy();
  });

  it("treats 'already fulfilled' as done: no error, the list just refreshes", async () => {
    signedIn();
    let subs = [sub(1, "ACTIVE")];
    mockApi({
      "GET /api/notifications": () => ({ body: { data: [] } }),
      "GET /api/restock-subscriptions": () => ({ body: { data: subs } }),
      "DELETE /api/restock-subscriptions/*": () => {
        subs = [sub(1, "NOTIFIED")]; // it was fulfilled while the page was open
        return { status: 404, body: { error: {} } };
      },
    });
    renderWithProviders(<NotificationsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Waiting/ }));
    await userEvent.click(await screen.findByRole("button", { name: /stop waiting/i }));
    await waitFor(() => expect(screen.getByText("You're not waiting for anything")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a real failure to cancel", async () => {
    signedIn();
    mockApi({
      "GET /api/notifications": () => ({ body: { data: [] } }),
      "GET /api/restock-subscriptions": () => ({ body: { data: [sub(1, "ACTIVE")] } }),
      "DELETE /api/restock-subscriptions/*": () => ({ status: 503, body: {} }),
    });
    renderWithProviders(<NotificationsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Waiting/ }));
    await userEvent.click(await screen.findByRole("button", { name: /stop waiting/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/temporarily unavailable/i);
  });

  it("keeps fulfilled and cancelled subscriptions under 'Earlier'", async () => {
    signedIn();
    mockApi({
      "GET /api/notifications": () => ({ body: { data: [] } }),
      "GET /api/restock-subscriptions": () => ({ body: { data: [sub(1, "NOTIFIED", "Crocin"), sub(2, "CANCELLED", "Dolo"), sub(3, "ACTIVE", "Calpol")] } }),
    });
    renderWithProviders(<NotificationsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Waiting \(1\)/ }));
    const earlier = (await screen.findByText(/Earlier \(2\)/)).closest("details")!;
    expect(within(earlier).getByText("Notified")).toBeTruthy();
    expect(within(earlier).getByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("Calpol 500mg")).toBeTruthy();
  });

  it("'Not you?' forgets the email on this device and goes back to asking", async () => {
    signedIn();
    mockApi({ "GET /api/notifications": () => ({ body: { data: [] } }), "GET /api/restock-subscriptions": () => ({ body: { data: [] } }) });
    renderWithProviders(<NotificationsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /not you/i }));
    expect(await screen.findByRole("heading", { name: "See your notifications" })).toBeTruthy();
    expect(localStorage.getItem("medlink:notify-email")).toBeNull();
  });
});
