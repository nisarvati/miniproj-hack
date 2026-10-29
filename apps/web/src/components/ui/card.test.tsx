// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card, EmptyState } from "./primitives";

afterEach(cleanup);
const cls = (el: HTMLElement) => el.className.split(/\s+/);

describe("the shared card", () => {
  it("is the glass card by default: one base class and nothing else", () => {
    render(<Card data-testid="c">x</Card>);
    expect(cls(screen.getByTestId("c"))).toEqual(["mx-card"]);
  });

  it("variants are one extra class each, and a card can be interactive and selected", () => {
    render(
      <>
        <Card data-testid="solid" variant="solid" />
        <Card data-testid="quiet" variant="quiet" />
        <Card data-testid="overlay" variant="overlay" />
        <Card data-testid="both" interactive selected className="p-4" />
      </>,
    );
    expect(cls(screen.getByTestId("solid"))).toEqual(["mx-card", "mx-card--solid"]);
    expect(cls(screen.getByTestId("quiet"))).toEqual(["mx-card", "mx-card--quiet"]);
    expect(cls(screen.getByTestId("overlay"))).toEqual(["mx-card", "mx-card--overlay"]);
    expect(cls(screen.getByTestId("both"))).toEqual(["mx-card", "mx-card--interactive", "mx-card--selected", "p-4"]);
  });

  it("passes everything else through, so a card stays an ordinary element", () => {
    render(<Card role="region" aria-label="Details" id="x">content</Card>);
    expect(screen.getByRole("region", { name: "Details" }).id).toBe("x");
  });

  it("the empty state is a quiet card", () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByRole("heading", { name: "Nothing here" }).parentElement!.className).toMatch(/mx-card mx-card--quiet/);
  });
});
