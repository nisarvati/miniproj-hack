// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StockBadge } from "./StockBadge";

afterEach(cleanup);

describe("the stock badge", () => {
  it.each([["IN_STOCK", "In stock"], ["LOW_STOCK", "Low stock"], ["OUT_OF_STOCK", "Out of stock"]] as const)("%s says only %s", (status, label) => {
    const { container } = render(<StockBadge status={status} />);
    expect(container.textContent).toBe(label);
    render(<StockBadge status={status} compact />);
    expect(screen.getAllByText(label)).toHaveLength(2); // compact keeps the word too: it never falls back to a number
    expect(container.textContent).not.toMatch(/\d/);
  });

});
