import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Revealyst — Prompt Coach",
  version: "0.1.0",
  description:
    "Turn every prompt into a step forward — live prompt scoring, one-click suggestions, team analytics.",
  permissions: ["storage"],
  // http://localhost/* is for Playwright e2e against mock LLM pages only.
  // chatgpt.com is the current ChatGPT origin (chat.openai.com redirects).
  host_permissions: [
    "https://chat.openai.com/*",
    "https://chatgpt.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*",
    "https://revealyst-workers.thapi.workers.dev/*",
    // Local ONNX scorer (spec §5.2): model artifact on R2 + the CDN
    // Transformers.js loads its wasm/onnxruntime runtime from.
    "https://*.r2.dev/*",
    "https://cdn.jsdelivr.net/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
  ],
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: [
        "https://chat.openai.com/*",
        "https://chatgpt.com/*",
        "https://claude.ai/*",
        "https://gemini.google.com/*",
        "http://localhost/*",
        "http://127.0.0.1/*",
      ],
      js: ["src/content/index.tsx"],
      run_at: "document_idle",
    },
  ],
  web_accessible_resources: [
    {
      resources: ["assets/*"],
      matches: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    },
  ],
});
