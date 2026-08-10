import { Reveal } from "./Reveal";
import { BoardMockup } from "./BoardMockup";
import { GlyphCardMove, GlyphRoster, GlyphSync, GlyphThread, IconTile } from "./Glyphs";

function CardShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border border-border bg-card p-6 shadow-hair transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft md:p-8 ${className ?? ""}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          background:
            "radial-gradient(400px circle at 50% 0%, var(--accent-soft), transparent 70%)",
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}

const small = [
  {
    Glyph: GlyphRoster,
    title: "Everyone on the same page",
    body: "Roles and permissions so the right people can edit, and everyone can see what's happening.",
  },
  {
    Glyph: GlyphSync,
    title: "Work that updates itself",
    body: "Changes show up for your team the moment they happen. No refreshing, no confusion.",
  },
  {
    Glyph: GlyphThread,
    title: "Context, not chaos",
    body: "Comments, due dates, and priorities live right on the card, so nothing gets lost in another tab.",
  },
];

export function Bento() {
  return (
    <section id="features" className="section-y">
      <div className="container-page">
        <Reveal className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-5xl">
            Everything your team needs to stay on track.
          </h2>
          <p className="mt-4 text-base text-muted-foreground sm:text-lg">
            Simple pieces that fit together, so planning stops being a project of its own.
          </p>
        </Reveal>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          <Reveal className="md:col-span-3">
            <CardShell>
              <div className="grid items-center gap-8 lg:grid-cols-2">
                <div>
                  <IconTile>
                    <GlyphCardMove />
                  </IconTile>
                  <h3 className="mt-5 text-2xl font-semibold tracking-tight">
                    Boards that just make sense
                  </h3>
                  <p className="mt-3 max-w-md text-muted-foreground">
                    Drag cards across columns, reorder in seconds, and see the whole project at a
                    glance without asking anyone for an update.
                  </p>
                </div>
                <div className="overflow-hidden rounded-xl border border-border shadow-soft">
                  <BoardMockup compact />
                </div>
              </div>
            </CardShell>
          </Reveal>

          {small.map((f, i) => (
            <Reveal key={f.title} delay={i * 80}>
              <CardShell className="h-full">
                <IconTile>
                  <f.Glyph />
                </IconTile>
                <h3 className="mt-5 text-lg font-semibold tracking-tight">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </CardShell>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
