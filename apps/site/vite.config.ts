import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss(path.resolve(__dirname, "./tailwind.config.js")),
        autoprefixer()
      ]
    }
  },
  server: {
    port: 5174,
    host: "0.0.0.0"
  }
});
