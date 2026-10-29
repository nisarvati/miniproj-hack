// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

import { LandingSearch } from "./LandingSearch";

beforeEach(() => nav.push.mockClear());
afterEach(cleanup);

describe("LandingSearch", () => {
  it("is a labelled search form that falls back to a plain GET to /search without JavaScript", () => {
    render(<LandingSearch />);
    const form = screen.getByRole("search");
    expect(form.getAttribute("action")).toBe("/search");
    expect(form.getAttribute("method")).toBe("get");
    expect(screen.getByLabelText("Medicine name").getAttribute("name")).toBe("q");
  });

  it("sends the query to the existing search page", async () => {
    render(<LandingSearch />);
    await userEvent.type(screen.getByRole("combobox"), "Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Find a Medicine" }));
    expect(nav.push).toHaveBeenCalledWith("/search?q=Crocin+500mg");
  });

  it("submits with Enter", async () => {
    render(<LandingSearch />);
    await userEvent.type(screen.getByRole("combobox"), "Augmentin{Enter}");
    expect(nav.push).toHaveBeenCalledWith("/search?q=Augmentin");
  });

  it("does not search an empty box, says why, and clears the message when typing", async () => {
    render(<LandingSearch />);
    await userEvent.click(screen.getByRole("button", { name: "Find a Medicine" }));
    expect(nav.push).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Enter a medicine name/);
    expect(screen.getByRole("combobox").getAttribute("aria-invalid")).toBe("true");
    await userEvent.type(screen.getByRole("combobox"), "x");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers keyboard-navigable suggestions", async () => {
    render(<LandingSearch />);
    await userEvent.type(screen.getByRole("combobox"), "para");
    expect(screen.getByRole("listbox").hasAttribute("hidden")).toBe(false);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(nav.push).toHaveBeenCalledWith("/search?q=Paracetamol");
  });

  it("lists try-links that are real links into the search page", () => {
    render(<LandingSearch />);
    expect(screen.getByRole("link", { name: "Paracetamol" }).getAttribute("href")).toBe("/search?q=Paracetamol");
  });
});
