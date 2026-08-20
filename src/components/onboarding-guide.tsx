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

  const openKey = `fn-guide-open:${storageKey}`;
  const hasTour = steps.some((s) => s.target);

  useEffect(() => {
    // The walkthrough runs once, ever — localStorage, not sessionStorage, so it
    // doesn't reappear every time someone opens a new tab. Someone who has
    // already been shown around gets the checklist and nothing else.
    if (hasTour && !tourAlreadyDone(storageKey)) setTourRunning(true);

    let openedBefore = false;
    try {
      openedBefore = window.sessionStorage.getItem(openKey) === "1";
    } catch {
      // Storage blocked (private mode, or a browser setting) — fall through to
      // the default rather than breaking the page over a preference.
    }
    // Collapsed by default. It used to open itself on arrival, which made sense
    // when the checklist was the only thing explaining the page — but the
    // walkthrough does that now, and having both compete for attention on the
    // first screen is just noise. What remains is a small pill with the count,
    // which someone opens when they want it.
    //
    // sessionStorage remembers only that it was opened, so it stays open while
    // they work and returns to the pill on the next sign-in.
    setExpanded(openedBefore);
    setMounted(true);
  }, [openKey, hasTour, storageKey]);

  function setCollapsed(collapsed: boolean) {
    setExpanded(!collapsed);
    try {
      if (collapsed) window.sessionStorage.removeItem(openKey);
      else window.sessionStorage.setItem(openKey, "1");
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

      {/* Bottom-LEFT. Every page in this app keeps its own actions on the right
          — "Add person", the search, Save — so the left corner is the one place
          a floating panel cannot land on top of something that matters.
          pointer-events-none on the wrapper is the other half, and the more
          important one: this box keeps its full width even when collapsed to a
          small pill, so without it the corner holds an INVISIBLE rectangle that
          swallows clicks meant for whatever is underneath. That is exactly what
          happened — the middle of Add person stopped responding while its edges
          still worked. Only the visible parts take pointer events back. */}
      <div className="pointer-events-none fixed bottom-4 left-4 z-40 flex w-[min(15rem,calc(100vw-2rem))] flex-col items-start lg:left-6">
        {expanded ? (
          <div className="pointer-events-auto w-full rounded-lg border border-border bg-card shadow-card">
            {/* Heading and count on one line: two lines of chrome above a
                three-item list made the panel taller than the thing it was
                describing. */}
            <div className="flex items-center justify-between gap-2 border-b border-border py-2 pr-1 pl-3">
              <p className="truncate text-xs font-semibold text-foreground">
                {heading}
                <span className="ml-1.5 font-normal text-muted-foreground">
                  {allRequiredDone ? "· done" : `· ${done}/${total}`}
                </span>
              </p>
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
            <ul className="max-h-[min(50vh,20rem)] overflow-y-auto">
              {listSteps.map((step) => (
                <li key={step.id}>
                  {/* One line per step. The summary moved into the dialog behind
                      each row: repeating it here doubled the panel's height to
                      explain things nobody is reading at that moment. */}
                  <button
                    type="button"
                    onClick={() => setOpenStepId(step.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted"
                  >
                    <StepIcon step={step} />
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${
                        step.kind === "task" && step.done
                          ? "text-muted-foreground line-through decoration-muted-foreground/40"
                          : "text-foreground"
                      }`}
                    >
                      {step.title}
                    </span>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
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
                className="w-full border-t border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Show me around again
              </button>
            )}
          </div>
        ) : (
          /* The default. A small pill carrying the count, which is the only
             thing worth glancing at — the list itself is something you open
             when you want it, not something the page pushes at you. */
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-card transition-colors hover:bg-muted"
          >
            <ListChecks className="size-3.5" />
            {allRequiredDone ? "Setup" : `Setup · ${done}/${total}`}
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
