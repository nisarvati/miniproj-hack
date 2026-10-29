// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, offer, renderWithProviders } from "../../../../test/utils";
import { HeroMap } from "./HeroMap";
import { markerLabel, NETWORK, SAMPLE_PHARMACIES } from "./data";
import { INVITATION, STEP, TIMELINE, captionFor } from "./story";
import { V1Landing } from "../V1Landing";

const font = vi.hoisted(() => ({ variable: "font-var", className: "font-class" }));
vi.mock("../fonts", () => ({ display: font, mono: font }));
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));

const reduced = (on: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: on && query.includes("reduce"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

beforeEach(() => {
  reduced(false);
  localStorage.clear();
  mockApi({
    "GET /api/notifications": () => ({ body: { data: [] } }),
    "GET /api/search": () => ({ body: { data: [offer()], meta: { live: true } } }),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const frame = () => document.querySelector("[data-hero-map]") as HTMLElement;
const step = () => Number(frame().getAttribute("data-step"));
const card = () => document.querySelector("[data-card]") as HTMLElement;
const chip = (id: string) => document.querySelector(`[data-chip="${id}"]`) as HTMLButtonElement | null;
const caption = () => document.querySelector("[data-caption]")!.textContent;
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const explore = () => screen.getByRole("button", { name: /Explore/ });

describe("the reveal timeline", () => {
  it("is ordered, starts at the click, and ends on the explorable scene", () => {
    const times = TIMELINE.map(([, ms]) => ms);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(TIMELINE[0]).toEqual([STEP.rotate, 0]);
    expect(TIMELINE.at(-1)![0]).toBe(STEP.reveal);
    expect(captionFor(STEP.rest, null)).toBe("A capsule");
    expect(captionFor(STEP.network, null)).toBe("Network update");
    expect(captionFor(STEP.reveal, "b")).toBe("Pharmacy details");
  });

  it("the sample is four independent example shops joined by dotted connections, one not listing the medicine", () => {
    expect(SAMPLE_PHARMACIES).toHaveLength(4);
    expect(SAMPLE_PHARMACIES.every((p) => /^Example Pharmacy [A-D]$/.test(p.name))).toBe(true);
    expect(SAMPLE_PHARMACIES.filter((p) => p.status === "NOT_LISTED")).toHaveLength(1);
    expect(NETWORK.length).toBeGreaterThanOrEqual(3);
  });
});

describe("before the click", () => {
  it("shows the capsule with the invitation and an Explore button, and nothing of the neighbourhood is usable yet", () => {
    render(<HeroMap />);
    expect(step()).toBe(STEP.rest);
    expect(screen.getByText(INVITATION)).toBeTruthy();
    expect(explore().textContent).toMatch(/Explore/);
    expect(screen.queryAllByRole("button").filter((b) => b.hasAttribute("data-chip"))).toHaveLength(0);
    expect(caption()).toMatch(/A capsule/);
    expect(frame().querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Explore", () => {
  it("plays the reveal in order: turn, split, map, four shops one after another, markers, network, travelling capsule, annotation", () => {
    vi.useFakeTimers();
    render(<HeroMap />);
    fireEvent.click(explore());
    advance(10);
    expect(step()).toBe(STEP.rotate);
    for (const [st, ms] of TIMELINE.slice(1)) {
      advance(ms - (TIMELINE[TIMELINE.findIndex(([s2]) => s2 === st) - 1]![1]) + 5);
      expect(step()).toBe(st);
    }
    expect(step()).toBe(STEP.reveal);
    expect(chip("a")).not.toBeNull();
    expect(card().getAttribute("data-visible")).toBe("true");
    expect(card().textContent).toMatch(/Crocin 500mg/);
    expect(card().textContent).toMatch(/Example Pharmacy A/);
    expect(card().textContent).toMatch(/In stock/);
    expect(card().textContent).toMatch(/Illustration · sample availability, not live stock/);
    expect(caption()).toMatch(/The Medicineverse/);
    expect(document.querySelectorAll("[data-shop]")).toHaveLength(4);
    expect(document.querySelectorAll("[data-marker]")).toHaveLength(4);
  });

  it("with reduced motion shows the finished scene at once, with no timers", () => {
    reduced(true);
    vi.useFakeTimers();
    render(<HeroMap />);
    expect(frame().getAttribute("data-motion")).toBe("off");
    fireEvent.click(explore());
    expect(step()).toBe(STEP.reveal);
    expect(vi.getTimerCount()).toBe(0);
    expect(card().getAttribute("data-visible")).toBe("true");
  });

  it("does not block the page: the search box stays usable and untouched while it plays", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithProviders(<V1Landing />);
    fireEvent.click(explore());
    advance(1000);
    const box = screen.getAllByRole("combobox")[0]! as HTMLInputElement;
    await userEvent.type(box, "Crocin 500mg{Enter}");
    expect(nav.push).toHaveBeenLastCalledWith("/search?q=Crocin+500mg");
    expect(screen.getAllByRole("button", { name: "Find a Medicine" })).toHaveLength(2);
    expect(box.value).toBe("Crocin 500mg"); // the illustration never changed it
  });
});

describe("after the reveal", () => {
  const revealed = () => {
    reduced(true);
    render(<HeroMap />);
    fireEvent.click(explore());
  };

  it("offers four keyboard-reachable markers whose names state the status in words and say it is a sample", () => {
    revealed();
    expect(screen.getAllByRole("button").filter((b) => b.hasAttribute("data-chip"))).toHaveLength(4);
    for (const p of SAMPLE_PHARMACIES) expect(chip(p.id)!.getAttribute("aria-label")).toBe(markerLabel(p, "Crocin 500mg"));
    expect(chip("b")!.getAttribute("aria-label")).toMatch(/Not listed here/);
    expect(chip("d")!.getAttribute("aria-label")).toMatch(/Sold out/);
  });

  it("clicking selects, shows its annotation, highlights its connections and subdues the others; another click switches; a second click clears", async () => {
    revealed();
    await userEvent.click(chip("c")!);
    expect(chip("c")!.getAttribute("aria-pressed")).toBe("true");
    expect(card().textContent).toMatch(/Example Pharmacy C/);
    expect(card().textContent).toMatch(/Low stock/);
    expect(chip("a")!.getAttribute("class")).toMatch(/chipDim/);
    expect(document.querySelectorAll("g[class*=netLit]").length).toBe(NETWORK.filter((e) => e.ends.includes("c")).length);
    expect(frame().getAttribute("data-selected")).toBe("c");

    await userEvent.click(chip("d")!);
    expect(chip("c")!.getAttribute("aria-pressed")).toBe("false");
    expect(card().textContent).toMatch(/Sold out/);
    expect(caption()).toMatch(/Pharmacy details/);

    await userEvent.click(chip("d")!);
    expect(chip("d")!.getAttribute("aria-pressed")).toBe("false");
    expect(frame().getAttribute("data-selected")).toBe("");
  });

  it("works from the keyboard: Enter selects, Escape clears, and the card's close button clears", async () => {
    revealed();
    chip("b")!.focus();
    await userEvent.keyboard("{Enter}");
    expect(chip("b")!.getAttribute("aria-pressed")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(chip("b")!.getAttribute("aria-pressed")).toBe("false");
    await userEvent.keyboard(" ");
    expect(chip("b")!.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Clear the selected pharmacy" }));
    expect(chip("b")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("hover and focus reveal an annotation; a touch pointer does not rely on hover; a drawn shop is clickable", () => {
    revealed();
    fireEvent.pointerEnter(chip("d")!, { pointerType: "mouse" });
    expect(card().textContent).toMatch(/Example Pharmacy D/);
    fireEvent.pointerLeave(chip("d")!, { pointerType: "mouse" });
    fireEvent.pointerEnter(chip("c")!, { pointerType: "touch" });
    expect(card().textContent).not.toMatch(/Example Pharmacy C/);
    fireEvent.click(document.querySelector('[data-shop="b"] path')!);
    expect(chip("b")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("Replay returns to the capsule and plays again", () => {
    vi.useFakeTimers();
    render(<HeroMap />);
    fireEvent.click(explore());
    advance(9000);
    expect(step()).toBe(STEP.reveal);
    fireEvent.click(screen.getByRole("button", { name: "Replay the animation" }));
    expect(step()).toBe(STEP.rest);
    expect(chip("a")).toBeNull();
    advance(400);
    advance(900);
    expect(step()).toBeGreaterThanOrEqual(STEP.rotate);
    advance(9000);
    expect(step()).toBe(STEP.reveal);
  });

  it("selecting a marker while the reveal is still playing skips to the finished scene", () => {
    vi.useFakeTimers();
    render(<HeroMap />);
    fireEvent.click(explore());
    advance(4600);
    expect(step()).toBe(STEP.markers);
    fireEvent.click(chip("c")!);
    expect(step()).toBe(STEP.reveal);
    expect(chip("c")!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("artwork and claims", () => {
  it("never lets a CSS transition or animation sit on a group whose position is a transform attribute", () => {
    reduced(true);
    render(<HeroMap />);
    fireEvent.click(explore());
    const risky = Array.from(document.querySelectorAll("[data-hero-map] g[transform]")).filter((g) => /(float|half|spin|emerge|drop|token)/.test(g.getAttribute("class") ?? ""));
    expect(risky).toEqual([]);
  });

  it("claims nothing real: sample shops only, no price, distance or live wording", () => {
    reduced(true);
    render(<HeroMap />);
    fireEvent.click(explore());
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/₹|\bkm\b|real-time|updated \d|partner/i);
  });
});
