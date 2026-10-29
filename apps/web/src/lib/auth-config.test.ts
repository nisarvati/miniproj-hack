import { describe, expect, it } from "vitest";
import { authConfigured, safeRedirect, signInErrorMessage } from "./auth-config";

describe("authConfigured", () => {
  it("is true only when all three private settings are present", () => {
    expect(authConfigured({})).toBe(false);
    expect(authConfigured({ AUTH_SECRET: "x", AUTH_GOOGLE_ID: "y" })).toBe(false);
    expect(authConfigured({ AUTH_SECRET: "x", AUTH_GOOGLE_ID: "y", AUTH_GOOGLE_SECRET: " " })).toBe(false);
    expect(authConfigured({ AUTH_SECRET: "x", AUTH_GOOGLE_ID: "y", AUTH_GOOGLE_SECRET: "z" })).toBe(true);
  });
});

describe("safeRedirect (no open redirects)", () => {
  it("keeps paths on this site, with their query and fragment", () => {
    expect(safeRedirect("/account")).toBe("/account");
    expect(safeRedirect("/search?q=Crocin%20500mg&stock=1")).toBe("/search?q=Crocin%20500mg&stock=1");
    expect(safeRedirect("/pharmacies/4#stock")).toBe("/pharmacies/4#stock");
  });

  it("falls back for every way of leaving the site", () => {
    for (const bad of [
      "https://evil.example/",
      "http://evil.example",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/%2F%2Fevil.example/../..//evil.example", // decodes to nothing dangerous in a path, but must stay a path
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "evil.example",
      "",
      "   ",
      "/a".repeat(400),
    ]) {
      const out = safeRedirect(bad);
      expect(out.startsWith("/"), bad).toBe(true);
      expect(out.startsWith("//"), bad).toBe(false);
    }
    expect(safeRedirect("https://evil.example/")).toBe("/");
    expect(safeRedirect("//evil.example")).toBe("/");
    expect(safeRedirect("/\t/evil.example")).toBe("/");
    expect(safeRedirect("javascript:alert(1)")).toBe("/");
    expect(safeRedirect("/a/..//evil.example")).toBe("/"); // dot segments that would normalise to //host
  });

  it("falls back for values that are not strings, and honours a custom fallback", () => {
    for (const v of [undefined, null, 5, {}, ["/x"]]) expect(safeRedirect(v)).toBe("/");
    expect(safeRedirect("https://evil.example", "/search")).toBe("/search");
  });
});

describe("signInErrorMessage", () => {
  it("words known errors for people, and never echoes the code", () => {
    expect(signInErrorMessage("AccessDenied")).toMatch(/cancelled|not verified/);
    expect(signInErrorMessage("OAuthCallbackError")).toMatch(/did not finish/);
    expect(signInErrorMessage("NotConfigured")).toMatch(/not set up/);
    expect(signInErrorMessage("<script>alert(1)</script>")).not.toContain("<script>");
    expect(signInErrorMessage("totally-unknown")).toMatch(/Something went wrong/);
  });
  it("says nothing when there is no error", () => {
    expect(signInErrorMessage(undefined)).toBeNull();
    expect(signInErrorMessage("")).toBeNull();
  });
});
