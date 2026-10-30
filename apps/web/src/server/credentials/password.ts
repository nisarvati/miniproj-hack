import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing for the email-and-password sign-in. scrypt (memory-hard, built into Node), a fresh random salt per password, and the parameters stored
 * with every hash ("scrypt$N$r$p$<salt>$<hash>", base64url) so the cost can be raised later without breaking old hashes. Verification is constant-time.
 * Server code only.
 */
export const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
/** scrypt needs 128 * N * r bytes (32 MiB here); Node's default ceiling is exactly that, so it is raised. */
const MAX_MEMORY = 128 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 8;
/** Hashing is deliberately slow, so an unbounded password would be a way to burn the server's time. */
export const PASSWORD_MAX_LENGTH = 128;

const scrypt = (password: string, salt: Buffer, keyLength: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key))));

export const passwordAcceptable = (password: string): boolean => password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLength);
  const key = await scrypt(password, salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAX_MEMORY });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** True only for the right password. A malformed or foreign stored value, or an over-long password, is simply false: never an error. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Refuse parameters that would make verification cost more than anything this server ever wrote.
  if (![N, r, p].every(Number.isInteger) || N < 2 || (N & (N - 1)) !== 0 || N > 2 ** 17 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 8 || expected.length < 16 || expected.length > 64) return false;
  try {
    const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAX_MEMORY });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** Spends the same time a real check would, for an email that has no account, so the answer's speed does not say whether the account exists. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummy);
  return false;
}
