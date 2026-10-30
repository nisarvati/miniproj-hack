// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../lib/api";
import { offer, pharmacy, renderWithProviders } from "../../test/utils";
import { LocationNotice } from "./LocationNotice";
import { ResultCard } from "./ResultCard";
import { LocationMenu } from "../shell/LocationMenu";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
});
beforeEach(() => Object.defineProperty(window, "isSecureContext", { value: true, configurable: true }));

type Answer = { position: { latitude: number; longitude: number } } | { code: number } | "never";
function geolocation(answer: Answer) {
  const getCurrentPosition = vi.fn((ok: PositionCallback, fail: PositionErrorCallback) => {
    if (answer === "never") return;
    if ("code" in answer) fail({ PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, code: answer.code, message: "" } as GeolocationPositionError);
    else ok({ coords: answer.position } as GeolocationPosition);
  });
  Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition }, configurable: true });
  return getCurrentPosition;
}
const stored = () => JSON.parse(window.localStorage.getItem("medlink:location") ?? "null");

describe("LocationNotice", () => {
  it("says distances come from the default area until a location is chosen, and does not ask the browser by itself", async () => {
    const ask = geolocation({ position: { latitude: 19.1, longitude: 72.9 } });
    renderWithProviders(<LocationNotice />);
    await screen.findByText(/Your location isn't set, so distances are measured from Andheri West/);
    expect(screen.getByRole("button", { name: /Use my location/ })).toBeTruthy();
    expect(ask).not.toHaveBeenCalled(); // no prompt on render
  });

  it("shows Detecting location… while the browser is working, then Location detected, and keeps full precision for the search", async () => {
    const ask = geolocation({ position: { latitude: 19.123456, longitude: 72.845678 } });
    renderWithProviders(<LocationNotice />);
    await userEvent.click(await screen.findByRole("button", { name: /Use my location/ }));
    await screen.findByText(/Location detected/);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ label: "Your location", detected: true, location: { latitude: 19.12, longitude: 72.85 } });
  });

  it("shows Detecting location… and ignores a second click while waiting", async () => {
    const ask = geolocation("never");
    renderWithProviders(<LocationNotice />);
    const button = await screen.findByRole("button", { name: /Use my location/ });
    await userEvent.click(button);
    await screen.findByText("Detecting location…");
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button"));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ code: 1 }, /permission was denied.*Search still works/],
    [{ code: 2 }, /Unable to detect your location/],
    [{ code: 3 }, /took too long/],
  ])("explains a failed attempt (%o), keeps the current area, and offers to try again", async (answer, text) => {
    geolocation(answer);
    renderWithProviders(<LocationNotice />);
    await userEvent.click(await screen.findByRole("button", { name: /Use my location/ }));
    await screen.findByText(text);
    expect(stored()).toBeNull(); // nothing was chosen, so nothing is remembered
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    geolocation({ position: { latitude: 19.1, longitude: 72.9 } }); // refreshing: a retry works after a failure
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/Location detected/);
  });

  it("says so when the browser has no geolocation", async () => {
    Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
    renderWithProviders(<LocationNotice />);
    await userEvent.click(await screen.findByRole("button", { name: /Use my location/ }));
    await screen.findByText(/can't detect your location/);
  });

  it("says so on an insecure page", async () => {
    geolocation({ position: { latitude: 19.1, longitude: 72.9 } });
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    renderWithProviders(<LocationNotice />);
    await userEvent.click(await screen.findByRole("button", { name: /Use my location/ }));
    await screen.findByText(/secure \(https\)/);
  });

  it("stays out of the way once a location is chosen", async () => {
    window.localStorage.setItem("medlink:location", JSON.stringify({ label: "Juhu, Mumbai", location: { latitude: 19.1075, longitude: 72.8263 } }));
    renderWithProviders(<LocationNotice />);
    await act(async () => undefined);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/isn't set/)).toBeNull();
  });
});

describe("the header location menu", () => {
  it("uses the same detection and the same wording", async () => {
    geolocation({ code: 3 });
    renderWithProviders(<LocationMenu />);
    await userEvent.click(screen.getByRole("button", { name: /Location:/ }));
    await userEvent.click(screen.getByRole("button", { name: /Use my current location/ }));
    await screen.findByText(/took too long/);
    geolocation({ position: { latitude: 19.2, longitude: 72.9 } });
    await userEvent.click(screen.getByRole("button", { name: /Use my current location/ }));
    await waitFor(() => expect(stored()).toMatchObject({ label: "Your location", detected: true }));
  });
});

describe("ResultCard distance wording", () => {
  const card = (over: Record<string, unknown>, pharmacyOver: Record<string, unknown> = {}) =>
    renderWithProviders(<ResultCard result={{ ...offer({ pharmacy: pharmacy(pharmacyOver), ...over }) } as unknown as SearchResult} origin={null} best={false} />);

  it("says the pharmacy's location has not been verified, and shows no distance at all, never 0 km", async () => {
    card({ distanceKm: null, distanceVerified: false }, { locationVerified: false });
    await screen.findByText("Distance not shown");
    expect(screen.getByText("Pharmacy location not verified")).toBeTruthy();
    expect(screen.queryByText(/\bkm\b/)).toBeNull();
  });

  it("says the user's location is needed when the pharmacy is verified but there is no distance", async () => {
    card({ distanceKm: null, distanceVerified: false }, { locationVerified: true });
    await screen.findByText("Distance not shown");
    expect(screen.getByText("Set your location to see the distance")).toBeTruthy();
  });

  it("shows a calculated distance, and where it is measured from while no location has been chosen", async () => {
    card({ distanceKm: 2.4, distanceVerified: true }, { locationVerified: true });
    await screen.findByText("2.4 km away");
    expect(screen.getByText("from Andheri West")).toBeTruthy();
    expect(screen.queryByText("Distance not shown")).toBeNull();
  });

  it("drops 'from …' once the person has chosen a location", async () => {
    window.localStorage.setItem("medlink:location", JSON.stringify({ label: "Your location", location: { latitude: 19.1, longitude: 72.9 } }));
    card({ distanceKm: 2.4, distanceVerified: true }, { locationVerified: true });
    await screen.findByText("2.4 km away");
    await waitFor(() => expect(screen.queryByText(/^from /)).toBeNull());
  });
});
