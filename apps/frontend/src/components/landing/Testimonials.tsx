import { Reveal } from "./Reveal";

const quotes = [
  {
    q: "We stopped asking where things stood. The board answers it for us.",
    n: "Mira Kaur",
    r: "Head of Product, Northwind",
    i: "MK",
    c: "bg-accent/15 text-accent",
  },
  {
    q: "It's the first tool our whole team actually kept using after week two.",
    n: "Jordan Tate",
    r: "Operations Lead, Kestrel",
    i: "JT",
    c: "bg-emerald-100 text-emerald-700",
  },
  {
    q: "Planning takes ten minutes now. It used to take a whole morning.",
    n: "Ava Reyes",
    r: "Studio Director, Foldera",
    i: "AR",
    c: "bg-amber-100 text-amber-700",
  },
];

export function Testimonials() {
  return (
    <section className="section-y border-y border-border bg-card">
      <div className="container-page">
        <Reveal className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-5xl">
            Teams who traded the chaos.
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {quotes.map((t, i) => (
            <Reveal key={t.n} delay={i * 80}>
              <figure className="h-full rounded-2xl border border-border bg-background p-6 shadow-hair transition-all duration-200 hover:-translate-y-1 hover:shadow-soft">
                <blockquote className="text-[15px] leading-relaxed text-foreground">
                  &ldquo;{t.q}&rdquo;
                </blockquote>
                <figcaption className="mt-6 flex items-center gap-3">
                  <span
                    className={`grid size-9 place-items-center rounded-full text-xs font-semibold ${t.c}`}
                  >
                    {t.i}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{t.n}</span>
                    <span className="block truncate text-xs text-muted-foreground">{t.r}</span>
                  </span>
                </figcaption>
              </figure>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
