# Google sign-in (patients)

Patients can sign in with Google. It is optional: searching, pharmacy pages and restock alerts work without an account, exactly as before, and the pharmacy portal's staff sign-in is a separate system that is unchanged.

## What was built

* **Library: Auth.js (`next-auth` v5, pinned `5.0.0-beta.32`).** The repository had no patient authentication (Clerk, NextAuth or otherwise), so this adds the first one; there is no second system next to it. Auth.js does the server-side OAuth authorization-code flow with `state` and PKCE, validates the callback, and keeps the session in a signed, encrypted, `HttpOnly`, `SameSite=Lax` cookie (`Secure` on https) using a JWT, so **no database table and no Google token is stored**. The `5.x` line is still tagged beta by its maintainers; it is the Auth.js line that supports Next.js 16, which is why it is pinned exactly.
* **Scopes:** only the defaults, `openid email profile`. Nothing else is requested (no Drive, no Gmail).
* **Who may sign in:** only a Google account whose email Google reports as verified (`email_verified`). Anything else is refused ("AccessDenied").
* **No account linking:** there is no accounts table, so nothing is merged by matching email addresses. The signed-in identity is for display and for the one page that needs a session; it is **not** connected to restock subscriptions, which still identify a person by the email they type (see [restock-notifications.md](restock-notifications.md)).

| File | Purpose |
|---|---|
| `apps/web/src/auth.ts` | Auth.js setup (Google provider, JWT session, sign-in and redirect rules), `getSession()` |
| `apps/web/src/app/auth/[...nextauth]/route.ts` | Auth.js endpoints at `/auth/*` (guarded: 503 / `{configured:false}` until configured) |
| `apps/web/src/auth-actions.ts` | server actions `signInWithGoogle`, `signOutAction` (checks the redirect on the server) |
| `apps/web/src/lib/auth-config.ts` | `authConfigured`, `safeRedirect` (no open redirects), error wording |
| `apps/web/src/app/signin/page.tsx`, `components/auth/SignInPage.tsx` | the animated **Continue with Google** page: two-column on desktop, button-first on phones; draws its own page (no app header); loading, error and not-set-up states; `signin.module.css` holds the page's motion, and `components/auth/storm/` is the animated medicine hero (decorative; see its header comment) |
| `apps/web/src/app/account/page.tsx`, `components/auth/AccountPage.tsx` | the only protected page: checks the session on the server; shows the profile and **Sign out** |
| `apps/web/src/components/providers/auth.tsx`, `components/shell/AuthMenu.tsx` | header entry: "Sign in", or the person's picture linking to `/account` |
| `apps/web/src/components/ui/icons.tsx` | `GoogleIcon` |

Auth.js is mounted at **`/auth`**, not `/api/auth`, because in development `/api/*` is proxied to the search service (`next.config.ts`) and would shadow it.

The journey: signed out → `/signin` → Google → back to `/` (or the safe on-site page you came from) → **Sign out** → `/signin`. A signed-in visitor opening `/signin` is sent on to `/` (or the safe `callbackUrl`). The header and the homepage nav refresh their signed-in state on every page change and when the browser restores a page from its back/forward cache. All motion on `/signin` is switched off by `prefers-reduced-motion: reduce`.

The session also carries the account's stable Google identifier (`user.id`, set in the `session` callback in `apps/web/src/auth.ts`); the patient calendar (`medicine-calendar.md`) keys a person by it, on the server only. Still no accounts are merged by email.

Routes: `/signin` (public), `/account` (needs a session; unauthenticated visitors are sent to `/signin?callbackUrl=%2Faccount`). Everything else stays public.

## Configure it (once)

Google Cloud Console (https://console.cloud.google.com/):

1. Create or choose a project. **APIs & Services → OAuth consent screen**: user type External, app name MedLink, your support email. Scopes: add only `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. While the app is in **Testing**, add the Google accounts that may sign in as test users.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**
3. **Authorized JavaScript origins:** `http://localhost:3000`
4. **Authorized redirect URIs:** `http://localhost:3000/auth/callback/google`
   (This is the exact URL the running code reports: `GET /auth/providers` returns `callbackUrl`. For another host, use `https://<your-host>/auth/callback/google`.)
5. Copy the client ID and secret.

Private settings, in **`apps/web/.env.local`** (git-ignored; the Next.js app reads this file, **not** the root `.env`). Never commit them or paste them into chat:

```
AUTH_SECRET=<output of: openssl rand -base64 32>
AUTH_GOOGLE_ID=<client id>
AUTH_GOOGLE_SECRET=<client secret>
```

Restart the web app yourself (`npm run web:dev`) so it picks them up. In production also set `AUTH_URL=https://<your-host>` (and `AUTH_TRUST_HOST=true` only if the host header is trusted), and serve over https.

## Try it locally

1. With the settings in place and the web app restarted, open http://localhost:3000/search: the header shows **Sign in** (it is hidden while sign-in is not configured).
2. **Sign in → Continue with Google**, choose a test account, accept. You return to the page you came from (or `/`), and the header shows your picture.
3. Open `/account`: your name, email and **Sign out**. In a private window, `/account` sends you to `/signin`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Google shows `redirect_uri_mismatch` | the redirect URI in the Google client is not exactly `http://localhost:3000/auth/callback/google` (scheme, host, port, path) |
| Google shows "Access blocked: app not verified / not completed the verification" | the consent screen is in Testing and your account is not a listed test user |
| Back on `/signin` with "did not let this sign-in through" | you cancelled, or the Google account's email is unverified |
| Back on `/signin` with "did not finish" | the callback failed: check the web app's log; usually a wrong client secret or a clock far off |
| "Sign in" never appears | `AUTH_SECRET`, `AUTH_GOOGLE_ID` or `AUTH_GOOGLE_SECRET` is missing from `apps/web/.env.local`, or the web app was not restarted (`GET /auth/session` returns `{"configured":false}`) |
| `UntrustedHost` in the log (production) | set `AUTH_URL` (or `AUTH_TRUST_HOST=true` behind a trusted proxy) |
| Signed in on one port, not another | the session cookie belongs to the origin; use the same `localhost:3000` you registered |

## Tests and what they do not prove

Automated tests (no Google involved): the sign-in page, loading and error states, the header, the account page, sign-out, the guarded `/auth/*` routes (providers, callback URL, CSRF, no session without a cookie, a forged cookie refused), the sign-in rule (verified Google email only), `/account` redirecting without a session, and redirect checks (`//host`, `https://host`, `javascript:`, backslashes, dot-segment tricks). **A real Google sign-in has not been tested**: it needs your Google client and account. Until you have done step 2 above with real credentials, treat the flow as unverified.

## Limits

* The session is a JWT: signing out clears the cookie on this browser, but a copied cookie stays valid until it expires (7 days).
* `/account` and the medicine calendar (`/calendar` and `/calendar-api/*`, see `medicine-calendar.md`) are the places that use the session. Restock alerts, notifications and search do not, and the notification API still identifies a person by email only (documented limitation).
* No rate limiting or audit log of sign-ins.

Pharmacy staff and administrator roles, throttling and known gaps are described in [security.md](security.md).
