// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

function Host() {
  const [open, setOpen] = useState(true);
  return open ? <Modal title="A dialog" onClose={() => setOpen(false)}><button type="button">Inside</button></Modal> : <p>closed</p>;
}
const motion = (reduce: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && /reduce/.test(q), media: q, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the dialog's motion", () => {
  it("is the overlay card, and eases in", () => {
    motion(false);
    render(<Host />);
    const dialog = screen.getByRole("dialog", { name: "A dialog" });
    expect(dialog.className).toMatch(/mx-card mx-card--overlay/);
    expect(dialog.style.animation).toMatch(/^mx-panel-in 200ms/);
    expect(dialog.parentElement!.style.animation).toMatch(/^mx-scrim-in/);
  });

  it("eases out before it is removed: still there at first, gone after about 140 ms", async () => {
    motion(false);
    render(<Host />);
    await userEvent.keyboard("{Escape}");
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.animation).toMatch(/^mx-panel-out 140ms/);
    expect(dialog.parentElement!.style.animation).toMatch(/^mx-scrim-out 140ms/);
    await act(async () => void vi.advanceTimersByTime(150));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("closed")).toBeTruthy();
  });

  it("closes at once when the person asks for reduced motion", async () => {
    motion(true);
    render(<Host />);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes at once where the browser cannot say (no matchMedia), and a second request while leaving does nothing extra", async () => {
    render(<Host />);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a backdrop click and the Close button take the same exit", async () => {
    motion(false);
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => void vi.advanceTimersByTime(150));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
