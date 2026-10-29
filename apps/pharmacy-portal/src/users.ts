import { createPool } from "@medlink/db";
import { decide, listUsers } from "./admin.js";

// npm run portal:users -- list [all]
// npm run portal:users -- approve <email>
// npm run portal:users -- reject <email>
const [command, arg] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const db = createPool(url);
try {
  if (command === "list") {
    const users = await listUsers(db, arg === "all" ? "all" : "pending");
    if (!users.length) console.log(arg === "all" ? "No accounts." : "No pending requests.");
    for (const u of users) console.log(`${u.status.padEnd(8)} ${u.pharmacyCode}  ${u.email}  (${u.requestedAt.toISOString()})`);
  } else if ((command === "approve" || command === "reject") && arg) {
    const u = await decide(db, arg, command);
    console.log(`${command === "approve" ? "Approved" : "Rejected"}: ${u.email} -> ${u.pharmacyCode}`);
  } else {
    console.error("Usage: portal:users -- list [all] | approve <email> | reject <email>");
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
