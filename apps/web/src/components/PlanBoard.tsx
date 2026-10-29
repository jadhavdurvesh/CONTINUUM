import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Flag, GitBranch, Layers, RefreshCw, TriangleAlert, UserX } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useStable } from "../lib/hooks";

type Plan = {
  milestones: { id: string; title: string; status: string; due_date: string | null; total: number; done: number; blocked: number; overdue: number; percent: number }[];
  workstreams: { id: string; name: string; status: string; total: number; done: number; percent: number }[];
  summary: { open_tasks: number; unassigned: number; overdue: number; blocked_by_dependency: number };
};
type PlanTask = { id: string; title: string; status: string; priority: string; due_date: string | null; assigned_to: string | null; workstream_id: string | null; milestone_id: string | null; parent_task_id: string | null };
type Dep = { task_id: string; depends_on_task_id: string };
type Member = { user_id: string; display_name: string; role: string };
type Props = { projectId: string; userId: string; members: Member[]; onNotify: (message: string) => void; onChanged: () => void };

const MILESTONE_STATUS = ["planned", "in_progress", "at_risk", "completed", "cancelled"];

function daysUntil(date: string | null): number | null {
  if (!date) return null;
  const target = new Date(date + "T00:00:00"); const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}


function Roadmap({ milestones }: { milestones: Plan["milestones"] }) {
  const dated = milestones.filter((milestone) => milestone.due_date).map((milestone) => ({ ...milestone, time: new Date(milestone.due_date + "T00:00:00").getTime() })).sort((a, b) => a.time - b.time);
  if (!dated.length) return <p className="evidence-empty">Give milestones a due date to see them on the roadmap.</p>;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = 86400000;
  const start = Math.min(today.getTime(), dated[0].time) - 7 * day;
  const end = Math.max(today.getTime(), dated[dated.length - 1].time) + 21 * day;
  const at = (time: number) => ((time - start) / (end - start)) * 100;
  return <div className="roadmap" aria-label="Roadmap timeline"><div className="roadmap-track">
    <div className="roadmap-today" style={{ left: at(today.getTime()) + "%" }}><span>today</span></div>
    {dated.map((milestone, index) => {
      const late = milestone.status !== "completed" && milestone.status !== "cancelled" && milestone.time < today.getTime();
      const risky = late || milestone.status === "at_risk" || milestone.overdue > 0;
      return <div key={milestone.id} className={"roadmap-marker " + (milestone.status === "completed" ? "ok" : risky ? "risk" : "")} style={{ left: at(milestone.time) + "%", top: (index % 3) * 38 + "px" }}>
        <span className="roadmap-dot"/><div className="roadmap-card"><strong>{milestone.title}</strong><small>{milestone.due_date} · {milestone.percent}%</small></div></div>;
    })}
  </div></div>;
}

