const allowedOrigins = new Set([
  "https://continuum-dun-ten.vercel.app",
  ...(process.env.CONTINUUM_DASHBOARD_ORIGIN ? [process.env.CONTINUUM_DASHBOARD_ORIGIN.replace(/\/$/, "")] : []),
  ...(process.env.VERCEL_URL ? ["https://" + process.env.VERCEL_URL.replace(/^https?:\/\//, "").replace(/\/$/, "")] : []),
]);

export function isAllowedAgentOrigin(origin: string): boolean {
  if (allowedOrigins.has(origin)) return true;
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
  if (!origin) return true;
  if (!isAllowedAgentOrigin(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}
