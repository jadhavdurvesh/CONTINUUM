import { createHmac, timingSafeEqual } from "node:crypto";

// GitHub → CONTINUUM trusted evidence. Everything security-relevant is a pure function here so it can be tested
// without a network: signature verification, task-reference extraction and payload mapping.

export type CiRun = {
  checkName: string; conclusion: string; commitSha: string; externalId: string; url: string;
  refs: string[]; startedAt: string | null; finishedAt: string | null; summary: string;
};
export type Lookup = { project_id: string; secret: string };
export type Deps = {
  lookup: (repo: string) => Promise<Lookup | null>;
  record: (projectId: string, run: CiRun) => Promise<Record<string, unknown>>;
};
export type Reply = { status: number; body: Record<string, unknown> };

export const MAX_BODY_BYTES = 1_000_000;

/** `X-Hub-Signature-256: sha256=<hex>` over the raw request body, compared in constant time. */
export function verifyGithubSignature(rawBody: Buffer | string, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Task references look like `ct-3f9a1c2b`, `ct:3f9a1c2b` or `CT_3F9A1C2B` (first 8 hex characters of the task id). */
export function extractTaskRefs(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(/(?<![0-9a-z])ct[-:_]([0-9a-f]{8})(?![0-9a-z])/gi)) found.add(match[1].toLowerCase());
    if (found.size >= 10) break;
  }
  return [...found].slice(0, 10);
}

const str = (value: unknown): string => typeof value === "string" ? value : "";
// GitHub sends ids and attempt counters as numbers.
const num = (value: unknown, fallback = ""): string => typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" && /^\d+$/.test(value) ? value : fallback;
const isoOrNull = (value: unknown): string | null => { const text = str(value); return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null; };

/** Map a completed `workflow_run` or `workflow_job` webhook payload to a CI run, or null when it is not a completed run. */
export function mapGithubEvent(event: string, payload: any): CiRun | null {
  if (payload?.action !== "completed") return null;
  if (event === "workflow_run") {
    const run = payload.workflow_run;
    if (!run || !str(run.conclusion) || !str(run.head_sha)) return null;
    return {
      checkName: str(run.name).slice(0, 100) || "workflow", conclusion: str(run.conclusion), commitSha: str(run.head_sha),
      externalId: "run-" + num(run.id, "0") + "-" + num(run.run_attempt, "1"), url: str(run.html_url),
      refs: extractTaskRefs(run.head_branch, run.display_title, run.head_commit?.message),
      startedAt: isoOrNull(run.run_started_at), finishedAt: isoOrNull(run.updated_at),
      summary: (str(run.name) + " on " + str(run.head_branch) + ": " + str(run.conclusion)).slice(0, 500)
    };
  }
  if (event === "workflow_job") {
    const job = payload.workflow_job;
    if (!job || !str(job.conclusion) || !str(job.head_sha)) return null;
    return {
      checkName: str(job.name).slice(0, 100) || "job", conclusion: str(job.conclusion), commitSha: str(job.head_sha),
      externalId: "job-" + num(job.id, "0") + "-" + num(job.run_attempt, "1"), url: str(job.html_url),
      refs: extractTaskRefs(job.head_branch),
      startedAt: isoOrNull(job.started_at), finishedAt: isoOrNull(job.completed_at),
      summary: (str(job.workflow_name) + " / " + str(job.name) + ": " + str(job.conclusion)).slice(0, 500)
    };
  }
  return null;
}

/** The whole webhook, with the database behind `deps`. Unknown repositories and bad signatures look identical (401). */
export async function handleGithubWebhook(input: { event: string | undefined; signature: string | undefined; rawBody: Buffer }, deps: Deps): Promise<Reply> {
  if (input.rawBody.length > MAX_BODY_BYTES) return { status: 413, body: { error: "Payload too large." } };
  let payload: any;
  try { payload = JSON.parse(input.rawBody.toString("utf8")); } catch { return { status: 400, body: { error: "Invalid JSON." } }; }
  const repo = str(payload?.repository?.full_name);
  if (!repo || repo.length > 200) return { status: 400, body: { error: "The payload does not name a repository." } };

  const found = await deps.lookup(repo);
  if (!found || !verifyGithubSignature(input.rawBody, input.signature, found.secret)) return { status: 401, body: { error: "Invalid signature." } };

  if (input.event === "ping") return { status: 200, body: { ok: true, message: "CONTINUUM is connected to " + repo + "." } };
  const run = mapGithubEvent(input.event ?? "", payload);
  if (!run) return { status: 202, body: { ignored: true, reason: "Only completed workflow_run and workflow_job events are recorded." } };
  const result = await deps.record(found.project_id, run);
  return { status: 200, body: { ok: true, ...result } };
}
