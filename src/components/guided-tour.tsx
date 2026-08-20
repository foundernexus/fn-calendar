"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { OnboardingStep } from "@/lib/onboarding";

/** A walkthrough that points at the thing it's talking about.
 *
 * Deliberately NOT a modal. The dimmed area has pointer-events: none, so the
 * page underneath stays fully usable at every step — someone who'd rather just
 * get on with it can ignore this entirely, click straight through it, or press
 * Escape. A tour that traps you is a tour people resent, and the second time
 * they see it they'll dismiss it before reading a word.
 *
 * It runs once, on arrival. It is not the permanent explanation — the checklist
 * panel is, because the thing someone needs three weeks later ("which calendar
 * actually receives the invite?") is exactly what a tour they clicked through on
 * day one can no longer tell them. */

/** Where the spotlight sits, in viewport coordinates. */
type Rect = { top: number; left: number; width: number; height: number };

const PADDING = 8;
const BUBBLE_WIDTH = 320;
const BUBBLE_GAP = 12;

export function GuidedTour({
  steps,
  storageKey,
  onFinish,
}: {
  /** Only steps carrying a `target` can be pointed at; the rest are skipped.
   * Reuses the checklist's own steps so the two can never drift apart. */
  steps: OnboardingStep[];
  storageKey: string;
  onFinish?: () => void;
}) {
  const tourSteps = steps.filter((s) => s.target);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step = tourSteps[index];

  /** Done with it for good — reached the end, or chose Skip. */
  const finish = useCallback(() => {
    try {
      window.localStorage.setItem(tourStorageKey(storageKey), "1");
    } catch {
      // Storage blocked — the tour just runs again next time. Harmless.
    }
    onFinish?.();
  }, [storageKey, onFinish]);

  /** Out of the way for now, WITHOUT recording it as seen.
   *
   * Escape is a reflex — people press it to shut something, not to decline it
   * forever. Treating that as "seen it" meant one stray keypress permanently
   * removed the walkthrough, and the person then reported it as missing rather
   * than as dismissed, because from where they sat those look identical.
   * Skip is the deliberate no; this is the accidental one. */
  const dismissForNow = useCallback(() => {
    onFinish?.();
  }, [onFinish]);

  // Measure the target, and keep measuring: the page reflows when the panel
  // opens, when a day is switched on, or when the window changes size, and a
  // spotlight left behind on stale coordinates highlights empty space.
  useEffect(() => {
    if (!step?.target) return;
    const element = document.querySelector(step.target);
    if (!element) {
      // A target that isn't on this page must not strand the tour on a blank
      // step — move along rather than showing a bubble pointing at nothing.
      setIndex((i) => (i + 1 < tourSteps.length ? i + 1 : i));
      return;
    }

    element.scrollIntoView({ behavior: "smooth", block: "center" });

    const measure = () => {
      const r = element.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [step, tourSteps.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissForNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissForNow]);

  if (!step || !rect) return null;

  const isLast = index === tourSteps.length - 1;
  // Below the target unless that would fall off the bottom, in which case
  // above it. Nothing cleverer: two options cover every layout in this app,
  // and a full placement engine would be more code than the tour itself.
  const below = rect.top + rect.height + BUBBLE_GAP + 200 < window.innerHeight;
  const bubbleTop = below ? rect.top + rect.height + BUBBLE_GAP : undefined;
  const bubbleBottom = below ? undefined : window.innerHeight - rect.top + BUBBLE_GAP;
  const bubbleLeft = Math.min(
    Math.max(BUBBLE_GAP, rect.left),
    Math.max(BUBBLE_GAP, window.innerWidth - BUBBLE_WIDTH - BUBBLE_GAP)
  );

  return (
    <>
      {/* The spotlight. One element, dimming everything else via an enormous
          spread shadow — cheaper and steadier than four positioned panels
          around a hole, which visibly seam at the corners while scrolling.
          pointer-events-none is what keeps the page usable underneath. */}
      <div
        aria-hidden
        className="pointer-events-none fixed z-40 rounded-lg ring-2 ring-primary transition-all duration-200"
        style={{
          top: rect.top - PADDING,
          left: rect.left - PADDING,
          width: rect.width + PADDING * 2,
          height: rect.height + PADDING * 2,
          boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.45)",
        }}
      />

      <div
        role="dialog"
        aria-label={step.title}
        className="fixed z-50 rounded-lg border border-border bg-card p-4 shadow-card"
        style={{ top: bubbleTop, bottom: bubbleBottom, left: bubbleLeft, width: BUBBLE_WIDTH }}
      >
        <p className="text-xs text-muted-foreground">
          Step {index + 1} of {tourSteps.length}
        </p>
        <p className="mt-1 text-sm font-semibold text-foreground">{step.title}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{step.detail[0]}</p>

        <div className="mt-4 flex items-center justify-between gap-2">
          {/* Skip is always present and never hidden behind anything. Someone
              who doesn't want this should be able to leave at the first step
              without hunting for the way out. */}
          <button
            type="button"
            onClick={finish}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Skip
          </button>
          <div className="flex gap-2">
            {index > 0 && (
              <Button type="button" variant="secondary" size="sm" onClick={() => setIndex(index - 1)}>
                Back
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => (isLast ? finish() : setIndex(index + 1))}
            >
              {isLast ? "Got it" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

/** Bumped when the steps themselves change materially.
 *
 * Without it, "already seen it" is permanent: anyone who ran an earlier version
 * never sees the revised one, and the tour silently stops existing for exactly
 * the people who have been here longest. Raising this shows the new walkthrough
 * once more, to everyone. Do it for a changed sequence, not for a reworded
 * sentence. */
const TOUR_VERSION = 2;

/** Whether this person has already been walked through THIS version. Read on
 * the client only — the server has no idea, and guessing would flash the tour
 * at someone who finished it months ago. */
export function tourAlreadyDone(storageKey: string) {
  try {
    return window.localStorage.getItem(tourStorageKey(storageKey)) === "1";
  } catch {
    return false;
  }
}

export function tourStorageKey(storageKey: string) {
  return `fn-tour-done:${storageKey}:v${TOUR_VERSION}`;
}
