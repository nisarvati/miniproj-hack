// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/search" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn() }) }));

import { AppShell } from "./AppShell";

const signedIn = { user: { name: "Alice Example", email: "alice@example.com", image: null } };
/** A fake backend for what the shell asks for: who is signed in (Auth.js's session route) and the notification list. */
const api = (session: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost:3000").pathname;
    if (path === "/auth/session") return Response.json(session);
    if (path === "/api/notifications") return Response.json({ data: [] });
    return new Response("{}", { status: 500 });
  }));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const header = () => within(screen.getByRole("banner"));
const mainNav = () => within(header().getAllByRole("navigation", { name: "Main" })[0]!);

describe("the shared header, on /search and on /calendar", () => {
  it.each(["/search", "/calendar", "/pharmacies", "/notifications"])("%s: the same brand, destinations and account, with the current page marked", async (path) => {
    api(signedIn);
    nav.pathname = path;
    render(<AppShell signOutAction={async () => undefined}><main /></AppShell>);

    expect(header().getByRole("link", { name: "MedLink home" }).getAttribute("href")).toBe("/");
    await screen.findByRole("link", { name: "Your account: Alice Example" }); // the session has loaded
    const links = mainNav().getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([["Search", "/search"], ["Pharmacies", "/pharmacies"], ["Notifications", "/notifications"], ["Dashboard", "/dashboard"], ["Calendar", "/calendar"]]);
    const current = mainNav().getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.getAttribute("href"))).toEqual([path]);
    expect(header().getByRole("link", { name: "Your account: Alice Example" }).getAttribute("href")).toBe("/account");
    expect(header().getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(header().getByRole("button", { name: /Andheri West|location/i })).toBeTruthy(); // the location control
  });

  it("every page's header has the identical container: same width, margins and height, so everything lines up", async () => {
    api(signedIn);
    const containers = new Set<string>();
    for (const path of ["/search", "/calendar", "/pharmacies", "/notifications", "/account", "/portal"]) {
      nav.pathname = path;
      const { container, unmount } = render(<AppShell><main /></AppShell>);
      containers.add(container.querySelector("header > div")!.className);
      unmount();
    }
    expect([...containers]).toEqual(["mx-auto flex h-16 max-w-6xl items-center gap-3 px-4"]);
  });

  it("on /calendar the phone tab bar is there too, so every destination is reachable on a phone; and there is no sidebar or footer", async () => {
    api(signedIn);
    nav.pathname = "/calendar";
    render(<AppShell><main /></AppShell>);
    await screen.findByRole("link", { name: "Your account: Alice Example" });
    const bars = screen.getAllByRole("navigation", { name: "Main" });
    expect(bars).toHaveLength(2); // the header's (tablet and up) and the phone tab bar
    for (const bar of bars) expect(within(bar).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/search", "/pharmacies", "/notifications", "/dashboard", "/calendar"]);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(screen.getByRole("link", { name: "Skip to the calendar" }).getAttribute("href")).toBe("#cal-main");
  });

  it("signing out uses the server's sign-out action", async () => {
    api(signedIn);
    nav.pathname = "/calendar";
    const action = vi.fn(async () => undefined);
    render(<AppShell signOutAction={action}><main /></AppShell>);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("signed out: a Sign in link and no account or sign-out; the destinations are Search, Pharmacies, Notifications and Dashboard", async () => {
    api(null);
    nav.pathname = "/search";
    render(<AppShell signOutAction={async () => undefined}><main /></AppShell>);
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe("/signin");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Your account/ })).toBeNull();
    expect(mainNav().getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/search", "/pharmacies", "/notifications", "/dashboard"]);
  });

  it("without a sign-out action there is no sign-out button (nothing is invented)", async () => {
    api(signedIn);
    nav.pathname = "/search";
    render(<AppShell><main /></AppShell>);
    await screen.findByRole("link", { name: "Your account: Alice Example" });
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