export default function PlanBoard({ projectId, userId, members, onNotify, onChanged }: Props) {
  const notify = useStable(onNotify);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [deps, setDeps] = useState<Dep[]>([]);
  const [open, setOpen] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [planResult, taskResult] = await Promise.all([
      supabase.rpc("project_plan", { p_project_id: projectId }),
      supabase.from("tasks").select("id,title,status,priority,due_date,assigned_to,workstream_id,milestone_id,parent_task_id").eq("project_id", projectId).order("created_at", { ascending: false }).limit(300)
    ]);
    const list = (taskResult.data as PlanTask[] | null) ?? [];
    const ids = list.map((task) => task.id);
    const depResult = ids.length ? await supabase.from("task_dependencies").select("task_id,depends_on_task_id").in("task_id", ids) : { data: [], error: null };
    const error = planResult.error ?? taskResult.error ?? depResult.error;
    if (error) notify(error.message);
    setPlan((planResult.data as Plan | null) ?? null); setTasks(list); setDeps((depResult.data as Dep[] | null) ?? []); setLoading(false);
  }, [projectId, notify]);
  useEffect(() => { void load(); }, [load]);

  async function run(action: PromiseLike<{ error: { message: string } | null }>, success: string) {
    const { error } = await action;
    if (error) { notify(error.message); return; }
    notify(success); await load(); onChanged();
  }

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const memberName = (id: string | null) => !id ? "Unassigned" : (members.find((member) => member.user_id === id)?.display_name || id.slice(0, 8));
  const openDepsOf = (taskId: string) => deps.filter((dep) => dep.task_id === taskId && byId.get(dep.depends_on_task_id)?.status !== "done");
  const openTasks = tasks.filter((task) => task.status !== "done");
  const patch = (task: PlanTask, change: Record<string, unknown>, message: string) => run(supabase!.from("tasks").update({ ...change, updated_by: userId }).eq("id", task.id), message);

  return <div className="evidence-board">
    <section className="panel full-panel">
      <div className="panel-heading"><div><div className="section-kicker">DELIVERY PLAN</div><h2>Milestones & workstreams</h2><p>Progress is computed from the tasks assigned to each milestone, never typed in by hand.</p></div>
        <button className="button secondary small" onClick={() => void load()} disabled={loading}><RefreshCw size={13}/> Refresh</button></div>
      {plan && <div className="metric-grid evidence-metrics">
        <div className="metric-card"><div className="metric-head"><span>Open tasks</span><Layers size={15}/></div><div className="metric-value">{plan.summary.open_tasks}</div></div>
        <div className="metric-card"><div className="metric-head"><span>Blocked by dependencies</span><GitBranch size={15}/></div><div className="metric-value">{plan.summary.blocked_by_dependency}</div><div className="metric-note">Waiting on unfinished work</div></div>
        <div className="metric-card"><div className="metric-head"><span>Overdue</span><TriangleAlert size={15}/></div><div className="metric-value">{plan.summary.overdue}</div><div className="metric-note">Past due date, not done</div></div>
        <div className="metric-card"><div className="metric-head"><span>Unassigned</span><UserX size={15}/></div><div className="metric-value">{plan.summary.unassigned}</div><div className="metric-note">Open tasks with no owner</div></div>
      </div>}
      <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const title = String(data.get("title") ?? "").trim();
        if (title.length < 2) { notify("Give the milestone a title."); return; }
        void run(supabase!.from("milestones").insert({ project_id: projectId, title, due_date: String(data.get("due") ?? "") || null, created_by: userId, position: (plan?.milestones.length ?? 0) }), "Milestone added.").then(() => form.reset()); }}>
        <input name="title" placeholder="New milestone, e.g. Alpha flight" maxLength={180}/><input name="due" type="date" aria-label="Due date"/><button className="button primary small">Add milestone</button></form>
      {plan && <Roadmap milestones={plan.milestones}/>}
      <div className="pm-card-grid">{plan?.milestones.length ? plan.milestones.map((milestone) => {
        const days = daysUntil(milestone.due_date);
        const atRisk = milestone.status !== "completed" && milestone.status !== "cancelled" && (milestone.overdue > 0 || (days !== null && days < 0) || (days !== null && days <= 14 && milestone.percent < 50 && milestone.total > 0));
        return <div className="pm-card" key={milestone.id}>
          <div className="pm-card-head"><Flag size={14}/><strong>{milestone.title}</strong>{atRisk && <span className="evidence-pill warn">At risk</span>}</div>
          <div className="metric-progress"><span style={{ width: milestone.percent + "%" }}/></div>
          <div className="pm-card-meta"><span>{milestone.done}/{milestone.total} done · {milestone.percent}%</span>
            <span><CalendarClock size={11}/> {milestone.due_date ? (days !== null && days < 0 ? Math.abs(days) + " days late" : days === 0 ? "due today" : days + " days left") : "no date"}</span></div>
          {(milestone.blocked > 0 || milestone.overdue > 0) && <div className="pm-card-meta"><span>{milestone.blocked} blocked · {milestone.overdue} overdue</span></div>}
          <select value={milestone.status} aria-label={"Status of " + milestone.title} onChange={(event) => void run(supabase!.from("milestones").update({ status: event.target.value }).eq("id", milestone.id), "Milestone updated.")}>
            {MILESTONE_STATUS.map((status) => <option key={status} value={status}>{status.replace("_", " ")}</option>)}</select>
        </div>; }) : <p className="evidence-empty">No milestones yet. Add the first checkpoint the team is working towards.</p>}</div>
    </section>

    <section className="panel full-panel evidence-section">
      <div className="panel-heading"><div><div className="section-kicker">WORKSTREAMS</div><h2>Areas of work</h2><p>Group tasks by discipline, e.g. Perception, Controls, Infrastructure.</p></div></div>
      <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const name = String(new FormData(form).get("name") ?? "").trim();
        if (name.length < 2) { notify("Name the workstream."); return; }
        void run(supabase!.from("workstreams").insert({ project_id: projectId, name, created_by: userId, position: (plan?.workstreams.length ?? 0) }), "Workstream added.").then(() => form.reset()); }}>
        <input name="name" placeholder="New workstream" maxLength={120}/><button className="button primary small">Add workstream</button></form>
      <div className="pm-card-grid">{plan?.workstreams.map((stream) => <div className="pm-card" key={stream.id}>
        <div className="pm-card-head"><Layers size={14}/><strong>{stream.name}</strong></div>
        <div className="metric-progress"><span style={{ width: stream.percent + "%" }}/></div>
        <div className="pm-card-meta"><span>{stream.done}/{stream.total} done · {stream.percent}%</span></div></div>)}</div>
    </section>

    <section className="panel full-panel evidence-section">
      <div className="panel-heading"><div><div className="section-kicker">TASK PLANNING</div><h2>Assign, schedule and sequence</h2><p>Dependencies and subtasks are enforced: a task cannot complete while its prerequisites are open, and loops are rejected.</p></div></div>
      {openTasks.length ? openTasks.map((task) => {
        const blockers = openDepsOf(task.id); const expanded = open === task.id;
        return <div className="evidence-task" key={task.id}>
          <div className="evidence-task-head">
            <div className="protected-copy"><strong>{task.title}</strong><span>{task.status.replace("_", " ")} · {memberName(task.assigned_to)}{task.due_date ? " · due " + task.due_date : ""}{task.parent_task_id ? " · subtask of " + (byId.get(task.parent_task_id)?.title ?? "…") : ""}</span></div>
            {blockers.length > 0 && <span className="evidence-pill warn">Waiting on {blockers.length}</span>}
            <button className="button secondary small" onClick={() => setOpen(expanded ? "" : task.id)}>{expanded ? "Close" : "Plan"}</button>
          </div>
          {expanded && <div className="evidence-detail pm-planner">
            <label className="evidence-label">Assignee<select value={task.assigned_to ?? ""} onChange={(event) => void patch(task, { assigned_to: event.target.value || null }, "Assignee updated.")}><option value="">Unassigned</option>{members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name || member.user_id.slice(0, 8)} ({member.role})</option>)}</select></label>
            <label className="evidence-label">Milestone<select value={task.milestone_id ?? ""} onChange={(event) => void patch(task, { milestone_id: event.target.value || null }, "Milestone updated.")}><option value="">None</option>{plan?.milestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.title}</option>)}</select></label>
            <label className="evidence-label">Workstream<select value={task.workstream_id ?? ""} onChange={(event) => void patch(task, { workstream_id: event.target.value || null }, "Workstream updated.")}><option value="">None</option>{plan?.workstreams.map((stream) => <option key={stream.id} value={stream.id}>{stream.name}</option>)}</select></label>
            <label className="evidence-label">Parent task<select value={task.parent_task_id ?? ""} onChange={(event) => void patch(task, { parent_task_id: event.target.value || null }, "Hierarchy updated.")}><option value="">None (top level)</option>{tasks.filter((other) => other.id !== task.id).map((other) => <option key={other.id} value={other.id}>{other.title}</option>)}</select></label>
            <label className="evidence-label">Due date<input type="date" value={task.due_date ?? ""} onChange={(event) => void patch(task, { due_date: event.target.value || null }, "Due date updated.")}/></label>
            <div className="evidence-label">Depends on
              <div className="evidence-cases">{deps.filter((dep) => dep.task_id === task.id).map((dep) => { const target = byId.get(dep.depends_on_task_id);
                return <span key={dep.depends_on_task_id} className={"evidence-pill " + (target?.status === "done" ? "ok" : "warn")}>{target?.title ?? "…"}
                  <button className="pm-chip-x" aria-label="Remove dependency" onClick={() => void run(supabase!.from("task_dependencies").delete().eq("task_id", task.id).eq("depends_on_task_id", dep.depends_on_task_id), "Dependency removed.")}>×</button></span>; })}
                {!deps.some((dep) => dep.task_id === task.id) && <span className="evidence-empty">No prerequisites.</span>}</div>
              <select value="" onChange={(event) => { if (event.target.value) void run(supabase!.from("task_dependencies").insert({ task_id: task.id, depends_on_task_id: event.target.value, created_by: userId }), "Dependency added."); }}>
                <option value="">Add a prerequisite…</option>{tasks.filter((other) => other.id !== task.id && !deps.some((dep) => dep.task_id === task.id && dep.depends_on_task_id === other.id)).map((other) => <option key={other.id} value={other.id}>{other.title}</option>)}</select></div>
          </div>}
        </div>; }) : <p className="evidence-empty">No open tasks to plan.</p>}
    </section>
  </div>;
}
