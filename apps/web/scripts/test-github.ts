import { createHmac } from "node:crypto";
import { extractTaskRefs, handleGithubWebhook, mapGithubEvent, verifyGithubSignature, type CiRun } from "../api/_lib/github";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("GitHub integration test failed: " + message);
}
const SECRET = "whsec_" + "a".repeat(40);
const sign = (body: string, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

// --- signature ---
const body = JSON.stringify({ hello: "world" });
assert(verifyGithubSignature(body, sign(body), SECRET), "valid signature accepted");
assert(!verifyGithubSignature(body, sign(body, "other-secret-other-secret-other"), SECRET), "wrong secret rejected");
assert(!verifyGithubSignature(body + " ", sign(body), SECRET), "tampered body rejected");
assert(!verifyGithubSignature(body, undefined, SECRET), "missing header rejected");
assert(!verifyGithubSignature(body, "sha256=abc", SECRET), "short digest rejected");
assert(!verifyGithubSignature(body, "sha1=" + "a".repeat(40), SECRET), "sha1 rejected");
assert(!verifyGithubSignature(body, sign(body), ""), "empty secret rejected");

// --- task references ---
assert(JSON.stringify(extractTaskRefs("feature/ct-3f9a1c2b-detector")) === '["3f9a1c2b"]', "branch reference");
assert(JSON.stringify(extractTaskRefs("Fix CT:ABCDEF12 and ct_0123abcd")) === '["abcdef12","0123abcd"]', "case-insensitive, several forms");
assert(extractTaskRefs("project ct-3f9a1c2bX", "ct-123", "act-3f9a1c2b").length === 0, "no partial or embedded matches");
assert(extractTaskRefs(null, undefined, "").length === 0, "empty inputs");
assert(extractTaskRefs("ct-3f9a1c2b", "ct-3f9a1c2b").length === 1, "deduplicated");

// --- payload mapping ---
const run = { action: "completed", repository: { full_name: "Acme/Robot" }, workflow_run: {
  id: 77, run_attempt: 2, name: "validate", conclusion: "success", head_sha: "a".repeat(40), head_branch: "ct-3f9a1c2b-detector",
  display_title: "Add detector", html_url: "https://github.com/Acme/Robot/actions/runs/77", run_started_at: "2026-10-30T10:00:00Z", updated_at: "2026-10-30T10:02:00Z",
  head_commit: { message: "wip ct:deadbeef" } } };
const mappedRun = mapGithubEvent("workflow_run", run)!;
assert(mappedRun.externalId === "run-77-2" && mappedRun.checkName === "validate" && mappedRun.conclusion === "success", "workflow_run mapped");
assert(JSON.stringify(mappedRun.refs) === '["3f9a1c2b","deadbeef"]', "references from branch and commit message");
assert(mappedRun.startedAt === "2026-10-30T10:00:00.000Z", "times normalised");
assert(mapGithubEvent("workflow_run", { ...run, action: "requested" }) === null, "non-completed ignored");
assert(mapGithubEvent("workflow_run", { action: "completed", workflow_run: { ...run.workflow_run, conclusion: null } }) === null, "no conclusion ignored");
assert(mapGithubEvent("push", run) === null, "other events ignored");
const job = mapGithubEvent("workflow_job", { action: "completed", workflow_job: { id: 5, run_attempt: 1, name: "unit-tests", workflow_name: "validate", conclusion: "failure", head_sha: "b".repeat(40), head_branch: "ct-3f9a1c2b", html_url: "u", started_at: "bad date", completed_at: "2026-10-30T10:05:00Z" } })!;
assert(job.checkName === "unit-tests" && job.externalId === "job-5-1" && job.startedAt === null && job.finishedAt === "2026-10-30T10:05:00.000Z", "workflow_job mapped, bad dates dropped");

// --- the webhook end to end, with a fake database ---
const calls: { looked: string[]; recorded: { projectId: string; run: CiRun }[] } = { looked: [], recorded: [] };
const deps = {
  lookup: async (repo: string) => { calls.looked.push(repo); return repo === "Acme/Robot" ? { project_id: "p1", secret: SECRET } : null; },
  record: async (projectId: string, value: CiRun) => { calls.recorded.push({ projectId, run: value }); return { recorded: 1 }; }
};
const send = (payload: unknown, opts: { event?: string; secret?: string; signature?: string } = {}) => {
  const raw = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  return handleGithubWebhook({ event: opts.event ?? "workflow_run", signature: opts.signature ?? sign(raw.toString(), opts.secret), rawBody: raw }, deps);
};

let reply = await send(run);
assert(reply.status === 200 && reply.body.recorded === 1 && calls.recorded[0].projectId === "p1", "valid workflow_run recorded for the right project");
reply = await send(run, { secret: "wrong-wrong-wrong-wrong-wrong-wrong" });
assert(reply.status === 401 && calls.recorded.length === 1, "bad signature rejected and nothing recorded");
const unknown = await send({ ...run, repository: { full_name: "Evil/Repo" } });
assert(unknown.status === 401 && JSON.stringify(unknown.body) === JSON.stringify(reply.body), "unknown repository is indistinguishable from a bad signature");
reply = await send(run, { signature: "" });
assert(reply.status === 401, "missing signature rejected");
reply = await send({ zen: "keep it logically awesome", repository: { full_name: "Acme/Robot" } }, { event: "ping" });
assert(reply.status === 200 && String(reply.body.message).includes("Acme/Robot"), "ping answered once verified");
reply = await send({ ...run, action: "in_progress" });
assert(reply.status === 202 && calls.recorded.length === 1, "in-progress runs are ignored, not recorded");
reply = await send(run, { event: "push" });
assert(reply.status === 202, "unsupported event ignored");
reply = await send("not json");
assert(reply.status === 400, "invalid JSON rejected");
reply = await send({ no: "repository" });
assert(reply.status === 400, "payload without a repository rejected");
reply = await handleGithubWebhook({ event: "workflow_run", signature: "x", rawBody: Buffer.alloc(1_000_001) }, deps);
assert(reply.status === 413, "oversized payload rejected before any lookup");
assert(calls.looked.every((repo) => repo.length < 50), "lookups only use the repository name");

console.log("GitHub integration tests passed.");
