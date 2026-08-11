import { createFileRoute } from "@tanstack/react-router";
import { Nav } from "@/components/landing/Nav";
import { Hero } from "@/components/landing/Hero";
import { Bento } from "@/components/landing/Bento";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Spotlight } from "@/components/landing/Spotlight";
import { Testimonials } from "@/components/landing/Testimonials";
import { Pricing } from "@/components/landing/Pricing";
import { FinalCTA, Footer } from "@/components/landing/FinalCTA";

const title = "Plana";
const description =
  "Plana brings every project, task, and teammate into one calm, organized view. Boards, cards, and a workspace that feels effortless.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main>
        <Hero />
        <Bento />
        <HowItWorks />
        <Spotlight />
        <Testimonials />
        <Pricing />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
