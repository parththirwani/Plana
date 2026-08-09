import { useEffect, useRef, useState } from "react";
import { Reveal } from "./Reveal";
import { BrowserFrame } from "./BoardMockup";
import { KanbanDemo } from "./KanbanDemo";
import { GlyphArrow } from "./Glyphs";

/** Board tilts back slightly and straightens as it scrolls into view. */
function useStraighten() {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const rect = el.getBoundingClientRect();
      const progress = 1 - (rect.top + rect.height * 0.35) / window.innerHeight;
      setTilt(Math.min(1, Math.max(0, 1 - progress * 1.6)));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return { ref, tilt };
}

export function Hero() {
  const { ref, tilt } = useStraighten();

  return (
    <section id="top" className="relative overflow-hidden pt-32 md:pt-40">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,var(--accent-soft),transparent_70%)]"
      />
      <div className="container-page relative">
        <Reveal className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-white px-3 py-1 text-xs text-muted-foreground shadow-hair">
            <span className="size-1.5 rounded-full bg-accent" />
            Built for fast-moving teams
          </span>
          <h1 className="mt-6 text-[2.6rem] font-semibold leading-[1.05] tracking-tight sm:text-6xl md:text-7xl">
            The clearest way to plan your team&apos;s work.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Every project, task, and teammate in one calm, organized view. Plana keeps the plan
            visible so the work can move.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="#pricing"
              className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-medium text-accent-foreground shadow-glow transition-all duration-200 hover:scale-[1.02] hover:opacity-90 sm:w-auto"
            >
              Get started free
              <span className="size-4 transition-transform duration-200 group-hover:translate-x-0.5">
                <GlyphArrow />
              </span>
            </a>
            <a
              href="#product"
              className="inline-flex w-full items-center justify-center rounded-xl border border-border bg-white px-5 py-3 text-sm font-medium text-foreground shadow-hair transition-all duration-200 hover:scale-[1.02] hover:bg-muted sm:w-auto"
            >
              See it in action
            </a>
          </div>
        </Reveal>

        <Reveal delay={120} className="mt-16 md:mt-20">
          <div ref={ref} style={{ perspective: "1600px" }}>
            <BrowserFrame
              className="transition-transform duration-300 ease-out will-change-transform"
              style={{
                transform: `rotateX(${(tilt * 7).toFixed(2)}deg) scale(${(1 - tilt * 0.02).toFixed(3)})`,
                transformOrigin: "center top",
              }}
            >
              <KanbanDemo />
            </BrowserFrame>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
