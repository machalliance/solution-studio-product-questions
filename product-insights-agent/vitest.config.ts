import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tooling/test-setup/setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules", ".next", "e2e"],
  },
  resolve: {
    alias: [
      {
        find: /^@\/widget$/,
        replacement: path.resolve(__dirname, "src/widget/index.ts"),
      },
      {
        find: /^@\/widget\/(.*)$/,
        replacement: path.resolve(__dirname, "src/widget") + "/$1",
      },
      {
        find: /^@\/controlpanel\/(.*)$/,
        replacement: path.resolve(__dirname, "src/controlpanel") + "/$1",
      },
      {
        find: /^@\/server\/(.*)$/,
        replacement: path.resolve(__dirname, "src/server") + "/$1",
      },
      {
        find: /^@\/tooling\/(.*)$/,
        replacement: path.resolve(__dirname, "tooling") + "/$1",
      },
      { find: /^@\/(.*)$/, replacement: path.resolve(__dirname, ".") + "/$1" },
    ],
  },
});
