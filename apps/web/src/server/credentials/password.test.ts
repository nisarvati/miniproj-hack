import { describe, expect, it } from "vitest";
import { hashPassword, passwordAcceptable, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, SCRYPT, verifyAgainstDummy, verifyPassword } from "./password";

describe("hashPassword", () => {
  it("is a salted scrypt hash that carries its own parameters, and never contains the password", async () => {
    const h = await hashPassword("correct horse battery");
    const [scheme, N, r, p, salt, key] = h.split("$");
    expect(scheme).toBe("scrypt");
    expect([Number(N), Number(r), Number(p)]).toEqual([SCRYPT.N, SCRYPT.r, SCRYPT.p]);
    expect(Buffer.from(salt!, "base64url")).toHaveLength(SCRYPT.saltLength);
    expect(Buffer.from(key!, "base64url")).toHaveLength(SCRYPT.keyLength);
    expect(h).not.toContain("correct horse");
  });
  it("uses a fresh salt every time: the same password never gives the same hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password-1"), hashPassword("same-password-1")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password-1", a)).toBe(true);
    expect(await verifyPassword("same-password-1", b)).toBe(true);
  });
  it("is not a fast or unsalted hash: nothing like SHA-256 of the password (the old scheme)", async () => {
    const h = await hashPassword("super-secret");
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("medlink-credentials:super-secret")))).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(h).not.toContain(sha);
    expect(h.length).toBeLessThan(512);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and refuses a wrong one, including a near miss and a different case", async () => {
    const h = await hashPassword("Tr0ub4dor&3-long");
    expect(await verifyPassword("Tr0ub4dor&3-long", h)).toBe(true);
    for (const wrong of ["Tr0ub4dor&3-lonG", "tr0ub4dor&3-long", "Tr0ub4dor&3-long ", "", "x"]) expect(await verifyPassword(wrong, h), wrong).toBe(false);
  });
  it("treats anything that is not one of its own hashes as a failed check, never an error", async () => {
    const good = await hashPassword("a-good-password");
    const parts = good.split("$");
    const bad = [
      "", "plaintext", "scrypt", "scrypt$1$2$3", "bcrypt$x$y$z$a$b",
      [parts[0], "abc", parts[2], parts[3], parts[4], parts[5]].join("$"), // not a number
      [parts[0], "3", parts[2], parts[3], parts[4], parts[5]].join("$"), // not a power of two
      [parts[0], String(2 ** 20), parts[2], parts[3], parts[4], parts[5]].join("$"), // far more costly than anything this server writes
      [parts[0], parts[1], "64", parts[3], parts[4], parts[5]].join("$"),
      [parts[0], parts[1], parts[2], "99", parts[4], parts[5]].join("$"),
      [parts[0], parts[1], parts[2], parts[3], "", parts[5]].join("$"), // no salt
      [parts[0], parts[1], parts[2], parts[3], parts[4], ""].join("$"), // no hash
    ];
    for (const stored of bad) expect(await verifyPassword("a-good-password", stored), stored).toBe(false);
  });
  it("does no work for an over-long password, so it cannot be used to burn the server's time", async () => {
    const h = await hashPassword("a-good-password");
    const t = Date.now();
    expect(await verifyPassword("x".repeat(PASSWORD_MAX_LENGTH + 1), h)).toBe(false);
    expect(Date.now() - t).toBeLessThan(50);
  });
  it("is slow on purpose (a cost an attacker pays for every guess), yet fast enough for a sign-in", async () => {
    const t = Date.now();
    const h = await hashPassword("a-good-password");
    const took = Date.now() - t;
    expect(took).toBeGreaterThan(15);
    expect(took).toBeLessThan(3000);
    expect(h).toBeTruthy();
  });
});

describe("verifyAgainstDummy", () => {
  it("always says no, after doing a real check's work (so an unknown email is not faster than a wrong password)", async () => {
    const real = await hashPassword("a-good-password");
    const timeIt = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return performance.now() - t; };
    await verifyAgainstDummy("warm-up-1"); // builds the dummy once
    const dummy = await timeIt(() => verifyAgainstDummy("anything-at-all"));
    const wrong = await timeIt(() => verifyPassword("wrong-password-x", real));
    expect(await verifyAgainstDummy("a-good-password")).toBe(false);
    expect(dummy).toBeGreaterThan(wrong * 0.4);
    expect(dummy).toBeLessThan(wrong * 2.5 + 30);
  });
});

describe("passwordAcceptable", () => {
  it("keeps the existing minimum of 8 and adds a maximum", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(passwordAcceptable("1234567")).toBe(false);
    expect(passwordAcceptable("12345678")).toBe(true);
    expect(passwordAcceptable("x".repeat(PASSWORD_MAX_LENGTH))).toBe(true);
    expect(passwordAcceptable("x".repeat(PASSWORD_MAX_LENGTH + 1))).toBe(false);
  });
});
