import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Serve the browser-only dev mock's hardware probe at /machine.json during
 * `npm run dev` ONLY. It used to live in public/, which Vite copies into every
 * build — so a release would have shipped a 20 MB snapshot of the developer's
 * own machine. dev-data/ is gitignored and never reaches dist/.
 */
function devMachineProbe(): Plugin {
  return {
    name: "modelfit-dev-machine-probe",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/machine.json", async (_req, res, next) => {
        try {
          const body = await readFile(new URL("./dev-data/machine.json", import.meta.url));
          res.setHeader("Content-Type", "application/json");
          res.end(body);
        } catch {
          next(); // absent → the mock falls back to its synthetic fixtures
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devMachineProbe()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
