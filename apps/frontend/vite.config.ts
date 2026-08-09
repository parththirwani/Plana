import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig, type PluginOption } from "vite";

export default defineConfig(async ({ command }) => {
  // TanStack Start's SSR server bundle. Nitro wraps it for deployment
  // (Cloudflare default, same as before). Dev and preview don't need it.
  const buildPlugins: PluginOption[] = [];
  if (command === "build") {
    const { nitro } = await import("nitro/vite");
    buildPlugins.push(nitro({ defaultPreset: "cloudflare-module" }));
  }

  return {
    // tsconfig paths resolve natively in Vite 8 (no vite-tsconfig-paths plugin).
    resolve: {
      tsconfigPaths: true,
      alias: { "@": `${process.cwd()}/src` },
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
      ignoreOutdatedRequests: true,
    },
    plugins: [
      tailwindcss(),
      tanstackStart({
        // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
        server: { entry: "server" },
        importProtection: {
          behavior: "error",
          client: { files: ["**/server/**"], specifiers: ["server-only"] },
        },
      }),
      react(),
      ...buildPlugins,
    ],
    server: {
      host: "::",
      port: 3000,
      strictPort: true,
      proxy: {
        // Proxy API calls to the Express backend during local dev so auth
        // cookies are set on the frontend origin (same-site). In production a
        // reverse proxy (e.g. Nginx) routes /api to the backend.
        "/api": "http://localhost:8000",
      },
    },
  };
});
