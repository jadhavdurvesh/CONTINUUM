import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          codemirror: ["@uiw/react-codemirror", "@codemirror/view", "@codemirror/lang-css", "@codemirror/lang-html", "@codemirror/lang-javascript", "@codemirror/lang-json", "@codemirror/lang-markdown", "@codemirror/lang-python"],
          supabase: ["@supabase/supabase-js"]
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true
      }
    }
  }
});
