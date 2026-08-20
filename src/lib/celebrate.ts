/** Confetti, for the one moment in this app worth celebrating: someone has
 * finished setting themselves up and is now bookable.
 *
 * Written by hand rather than pulling in a library. It is roughly sixty lines,
 * it has no dependencies to keep current, and — the part a library wouldn't
 * give us — it can be made to respect prefers-reduced-motion, which matters
 * because a burst of moving particles is exactly what that setting exists to
 * suppress. Someone who has asked their operating system for less motion gets
 * the toast and nothing else.
 *
 * The canvas is created on demand, draws itself out, and removes itself. There
 * is nothing left in the DOM afterwards and nothing to clean up at the call
 * site. */

/* Brand palette, not the generic confetti one this started with — that was
 * Tailwind's stock blue plus pink and violet, and FounderNexus has no purple
 * anywhere in its system. These are the logo's own two tones (blue #007BE4 and
 * the mark's grey #929497), the darker partner blue, the pale chip blue, and
 * the brand's success green, which is what this moment actually is. */
const COLOURS = ["#007BE4", "#0072BA", "#D3EAFD", "#929497", "#1F9D55"];
const PARTICLES = 90;
const DURATION_MS = 2600;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  spin: number;
  size: number;
  colour: string;
};

export function celebrate() {
  if (typeof window === "undefined") return;
  // Not a nice-to-have: vestibular disorders make full-screen motion genuinely
  // unpleasant, and the browser already knows the answer.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60";
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }

  // Launched from the bottom edge, spread across the middle of the screen and
  // thrown upward — the shape of something popping rather than falling.
  const particles: Particle[] = Array.from({ length: PARTICLES }, () => ({
    x: canvas.width * (0.2 + Math.random() * 0.6),
    y: canvas.height + 10,
    vx: (Math.random() - 0.5) * 9,
    vy: -(14 + Math.random() * 12),
    rotation: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.3,
    size: 6 + Math.random() * 6,
    colour: COLOURS[Math.floor(Math.random() * COLOURS.length)],
  }));

  const start = performance.now();

  function frame(now: number) {
    const elapsed = now - start;
    if (elapsed > DURATION_MS || !ctx) {
      canvas.remove();
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Fades over the last third rather than vanishing, so it ends rather than
    // being switched off.
    const fade = Math.max(0, 1 - Math.max(0, elapsed - DURATION_MS * 0.6) / (DURATION_MS * 0.4));

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.42; // gravity
      p.vx *= 0.995; // air resistance, so the spread settles rather than widening forever
      p.rotation += p.spin;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.colour;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
