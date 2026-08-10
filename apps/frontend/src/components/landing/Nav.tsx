import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { GlyphClose, GlyphMenu } from "./Glyphs";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/auth-store";

const links = [
  { label: "Product", href: "#product" },
  { label: "Features", href: "#features" },
  { label: "Pricing", href: "#pricing" },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const init = useAuthStore((s) => s.init);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    init();
  }, [init]);

  const ready = status === "authenticated" || status === "unauthenticated";
  const authenticated = status === "authenticated" && user;

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-200",
        scrolled
          ? "border-b border-border bg-white/85 backdrop-blur-md"
          : "border-b border-transparent",
      )}
    >
      <nav className="container-page flex h-16 items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2">
          <img
            src="/logo-with-text.png"
            alt="Plana"
            width={822}
            height={299}
            decoding="async"
            className="h-7 w-auto"
          />
        </Link>

        <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 md:flex">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-2 md:flex">
          {ready &&
            (authenticated ? (
              <Link
                to="/app"
                className="relative px-3 py-2 text-sm font-medium text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-[2px] after:origin-left after:scale-x-0 after:bg-accent after:transition-transform after:duration-200 hover:after:scale-x-100"
              >
                Open app
              </Link>
            ) : (
              <>
                <Link
                  to="/login"
                  className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
                >
                  Sign in
                </Link>
                <Link
                  to="/signup"
                  className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-foreground shadow-hair transition-all duration-200 hover:scale-[1.02] hover:opacity-90"
                >
                  Get started
                </Link>
              </>
            ))}
        </div>

        <button
          type="button"
          aria-label="Toggle menu"
          onClick={() => setOpen((v) => !v)}
          className="grid size-9 place-items-center rounded-lg border border-border bg-white md:hidden"
        >
          <span className="size-4">{open ? <GlyphClose /> : <GlyphMenu />}</span>
        </button>
      </nav>

      {open && (
        <div className="border-t border-border bg-white px-6 py-4 md:hidden">
          <div className="flex flex-col gap-3">
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                onClick={() => setOpen(false)}
                className="text-sm text-muted-foreground"
              >
                {l.label}
              </a>
            ))}
            {ready &&
              (authenticated ? (
                <Link
                  to="/app"
                  onClick={() => setOpen(false)}
                  className="mt-1 rounded-lg bg-accent px-3.5 py-2 text-center text-sm font-medium text-accent-foreground"
                >
                  Open app
                </Link>
              ) : (
                <>
                  <Link
                    to="/login"
                    onClick={() => setOpen(false)}
                    className="text-sm text-muted-foreground"
                  >
                    Sign in
                  </Link>
                  <Link
                    to="/signup"
                    onClick={() => setOpen(false)}
                    className="mt-1 rounded-lg bg-accent px-3.5 py-2 text-center text-sm font-medium text-accent-foreground"
                  >
                    Get started
                  </Link>
                </>
              ))}
          </div>
        </div>
      )}
    </header>
  );
}
