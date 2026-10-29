// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/search" }));

import { AuthProvider } from "../providers/auth";
import { BottomNav, TopNav } from "./nav";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const session = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => body })));
const shell = () =>
  render(
    <AuthProvider>
      <TopNav />
      <BottomNav />
    </AuthProvider>,
  );

describe("the Calendar link", () => {
  it("appears in both navigations for a signed-in patient", async () => {
    session({ user: { name: "Asha", email: "a@example.com", image: null } });
    shell();
    await waitFor(() => expect(screen.getAllByRole("link", { name: /Calendar/ })).toHaveLength(2));
    expect(screen.getAllByRole("link", { name: /Calendar/ }).every((l) => l.getAttribute("href") === "/calendar")).toBe(true);
  });

  it("is not offered to a visitor who is signed out (the page and API are protected on the server regardless)", async () => {
    session(null);
    shell();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: /Calendar/ })).toBeNull();
    expect(screen.getAllByRole("link", { name: /Search/ })).toHaveLength(2);
  });
});
