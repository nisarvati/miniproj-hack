// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../providers/auth";
import { LandingAuthLink } from "../landing/v1/LandingAuthLink";
import { AuthMenu } from "../shell/AuthMenu";
import { AccountPage } from "./AccountPage";
import { SignInPage } from "./SignInPage";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", async (original) => ({ ...(await original<typeof import("next/navigation")>()), usePathname: () => nav.pathname }));

// React runs form actions as one shared queue, so an action left hanging by one test would hold up the next test's. Release them.
const hanging: Array<() => void> = [];
const never = () => new Promise<void>((resolve) => hanging.push(resolve));

afterEach(async () => {
  nav.pathname = "/";
  cleanup();
  await act(async () => hanging.splice(0).forEach((release) => release()));
  vi.unstubAllGlobals();
});

describe("SignInPage", () => {
  const action = vi.fn(async () => undefined);

  it("is a complete page: banner, headline, a titled sign-in panel and a footer with the demo disclaimer", () => {
    render(<SignInPage action={action} error={null} callbackUrl="/" configured />);
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo").textContent).toMatch(/demonstration listings/i);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/Find the medicines you need/);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Welcome to MedLink");
    expect(screen.getByText("Patient access")).toBeTruthy();
    expect(screen.getByRole("link", { name: "MedLink home" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Pharmacy staff sign in" }).getAttribute("href")).toBe("/portal");
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main");
  });

  it("the hero is decorative (hidden from assistive technology) and the page says it is not live stock", () => {
    render(<SignInPage action={action} error={null} callbackUrl="/" configured />);
    expect(screen.getByTestId("medicine-storm").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText(/decorative medicines, not live stock or an inventory/i)).toBeTruthy();
  });

  it("offers Continue with Google, posts the checked destination, and explains what is asked of Google", () => {
    render(<SignInPage action={action} error={null} callbackUrl="/account" configured />);
    const button = screen.getByRole("button", { name: "Continue with Google" });
    expect(button.closest("form")).not.toBeNull();
    expect((document.querySelector('input[name="callbackUrl"]') as HTMLInputElement).value).toBe("/account");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText(/only for your name, email address and profile picture/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /keep searching without signing in/i }).getAttribute("href")).toBe("/search");
  });

  it("shows a loading state while Google is being opened, announces it, and cannot be submitted twice", async () => {
    const slow = vi.fn(() => never());
    render(<SignInPage action={slow} error={null} callbackUrl="/" configured />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(status.textContent).toBe("Connecting to Google…"));
    const busy = screen.getByRole("button", { name: "Continue with Google" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(busy);
    await userEvent.keyboard("{Enter}");
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("goes back to normal when the action finishes without leaving the page", async () => {
    let finish: () => void = () => undefined;
    const action2 = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<SignInPage action={action2} error={null} callbackUrl="/" configured />);
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Connecting to Google…"));
    await act(async () => {
      finish();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Continue with Google" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("comes back usable when the browser restores the page from its back/forward cache while it was still connecting", async () => {
    const slow = vi.fn(() => never());
    render(<SignInPage action={slow} error={null} callbackUrl="/" configured />);
    await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Connecting to Google…"));
    const restored = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(restored, "persisted", { value: true });
    await act(async () => void window.dispatchEvent(restored));
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Continue with Google" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("shows an understandable error (cancelled or failed sign-in) and keeps the button so the person can try again", () => {
    render(<SignInPage action={action} error="Google did not let this sign-in through." callbackUrl="/" configured />);
    expect(screen.getByRole("alert").textContent).toMatch(/Google did not let this sign-in through/);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
  });

  it("says plainly when Google sign-in is not set up, instead of offering a button that cannot work or showing it as a failure", () => {
    render(<SignInPage action={action} error="Google sign-in is not set up on this server yet." callbackUrl="/" configured={false} />);
    expect(screen.queryByRole("button", { name: /Google/ })).toBeNull();
    expect(screen.getByText(/not set up yet/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AccountPage", () => {
  it("shows who is signed in and a Sign out button that runs the sign-out action", async () => {
    const out = vi.fn(async () => undefined);
    render(<AccountPage user={{ name: "Asha Rao", email: "asha@example.com", image: "https://lh3.googleusercontent.com/a/x" }} signOutAction={out} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Asha Rao");
    expect(screen.getByText("asha@example.com")).toBeTruthy();
    expect(screen.getByText(/Signed in with Google/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(out).toHaveBeenCalledTimes(1);
  });

  it("shows that it is signing out while the action runs, and cannot be pressed twice", async () => {
    const slow = vi.fn(() => never());
    render(<AccountPage user={{ name: "Asha Rao", email: "asha@example.com", image: null }} signOutAction={slow} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const busy = await screen.findByRole("button", { name: "Signing out…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("falls back to an initial when there is no picture or name", () => {
    render(<AccountPage user={{ name: null, email: "zed@example.com", image: null }} signOutAction={async () => undefined} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("zed@example.com");
  });
});

const respond = (body: unknown, ok = true) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => body })));

describe("the header's sign-in entry, driven by the session route", () => {
  const menu = () =>
    render(
      <AuthProvider>
        <AuthMenu />
      </AuthProvider>,
    );

  it("signed out: a Sign in link to /signin", async () => {
    respond(null);
    menu();
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe("/signin");
  });

  it("signed in: the person's picture links to /account, named for assistive technology", async () => {
    respond({ user: { name: "Asha Rao", email: "asha@example.com", image: "https://lh3.googleusercontent.com/a/x" } });
    menu();
    const link = await screen.findByRole("link", { name: "Your account: Asha Rao" });
    expect(link.getAttribute("href")).toBe("/account");
    expect(link.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("not configured: nothing is shown, so there is no dead-end Sign in link", async () => {
    respond({ configured: false });
    const { container } = menu();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => undefined);
    expect(container.textContent).toBe("");
  });

  it("session route unreachable: treated as signed out, never as signed in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    menu();
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Your account/ })).toBeNull();
  });

  it("an error response is never trusted as a session", async () => {
    respond({ user: { name: "Mallory", email: "m@example.com", image: null } }, false);
    menu();
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText(/Mallory/)).toBeNull();
  });
});

describe("the session provider keeps the header honest", () => {
  it("asks again after a sign-out that navigates without reloading, so a stale signed-in header cannot stay", async () => {
    const answers: unknown[] = [{ user: { name: "Asha Rao", email: "asha@example.com", image: null } }, null];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => answers.shift() ?? null })));
    nav.pathname = "/account";
    const tree = () => (
      <AuthProvider>
        <AuthMenu />
      </AuthProvider>
    );
    const { rerender } = render(tree());
    expect(await screen.findByRole("link", { name: "Your account: Asha Rao" })).toBeTruthy();
    nav.pathname = "/signin";
    rerender(tree());
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Your account/ })).toBeNull();
  });

  it("asks again when the browser restores the page from its back/forward cache", async () => {
    const answers: unknown[] = [{ user: { name: "Asha Rao", email: "asha@example.com", image: null } }, null];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => answers.shift() ?? null })));
    render(
      <AuthProvider>
        <AuthMenu />
      </AuthProvider>,
    );
    expect(await screen.findByRole("link", { name: "Your account: Asha Rao" })).toBeTruthy();
    const restored = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(restored, "persisted", { value: true });
    await act(async () => void window.dispatchEvent(restored));
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
  });
});

describe("the homepage's account entry", () => {
  const landing = () =>
    render(
      <AuthProvider>
        <LandingAuthLink />
      </AuthProvider>,
    );

  it("signed out: Sign in; signed in: Account; not configured: nothing", async () => {
    respond(null);
    landing();
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe("/signin");
    cleanup();
    respond({ user: { name: "Asha Rao", email: "a@example.com", image: null } });
    landing();
    expect((await screen.findByRole("link", { name: "Your account: Asha Rao" })).getAttribute("href")).toBe("/account");
    cleanup();
    respond({ configured: false });
    const { container } = landing();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => undefined);
    expect(container.textContent).toBe("");
  });
});
