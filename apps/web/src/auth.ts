import NextAuth, { type Account, type Profile, type Session, type User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { authenticateCredentials, clientAddress, looksLikeEmail } from "./server/credentials/service";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./server/credentials/password";
import Google from "next-auth/providers/google";
import { AUTH_BASE_PATH, authConfigured, authReady, safeRedirect } from "./lib/auth-config";
import type { PatientIdentity } from "./server/calendar/repo";

export { createCredentialUser, findCredentialUser, looksLikeEmail, verifyCredentialUser } from "./server/credentials/service";

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
  /** Google accounts must have a verified email; credentials sign-ins are accepted after the user and password are validated. */
  signIn({ account, profile }: { account?: Account | null; profile?: Profile }): boolean {
    if (account?.provider === "credentials") return true;
    return account?.provider === "google" && profile?.email_verified === true && Boolean(profile.email);
  },
  /**
   * At sign-in, keeps the account's stable Google identifier (`providerAccountId`, Google's `sub`) in the token as `googleId`.
   * The token's own `sub` is NOT that: with no database adapter Auth.js makes it a new random id at every sign-in, so keying the
   * calendar by it would give a person a new, empty calendar each time they signed in. Later calls (no `account`) keep the token as is.
   */
  jwt({ token, account, user }: { token: JWT; account?: Account | null; user?: Partial<User> }): JWT {
    if (account?.provider === "google" && account.providerAccountId) {
      (token as { googleId?: string; authProvider?: string }).googleId = account.providerAccountId;
      (token as { authProvider?: string }).authProvider = "google";
    }
    if (user?.id) {
      (token as { userId?: string; authProvider?: string }).userId = String(user.id);
      (token as { authProvider?: string }).authProvider = account?.provider ?? "credentials";
    }
    return token;
  },
  /**
   * Adds that stable Google identifier to the server-side session, so the patient calendar can key a person by it. A session from
   * before it was kept (it has only the random `sub`) gets no id at all, so it can never create a calendar: signing in again fixes it.
   * It is the person's own identifier, returned only to that person.
   */
  session({ session, token }: { session: Session; token: JWT }): Session {
    const googleId = (token as { googleId?: string }).googleId;
    const userId = (token as { userId?: string }).userId;
    const authProvider = (token as { authProvider?: string }).authProvider ?? (googleId ? "google" : undefined);
    if (session.user) {
      (session.user as { id?: string; provider?: string }).id = googleId ?? userId;
      if (authProvider) (session.user as { provider?: string }).provider = authProvider;
    }
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

export const credentialsProvider = Credentials({
  name: "Email and password",
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
  },
  // The only door a sign-in goes through, including a request posted straight to /auth/callback/credentials: so the attempt limit lives here, not in the form's action.
  async authorize(credentials, request) {
    const email = String(credentials?.email ?? "").trim();
    const password = String(credentials?.password ?? "");
    if (!looksLikeEmail(email) || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return null;
    const user = await authenticateCredentials(email, password, clientAddress(request?.headers));
    return user ? { id: user.id, name: user.name, email: user.email } : null;
  },
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  basePath: AUTH_BASE_PATH,
  providers: [Google, credentialsProvider],
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: authCallbacks,
});

/** The signed-in patient as the server knows them for private data (see server/calendar): from the verified session only. */
export async function getPatientIdentity(): Promise<PatientIdentity | null> {
  if (!authReady() || !authConfigured()) return null;
  try {
    const user = (await auth())?.user as { id?: string; email?: string | null; name?: string | null; provider?: string } | undefined;
    if (!user?.id || user.provider !== "google") return null;
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
  if (!authReady()) return null;
  try {
    const session = await auth();
    return session?.user ? { user: { name: session.user.name ?? null, email: session.user.email ?? null, image: session.user.image ?? null } } : null;
  } catch {
    return null;
  }
}
