const logos = ["Northwind", "Kestrel", "Vantage", "Foldera", "Lumen", "Basalt", "Orbit", "Marrow"];

export function LogoStrip() {
  return (
    <section className="py-14 md:py-20">
      <div className="container-page">
        <p className="text-center text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Trusted by teams who like to stay organized
        </p>
      </div>
      <div className="relative mt-8 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
        <div className="flex w-max animate-marquee items-center gap-14 pr-14">
          {[...logos, ...logos].map((name, i) => (
            <span
              key={`${name}-${i}`}
              className="whitespace-nowrap text-xl font-semibold tracking-tight text-muted-foreground/50"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
