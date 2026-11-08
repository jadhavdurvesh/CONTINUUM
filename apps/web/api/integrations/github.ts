import { handleGithubWebhook, type CiRun } from "../_lib/github";

// Receives GitHub webhooks and records finished CI checks as trusted ("system") evidence.
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only; never shipped to browsers or desktop apps).
// The raw body is required to verify GitHub's HMAC signature, so body parsing is disabled.
export const config = { api: { bodyParser: false } };

async function readRaw(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_100_000) throw new Error("too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Use POST." }); }
  const root = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!root || !serviceKey) return res.status(503).json({ error: "The CI integration is not configured on this deployment." });

  let rawBody: Buffer;
  try { rawBody = await readRaw(req); } catch { return res.status(413).json({ error: "Payload too large." }); }

  const rpc = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(root + "/rest/v1/rpc/" + name, {
      method: "POST", headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    if (!response.ok) throw new Error("Supabase " + name + " failed (" + response.status + ")");
    return text ? JSON.parse(text) : null;
  };

  try {
    const reply = await handleGithubWebhook(
      { event: req.headers["x-github-event"], signature: req.headers["x-hub-signature-256"], rawBody },
      {
        lookup: async (repo: string) => (await rpc("ci_lookup", { p_provider: "github", p_repo: repo })) as { project_id: string; secret: string } | null,
        record: async (projectId: string, run: CiRun) => (await rpc("record_ci_run", {
          p_project_id: projectId, p_check_name: run.checkName, p_conclusion: run.conclusion, p_commit_sha: run.commitSha,
          p_external_id: run.externalId, p_url: run.url || null, p_refs: run.refs, p_started_at: run.startedAt, p_finished_at: run.finishedAt, p_summary: run.summary
        })) as Record<string, unknown>
      }
    );
    return res.status(reply.status).json(reply.body);
  } catch {
    return res.status(502).json({ error: "Could not record the CI result. GitHub will let you redeliver it." });
  }
}
