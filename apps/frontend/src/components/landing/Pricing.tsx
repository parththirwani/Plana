import { GlyphTick } from "./Glyphs";
import { Reveal } from "./Reveal";
import { cn } from "@/lib/utils";

const tiers = [
  {
    name: "Free",
    price: "$0",
    note: "For small teams getting started",
    cta: "Get started free",
    features: ["Up to 3 boards", "Unlimited cards", "Comments and due dates", "Up to 5 teammates"],
  },
  {
    name: "Team",
    price: "$9",
    note: "Per person, per month",
    cta: "Start free trial",
    popular: true,
    features: [
      "Unlimited boards",
      "Roles and permissions",
      "Live updates across the team",
      "Priorities and assignees",
      "Priority support",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    note: "For larger organizations",
    cta: "Talk to us",
    features: [
      "Everything in Team",
      "Advanced access controls",
      "Onboarding and training",
      "Dedicated support",
    ],
  },
];

export function Pricing() {
  return (
    <section id="pricing" className="section-y">
      <div className="container-page">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-5xl">
            Simple pricing, no surprises.
          </h2>
          <p className="mt-4 text-muted-foreground">Start free. Upgrade when your team grows.</p>
        </Reveal>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {tiers.map((t, i) => (
            <Reveal key={t.name} delay={i * 80}>
              <div
                className={cn(
                  "relative flex h-full flex-col rounded-2xl border bg-card p-7 shadow-hair transition-all duration-200 hover:shadow-soft",
                  t.popular ? "border-accent shadow-soft" : "border-border",
                )}
              >
                {t.popular && (
                  <span className="absolute -top-3 left-7 rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground">
                    Most popular
                  </span>
                )}
                <h3 className="text-sm font-semibold">{t.name}</h3>
                <p className="mt-4 text-4xl font-semibold tracking-tight">{t.price}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t.note}</p>
                <ul className="mt-6 space-y-3">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                      <span className="mt-0.5 size-4 shrink-0 text-accent">
                        <GlyphTick />
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
                <a
                  href="#top"
                  className={cn(
                    "mt-8 inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 hover:scale-[1.02]",
                    t.popular
                      ? "bg-accent text-accent-foreground hover:opacity-90"
                      : "border border-border bg-card text-foreground hover:bg-muted",
                  )}
                >
                  {t.cta}
                </a>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
