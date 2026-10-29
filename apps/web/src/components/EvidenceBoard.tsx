import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ClipboardCheck, FlaskConical, Link2, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useStable } from "../lib/hooks";

type Health = {
  tasks: { total: number; done: number; done_with_evidence: number; done_waived: number; done_without_requirement: number; blocked: number; in_review: number };
  requirements: { total: number; verified: number };
  required_tests: { total: number; passing: number; failing: number; not_run: number };
};
type Completion = {
  task_id: string; status: string; requires_evidence: boolean; ready: boolean; blockers: string[];
  required_cases: { id: string; name: string; latest_result: string }[];
  last_test_at: string | null;
  latest_review: { decision: string; reviewer_id: string; created_at: string; notes: string | null } | null;
};
type TaskLite = { id: string; title: string; status: string; requirement_id: string | null; assigned_to: string | null; completion_waiver: string | null };
type Requirement = { id: string; key: string | null; title: string; status: string };
type Props = { projectId: string; userId: string; isOwner: boolean; onNotify: (message: string) => void; onChanged: () => void };

const resultLabel: Record<string, string> = { passed: "Passed", failed: "Failed", error: "Error", skipped: "Skipped", not_run: "Not run" };

export default function EvidenceBoard({ projectId, userId, isOwner, onNotify, onChanged }: Props) {
  const [health, setHealth] = useState<Health | null>(null);
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [completion, setCompletion] = useState<Record<string, Completion>>({});
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState("");
  const [loading, setLoading] = useState(true);
  const notify = useStable(onNotify);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [healthResult, completionResult, taskResult, requirementResult] = await Promise.all([
      supabase.rpc("project_health", { p_project_id: projectId }),
      supabase.rpc("project_task_completion", { p_project_id: projectId }),
      supabase.from("tasks").select("id,title,status,requirement_id,assigned_to,completion_waiver").eq("project_id", projectId).order("updated_at", { ascending: false }).limit(200),
      supabase.from("requirements").select("id,key,title,status").eq("project_id", projectId).order("created_at", { ascending: true }).limit(200)
    ]);
    const firstError = healthResult.error ?? completionResult.error ?? taskResult.error ?? requirementResult.error;
    if (firstError) notify(firstError.message);
    setHealth((healthResult.data as Health | null) ?? null);
    const byTask: Record<string, Completion> = {};
    for (const item of ((completionResult.data as Completion[] | null) ?? [])) if (item) byTask[item.task_id] = item;
    setCompletion(byTask);
    setTasks((taskResult.data as TaskLite[] | null) ?? []);
    setRequirements((requirementResult.data as Requirement[] | null) ?? []);
    setLoading(false);
  }, [projectId, notify]);

  useEffect(() => { void load(); }, [load]);

  async function run(label: string, action: () => PromiseLike<{ error: { message: string } | null }>, success: string) {
    setBusy(label);
    const { error } = await action();
    setBusy("");
    if (error) { onNotify(error.message); return; }
    onNotify(success);
    await load();
    onChanged();
  }

  const recordRun = (task: TaskLite, form: FormData) => run("run-" + task.id, () => supabase!.from("test_runs").insert({
    project_id: projectId, task_id: task.id, test_case_id: String(form.get("case") ?? "") || null,
    result: String(form.get("result") ?? "passed"), summary: String(form.get("summary") ?? "").trim() || null,
    environment: "manual", executed_by: userId, actor_type: "human"
  }), "Test result recorded as evidence.");

  const recordReview = (task: TaskLite, decision: "approved" | "changes_requested", form: FormData) => run("review-" + task.id, () => supabase!.from("task_reviews").insert({
    project_id: projectId, task_id: task.id, decision, reviewer_id: userId, reviewer_type: "human",
    notes: String(form.get("notes") ?? "").trim() || null
  }), decision === "approved" ? "Approval recorded." : "Changes requested.");

  const addCase = (task: TaskLite, form: FormData) => {
    const name = String(form.get("case_name") ?? "").trim();
    if (name.length < 2) { onNotify("Name the required test (2+ characters)."); return Promise.resolve(); }
    return run("case-" + task.id, () => supabase!.from("test_cases").insert({
      project_id: projectId, task_id: task.id, requirement_id: task.requirement_id, name, created_by: userId
    }), "Required test added.");
  };

  const complete = (task: TaskLite) => run("done-" + task.id, () => supabase!.from("tasks").update({ status: "done", updated_by: userId }).eq("id", task.id), "Task completed with evidence.");
  const waive = (task: TaskLite) => {
    const reason = window.prompt("Why is this task being completed without evidence? (recorded in the audit trail)");
    if (!reason || reason.trim().length < 5) return Promise.resolve();
    return run("waive-" + task.id, () => supabase!.from("tasks").update({ status: "done", completion_waiver: reason.trim(), updated_by: userId }).eq("id", task.id), "Completed with an owner waiver.");
  };
  const link = (task: TaskLite, requirementId: string) => run("link-" + task.id, () => supabase!.from("tasks").update({ requirement_id: requirementId || null, updated_by: userId }).eq("id", task.id), "Requirement link updated.");
  const verify = (requirement: Requirement) => run("verify-" + requirement.id, () => supabase!.from("requirements").update({ status: "verified" }).eq("id", requirement.id), "Requirement verified.");
  const addRequirement = (form: FormData) => {
    const title = String(form.get("title") ?? "").trim();
    if (title.length < 2) { onNotify("Give the requirement a title."); return Promise.resolve(); }
    return run("req", () => supabase!.from("requirements").insert({ project_id: projectId, title, status: "approved", created_by: userId }), "Requirement added.");
  };

  const evidenceTasks = tasks.filter((task) => task.status !== "done");
  const doneTasks = tasks.filter((task) => task.status === "done");
  const taskCount = health?.tasks.total ?? 0;
  const verifiedPct = taskCount ? Math.round(((health?.tasks.done_with_evidence ?? 0) / taskCount) * 100) : 0;

  return <div className="evidence-board">
    <section className="panel full-panel">
      <div className="panel-heading">
        <div><div className="section-kicker">EVIDENCE-BASED PROGRESS</div><h2>Command center</h2><p>Progress counts only work that has passing tests and an independent human review.</p></div>
        <button className="button secondary small" onClick={() => void load()} disabled={loading}><RefreshCw size={13}/> Refresh</button>
      </div>
      {health ? <div className="metric-grid evidence-metrics">
        <div className="metric-card"><div className="metric-head"><span>Verified done</span><ShieldCheck size={15}/></div><div className="metric-value">{health.tasks.done_with_evidence}<small>/{health.tasks.total}</small></div><div className="metric-note">{verifiedPct}% of all tasks have evidence</div><div className="metric-progress"><span style={{ width: verifiedPct + "%" }}/></div></div>
        <div className="metric-card"><div className="metric-head"><span>Required tests</span><FlaskConical size={15}/></div><div className="metric-value">{health.required_tests.passing}<small>/{health.required_tests.total}</small></div><div className="metric-note">{health.required_tests.failing} failing · {health.required_tests.not_run} not run</div></div>
        <div className="metric-card"><div className="metric-head"><span>Requirements verified</span><ClipboardCheck size={15}/></div><div className="metric-value">{health.requirements.verified}<small>/{health.requirements.total}</small></div><div className="metric-note">Needs linked tasks done + required tests green</div></div>
        <div className="metric-card"><div className="metric-head"><span>Done without evidence</span><TriangleAlert size={15}/></div><div className="metric-value">{health.tasks.done_waived + health.tasks.done_without_requirement}</div><div className="metric-note">{health.tasks.done_waived} owner waivers · {health.tasks.done_without_requirement} legacy</div></div>
      </div> : <p className="evidence-empty">{loading ? "Loading project health…" : "Project health is unavailable. Apply migration 202610220001 to your Supabase project."}</p>}
    </section>

    <section className="panel full-panel evidence-section">
      <div className="panel-heading"><div><div className="section-kicker">REQUIREMENTS</div><h2>Traceability</h2><p>Requirement → task → tests → review → completion.</p></div></div>
      <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void addRequirement(new FormData(form)).then(() => form.reset()); }}>
        <input name="title" placeholder="New requirement, e.g. Detect the target object at 30 fps" maxLength={180}/>
        <button className="button primary small" disabled={busy === "req"}>Add requirement</button>
      </form>
      {requirements.length ? requirements.map((requirement) => {
        const linked = tasks.filter((task) => task.requirement_id === requirement.id);
        const allDone = linked.length > 0 && linked.every((task) => task.status === "done");
        return <div className="protected-row" key={requirement.id}>
          <div className="protected-icon evidence-icon"><ClipboardCheck size={16}/></div>
          <div className="protected-copy"><strong>{requirement.key ? requirement.key + " · " : ""}{requirement.title}</strong><span>{requirement.status} · {linked.length} linked task(s){linked.length ? " · " + linked.filter((task) => task.status === "done").length + " done" : ""}</span></div>
          {requirement.status !== "verified" && <button className="button secondary small" disabled={!allDone || busy === "verify-" + requirement.id} title={allDone ? "The database re-checks tasks and required tests" : "Link tasks and complete them first"} onClick={() => void verify(requirement)}>Verify</button>}
          {requirement.status === "verified" && <span className="evidence-pill ok">Verified</span>}
        </div>;
      }) : <p className="evidence-empty">No requirements yet. Add the first one above, then link tasks to it.</p>}
    </section>

    <section className="panel full-panel evidence-section">
      <div className="panel-heading"><div><div className="section-kicker">OPEN WORK</div><h2>Completion readiness</h2><p>The database refuses “Done” until every blocker below is cleared.</p></div></div>
      {evidenceTasks.length ? evidenceTasks.map((task) => {
        const info = completion[task.id];
        const expanded = open === task.id;
        return <div className="evidence-task" key={task.id}>
          <div className="evidence-task-head">
            <div className="protected-copy"><strong>{task.title}</strong>
              <span>{task.status.replace("_", " ")}{info?.latest_review ? " · last review: " + info.latest_review.decision.replace("_", " ") : ""}</span></div>
            {info?.ready ? <span className="evidence-pill ok"><CheckCircle2 size={12}/> Ready</span> : <span className="evidence-pill warn">{info?.blockers?.length ?? 0} blocker(s)</span>}
            <button className="button secondary small" onClick={() => setOpen(expanded ? "" : task.id)}>{expanded ? "Close" : "Evidence"}</button>
          </div>
          {expanded && <div className="evidence-detail">
            {info?.blockers?.length ? <ul className="evidence-blockers">{info.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : <p className="evidence-ok">All completion criteria are met.</p>}
            {!!info?.required_cases?.length && <div className="evidence-cases">{info.required_cases.map((testCase) => <span key={testCase.id} className={"evidence-pill " + (testCase.latest_result === "passed" ? "ok" : "warn")}>{testCase.name}: {resultLabel[testCase.latest_result] ?? testCase.latest_result}</span>)}</div>}
            <label className="evidence-label">Requirement
              <select value={task.requirement_id ?? ""} onChange={(event) => void link(task, event.target.value)}><option value="">— not linked —</option>{requirements.map((requirement) => <option key={requirement.id} value={requirement.id}>{requirement.title}</option>)}</select></label>
            <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void addCase(task, new FormData(form)).then(() => form.reset()); }}>
              <input name="case_name" placeholder="Add a required test, e.g. detects a cup in low light" maxLength={180}/><button className="button secondary small" disabled={busy === "case-" + task.id}>Add required test</button></form>
            <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void recordRun(task, new FormData(form)).then(() => form.reset()); }}>
              <select name="result" defaultValue="passed"><option value="passed">Passed</option><option value="failed">Failed</option><option value="error">Error</option></select>
              <select name="case" defaultValue=""><option value="">Whole task</option>{(info?.required_cases ?? []).map((testCase) => <option key={testCase.id} value={testCase.id}>{testCase.name}</option>)}</select>
              <input name="summary" placeholder="What was run and what happened" maxLength={500}/><button className="button secondary small" disabled={busy === "run-" + task.id}>Record test result</button></form>
            <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null; void recordReview(task, submitter?.value === "changes_requested" ? "changes_requested" : "approved", new FormData(event.currentTarget)); }}>
              <input name="notes" placeholder="Review notes (what you inspected)" maxLength={2000}/>
              <button className="button primary small" value="approved" disabled={busy === "review-" + task.id}>Approve</button>
              <button className="button secondary small" value="changes_requested" disabled={busy === "review-" + task.id}>Request changes</button></form>
            <div className="evidence-actions">
              <button className="button primary small" disabled={!info?.ready || busy === "done-" + task.id} onClick={() => void complete(task)}>Complete task</button>
              {isOwner && <button className="button secondary small" onClick={() => void waive(task)}><Link2 size={12}/> Complete with owner waiver…</button>}
            </div>
          </div>}
        </div>;
      }) : <p className="evidence-empty">No open tasks. Create work on the Tasks page.</p>}
      {doneTasks.length > 0 && <p className="evidence-footnote">{doneTasks.length} completed task(s) · {doneTasks.filter((task) => task.completion_waiver).length} with owner waivers.</p>}
    </section>
  </div>;
}
