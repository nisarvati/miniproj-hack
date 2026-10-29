import NextAuth, { type Account, type Profile, type Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Google from "next-auth/providers/google";
import { AUTH_BASE_PATH, authConfigured, safeRedirect } from "./lib/auth-config";
import type { PatientIdentity } from "./server/calendar/repo";

/**
 * Google sign-in for patients, with Auth.js (next-auth v5): the server-side authorization-code flow with state and PKCE, a signed
 * and encrypted session cookie (JWT, no database), HttpOnly and SameSite=Lax, Secure on https. It is separate from the pharmacy
 * portal's staff sign-in, which is unchanged.
 *
 * Private settings (names only; set them in the git-ignored .env): AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET. Auth.js reads
 * them itself. Only the default scopes (openid, email, profile) are requested, and no Google token is kept in the session.
 * The session itself is a cookie, not a database row. Accounts are never merged by matching email addresses: the patient calendar
 * (server/calendar) keys a person by the Google account identifier alone.
 */
export const authCallbacks = {
  /** Only a Google account whose email Google has verified may sign in. */
  signIn({ account, profile }: { account?: Account | null; profile?: Profile }): boolean {
    return account?.provider === "google" && profile?.email_verified === true && Boolean(profile.email);
  },
  /**
   * At sign-in, keeps the account's stable Google identifier (`providerAccountId`, Google's `sub`) in the token as `googleId`.
   * The token's own `sub` is NOT that: with no database adapter Auth.js makes it a new random id at every sign-in, so keying the
   * calendar by it would give a person a new, empty calendar each time they signed in. Later calls (no `account`) keep the token as is.
   */
  jwt({ token, account }: { token: JWT; account?: Account | null }): JWT {
    if (account?.provider === "google" && account.providerAccountId) (token as { googleId?: string }).googleId = account.providerAccountId;
    return token;
  },
  /**
   * Adds that stable Google identifier to the server-side session, so the patient calendar can key a person by it. A session from
   * before it was kept (it has only the random `sub`) gets no id at all, so it can never create a calendar: signing in again fixes it.
   * It is the person's own identifier, returned only to that person.
   */
  session({ session, token }: { session: Session; token: JWT }): Session {
    const googleId = (token as { googleId?: string }).googleId;
    if (session.user && googleId) (session.user as { id?: string }).id = googleId;
    return session;
  },
  /** Auth.js's own redirects (after sign-in and sign-out) may only land on this site. */
  redirect({ url, baseUrl }: { url: string; baseUrl: string }): string {
    if (url.startsWith("/")) return `${baseUrl}${safeRedirect(url)}`;
    try {
      if (new URL(url).origin === new URL(baseUrl).origin) return url;
    } catch {
      /* fall through */
    }
    return baseUrl;
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  basePath: AUTH_BASE_PATH,
  providers: [Google],
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: authCallbacks,
});

/** The signed-in patient as the server knows them for private data (see server/calendar): from the verified session only. */
export async function getPatientIdentity(): Promise<PatientIdentity | null> {
  if (!authConfigured()) return null;
  try {
    const user = (await auth())?.user as { id?: string; email?: string | null; name?: string | null } | undefined;
    if (!user?.id) return null;
    return { provider: "google", subject: user.id, email: user.email ?? null, name: user.name ?? null };
  } catch {
    return null;
  }
}

export interface SessionUser {
  name: string | null;
  email: string | null;
  image: string | null;
}

/** The signed-in visitor, or null: no cookie, an invalid or expired one, or sign-in not configured. Never throws. */
export async function getSession(): Promise<{ user: SessionUser } | null> {
  if (!authConfigured()) return null;
  try {
    const session = await auth();
    return session?.user ? { user: { name: session.user.name ?? null, email: session.user.email ?? null, image: session.user.image ?? null } } : null;
  } catch {
    return null;
  }
}
