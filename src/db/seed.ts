import { db } from "./index";
import { members } from "./schema";
import { normalizeEmail } from "@/lib/email";

// Edit these before running `npm run db:seed`. Emails must be real inboxes
// you can log into for /connect and /admin testing.
const SEED_MEMBERS: {
  email: string;
  fullName: string;
  role: "member" | "admin";
}[] = [
  { email: "karin@foundernexus.com", fullName: "Karin (Admin)", role: "admin" },
  { email: "member1@example.com", fullName: "Test Member One", role: "member" },
  { email: "member2@example.com", fullName: "Test Member Two", role: "member" },
  { email: "member3@example.com", fullName: "Test Member Three", role: "member" },
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
