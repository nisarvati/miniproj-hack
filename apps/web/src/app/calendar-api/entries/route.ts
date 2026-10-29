import { getPatientIdentity } from "../../../auth";
import { getCalendarDb } from "../../../server/db";
import { createCalendarApi } from "../../../server/calendar/api";

// Answers depend on the caller's cookie: never prerendered, never shared. (Not under /api: in development /api/* is proxied to the search service.)
export const dynamic = "force-dynamic";
const api = createCalendarApi({ identity: getPatientIdentity, db: getCalendarDb });

export const GET = (req: Request) => api.list(req);
export const POST = (req: Request) => api.create(req);
