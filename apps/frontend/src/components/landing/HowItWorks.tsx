import { Reveal } from "./Reveal";

const steps = [
  {
    title: "Create your workspace",
    body: "Set up your team in a minute and invite the people you work with.",
  },
  {
    title: "Set up your boards",
    body: "Build boards and columns that match however your team likes to work.",
  },
  {
    title: "Drag, assign, comment",
    body: "Move work forward together and stay in sync without the busywork.",
  },
];

export function HowItWorks() {
  return (
    <section className="section-y border-y border-border bg-card">
      <div className="container-page">
        <Reveal className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-5xl">
            Up and running in three steps.
          </h2>
        </Reveal>
        <div className="mt-14 grid gap-12 md:grid-cols-3 md:gap-8">
          {steps.map((s, i) => (
            <Reveal key={s.title} delay={i * 90}>
              <div className="relative border-t border-border px-4 pt-8 sm:px-6 sm:pt-10">
                <div className="flex items-baseline gap-5 sm:gap-4">
                  <h3 className="text-lg font-semibold tracking-tight">{s.title}</h3>
                  <span
                    aria-hidden
                    className="shrink-0 select-none text-[3.5rem] font-semibold leading-none tracking-tighter text-foreground/15 sm:text-[4.5rem]"
                  >
                    {i + 1}
                  </span>
                </div>
                <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
                  {s.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
