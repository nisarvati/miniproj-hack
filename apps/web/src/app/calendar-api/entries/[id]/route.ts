import { getPatientIdentity } from "../../../../auth";
import { getCalendarDb } from "../../../../server/db";
import { createCalendarApi } from "../../../../server/calendar/api";

export const dynamic = "force-dynamic";
const api = createCalendarApi({ identity: getPatientIdentity, db: getCalendarDb });

type Ctx = { params: Promise<{ id: string }> };
export const GET = async (req: Request, { params }: Ctx) => api.get(req, (await params).id);
export const PATCH = async (req: Request, { params }: Ctx) => api.update(req, (await params).id);
export const DELETE = async (req: Request, { params }: Ctx) => api.remove(req, (await params).id);
