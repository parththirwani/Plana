import { Link } from "@tanstack/react-router";
import { Reveal } from "./Reveal";

const columns = [
  { title: "Product", links: ["Boards", "Roles", "Pricing", "Changelog"] },
  { title: "Company", links: ["About", "Careers", "Blog", "Contact"] },
  { title: "Resources", links: ["Help center", "Guides", "Templates", "Status"] },
  { title: "Legal", links: ["Privacy", "Terms", "Security", "Cookies"] },
];

export function FinalCTA() {
  return (
    <section className="px-6 pb-16">
      <Reveal className="mx-auto max-w-[1200px]">
        <div className="relative overflow-hidden rounded-3xl bg-ink px-6 py-20 text-center md:py-28">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,oklch(0.523_0.183_283.5_/_0.45),transparent_70%)]"
          />
          <div className="relative">
            <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-5xl">
              Bring order to your team&apos;s work.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-sm text-white/60 sm:text-base">
              Free to start. Your team will feel the difference this week.
            </p>
            <Link
              to="/signup"
              className="mt-8 inline-flex items-center justify-center rounded-xl bg-accent px-6 py-3 text-sm font-medium text-accent-foreground transition-all duration-200 hover:scale-[1.02] hover:opacity-90"
            >
              Get started free
            </Link>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-border bg-card">
      <div className="container-page py-14">
        <div className="grid gap-10 md:grid-cols-[1.4fr_2fr]">
          <div>
            <div className="flex items-center gap-2">
              <img
                src="/logo-with-text.png"
                alt="Plana"
                width={822}
                height={299}
                decoding="async"
                className="h-7 w-auto"
              />
            </div>
            <p className="mt-3 max-w-xs text-sm text-muted-foreground">
              A calmer way to plan, organize, and ship work together.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            {columns.map((c) => (
              <div key={c.title}>
                <p className="text-xs font-semibold">{c.title}</p>
                <ul className="mt-3 space-y-2">
                  {c.links.map((l) => (
                    <li key={l}>
                      <a
                        href="#top"
                        className="text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
                      >
                        {l}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-12 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">© 2026 Plana. All rights reserved.</p>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <a href="#top" className="transition-colors hover:text-foreground">
              X
            </a>
            <a href="#top" className="transition-colors hover:text-foreground">
              LinkedIn
            </a>
            <a href="#top" className="transition-colors hover:text-foreground">
              GitHub
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
