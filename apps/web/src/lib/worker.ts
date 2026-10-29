// Client for the local CONTINUUM worker (the process on this PC that owns the real checkout).
// The worker token can run commands on this machine, so it is only ever sent to a loopback URL.
export const WORKER_CONFIG_KEY = "continuum.local-worker.config";

export function normalizeWorkerUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw.trim()); }
  catch { throw new Error("Enter the loopback worker URL, for example http://127.0.0.1:4318."); }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("For safety, the worker token is only sent to localhost, 127.0.0.1, or [::1] over HTTP.");
  }
  return parsed.origin;
}

export function loadWorkerConfig(): { url: string; token: string } {
  try {
    const raw = localStorage.getItem(WORKER_CONFIG_KEY);
    const token = sessionStorage.getItem(WORKER_CONFIG_KEY + ".token") || "";
    const url = raw ? (JSON.parse(raw) as { url?: string }).url : undefined;
    return { url: url || "http://127.0.0.1:4318", token };
  } catch { return { url: "http://127.0.0.1:4318", token: "" }; }
}

export type WorkerContext = { projectId: string; accessToken: string };

export async function workerCall<T = Record<string, unknown>>(path: string, context: WorkerContext, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const config = loadWorkerConfig();
  if (!config.token.trim()) throw new Error("Pair the local worker first: open Local IDE, enter the worker URL and token, and connect.");
  if (!context.projectId || !context.accessToken) throw new Error("Your CONTINUUM sign-in is missing. Sign out and sign in again.");
  const headers = new Headers({
    Authorization: "Bearer " + config.token.trim(),
    "X-Continuum-Project-Id": context.projectId,
    "X-Continuum-User-Token": context.accessToken
  });
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(normalizeWorkerUrl(config.url) + path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, mode: "cors", credentials: "omit",
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("For safety")) throw error;
    throw new Error("Could not reach the local worker. Keep it running on this PC and add this site's exact origin to CONTINUUM_ALLOWED_ORIGINS.");
  }
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Worker request failed (" + response.status + ").");
  return data as T;
}
