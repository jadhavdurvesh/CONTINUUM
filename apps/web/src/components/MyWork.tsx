import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bug, ClipboardCheck, Gavel, RefreshCw, Zap } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useStable } from "../lib/hooks";

type MyWorkData = {
  assigned: { id: string; title: string; status: string; priority: string; due_date: string | null; overdue: boolean; waiting_on_dependency: boolean }[];
  to_review: { id: string; title: string; status: string }[];
  defects: { id: string; title: string; severity: string; issue_type: string; status: string }[];
  decisions_to_decide: { id: string; title: string }[];
  counts: { overdue: number };
};
type Props = { projectId: string; onNotify: (message: string) => void; onNavigate: (page: string) => void };

export default function MyWork({ projectId, onNotify, onNavigate }: Props) {
  const notify = useStable(onNotify);
  const [data, setData] = useState<MyWorkData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data: result, error } = await supabase.rpc("my_work", { p_project_id: projectId });
    if (error) notify(error.message);
    setData((result as MyWorkData | null) ?? null); setLoading(false);
  }, [projectId, notify]);
  useEffect(() => { void load(); }, [load]);

  const nothing = data && !data.assigned.length && !data.to_review.length && !data.defects.length && !data.decisions_to_decide.length;

  return <div className="evidence-board">
    <section className="panel full-panel">
      <div className="panel-heading"><div><div className="section-kicker">MY WORK</div><h2>What needs you</h2><p>Your tasks, the work waiting for your review, defects assigned to you{data?.decisions_to_decide.length ? ", and decisions waiting for you to decide" : ""}.</p></div>
        <button className="button secondary small" onClick={() => void load()} disabled={loading}><RefreshCw size={13}/> Refresh</button></div>
      {data && <div className="metric-grid evidence-metrics">
        <div className="metric-card"><div className="metric-head"><span>Assigned to me</span><ClipboardCheck size={15}/></div><div className="metric-value">{data.assigned.length}</div><div className="metric-note">{data.counts.overdue} overdue</div></div>
        <div className="metric-card"><div className="metric-head"><span>Waiting for my review</span><ClipboardCheck size={15}/></div><div className="metric-value">{data.to_review.length}</div></div>
        <div className="metric-card"><div className="metric-head"><span>My open defects</span><Bug size={15}/></div><div className="metric-value">{data.defects.length}</div></div>
        <div className="metric-card"><div className="metric-head"><span>Decisions to decide</span><Gavel size={15}/></div><div className="metric-value">{data.decisions_to_decide.length}</div></div>
      </div>}
      {!data && !loading && <p className="evidence-empty">Your work hub is unavailable. Apply migration 202610290001 to your Supabase project.</p>}
      {nothing && <p className="evidence-ok">You are all caught up. Nothing is waiting on you.</p>}
    </section>

    {!!data?.assigned.length && <section className="panel full-panel evidence-section">
      <div className="section-kicker">ASSIGNED TO ME</div>
      {data.assigned.map((task) => <div className="evidence-task" key={task.id}><div className="evidence-task-head">
        <div className="protected-copy"><strong>{task.title}</strong><span>{task.status.replace("_", " ")} · {task.priority}{task.due_date ? " · due " + task.due_date : ""}</span></div>
        {task.overdue && <span className="evidence-pill warn"><AlertTriangle size={11}/> Overdue</span>}
        {task.waiting_on_dependency && <span className="evidence-pill warn">Waiting on a prerequisite</span>}
        <button className="button secondary small" onClick={() => onNavigate("Workspace Bridge")}><Zap size={12}/> Work on it</button>
        <button className="button secondary small" onClick={() => onNavigate("Evidence")}>Evidence</button></div></div>)}
    </section>}

    {!!data?.to_review.length && <section className="panel full-panel evidence-section">
      <div className="section-kicker">WAITING FOR MY REVIEW</div>
      <p className="evidence-footnote">These tasks have passing tests and no review from you since the latest run.</p>
      {data.to_review.map((task) => <div className="evidence-task" key={task.id}><div className="evidence-task-head">
        <div className="protected-copy"><strong>{task.title}</strong><span>{task.status.replace("_", " ")}</span></div>
        <button className="button primary small" onClick={() => onNavigate("Evidence")}>Review</button></div></div>)}
    </section>}

    {!!data?.defects.length && <section className="panel full-panel evidence-section">
      <div className="section-kicker">MY DEFECTS</div>
      {data.defects.map((issue) => <div className="evidence-task" key={issue.id}><div className="evidence-task-head">
        <div className="protected-copy"><strong>{issue.title}</strong><span>{issue.issue_type} · {issue.status.replace("_", " ")}</span></div>
        <span className={"evidence-pill " + (["critical", "high"].includes(issue.severity) ? "warn" : "")}>{issue.severity}</span>
        <button className="button secondary small" onClick={() => onNavigate("Quality")}>Open</button></div></div>)}
    </section>}

    {!!data?.decisions_to_decide.length && <section className="panel full-panel evidence-section">
      <div className="section-kicker">DECISIONS TO DECIDE</div>
      {data.decisions_to_decide.map((decision) => <div className="evidence-task" key={decision.id}><div className="evidence-task-head">
        <div className="protected-copy"><strong>{decision.title}</strong><span>proposed</span></div>
        <button className="button primary small" onClick={() => onNavigate("Documentation")}>Decide</button></div></div>)}
    </section>}
  </div>;
}
