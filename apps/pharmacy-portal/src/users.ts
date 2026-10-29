import { createPool } from "@medlink/db";
import { createAdmin, decide, listUsers } from "./admin.js";

// npm run portal:users -- list [all]
// npm run portal:users -- approve <email>
// npm run portal:users -- reject <email>
// PORTAL_ADMIN_PASSWORD='<at least 12 characters>' npm run portal:users -- create-admin <email>
//   (the password comes from the environment, not an argument, so it does not land in shell history or the process list)
const [command, arg] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const db = createPool(url);
try {
  if (command === "list") {
    const users = await listUsers(db, arg === "all" ? "all" : "pending");
    if (!users.length) console.log(arg === "all" ? "No accounts." : "No pending requests.");
    for (const u of users) console.log(`${u.status.padEnd(8)} ${u.role.padEnd(5)} ${(u.pharmacyCode ?? "-").padEnd(5)} ${u.email}  (${u.requestedAt.toISOString()})`);
  } else if (command === "create-admin" && arg) {
    const password = process.env.PORTAL_ADMIN_PASSWORD;
    if (!password) throw new Error("Set PORTAL_ADMIN_PASSWORD (at least 12 characters) in the environment.");
    const u = await createAdmin(db, arg, password);
    console.log(`Created administrator: ${u.email}`);
  } else if ((command === "approve" || command === "reject") && arg) {
    const u = await decide(db, arg, command);
    console.log(`${command === "approve" ? "Approved" : "Rejected"}: ${u.email} -> ${u.pharmacyCode}`);
  } else {
    console.error("Usage: portal:users -- list [all] | approve <email> | reject <email> | create-admin <email> (with PORTAL_ADMIN_PASSWORD set)");
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
