import { db } from "./index";
import { members } from "./schema";
import { normalizeEmail } from "@/lib/email";

// Edit these before running `npm run db:seed`. Emails must be real inboxes
// you can log into for /connect and /admin testing.
// `isFacilitator` gates who can be picked as "Session lead" in find-a-time —
// a curated set of people who actually run sessions, separate from who's
// merely connected a calendar (which is all any guest needs).
const SEED_MEMBERS: {
  email: string;
  fullName: string;
  role: "member" | "admin";
  isFacilitator: boolean;
}[] = [
  { email: "tobias@foundernexus.com", fullName: "Tobias", role: "admin", isFacilitator: true },
  { email: "tobiasj.hock137@gmail.com", fullName: "Tobias (personal)", role: "member", isFacilitator: false },
  { email: "karink@foundernexus.com", fullName: "Karin", role: "admin", isFacilitator: true },
  { email: "mattm@foundernexus.com", fullName: "Matt", role: "member", isFacilitator: true },
];

async function seed() {
  const rows = SEED_MEMBERS.map((m) => ({ ...m, email: normalizeEmail(m.email) }));
  await db.insert(members).values(rows).onConflictDoNothing({
    target: members.email,
  });
  console.log(`Seeded ${SEED_MEMBERS.length} members (existing rows left untouched).`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
