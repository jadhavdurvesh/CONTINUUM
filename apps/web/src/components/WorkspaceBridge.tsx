import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, FileDiff, FlaskConical, Play, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useStable } from "../lib/hooks";
import { workerCall } from "../lib/worker";

type Task = { id: string; title: string; status: string };
type Session = { id: string; title: string; goal: string; status: string; current_agent: string; focus_paths: string[]; task_id: string | null; last_error: string | null; created_at: string };
type ContextPreview = { files: { path: string; bytes: number }[]; total_bytes: number; limit_bytes: number; using_defaults: boolean; skipped: string[]; note: string };
type FilePreview = { path: string; status: "new" | "modified" | "unchanged"; additions: number; deletions: number; bytes: number; base_hash: string | null; diff: string; diff_truncated: boolean; blocked: string | null };
type RunResult = { exit_code: number; output: string; truncated: boolean };
type Completion = { ready: boolean; blockers: string[]; required_cases: { id: string; name: string; latest_result: string }[] };
type Props = { projectId: string; userId: string; accessToken: string; onNotify: (message: string) => void; onChanged: () => void; onOpenEvidence: () => void };

const COMMANDS: string[][] = [["npm", "test"], ["npm", "run", "build"], ["npm", "run", "typecheck"], ["pytest", "-q"], ["python", "-m", "pytest"]];
const ROLES = ["planner", "coder", "reviewer", "qa"];
const kb = (bytes: number) => (bytes / 1024).toFixed(1) + " KB";

