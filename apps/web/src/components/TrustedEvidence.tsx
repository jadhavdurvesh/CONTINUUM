import { useCallback, useEffect, useState } from "react";
import { ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useStable } from "../lib/hooks";

type Status = { github: { configured: boolean; updated_at: string } | null; repositories: { id: string; name: string; remote_url: string | null }[] } | null;
type CiRun = { id: string; result: string; summary: string | null; url: string | null; commit_sha: string | null; created_at: string; task_id: string | null };
type Props = { projectId: string; userId: string; isOwner: boolean; onNotify: (message: string) => void; onChanged: () => void };

function newSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "whsec_" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function TrustedEvidence({ projectId, userId, isOwner, onNotify, onChanged }: Props) {
  const notify = useStable(onNotify);
  const [policy, setPolicy] = useState<"any" | "ci_only">("any");
  const [status, setStatus] = useState<Status>(null);
  const [runs, setRuns] = useState<CiRun[]>([]);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState("");
  const hookUrl = (typeof window !== "undefined" ? window.location.origin : "") + "/api/integrations/github";

  const load = useCallback(async () => {
    if (!supabase) return;
    const [projectResult, statusResult, runResult] = await Promise.all([
      supabase.from("projects").select("evidence_policy").eq("id", projectId).single(),
      supabase.rpc("integration_status", { p_project_id: projectId }),
      supabase.from("test_runs").select("id,result,summary,url,commit_sha,created_at,task_id").eq("project_id", projectId).eq("source", "github-actions").order("created_at", { ascending: false }).limit(8)
    ]);
    if (projectResult.data) setPolicy((projectResult.data as { evidence_policy: "any" | "ci_only" }).evidence_policy ?? "any");
    if (statusResult.error && !/integration_status/.test(statusResult.error.message)) notify(statusResult.error.message);
    setStatus((statusResult.data as Status) ?? null); setRuns((runResult.data as CiRun[] | null) ?? []);
  }, [projectId, notify]);
  useEffect(() => { void load(); }, [load]);

  async function changePolicy(next: "any" | "ci_only") {
    if (!supabase) return;
    if (next === "ci_only" && !window.confirm("Only CI results will count toward completion. Manual and local test results will be kept but ignored by the gate. Continue?")) return;
    setBusy("policy");
    const { error } = await supabase.from("projects").update({ evidence_policy: next }).eq("id", projectId);
    setBusy("");
    if (error) { notify(error.message); return; }
    setPolicy(next); notify(next === "ci_only" ? "Only trusted CI evidence now counts." : "Manual and CI evidence both count."); onChanged();
  }

  async function generate() {
    if (!supabase) return;
    if (status?.github?.configured && !window.confirm("This replaces the current webhook secret. You will need to update it in GitHub. Continue?")) return;
    const value = newSecret();
    setBusy("secret");
    const { error } = await supabase.rpc("set_integration_secret", { p_project_id: projectId, p_provider: "github", p_secret: value });
    setBusy("");
    if (error) { notify(error.message); return; }
    setSecret(value); await load();
  }

  async function addRepository(form: FormData) {
    if (!supabase) return;
    const name = String(form.get("name") ?? "").trim(); const remote = String(form.get("remote") ?? "").trim();
    if (!name || !/github\.com[:/][\w.-]+\/[\w.-]+/i.test(remote)) { notify("Enter a name and a GitHub repository URL such as https://github.com/owner/repo."); return; }
    const { error } = await supabase.from("repositories").insert({ project_id: projectId, name, provider: "github", remote_url: remote, created_by: userId });
    if (error) notify(error.message); else { notify("Repository linked."); await load(); }
  }

  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => notify("Copied."));

  return <section className="panel full-panel evidence-section">
    <div className="panel-heading"><div><div className="section-kicker"><ShieldCheck size={11}/> TRUSTED EVIDENCE</div><h2>Results people cannot type in</h2>
      <p>CI results arrive from GitHub, signed with a secret only your project knows, and are recorded as system evidence. Choose whether manual results still count.</p></div></div>

    <div className="evidence-inline-form">
      <span className="evidence-pill ok">Policy</span>
      <select value={policy} disabled={!isOwner || busy === "policy"} onChange={(event) => void changePolicy(event.target.value as "any" | "ci_only")} aria-label="Evidence policy">
        <option value="any">Manual, local and CI results count</option><option value="ci_only">Only CI results count (strict)</option></select>
      {!isOwner && <span className="evidence-footnote">Only owners change the policy.</span>}
    </div>

    <div className="links-panel"><div className="section-kicker"><KeyRound size={11}/> GITHUB ACTIONS</div>
      <p className="evidence-footnote">{status?.github?.configured ? "Connected since " + new Date(status.github.updated_at).toLocaleDateString() + ". Link results to a task by putting its reference in the branch name, e.g. feature/ct-3f9a1c2b-detector." : "Not connected yet."}</p>
      <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void addRepository(new FormData(form)).then(() => form.reset()); }}>
        <input name="name" placeholder="Name, e.g. robot-vision" maxLength={80} style={{ maxWidth: 170 }}/><input name="remote" placeholder="https://github.com/owner/repo"/><button className="button secondary small">Link repository</button></form>
      {status?.repositories.map((repository) => <div className="evidence-footnote" key={repository.id}>• {repository.name} — {repository.remote_url}</div>)}
      {isOwner && <div className="evidence-actions"><button className="button primary small" disabled={busy === "secret" || !status?.repositories.length} title={status?.repositories.length ? "" : "Link a repository first"} onClick={() => void generate()}>{status?.github?.configured ? "Rotate webhook secret" : "Generate webhook secret"}</button></div>}
      {secret && <div className="evidence-detail">
        <strong>Copy these into GitHub → Settings → Webhooks → Add webhook. The secret is shown once.</strong>
        <label className="evidence-label">Payload URL<input readOnly value={hookUrl} onFocus={(event) => event.currentTarget.select()}/></label>
        <label className="evidence-label">Secret<input readOnly value={secret} onFocus={(event) => event.currentTarget.select()}/></label>
        <p className="evidence-footnote">Content type: application/json · Events: “Workflow runs” and “Workflow jobs”. Name a test’s CI check exactly like the workflow job to attach results to it.</p>
        <div className="evidence-actions"><button className="button secondary small" onClick={() => copy(hookUrl)}>Copy URL</button><button className="button secondary small" onClick={() => copy(secret)}>Copy secret</button></div></div>}
    </div>

    <div className="section-kicker">RECENT CI RESULTS</div>
    {runs.length ? runs.map((run) => <div className="evidence-task" key={run.id}><div className="evidence-task-head">
      <div className="protected-copy"><strong>{run.summary ?? "CI run"}</strong><span>{new Date(run.created_at).toLocaleString()}{run.commit_sha ? " · " + run.commit_sha.slice(0, 8) : ""}{run.task_id ? "" : " · not linked to a task"}</span></div>
      <span className={"evidence-pill " + (run.result === "passed" ? "ok" : run.result === "failed" || run.result === "error" ? "warn" : "")}>{run.result}</span>
      {run.url && <a className="text-action" href={run.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={12}/> Open</a>}</div></div>)
      : <p className="evidence-empty">No CI results yet. After connecting, push a branch named like ct-&lt;task reference&gt;.</p>}
  </section>;
}
