import { redirect } from "next/navigation";

// No longer linked anywhere — admins now sign in through the same shared
// email form as everyone else (see /connect and /api/connect/start). This
// page stays only as a safety net for anyone with the old URL bookmarked;
// /connect itself redirects an already-authenticated admin straight on to
// /admin/find-a-time.
export default function AdminLoginPage() {
  redirect("/connect");
}
