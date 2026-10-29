import type { NextRequest } from "next/server";
import { handlers } from "../../../auth";
import { authConfigured } from "../../../lib/auth-config";

/**
 * Auth.js's endpoints (sign-in, the Google callback, session, sign-out), mounted at /auth. The Google OAuth redirect URI is
 * therefore  <site>/auth/callback/google . Until the three private settings exist, the session route reports
 * { configured: false } (so the header can hide "Sign in") and everything else answers 503.
 */
const notConfigured = (req: NextRequest) =>
  req.method === "GET" && new URL(req.url).pathname.endsWith("/session")
    ? Response.json({ configured: false })
    : Response.json({ error: "Google sign-in is not configured on this server." }, { status: 503 });

export const GET = (req: NextRequest) => (authConfigured() ? handlers.GET(req) : notConfigured(req));
export const POST = (req: NextRequest) => (authConfigured() ? handlers.POST(req) : notConfigured(req));