export default function WorkspaceBridge({ projectId, userId, accessToken, onNotify, onChanged, onOpenEvidence }: Props) {
  const notify = useStable(onNotify);
  const ctx = useMemo(() => ({ projectId, accessToken }), [projectId, accessToken]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [taskId, setTaskId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [paths, setPaths] = useState("");
  const [context, setContext] = useState<ContextPreview | null>(null);
  const [files, setFiles] = useState<FilePreview[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openDiff, setOpenDiff] = useState("");
  const [busy, setBusy] = useState("");
  const [applied, setApplied] = useState<string[]>([]);
  const [run, setRun] = useState<{ command: string[]; result: RunResult; durationMs: number; startedAt: string } | null>(null);
  const [caseId, setCaseId] = useState("");
  const [completion, setCompletion] = useState<Completion | null>(null);

  const session = sessions.find((item) => item.id === sessionId) ?? null;
  const task = tasks.find((item) => item.id === taskId) ?? null;
  const taskSessions = sessions.filter((item) => item.task_id === taskId);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [taskResult, sessionResult] = await Promise.all([
      supabase.from("tasks").select("id,title,status").eq("project_id", projectId).neq("status", "done").order("updated_at", { ascending: false }).limit(200),
      supabase.from("agent_sessions").select("id,title,goal,status,current_agent,focus_paths,task_id,last_error,created_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(100)
    ]);
    const error = taskResult.error ?? sessionResult.error;
    if (error) notify(error.message);
    setTasks((taskResult.data as Task[] | null) ?? []); setSessions((sessionResult.data as Session[] | null) ?? []);
  }, [projectId, notify]);
  useEffect(() => { void load(); }, [load]);

  const loadCompletion = useCallback(async () => {
    if (!supabase || !taskId) { setCompletion(null); return; }
    const { data } = await supabase.rpc("task_completion_status", { p_task_id: taskId });
    setCompletion((data as Completion | null) ?? null);
  }, [taskId]);
  useEffect(() => { void loadCompletion(); }, [loadCompletion]);

  useEffect(() => { setPaths((session?.focus_paths ?? []).join("\n")); setContext(null); setFiles(null); setApplied([]); }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function guarded(label: string, action: () => Promise<void>) {
    setBusy(label);
    try { await action(); } catch (error) { notify(error instanceof Error ? error.message : "Something went wrong."); }
    finally { setBusy(""); }
  }

  const parsedPaths = () => paths.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 12);

  const createSession = (form: FormData) => guarded("create", async () => {
    if (!supabase || !task) return;
    const goal = String(form.get("goal") ?? "").trim();
    if (goal.length < 10) throw new Error("Describe the goal in at least a sentence.");
    const { data, error } = await supabase.from("agent_sessions").insert({
      project_id: projectId, task_id: task.id, title: task.title.slice(0, 120), goal, current_agent: String(form.get("role") ?? "coder"),
      status: "queued", focus_paths: parsedPaths(), requested_by: userId
    }).select("id").single();
    if (error) throw new Error(error.message);
    await load(); setSessionId((data as { id: string }).id); notify("Agent session created.");
  });

  const savePaths = () => guarded("paths", async () => {
    if (!supabase || !session) return;
    const { error } = await supabase.from("agent_sessions").update({ focus_paths: parsedPaths() }).eq("id", session.id);
    if (error) throw new Error(error.message);
    await load(); setContext(null); notify("Context selection saved.");
  });

  const previewContext = () => guarded("context", async () => {
    if (!session) return;
    setContext(await workerCall<ContextPreview>("/api/worker/agents/context", ctx, { body: { project_id: projectId, session_id: session.id } }));
  });

  const runStep = () => guarded("step", async () => {
    if (!session) return;
    await workerCall("/api/worker/agents/run-step", ctx, { body: { project_id: projectId, session_id: session.id } });
    await load(); setFiles(null); setApplied([]); notify("Agent step finished. Review the proposal before anything is written.");
  });

  const reviewProposal = () => guarded("review", async () => {
    if (!session) return;
    const data = await workerCall<{ files: FilePreview[] }>("/api/worker/agents/preview", ctx, { body: { project_id: projectId, session_id: session.id } });
    setFiles(data.files);
    setSelected(new Set(data.files.filter((file) => !file.blocked && file.status !== "unchanged").map((file) => file.path)));
  });

  const applySelected = () => guarded("apply", async () => {
    if (!session || !files) return;
    const chosen = files.filter((file) => selected.has(file.path));
    if (!chosen.length) throw new Error("Select at least one file to apply.");
    const base_hashes = Object.fromEntries(chosen.map((file) => [file.path, file.base_hash]));
    const result = await workerCall<{ applied: string[] }>("/api/worker/agents/apply-proposal", ctx, { body: { project_id: projectId, session_id: session.id, paths: chosen.map((file) => file.path), base_hashes } });
    setApplied(result.applied); setFiles(null); await load(); notify("Applied " + result.applied.length + " file(s). Changes are uncommitted: run the checks next.");
  });

  const runChecks = (command: string[]) => guarded("run", async () => {
    const startedAt = new Date().toISOString(); const t0 = performance.now();
    const result = await workerCall<RunResult>("/api/worker/run", ctx, { body: { command } });
    setRun({ command, result, durationMs: Math.round(performance.now() - t0), startedAt });
  });

  const recordEvidence = () => guarded("evidence", async () => {
    if (!supabase || !run || !task) return;
    let head: { sha: string | null; dirty: boolean } = { sha: null, dirty: false };
    try { head = await workerCall<{ sha: string | null; dirty: boolean }>("/api/worker/git/head", ctx); } catch { /* evidence is still useful without a SHA */ }
    const passed = run.result.exit_code === 0;
    const { error } = await supabase.from("test_runs").insert({
      project_id: projectId, task_id: task.id, test_case_id: caseId || null, result: passed ? "passed" : "failed", environment: "local-worker",
      commit_sha: head.sha, duration_ms: run.durationMs, started_at: run.startedAt, finished_at: new Date().toISOString(),
      summary: run.command.join(" ") + " → exit " + run.result.exit_code + (head.dirty ? " (uncommitted changes in the checkout)" : ""),
      log_text: run.result.output.slice(-8000), executed_by: userId, actor_type: "human"
    });
    if (error) throw new Error(error.message);
    notify("Recorded as " + (passed ? "passing" : "failing") + " evidence on “" + task.title + "”.");
    await loadCompletion(); onChanged();
  });

  const toggle = (path: string) => setSelected((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const awaitingReview = session?.status === "needs_review";

  return <div className="evidence-board">
    <section className="panel full-panel">
      <div className="panel-heading"><div><div className="section-kicker">WORKSPACE BRIDGE</div><h2>Agent work on your real checkout</h2>
        <p>Nothing leaves your PC until you have seen exactly what is sent, and nothing is written until you have reviewed the diff. The result is recorded as evidence on the task.</p></div>
        <button className="button secondary small" onClick={() => void load()}><RefreshCw size={13}/> Refresh</button></div>
      <ol className="bridge-steps"><li className={taskId ? "done" : "now"}>1 · Task</li><li className={context ? "done" : session ? "now" : ""}>2 · Context</li><li className={awaitingReview || applied.length ? "done" : session ? "now" : ""}>3 · Agent step</li><li className={applied.length ? "done" : awaitingReview ? "now" : ""}>4 · Review & apply</li><li className={run ? "done" : applied.length ? "now" : ""}>5 · Verify</li><li className={completion?.ready ? "done" : ""}>6 · Evidence</li></ol>
    </section>

    <section className="panel full-panel evidence-section">
      <div className="section-kicker">1 · CHOOSE THE TASK</div>
      <label className="evidence-label">Task<select value={taskId} onChange={(event) => { setTaskId(event.target.value); setSessionId(""); setRun(null); }}><option value="">Select an open task…</option>{tasks.map((item) => <option key={item.id} value={item.id}>{item.title} ({item.status.replace("_", " ")})</option>)}</select></label>
      {task && <>
        {taskSessions.length > 0 && <label className="evidence-label">Existing agent sessions<select value={sessionId} onChange={(event) => setSessionId(event.target.value)}><option value="">New session…</option>{taskSessions.map((item) => <option key={item.id} value={item.id}>{item.current_agent} · {item.status.replace("_", " ")} · {new Date(item.created_at).toLocaleString()}</option>)}</select></label>}
        {!sessionId && <form className="decision-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void createSession(new FormData(form)); }}>
          <textarea name="goal" rows={2} placeholder="What should the agent do for this task?"/>
          <select name="role" defaultValue="coder" className="bridge-select">{ROLES.map((role) => <option key={role} value={role}>{role}</option>)}</select>
          <textarea value={paths} onChange={(event) => setPaths(event.target.value)} rows={3} placeholder={"Files to share as context, one per line (max 12), e.g.\nsrc/detector.py\ntests/test_detector.py"}/>
          <button className="button primary small" disabled={busy === "create"}>Create session</button></form>}
      </>}
    </section>

    {session && <>
      <section className="panel full-panel evidence-section">
        <div className="section-kicker"><ShieldCheck size={11}/> 2 · WHAT WILL BE SENT</div>
        <p className="evidence-footnote">Goal: {session.goal}</p>
        {session.status === "queued" && <><textarea className="md-editor short" value={paths} onChange={(event) => setPaths(event.target.value)} placeholder="One path per line. Leave empty to use the project defaults." aria-label="Context files"/>
          <div className="evidence-actions"><button className="button secondary small" onClick={() => void savePaths()} disabled={busy === "paths"}>Save selection</button></div></>}
        <div className="evidence-actions"><button className="button secondary small" onClick={() => void previewContext()} disabled={busy === "context"}>Preview what will be sent</button></div>
        {context && <div className="evidence-detail">
          {context.files.length ? <ul className="links-list">{context.files.map((file) => <li key={file.path}><span className="evidence-pill ok">sent</span><strong>{file.path}</strong><span>{kb(file.bytes)}</span></li>)}</ul> : <p className="evidence-empty">No readable files are selected, so the agent would only see your goal.</p>}
          <p className="evidence-footnote">{kb(context.total_bytes)} of {kb(context.limit_bytes)} budget{context.using_defaults ? " · using project defaults" : ""}. {context.note}</p>
          {context.skipped.length > 0 && <p className="evidence-footnote">Not sent: {context.skipped.join(", ")}</p>}</div>}
      </section>

      <section className="panel full-panel evidence-section">
        <div className="section-kicker"><Zap size={11}/> 3 · RUN ONE AGENT STEP</div>
        <p className="evidence-footnote">Status: {session.status.replace("_", " ")} · role: {session.current_agent}{session.last_error ? " · last error: " + session.last_error : ""}</p>
        <div className="evidence-actions"><button className="button primary small" disabled={session.status !== "queued" || busy === "step"} onClick={() => void runStep()}><Play size={13}/> {busy === "step" ? "Running…" : "Run agent step"}</button></div>
      </section>

      <section className="panel full-panel evidence-section">
        <div className="section-kicker"><FileDiff size={11}/> 4 · REVIEW THE DIFF, THEN APPLY</div>
        {awaitingReview ? <div className="evidence-actions"><button className="button secondary small" onClick={() => void reviewProposal()} disabled={busy === "review"}>Load diff against my checkout</button></div> : <p className="evidence-empty">A proposal appears here after the agent step finishes.</p>}
        {files && files.map((file) => <div className="evidence-task" key={file.path}>
          <div className="evidence-task-head">
            <label className="pm-check"><input type="checkbox" disabled={!!file.blocked || file.status === "unchanged"} checked={selected.has(file.path)} onChange={() => toggle(file.path)}/></label>
            <div className="protected-copy"><strong>{file.path}</strong><span>{file.blocked ? "blocked: " + file.blocked : file.status + " · +" + file.additions + " −" + file.deletions + " · " + kb(file.bytes)}</span></div>
            <span className={"evidence-pill " + (file.blocked ? "warn" : file.status === "unchanged" ? "" : "ok")}>{file.blocked ? "blocked" : file.status}</span>
            {!file.blocked && file.status !== "unchanged" && <button className="button secondary small" onClick={() => setOpenDiff(openDiff === file.path ? "" : file.path)}>{openDiff === file.path ? "Hide" : "Diff"}</button>}
          </div>
          {openDiff === file.path && <pre className="diff-view">{file.diff.split("\n").map((line, index) => <div key={index} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : line.startsWith("@@") ? "diff-hunk" : ""}>{line || " "}</div>)}{file.diff_truncated && <div className="diff-hunk">… diff truncated</div>}</pre>}
        </div>)}
        {files && <div className="evidence-actions"><button className="button primary small" disabled={!selected.size || busy === "apply"} onClick={() => void applySelected()}>Apply {selected.size} selected file(s)</button>
          <span className="evidence-footnote">If a file changes on disk after this review, the worker refuses to overwrite it.</span></div>}
        {applied.length > 0 && <p className="evidence-ok"><CheckCircle2 size={12}/> Applied: {applied.join(", ")} (uncommitted)</p>}
      </section>

      <section className="panel full-panel evidence-section">
        <div className="section-kicker"><FlaskConical size={11}/> 5 · VERIFY LOCALLY</div>
        <div className="evidence-actions">{COMMANDS.map((command) => <button key={command.join(" ")} className="button secondary small" disabled={busy === "run"} onClick={() => void runChecks(command)}>{command.join(" ")}</button>)}</div>
        {run && <>
          <div className="pm-version-banner">{run.command.join(" ")} → exit {run.result.exit_code} · {(run.durationMs / 1000).toFixed(1)}s <span className={"evidence-pill " + (run.result.exit_code === 0 ? "ok" : "warn")}>{run.result.exit_code === 0 ? "passed" : "failed"}</span></div>
          <pre className="diff-view">{run.result.output || "(no output)"}</pre>
          <div className="evidence-inline-form">
            <select value={caseId} onChange={(event) => setCaseId(event.target.value)} aria-label="Test case"><option value="">Whole task</option>{(completion?.required_cases ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <button className="button primary small" disabled={busy === "evidence"} onClick={() => void recordEvidence()}>Record as evidence on this task</button></div>
        </>}
      </section>
    </>}

    {task && completion && <section className="panel full-panel evidence-section">
      <div className="section-kicker">6 · WHERE THIS TASK STANDS</div>
      {completion.ready ? <p className="evidence-ok"><CheckCircle2 size={12}/> Every completion criterion is met. Finish it on the Evidence page.</p> : <ul className="evidence-blockers">{completion.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
      <div className="evidence-actions"><button className="button secondary small" onClick={onOpenEvidence}>Open Evidence page</button></div>
    </section>}
  </div>;
}
