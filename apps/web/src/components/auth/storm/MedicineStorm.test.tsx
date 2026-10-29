// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDICINES, PASSERS, TONES } from "./medicines";
import { MedicineStorm } from "./MedicineStorm";

const mediaQuery = (reduce: boolean, fine: boolean) =>
  vi.fn((query: string) => ({
    matches: query.includes("reduced-motion") ? reduce : fine,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));

let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const move = (x: number, y: number) => {
  const e = new Event("pointermove") as PointerEvent;
  Object.assign(e, { clientX: x, clientY: y, pointerType: "mouse" });
  window.dispatchEvent(e);
};
const runFrames = () => act(() => void frames.splice(0).forEach((cb) => cb(0)));

describe("the medicine hero", () => {
  it("is a data-driven scene: a hero capsule, a swarm of capsules and tablets, crossing medicines, trails, currents and specks", () => {
    vi.stubGlobal("matchMedia", mediaQuery(false, true));
    const { container } = render(<MedicineStorm />);
    const stage = screen.getByTestId("medicine-storm");
    expect(stage.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll("[data-medicine]")).toHaveLength(MEDICINES.length);
    expect(container.querySelectorAll("[data-passing]")).toHaveLength(PASSERS.length);
    expect(MEDICINES.length).toBeGreaterThanOrEqual(10);
    expect(MEDICINES.filter((m) => m.shape === "capsule").length).toBeGreaterThan(3);
    expect(MEDICINES.some((m) => m.shape === "round") && MEDICINES.some((m) => m.shape === "oblong")).toBe(true);
    expect(MEDICINES.filter((m) => m.hero)).toHaveLength(1);
    // three depths of objects, and every object has its own timing (no two drift in step)
    expect(new Set(MEDICINES.map((m) => m.z)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(MEDICINES.map((m) => `${m.dxd}/${m.dyd}`)).size).toBe(MEDICINES.length);
    expect(container.querySelectorAll("svg path[d*='C']").length).toBeGreaterThan(6);
    // no pharmacies, maps, pins or people: the picture is medicine only
    expect(stage.textContent).toBe("");
    expect(stage.innerHTML).not.toMatch(/\b(pharmacy|pin|map|route)\b/i);
  });

  it("the hero capsule is forest green over warm ivory", () => {
    expect(TONES[MEDICINES.find((m) => m.hero)!.tone]).toEqual(["#2b6a50", "#f5f0df"]);
  });

  it("follows a mouse by setting two CSS variables, never by re-rendering, and bounds the movement", async () => {
    vi.stubGlobal("matchMedia", mediaQuery(false, true));
    render(<MedicineStorm />);
    const stage = screen.getByTestId("medicine-storm");
    move(100000, -100000); // far outside the window
    for (let i = 0; i < 80; i++) await runFrames();
    expect(Number(stage.style.getPropertyValue("--px"))).toBeGreaterThan(0.9);
    expect(Number(stage.style.getPropertyValue("--px"))).toBeLessThanOrEqual(1);
    expect(Number(stage.style.getPropertyValue("--py"))).toBeLessThan(-0.9);
    expect(Number(stage.style.getPropertyValue("--py"))).toBeGreaterThanOrEqual(-1);
  });

  it("does not run an animation loop once the value has settled", async () => {
    vi.stubGlobal("matchMedia", mediaQuery(false, true));
    render(<MedicineStorm />);
    move(0, 0);
    for (let i = 0; i < 200; i++) await runFrames();
    expect(frames).toHaveLength(0);
  });

  it("ignores touch, and leaves the scene to its ambient animation when there is no mouse-like pointer", async () => {
    vi.stubGlobal("matchMedia", mediaQuery(false, false));
    render(<MedicineStorm />);
    move(10, 10);
    await runFrames();
    expect(frames).toHaveLength(0);
    expect(screen.getByTestId("medicine-storm").style.getPropertyValue("--px")).toBe("");
  });

  it("with reduced motion requested, never attaches the pointer follow", async () => {
    vi.stubGlobal("matchMedia", mediaQuery(true, true));
    const add = vi.spyOn(window, "addEventListener");
    render(<MedicineStorm />);
    expect(add.mock.calls.some(([type]) => type === "pointermove")).toBe(false);
    move(900, 900);
    await runFrames();
    expect(screen.getByTestId("medicine-storm").style.getPropertyValue("--px")).toBe("");
  });

  it("removes its listeners and stops its loop when it unmounts", async () => {
    vi.stubGlobal("matchMedia", mediaQuery(false, true));
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<MedicineStorm />);
    move(900, 900);
    unmount();
    expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(["pointermove", "resize", "scroll", "blur"]));
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });
});

describe("the stylesheet", () => {
  it("switches every animation off for reduced motion and keeps the stage under the sign-in panel", async () => {
    const { readFileSync } = await import("node:fs");
    const dir = "apps/web/src/components/auth";
    const css = readFileSync(`${dir}/storm/storm.module.css`, "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.stage \*[\s\S]*animation: none !important/);
    expect(css).toMatch(/pointer-events: none/);
    expect(css).toMatch(/overflow: clip/);
    const page = readFileSync(`${dir}/signin.module.css`, "utf8");
    expect(page).toMatch(/\.panelWrap \{ position: relative; z-index: 2; \}/);
    expect(page).toMatch(/\.art \{[^}]*position: relative;[^}]*z-index: 0;/);
    // one screen high where it fits (with a vh fallback), scrolling naturally where it does not; the picture sizes itself from the space left
    expect(page).toMatch(/min-height: 100vh;\s*min-height: 100dvh;/);
    expect(page).toMatch(/@media \(min-width: 64rem\) and \(min-height: 41rem\)[\s\S]*height: 100dvh;[\s\S]*container-type: size;/);
    expect(css).toMatch(/@media \(min-width: 64rem\) and \(min-height: 41rem\)[\s\S]*width: min\(100cqw, calc\(100cqh \* 100 \/ 62\)\)/);
  });
});
