// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StaffAccount } from "../../lib/portal";
import { mockApi } from "../../test/utils";
import { AdminPanel } from "./AdminPanel";
import { PortalPage } from "./PortalPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const account = (over: Partial<StaffAccount> = {}): StaffAccount => ({
  id: "11", email: "new.staff@pharmacy.test", role: "STAFF", pharmacyCode: "P002", status: "pending", requestedAt: new Date().toISOString(), decidedAt: null, ...over,
});
const page = (items: StaffAccount[], total = items.length, offset = 0, status = "pending") => ({ body: { data: items, meta: { total, limit: 20, offset, hasMore: offset + items.length < total, status } } });
const session = { email: "root@medlink.test", role: "ADMIN" as const, pharmacy: null };
const noop = () => undefined;
const decided = (a: StaffAccount, status: StaffAccount["status"]) => ({ body: { data: { ...a, status, decidedAt: new Date().toISOString() } } });

describe("AdminPanel", () => {
  it("says who the administrator is and what the role can and cannot see", async () => {
    mockApi({ "GET /portal/admin/staff-requests": () => page([]) });
    render(<AdminPanel session={session} onSignedOut={noop} />);
    expect(screen.getByRole("heading", { level: 1, name: "Pharmacy access" })).toBeTruthy();
    expect(screen.getByText("Signed in as root@medlink.test")).toBeTruthy();
    expect(screen.getByText(/cannot see any pharmacy's\s+stock, history, alerts or restock plans/)).toBeTruthy();
    await screen.findByRole("heading", { name: "No requests are waiting" });
  });

  it("lists the requests with the person, the pharmacy they ask for and the state in words", async () => {
    mockApi({ "GET /portal/admin/staff-requests": () => page([account(), account({ id: "12", email: "other@pharmacy.test", pharmacyCode: "P004" })]) });
    render(<AdminPanel session={session} onSignedOut={noop} />);
    expect(screen.getByRole("status").textContent).toMatch(/Loading staff accounts/);
    const rows = within(await screen.findByRole("list", { name: "Accounts" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/new\.staff@pharmacy\.test/);
    expect(rows[0]!.textContent).toMatch(/Pharmacy P002/);
    expect(rows[0]!.textContent).toMatch(/Account status: Waiting for a decision/);
    expect(rows[1]!.textContent).toMatch(/Pharmacy P004/);
    expect(screen.getByText("Showing 1–2 of 2")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/password|hash|scrypt/i);
  });

  it("approves a request by id, says so, and reads the list again", async () => {
    let approved = false;
    const api = mockApi({
      "GET /portal/admin/staff-requests": () => page(approved ? [] : [account()]),
      "POST /portal/admin/staff-requests/*/decision": () => ((approved = true), decided(account(), "active")),
    });
    render(<AdminPanel session={session} onSignedOut={noop} />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve new.staff@pharmacy.test" }));
    expect(await screen.findByText("Approved new.staff@pharmacy.test for pharmacy P002.")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "No requests are waiting" })).toBeTruthy();
    const post = api.calls.find((c) => c.method === "POST")!;
    expect([post.path, post.body]).toEqual(["/portal/admin/staff-requests/11/decision", { decision: "approve" }]);
  });

  it("declines a request", async () => {
    const api = mockApi({ "GET /portal/admin/staff-requests": () => page([account()]), "POST /portal/admin/staff-requests/*/decision": () => decided(account(), "rejected") });
    render(<AdminPanel session={session} onSignedOut={noop} />);
    await userEvent.click(await screen.findByRole("button", { name: "Decline new.staff@pharmacy.test" }));
    expect(await screen.findByText("Declined new.staff@pharmacy.test.")).toBeTruthy();
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "reject" });
  });

  it("asks before removing someone's access, and sends nothing until confirmed", async () => {
    const api = mockApi({
      "GET /portal/admin/staff-requests": () => page([account({ status: "active", email: "staff@pharmacy.test" })], 1, 0, "active"),
      "POST /portal/admin/staff-requests/*/decision": () => decided(account({ status: "active" }), "rejected"),
    });
    render(<AdminPanel session={session} onSignedOut={noop} />);
    await userEvent.click(await screen.findByRole("button", { name: "Active" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove access for staff@pharmacy.test" }));
    expect(screen.getByText(/signed out at their next request/)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === "POST")).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove access for staff@pharmacy.test" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, remove access" }));
    expect(await screen.findByText("Access removed for staff@pharmacy.test.")).toBeTruthy();
    expect(api.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ decision: "revoke" }]);
  });

  it("offers no decision for an administrator account", async () => {
    mockApi({ "GET /portal/admin/staff-requests": () => page([account({ role: "ADMIN", pharmacyCode: null, status: "active", email: "root@medlink.test" })], 1, 0, "all") });
    render(<AdminPanel session={session} onSignedOut={noop} />);
    await userEvent.click(await screen.findByRole("button", { name: "All" }));
    const row = (await screen.findByText("root@medlink.test")).closest("li")!;
    expect(row.textContent).toMatch(/Administrator \(no pharmacy\)/);
    expect(within(row).queryAllByRole("button")).toEqual([]);
  });

  it("shows the server's refusal and leaves the row as it was", async () => {
    mockApi({
      "GET /portal/admin/staff-requests": () => page([account()]),
      "POST /portal/admin/staff-requests/*/decision": () => ({ status: 409, body: { error: { code: "ACCOUNT_STATE", message: "This account is active, so it cannot be approved." } } }),
    });
    render(<AdminPanel session={session} onSignedOut={noop} />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve new.staff@pharmacy.test" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/This account is active, so it cannot be approved/);
    expect(screen.getByText("new.staff@pharmacy.test")).toBeTruthy();
  });

  it("filters, pages and shows loading, empty and error states with a retry", async () => {
    let up = false;
    const api = mockApi({
      "GET /portal/admin/staff-requests": (url) => {
        if (!up) return { status: 503, body: { error: { code: "X", message: "down" } } };
        const offset = Number(url.searchParams.get("offset"));
        return page(Array.from({ length: Math.min(20, 25 - offset) }, (_, i) => account({ id: String(offset + i), email: `user${offset + i}@pharmacy.test` })), 25, offset, url.searchParams.get("status")!);
      },
    });
    render(<AdminPanel session={session} onSignedOut={noop} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't load the accounts/);
    up = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Showing 1–20 of 25")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(await screen.findByText("Showing 21–25 of 25")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(api.calls.at(-1)!.search.get("status")).toBe("all"));
    expect(api.calls.at(-1)!.search.get("offset")).toBe("0"); // a new filter starts at the top
  });

  it("goes back to sign-in when the session has ended", async () => {
    mockApi({ "GET /portal/admin/staff-requests": () => ({ status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Please sign in" } } }) });
    const onSignedOut = vi.fn();
    render(<AdminPanel session={session} onSignedOut={onSignedOut} />);
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  });
});

describe("in the portal", () => {
  it("an administrator is shown the access page and the page asks for no pharmacy data at all", async () => {
    const api = mockApi({
      "GET /portal/me": () => ({ body: { data: { email: "root@medlink.test", role: "ADMIN", pharmacy: null } } }),
      "GET /portal/admin/staff-requests": () => page([]),
    });
    render(<PortalPage />);
    expect(await screen.findByRole("heading", { level: 1, name: "Pharmacy access" })).toBeTruthy();
    await screen.findByRole("heading", { name: "No requests are waiting" });
    expect(screen.queryByText(/Managing inventory for/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Record sale" })).toBeNull();
    const asked = api.calls.map((c) => c.path);
    expect(asked.every((p) => p === "/portal/me" || p.startsWith("/portal/admin/"))).toBe(true); // no stock, history, alerts, plans or export requested
  });

  it("signing out clears the session", async () => {
    const api = mockApi({
      "GET /portal/me": () => ({ body: { data: { email: "root@medlink.test", role: "ADMIN", pharmacy: null } } }),
      "GET /portal/admin/staff-requests": () => page([]),
      "POST /portal/logout": () => ({ status: 204, body: undefined }),
    });
    render(<PortalPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.calls.some((c) => c.path === "/portal/logout" && c.method === "POST")).toBe(true));
  });

  it("an account with no pharmacy and no administrator role is told, not shown a broken page", async () => {
    mockApi({ "GET /portal/me": () => ({ body: { data: { email: "odd@pharmacy.test", role: "STAFF", pharmacy: null } } }) });
    render(<PortalPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/This account has no pharmacy/);
  });
});
