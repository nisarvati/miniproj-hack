// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi } from "../../test/utils";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn() }) }));

import { AppShell } from "./AppShell";

beforeEach(() => {
  localStorage.clear();
  mockApi({ "GET /api/notifications": () => ({ body: { data: [] } }) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppShell", () => {
  it("wraps ordinary pages in the app's header, navigation and footer", () => {
    nav.pathname = "/pharmacies";
    render(<AppShell><p>page</p></AppShell>);
    expect(screen.getByRole("link", { name: "MedLink home" })).toBeTruthy();
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("contentinfo")).toBeTruthy();
  });

  it.each(["/", "/signin", "/landing", "/landing/v3"])("leaves %s to draw its own page (no app chrome)", (path) => {
    nav.pathname = path;
    render(<AppShell><p>landing page</p></AppShell>);
    expect(screen.getByText("landing page")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "MedLink home" })).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(screen.queryByRole("link", { name: "Skip to content" })).toBeNull();
  });

  it("applies the app theme to ordinary pages only, never to the homepage or the landing previews", () => {
    for (const path of ["/search", "/pharmacies", "/pharmacies/2", "/notifications", "/portal"]) {
      nav.pathname = path;
      const { container, unmount } = render(<AppShell><p>page</p></AppShell>);
      expect(container.querySelector(".app-theme"), path).not.toBeNull();
      expect(container.querySelector(".app-theme main#main"), path).not.toBeNull();
      unmount();
    }
    for (const path of ["/", "/landing", "/landing/v1", "/landing/v2", "/landing/v5"]) {
      nav.pathname = path;
      const { container, unmount } = render(<AppShell><p>page</p></AppShell>);
      expect(container.querySelector(".app-theme"), path).toBeNull();
      unmount();
    }
  });

  it("gives /dashboard the full window below the same header: the dashboard fills what is left, with no footer, margins or width limit", () => {
    nav.pathname = "/dashboard";
    const { container } = render(<AppShell><p>dashboard</p></AppShell>);
    expect(screen.getByText("dashboard")).toBeTruthy();
    expect(screen.getByRole("link", { name: "MedLink home" })).toBeTruthy(); // the same header
    expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("contentinfo")).toBeNull();
    const shell = container.querySelector(".app-theme")!;
    expect(shell.classList.contains("app-shell-fill")).toBe(true);
    const main = screen.getByRole("main");
    expect(main.id).toBe("main");
    expect(main.classList.contains("dash-main")).toBe(true);
    expect(main.className).not.toMatch(/max-w-|min-h-\[calc/);
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
  });

  it("gives /calendar the app theme and the same header as every page, without the footer", () => {
    nav.pathname = "/calendar";
    const { container } = render(<AppShell><main><p>calendar workspace</p></main></AppShell>);
    expect(container.querySelector(".app-theme.app-shell-fill")).not.toBeNull();
    expect(screen.getByText("calendar workspace")).toBeTruthy();
    expect(screen.getByRole("link", { name: "MedLink home" })).toBeTruthy();
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.queryByRole("contentinfo")).toBeNull();
  });

  it("has no theme switch, and a saved \"dark\" choice or a dark operating system cannot turn dark mode on", () => {
    localStorage.setItem("medlink:theme", "dark");
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: /dark/.test(query), media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
    for (const path of ["/search", "/calendar", "/pharmacies", "/"]) {
      nav.pathname = path;
      const { unmount } = render(<AppShell><p>page</p></AppShell>);
      expect(document.documentElement.classList.contains("dark"), path).toBe(false);
      expect(screen.queryByRole("button", { name: /theme|dark|light mode|appearance/i }), path).toBeNull();
      unmount();
    }
    expect(localStorage.getItem("medlink:theme")).toBe("dark"); // left alone: nothing reads it any more
  });

  it("does not treat lookalike routes as landing pages", () => {
    nav.pathname = "/landings";
    render(<AppShell><p>x</p></AppShell>);
    expect(screen.getByRole("link", { name: "MedLink home" })).toBeTruthy();
  });
});
