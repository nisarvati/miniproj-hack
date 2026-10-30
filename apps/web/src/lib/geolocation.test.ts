// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectPosition, FAILURE_MESSAGE, isValidCoordinate } from "./geolocation";
import { DEFAULT_LOCATION, loadLocation, saveLocation } from "./location-store";

const CODES = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
/** Installs a fake navigator.geolocation whose single request answers with a position or an error code. */
function fakeGeolocation(answer: { position?: { latitude: number; longitude: number } } | { code: number }) {
  const getCurrentPosition = vi.fn((ok: PositionCallback, fail: PositionErrorCallback, _options?: PositionOptions) => {
    if ("code" in answer) fail({ ...CODES, code: answer.code, message: "" } as GeolocationPositionError);
    else ok({ coords: answer.position } as GeolocationPosition);
  });
  Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition }, configurable: true });
  return getCurrentPosition;
}
const secure = (value: boolean) => Object.defineProperty(window, "isSecureContext", { value, configurable: true });

beforeEach(() => secure(true));
afterEach(() => {
  Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
  window.localStorage.clear();
});

describe("detectPosition", () => {
  it("returns the position the browser reports, and asks once", async () => {
    const ask = fakeGeolocation({ position: { latitude: 19.12345, longitude: 72.84567 } });
    expect(await detectPosition()).toEqual({ ok: true, location: { latitude: 19.12345, longitude: 72.84567 } });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![2]).toMatchObject({ timeout: 10_000, enableHighAccuracy: false });
  });

  it("says why it failed: permission denied, location unavailable, timed out", async () => {
    fakeGeolocation({ code: 1 });
    expect(await detectPosition()).toEqual({ ok: false, reason: "denied" });
    fakeGeolocation({ code: 2 });
    expect(await detectPosition()).toEqual({ ok: false, reason: "unavailable" });
    fakeGeolocation({ code: 3 });
    expect(await detectPosition()).toEqual({ ok: false, reason: "timeout" });
  });

  it("reports an unsupported browser without asking anything", async () => {
    Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
    expect(await detectPosition()).toEqual({ ok: false, reason: "unsupported" });
  });

  it("reports an insecure page without asking, because the browser would refuse anyway", async () => {
    const ask = fakeGeolocation({ position: { latitude: 19, longitude: 72 } });
    secure(false);
    expect(await detectPosition()).toEqual({ ok: false, reason: "insecure" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not trust coordinates that are not real: NaN, out of range", async () => {
    for (const bad of [{ latitude: NaN, longitude: 72 }, { latitude: 19, longitude: Infinity }, { latitude: 91, longitude: 72 }, { latitude: 19, longitude: -181 }]) {
      fakeGeolocation({ position: bad });
      expect(await detectPosition()).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("has a message for every failure, and none of them blocks searching", () => {
    for (const text of Object.values(FAILURE_MESSAGE)) expect(text.length).toBeGreaterThan(20);
    expect(FAILURE_MESSAGE.denied).toMatch(/Search still works/);
  });
});

describe("isValidCoordinate", () => {
  it("accepts the edges and refuses anything else", () => {
    expect(isValidCoordinate({ latitude: 90, longitude: -180 })).toBe(true);
    expect(isValidCoordinate({ latitude: 0, longitude: 0 })).toBe(true);
    expect(isValidCoordinate({ latitude: 90.0001, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: NaN, longitude: 0 })).toBe(false);
    expect(isValidCoordinate(null)).toBe(false);
  });
});

describe("remembering a location", () => {
  it("keeps a detected position only to about 1 km, and an area or typed place as it was", () => {
    saveLocation({ label: "Your location", location: { latitude: 19.123456, longitude: 72.845678 }, detected: true });
    expect(loadLocation()).toEqual({ label: "Your location", location: { latitude: 19.12, longitude: 72.85 }, detected: true });
    expect(window.localStorage.getItem("medlink:location")).not.toMatch(/19\.123456|72\.845678/);
    saveLocation(DEFAULT_LOCATION);
    expect(loadLocation()).toEqual(DEFAULT_LOCATION);
  });
});
