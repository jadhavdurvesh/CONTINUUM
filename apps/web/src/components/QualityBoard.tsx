import { useCallback, useEffect, useMemo, useState } from "react";
import { Bug, FlaskConical, RefreshCw, ShieldAlert } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useStable } from "../lib/hooks";
import LinksPanel from "./LinksPanel";

type TestCase = { id: string; name: string; test_kind: string; is_required: boolean; requirement_id: string | null; task_id: string | null };
type Run = { test_case_id: string | null; result: string; created_at: string };
type Issue = { id: string; title: string; description: string | null; issue_type: string; severity: string; status: string; task_id: string | null; assigned_to: string | null; created_at: string };
type Ref = { id: string; title: string };
type Member = { user_id: string; display_name: string };
type Props = { projectId: string; userId: string; isOwner: boolean; members: Member[]; onNotify: (message: string) => void; onChanged: () => void };

const KINDS = ["automated", "manual", "integration", "acceptance", "security", "performance"];
const ISSUE_TYPES = ["bug", "risk", "blocker", "question", "change"];
const SEVERITIES = ["low", "normal", "high", "critical"];
const ISSUE_STATUS = ["open", "in_progress", "resolved", "closed", "accepted_risk"];

export default function QualityBoard({ projectId, userId, isOwner, members, onNotify, onChanged }: Props) {
  const notify = useStable(onNotify);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [requirements, setRequirements] = useState<Ref[]>([]);
  const [tasks, setTasks] = useState<Ref[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [openIssue, setOpenIssue] = useState("");

  const load = useCallback(async () => {
    if (!supabase) return;
    const [caseResult, runResult, issueResult, reqResult, taskResult] = await Promise.all([
      supabase.from("test_cases").select("id,name,test_kind,is_required,requirement_id,task_id").eq("project_id", projectId).order("created_at", { ascending: false }).limit(300),
      supabase.from("test_runs").select("test_case_id,result,created_at").eq("project_id", projectId).not("test_case_id", "is", null).order("created_at", { ascending: false }).limit(1500),
      supabase.from("issues").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(300),
      supabase.from("requirements").select("id,title").eq("project_id", projectId).limit(300),
      supabase.from("tasks").select("id,title").eq("project_id", projectId).order("created_at", { ascending: false }).limit(300)
    ]);
    const error = caseResult.error ?? runResult.error ?? issueResult.error ?? reqResult.error ?? taskResult.error;
    if (error) notify(error.message);
    setCases((caseResult.data as TestCase[] | null) ?? []); setRuns((runResult.data as Run[] | null) ?? []);
    setIssues((issueResult.data as Issue[] | null) ?? []); setRequirements((reqResult.data as Ref[] | null) ?? []); setTasks((taskResult.data as Ref[] | null) ?? []);
  }, [projectId, notify]);
  useEffect(() => { void load(); }, [load]);

  async function run(action: PromiseLike<{ error: { message: string } | null }>, success: string) {
    const { error } = await action;
    if (error) { notify(error.message); return; }
    notify(success); await load(); onChanged();
  }

  const latest = useMemo(() => { const map = new Map<string, string>(); for (const item of runs) if (item.test_case_id && !map.has(item.test_case_id)) map.set(item.test_case_id, item.result); return map; }, [runs]);
  const runCount = useMemo(() => { const map = new Map<string, number>(); for (const item of runs) if (item.test_case_id) map.set(item.test_case_id, (map.get(item.test_case_id) ?? 0) + 1); return map; }, [runs]);
  const required = cases.filter((testCase) => testCase.is_required);
  const passing = required.filter((testCase) => latest.get(testCase.id) === "passed").length;
  const openIssues = issues.filter((issue) => ["open", "in_progress"].includes(issue.status));
  const serious = openIssues.filter((issue) => ["high", "critical"].includes(issue.severity) && ["bug", "blocker"].includes(issue.issue_type));
  const untested = requirements.filter((requirement) => !cases.some((testCase) => testCase.requirement_id === requirement.id && testCase.is_required));
  const taskTitle = (id: string | null) => tasks.find((task) => task.id === id)?.title;

  return <div className="evidence-board">
    <section className="panel full-panel">
      <div className="panel-heading"><div><div className="section-kicker">QUALITY</div><h2>Tests & defects</h2><p>What is verified, what is failing, and what could block a release.</p></div>
        <button className="button secondary small" onClick={() => void load()}><RefreshCw size={13}/> Refresh</button></div>
      <div className="metric-grid evidence-metrics">
        <div className="metric-card"><div className="metric-head"><span>Required tests passing</span><FlaskConical size={15}/></div><div className="metric-value">{passing}<small>/{required.length}</small></div><div className="metric-progress"><span style={{ width: (required.length ? Math.round(100 * passing / required.length) : 0) + "%" }}/></div></div>
        <div className="metric-card"><div className="metric-head"><span>Open defects & risks</span><Bug size={15}/></div><div className="metric-value">{openIssues.length}</div></div>
        <div className="metric-card"><div className="metric-head"><span>Release-blocking</span><ShieldAlert size={15}/></div><div className="metric-value">{serious.length}</div><div className="metric-note">Open high/critical bugs</div></div>
        <div className="metric-card"><div className="metric-head"><span>Requirements without tests</span><FlaskConical size={15}/></div><div className="metric-value">{untested.length}</div><div className="metric-note">Cannot be verified yet</div></div>
      </div>
      {untested.length > 0 && <div className="governance-note"><ShieldAlert size={16}/><span>No required test covers: {untested.slice(0, 5).map((requirement) => requirement.title).join(" · ")}{untested.length > 5 ? " …" : ""}</span></div>}
    </section>

    <section className="panel full-panel evidence-section">
      <div className="panel-heading"><div><div className="section-kicker">TEST CASES</div><h2>Verification</h2><p>Each result is recorded as you, immutably, and feeds the completion gate.</p></div></div>
      <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const name = String(data.get("name") ?? "").trim();
        if (name.length < 2) { notify("Name the test case."); return; }
        void run(supabase!.from("test_cases").insert({ project_id: projectId, name, test_kind: String(data.get("kind")), requirement_id: String(data.get("requirement") ?? "") || null, task_id: String(data.get("task") ?? "") || null, is_required: data.get("required") === "on", created_by: userId }), "Test case added.").then(() => form.reset()); }}>
        <input name="name" placeholder="Test case, e.g. Hover stays within 1 m in 20 km/h wind" maxLength={180}/>
        <select name="kind" defaultValue="automated">{KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select>
        <select name="requirement" defaultValue=""><option value="">Requirement…</option>{requirements.map((requirement) => <option key={requirement.id} value={requirement.id}>{requirement.title}</option>)}</select>
        <select name="task" defaultValue=""><option value="">Task…</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select>
        <label className="pm-check"><input type="checkbox" name="required" defaultChecked/> Required</label><button className="button primary small">Add test</button></form>
      {cases.length ? cases.map((testCase) => { const result = latest.get(testCase.id) ?? "not_run";
        return <div className="evidence-task" key={testCase.id}><div className="evidence-task-head">
          <div className="protected-copy"><strong>{testCase.name}</strong><span>{testCase.test_kind}{testCase.is_required ? " · required" : " · optional"}{taskTitle(testCase.task_id) ? " · " + taskTitle(testCase.task_id) : ""} · {runCount.get(testCase.id) ?? 0} run(s)</span></div>
          <span className={"evidence-pill " + (result === "passed" ? "ok" : result === "not_run" ? "" : "warn")}>{result.replace("_", " ")}</span>
          {(["passed", "failed"] as const).map((outcome) => <button key={outcome} className="button secondary small" onClick={() => void run(supabase!.from("test_runs").insert({ project_id: projectId, test_case_id: testCase.id, task_id: testCase.task_id, result: outcome, environment: "manual", executed_by: userId, actor_type: "human" }), "Recorded " + outcome + ".")}>Record {outcome}</button>)}
        </div></div>; }) : <p className="evidence-empty">No test cases yet. Define what “working” means before building it.</p>}
    </section>

    <section className="panel full-panel evidence-section">
      <div className="panel-heading"><div><div className="section-kicker">DEFECTS & RISKS</div><h2>Issue register</h2><p>Open high-severity bugs block task completion and releases. Only owners can accept a risk.</p></div>
        <label className="pm-check"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)}/> Show resolved</label></div>
      <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const title = String(data.get("title") ?? "").trim();
        if (title.length < 2) { notify("Describe the issue."); return; }
        void run(supabase!.from("issues").insert({ project_id: projectId, title, issue_type: String(data.get("type")), severity: String(data.get("severity")), task_id: String(data.get("task") ?? "") || null, assigned_to: String(data.get("assignee") ?? "") || null, created_by: userId }), "Issue logged.").then(() => form.reset()); }}>
        <input name="title" placeholder="What is wrong or at risk?" maxLength={180}/>
        <select name="type" defaultValue="bug">{ISSUE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select>
        <select name="severity" defaultValue="normal">{SEVERITIES.map((severity) => <option key={severity} value={severity}>{severity}</option>)}</select>
        <select name="task" defaultValue=""><option value="">Task…</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select>
        <select name="assignee" defaultValue=""><option value="">Assignee…</option>{members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name || member.user_id.slice(0, 8)}</option>)}</select>
        <button className="button primary small">Log issue</button></form>
      {issues.filter((issue) => showClosed || ["open", "in_progress"].includes(issue.status)).map((issue) => <div className="evidence-task" key={issue.id}>
        <div className="evidence-task-head">
          <div className="protected-copy"><strong>{issue.title}</strong><span>{issue.issue_type} · {issue.severity}{taskTitle(issue.task_id) ? " · " + taskTitle(issue.task_id) : ""} · {new Date(issue.created_at).toLocaleDateString()}</span></div>
          <span className={"evidence-pill " + (["high", "critical"].includes(issue.severity) && ["open", "in_progress"].includes(issue.status) ? "warn" : "")}>{issue.severity}</span>
          <select value={issue.status} aria-label={"Status of " + issue.title} onChange={(event) => void run(supabase!.from("issues").update({ status: event.target.value }).eq("id", issue.id), "Issue updated.")}>
            {ISSUE_STATUS.filter((status) => status !== "accepted_risk" || isOwner || issue.status === "accepted_risk").map((status) => <option key={status} value={status}>{status.replace("_", " ")}</option>)}</select>
          <button className="button secondary small" onClick={() => setOpenIssue(openIssue === issue.id ? "" : issue.id)}>{openIssue === issue.id ? "Close" : "Links"}</button></div>
        {openIssue === issue.id && <div className="evidence-detail">{issue.description && <p>{issue.description}</p>}<LinksPanel projectId={projectId} userId={userId} isOwner={isOwner} entityType="issue" entityId={issue.id} onNotify={onNotify}/></div>}
      </div>)}
      {!issues.length && <p className="evidence-empty">No issues logged. Record defects and risks here so they can block what they should.</p>}
    </section>
  </div>;
}
