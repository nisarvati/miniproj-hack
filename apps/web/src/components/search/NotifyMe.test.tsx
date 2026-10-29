// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount } from "../providers/account";
import { mockApi, renderWithProviders } from "../../test/utils";
import { NotifyMe } from "./NotifyMe";

const crocin = { id: 1, brandName: "Crocin", dosage: "500mg" };
const subscription = { id: 7, status: "ACTIVE", medicine: crocin, createdAt: "2026-10-05T12:00:00Z", notifiedAt: null };

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotifyMe", () => {
  it("rejects an obviously wrong email without calling the server", async () => {
    const api = mockApi({ "GET /api/notifications": () => ({ body: { data: [] } }) });
    renderWithProviders(<NotifyMe medicine={crocin} />);
    await userEvent.type(screen.getByLabelText(/notify me when/i), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: "Notify me" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/valid email address/i);
    expect(api.count("POST", "/api/restock-subscriptions")).toBe(0);
  });

  it("subscribes, says so, and remembers the email on this device", async () => {
    const api = mockApi({
      "POST /api/restock-subscriptions": () => ({ status: 201, body: { data: subscription, meta: { created: true } } }),
      "GET /api/notifications": () => ({ body: { data: [] } }),
    });
    renderWithProviders(<NotifyMe medicine={crocin} />);
    await userEvent.type(screen.getByLabelText(/notify me when/i), "Asha@Example.com");
    await userEvent.click(screen.getByRole("button", { name: "Notify me" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/You're on the list\.\s*We'll add an alert to your MedLink notifications when Crocin 500mg is restocked at any pharmacy, and email asha@example\.com if email alerts are switched on/);
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({ email: "Asha@Example.com", medicineId: 1 });
    expect(localStorage.getItem("medlink:notify-email")).toBe("asha@example.com");
    expect(screen.getByRole("link", { name: /see my notifications/i }).getAttribute("href")).toBe("/notifications");
  });

  it("tells you when you were already waiting", async () => {
    mockApi({
      "POST /api/restock-subscriptions": () => ({ body: { data: subscription, meta: { created: false } } }),
      "GET /api/notifications": () => ({ body: { data: [] } }),
    });
    renderWithProviders(<NotifyMe medicine={crocin} />);
    await userEvent.type(screen.getByLabelText(/notify me when/i), "asha@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Notify me" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/already on the list/i);
  });

  it("lets a newly created subscription be undone", async () => {
    const api = mockApi({
      "POST /api/restock-subscriptions": () => ({ status: 201, body: { data: subscription, meta: { created: true } } }),
      "DELETE /api/restock-subscriptions/*": () => ({ body: { data: {} } }),
      "GET /api/notifications": () => ({ body: { data: [] } }),
    });
    renderWithProviders(<NotifyMe medicine={crocin} />);
    await userEvent.type(screen.getByLabelText(/notify me when/i), "asha@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Notify me" }));
    await screen.findByRole("status");
    await userEvent.click(screen.getByRole("button", { name: "Undo subscription" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Notify me" })).toBeTruthy());
    expect(api.calls.find((c) => c.method === "DELETE")?.path).toBe("/api/restock-subscriptions/7");
  });

  it("restores the subscription confirmation if undo fails", async () => {
    mockApi({
      "POST /api/restock-subscriptions": () => ({ status: 201, body: { data: subscription, meta: { created: true } } }),
      "DELETE /api/restock-subscriptions/*": () => ({ status: 503, body: {} }),
      "GET /api/notifications": () => ({ body: { data: [] } }),
    });
    renderWithProviders(<NotifyMe medicine={crocin} />);
    await userEvent.type(screen.getByLabelText(/notify me when/i), "asha@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Notify me" }));
    await screen.findByRole("status");
    await userEvent.click(screen.getByRole("button", { name: "Undo subscription" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/temporarily unavailable/i);
    expect(screen.getByText("You're on the list.")).toBeTruthy();
  });

  it("prefills the email it remembers", async () => {
    localStorage.setItem("medlink:notify-email", "asha@example.com");
    mockApi({ "GET /api/notifications": () => ({ body: { data: [] } }) });
    renderWithProviders(<NotifyMe medicine={crocin} />);
    await waitFor(() => expect((screen.getByLabelText(/notify me when/i) as HTMLInputElement).value).toBe("asha@example.com"));
  });

  it("does not overwrite what the person is typing when the remembered email turns up late", async () => {
    mockApi({ "GET /api/notifications": () => ({ body: { data: [] } }) });
    function Harness() {
      const { setEmail } = useAccount();
      return (
        <>
          <button onClick={() => setEmail("saved@example.com")}>remember</button>
          <NotifyMe medicine={crocin} />
        </>
      );
    }
    renderWithProviders(<Harness />);
    const input = screen.getByLabelText(/notify me when/i) as HTMLInputElement;
    await userEvent.type(input, "other@example.com");
    await userEvent.click(screen.getByRole("button", { name: "remember" })); // the account learns an email afterwards
    expect(input.value).toBe("other@example.com");
  });

  it("fills in the remembered email when it turns up after the form is already showing", async () => {
    mockApi({ "GET /api/notifications": () => ({ body: { data: [] } }) });
    function Harness() {
      const { setEmail } = useAccount();
      return (
        <>
          <button onClick={() => setEmail("saved@example.com")}>remember</button>
          <NotifyMe medicine={crocin} />
        </>
      );
    }
    renderWithProviders(<Harness />);
    const input = screen.getByLabelText(/notify me when/i) as HTMLInputElement;
    expect(input.value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "remember" }));
    await waitFor(() => expect(input.value).toBe("saved@example.com"));
  });

  it("shows a safe message when the server fails, and lets you try again", async () => {
    let fail = true;
    mockApi({
      "POST /api/restock-subscriptions": () => (fail ? { status: 503, body: { error: { message: "db password is hunter2" } } } : { status: 201, body: { data: subscription, meta: { created: true } } }),
      "GET /api/notifications": () => ({ body: { data: [] } }),
    });
    renderWithProviders(<NotifyMe medicine={crocin} />);
    await userEvent.type(screen.getByLabelText(/notify me when/i), "asha@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Notify me" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/temporarily unavailable/i);
    expect(alert.textContent).not.toMatch(/hunter2/);

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Notify me" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/on the list/i);
  });

  it("disables the button while saving so it cannot be sent twice", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const api = mockApi({ "GET /api/notifications": () => ({ body: { data: [] } }), "POST /api/restock-subscriptions": () => ({ body: { data: subscription, meta: { created: true } } }) });
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") await gate;
      return original(input, init);
    });
    renderWithProviders(<NotifyMe medicine={crocin} />);
    await userEvent.type(screen.getByLabelText(/notify me when/i), "asha@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Notify me" }));
    const busy = await screen.findByRole("button", { name: /saving/i });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByRole("status");
    expect(api.count("POST", "/api/restock-subscriptions")).toBe(1);
  });
});
