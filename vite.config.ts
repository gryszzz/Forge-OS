import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoBase = process.env.VITE_BASE_PATH || "./";

export default defineConfig({
  base: repoBase,
  plugins: [react()],
});
