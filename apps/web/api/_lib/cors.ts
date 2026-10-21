// Files under api/_lib are helpers, not endpoints: Vercel ignores underscore-prefixed paths.
// Set CONTINUUM_DASHBOARD_ORIGIN (comma-separated list allowed) to your production dashboard origin(s).
function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/$/, "");
}

function configuredOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const raw of (process.env.CONTINUUM_DASHBOARD_ORIGIN || "").split(",")) {
    if (raw.trim()) origins.add(normalizeOrigin(raw));
  }
  if (process.env.VERCEL_URL) {
    origins.add("https://" + process.env.VERCEL_URL.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    origins.add("https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, "").replace(/\/$/, ""));
  }
  return origins;
}

export function isAllowedAgentOrigin(origin: string): boolean {
  if (configuredOrigins().has(normalizeOrigin(origin))) return true;
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      && ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function setAgentCors(req: any, res: any): boolean {
  const origin = typeof req.headers?.origin === "string" ? req.headers.origin : "";
  if (!origin) return true; // Non-browser clients (desktop apps) send no Origin; bearer auth still applies.
  if (!isAllowedAgentOrigin(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}
