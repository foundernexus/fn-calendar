"use client";

import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The sign-in link, always reachable.
 *
 * This used to live inside the "Waiting to connect" section, which meant it
 * disappeared whenever that section was empty — including the two moments it is
 * most wanted: when everyone happens to be connected and you are about to add
 * somebody new, and right after a migration when every member sits under
 * "Need to reconnect" instead. A button that hides exactly when it is needed is
 * worse than no button, because people remember it existing. */
export function CopyLinkButton({ url }: { url: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Sign-in link copied.");
    } catch {
      // Clipboard access can be refused outright (permissions, an insecure
      // context, some managed browsers). Showing the link is the fallback that
      // still gets the job done.
      toast.error(`Couldn't copy automatically — the link is ${url}`);
    }
  }

  return (
    <Button type="button" variant="secondary" onClick={copy}>
      <Link2 data-icon="inline-start" />
      Copy sign-in link
    </Button>
  );
}
