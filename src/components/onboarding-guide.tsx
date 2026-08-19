"use client";

import { useEffect, useState } from "react";
import { Check, ChevronRight, Circle, Info, ListChecks, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { GuidedTour, tourAlreadyDone } from "@/components/guided-tour";
import { guideProgress, type OnboardingStep } from "@/lib/onboarding";

function StepIcon({ step }: { step: OnboardingStep }) {
  if (step.kind === "info") {
    return <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
  }
  if (step.done) {
    return (
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-accent">
        <Check className="size-3 text-accent-foreground" />
      </span>
    );
  }
  return <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}

/** The setup guide that follows someone in from the sign-in flow.
 *
 * Deliberately a panel of short steps that open into an explanation, not a
 * forced tour that seizes the page on first load. Half of what it has to
 * explain — that every calendar is read but only one is written to, that a grey
 * cell can be somebody else's conflict — isn't a thing you DO once and finish.
 * It's a rule you need again three weeks later, and a tour you clicked through
 * on day one is gone by then. So it collapses to a pill instead of disappearing,
 * and every step stays readable forever.
 *
 * Progress comes from real data (see buildMemberSteps), never from "has this
 * been clicked". A checklist that ticks itself when you read it trains people
 * to ignore it. */
export function OnboardingGuide({
  steps,
  storageKey,
  heading = "Getting set up",
}: {
  steps: OnboardingStep[];
  /** Namespaces the collapsed flag, so an owner who is also a member doesn't
   * dismiss the member guide by dismissing the admin one. */
  storageKey: string;
  heading?: string;
}) {
  // The checklist is the permanent list; steps marked tourOnly are prompts for
  // the moment ("press Save") and would read as unfinished work sitting in it
  // forever.
  const listSteps = steps.filter((s) => !s.tourOnly);
  const { total, done, allRequiredDone } = guideProgress(listSteps);
  // sessionStorage can't be read during render without a hydration mismatch, so
  // the panel renders nothing until it knows. It's an overlay, not content —
  // one frame late costs nothing.
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [openStepId, setOpenStepId] = useState<string | null>(null);
  const [tourRunning, setTourRunning] = useState(false);

  const collapsedKey = `fn-guide-collapsed:${storageKey}`;
  const hasTour = steps.some((s) => s.target);

  useEffect(() => {
    // The walkthrough runs once, ever — localStorage, not sessionStorage, so it
    // doesn't reappear every time someone opens a new tab. Someone who has
    // already been shown around gets the checklist and nothing else.
    if (hasTour && !tourAlreadyDone(storageKey)) setTourRunning(true);

    let collapsed = false;
    try {
      collapsed = window.sessionStorage.getItem(collapsedKey) === "1";
    } catch {
      // Storage blocked (private mode, or a browser setting) — fall through to
      // the default rather than breaking the page over a preference.
    }
    // Open by default on arrival, whether or not the setup is finished. Someone
    // signing in has just been handed a tool they may not have used in weeks,
    // and the steps double as the reference for how it works — a panel that
    // only appears while something is outstanding is missing exactly when
    // they've forgotten which calendar receives the invites.
    //
    // sessionStorage, not localStorage, is what makes that bearable: closing it
    // sticks for as long as they're working, and a fresh sign-in opens it
    // again. Persisting the dismissal forever would mean one stray click hides
    // it for good, on a panel most people meet exactly once.
    setExpanded(!collapsed);
    setMounted(true);
  }, [collapsedKey, hasTour, storageKey]);

  function setCollapsed(collapsed: boolean) {
    setExpanded(!collapsed);
    try {
      if (collapsed) window.sessionStorage.setItem(collapsedKey, "1");
      else window.sessionStorage.removeItem(collapsedKey);
    } catch {
      // Same as above: the panel still works for this visit, it just won't
      // remember the choice.
    }
  }

  if (!mounted || steps.length === 0) return null;

  const openStep = steps.find((s) => s.id === openStepId) ?? null;

  return (
    <>
      {tourRunning && (
        <GuidedTour steps={steps} storageKey={storageKey} onFinish={() => setTourRunning(false)} />
      )}

      {/* Top-right on a wide screen, where it sits beside the content instead
          of over it. Below lg there's no room for that, so it drops to the
          bottom corner and out of the reading path. */}
      <div className="fixed right-4 bottom-4 z-40 w-[min(20rem,calc(100vw-2rem))] lg:top-24 lg:right-6 lg:bottom-auto">
        {expanded ? (
          <div className="rounded-lg border border-border bg-card shadow-card">
            <div className="flex items-start justify-between gap-2 border-b border-border p-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{heading}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {allRequiredDone ? "Nothing left to do." : `${done} of ${total} done`}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setCollapsed(true)}
                aria-label="Hide the setup guide"
              >
                <X />
              </Button>
            </div>
            <ul className="max-h-[min(60vh,26rem)] divide-y divide-border overflow-y-auto">
              {listSteps.map((step) => (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => setOpenStepId(step.id)}
                    className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-secondary/50"
                  >
                    <StepIcon step={step} />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block text-sm font-medium ${
                          step.kind === "task" && step.done
                            ? "text-muted-foreground"
                            : "text-foreground"
                        }`}
                      >
                        {step.title}
                        {step.optional && !step.done && (
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            optional
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {step.summary}
                      </span>
                    </span>
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
            {/* The walkthrough is offered again rather than being a one-shot.
                Someone who skipped it in a hurry, or who comes back months
                later, shouldn't have to clear browser storage to see it. */}
            {hasTour && (
              <button
                type="button"
                onClick={() => setTourRunning(true)}
                className="w-full border-t border-border px-4 py-3 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground"
              >
                Show me around again
              </button>
            )}
          </div>
        ) : (
          /* Collapses to a pill rather than vanishing — these explanations are
             worth rereading long after setup is finished. */
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="ml-auto flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-xs font-medium text-foreground shadow-card transition-colors hover:bg-secondary"
          >
            <ListChecks className="size-4" />
            {allRequiredDone ? "Setup guide" : `Setup · ${done}/${total}`}
          </button>
        )}
      </div>

      <Dialog open={openStep !== null} onOpenChange={(open) => !open && setOpenStepId(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{openStep?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
            {openStep?.detail.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  );
}
