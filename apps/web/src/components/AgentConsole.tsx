import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, Check, CheckCircle2,
  ChevronRight, Circle, FileCode2, Play, Plus, RefreshCw,
  ShieldCheck, Sparkles, Terminal, Workflow, X
} from "lucide-react";
import { supabase } from "../lib/supabase";

type AgentRole = "planner" | "coder" | "reviewer" | "qa";
type SessionStatus = "queued" | "running" | "needs_review" | "completed" | "failed" | "cancelled";
type AgentSession = {
  id: string;
  project_id: string;
  task_id: string | null;
  title: string;
  goal: string;
  current_agent: AgentRole;
  status: SessionStatus;
  focus_paths: string[];
  checkpoint: Record<string, any>;
  last_error: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
};
type AgentMessage = {
  id: string;
  project_id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  actor_type: "human" | "agent" | "system";
  actor_id: string | null;
  content: string;
  metadata: Record<string, any>;
  created_at: string;
};
type Props = { projectId: string; userId: string; accessToken: string; onNotify: (message: string) => void };
type Proposal = { summary: string; files: { path: string; content: string }[]; next_role: AgentRole; status: string; review_notes?: string };

function roleName(role: string) {
  return ({ planner: "Planner", coder: "Coder", reviewer: "Reviewer", qa: "QA" } as Record<string, string>)[role] ?? role;
}
function statusName(status: string) {
  return ({ queued: "Queued", running: "Running", needs_review: "Review needed", completed: "Completed", failed: "Failed", cancelled: "Cancelled" } as Record<string, string>)[status] ?? status;
}
function proposalFrom(message?: AgentMessage): Proposal | null {
  if (!message || message.role !== "assistant") return null;
  try {
    const value = JSON.parse(message.content);
    if (typeof value.summary !== "string" || !Array.isArray(value.files)) return null;
    return value as Proposal;
  } catch { return null; }
}

export default function AgentConsole({ projectId, userId, accessToken, onNotify }: Props) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [tasks, setTasks] = useState<{ id: string; title: string }[]>([]);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [role, setRole] = useState<AgentRole>("planner");
  const [taskId, setTaskId] = useState("");
  const [focusPaths, setFocusPaths] = useState("");
  const [feedback, setFeedback] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [workerStatus, setWorkerStatus] = useState<"unknown" | "offline" | "ready" | "needs-key">("unknown");
  const [providerNames, setProviderNames] = useState<string[]>([]);
  const [workerMessage, setWorkerMessage] = useState("");

  const selected = sessions.find(item => item.id === selectedId) ?? null;
  const latestAssistant = [...messages].reverse().find(item => item.role === "assistant");
  const latestProposal = proposalFrom(latestAssistant);

  const refreshSessions = useCallback(async () => {
    if (!supabase) return;
    const [sessionResult, taskResult] = await Promise.all([
      supabase.from("agent_sessions").select("*").eq("project_id", projectId).order("updated_at", { ascending: false }).limit(100),
      supabase.from("tasks").select("id,title").eq("project_id", projectId).order("created_at", { ascending: false }).limit(200)
    ]);
    if (sessionResult.error) { setError(sessionResult.error.message); return; }
    const nextSessions = (sessionResult.data ?? []) as AgentSession[];
    setSessions(nextSessions);
    setSelectedId(current => nextSessions.some(item => item.id === current) ? current : nextSessions[0]?.id ?? "");
    if (!taskResult.error) setTasks((taskResult.data ?? []) as { id: string; title: string }[]);
  }, [projectId]);

  const refreshMessages = useCallback(async (sessionId: string) => {
    if (!supabase || !sessionId) { setMessages([]); return; }
    const result = await supabase.from("agent_messages").select("*").eq("project_id", projectId).eq("session_id", sessionId).order("created_at", { ascending: true }).limit(120);
    if (result.error) setError(result.error.message);
    else setMessages((result.data ?? []) as AgentMessage[]);
  }, [projectId]);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);
  useEffect(() => { void refreshMessages(selectedId); }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    const filter = "project_id=eq." + projectId;
    const channel = client.channel("agent-console-" + projectId)
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_sessions", filter }, () => void refreshSessions())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_messages", filter }, payload => {
        const row = payload.new as AgentMessage;
        if (row.session_id === selectedId) void refreshMessages(selectedId);
      })
      .subscribe();
    return () => { void client.removeChannel(channel); };
  }, [projectId, selectedId, refreshMessages, refreshSessions]);

  const apiWorker = useCallback(async (path: string, body?: Record<string, unknown>) => {
    if (!accessToken) throw new Error("Your cloud sign-in has expired. Sign in again before running an agent.");
    const init: RequestInit = {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + accessToken, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: "omit",
    };
    let response: Response;
    try { response = await fetch(path, init); }
    catch { throw new Error("Could not reach the hosted agent service. Check your internet connection and Vercel deployment."); }
    const data = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Cloud agent service returned HTTP " + response.status + ".");
    return data;
  }, [accessToken]);

  const checkWorker = useCallback(async () => {
    setWorkerStatus("unknown");
    setWorkerMessage("");
    try {
      const response = await fetch("/api/agents/status", { credentials: "omit" });
      const data = await response.json().catch(() => ({})) as Record<string, any>;
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Cloud agent status check failed.");
      setProviderNames(Array.isArray(data.providers) ? data.providers : []);
      setWorkerStatus(data.configured ? "ready" : data.supabaseConfigured ? "needs-key" : "offline");
      setWorkerMessage(typeof data.message === "string" ? data.message : "");
    } catch (e) {
      setWorkerStatus("offline");
      setWorkerMessage(e instanceof Error ? e.message : "Could not reach the hosted agent service.");
    }
  }, []);

  useEffect(() => { void checkWorker(); }, [checkWorker]);

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !goal.trim() || !title.trim()) return;
    setBusy(true); setError("");
    const focus = focusPaths.split(/\r?\n/).map(path => path.trim()).filter(Boolean).slice(0, 12);
    const created = await supabase.from("agent_sessions").insert({
      project_id: projectId,
      task_id: taskId || null,
      title: title.trim(),
      goal: goal.trim(),
      current_agent: role,
      status: "queued",
      focus_paths: focus,
      requested_by: userId
    }).select("*").single();
    if (created.error || !created.data) {
      setBusy(false); setError(created.error?.message ?? "Could not create the agent session."); return;
    }
    const messageResult = await supabase.from("agent_messages").insert({
      project_id: projectId,
      session_id: created.data.id,
      role: "user",
      actor_type: "human",
      actor_id: userId,
      content: goal.trim(),
      metadata: { initial_goal: true, focus_paths: focus }
    });
    if (messageResult.error) setError("Session created, but its first context message could not be saved: " + messageResult.error.message);
    setTitle(""); setGoal(""); setFocusPaths(""); setTaskId(""); setRole("planner"); setShowCreate(false); setSelectedId(created.data.id);
    await refreshSessions();
    await refreshMessages(created.data.id);
    setBusy(false);
    onNotify("Agent session queued with durable project context.");
  }

  async function runStep() {
    if (!selected || selected.status !== "queued" || !supabase) return;
    setBusy(true); setError("");
    try {
      const { data, error: fileError } = await supabase.from("code_files")
        .select("path,content").eq("project_id", projectId).order("path").limit(500);
      if (fileError) throw new Error(fileError.message);
      const allFiles = (data ?? []) as { path: string; content: string }[];
      const focus = new Set(selected.focus_paths ?? []);
      const preferred = focus.size ? allFiles.filter(file => focus.has(file.path)) : allFiles;
      let used = 0;
      const workspace_context = preferred.slice(0, 12).map(file => {
        const content = file.content.slice(0, 12000);
        used += content.length;
        return { path: file.path, content };
      }).filter(() => used <= 75000);
      const result = await apiWorker("/api/agents/run-step", { project_id: projectId, session_id: selected.id, workspace_context });
      await refreshSessions(); await refreshMessages(selected.id);
      onNotify("Cloud agent step completed through " + result.provider + (result.attempts > 1 ? " with provider fallback." : "."));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not run the cloud agent step."); await refreshSessions(); await refreshMessages(selected.id); }
    finally { setBusy(false); }
  }

  async function applyProposal() {
    if (!selected || !latestProposal?.files?.length || !supabase) return;
    const confirmed = window.confirm("Apply " + latestProposal.files.length + " proposed file change(s) to the shared cloud workbench? Protected files remain governed by database permissions.");
    if (!confirmed) return;
    setBusy(true); setError("");
    try {
      const { data: existing, error: lookupError } = await supabase.from("code_files")
        .select("id,path").eq("project_id", projectId).in("path", latestProposal.files.map(file => file.path));
      if (lookupError) throw new Error(lookupError.message);
      const existingByPath = new Map(((existing ?? []) as { id: string; path: string }[]).map(file => [file.path, file.id]));
      for (const file of latestProposal.files) {
        const language = file.path.split(".").pop()?.toLowerCase() || "plaintext";
        const fileId = existingByPath.get(file.path);
        const result = fileId
          ? await supabase.from("code_files").update({ content: file.content, language, updated_by: userId }).eq("id", fileId).eq("project_id", projectId)
          : await supabase.from("code_files").insert({ project_id: projectId, path: file.path, content: file.content, language, created_by: userId, updated_by: userId });
        if (result.error) throw new Error(file.path + ": " + result.error.message);
      }
      const next = await supabase.from("agent_sessions").update({ status: "queued", last_error: null, finished_at: null })
        .eq("id", selected.id).eq("project_id", projectId);
      if (next.error) throw new Error(next.error.message);
      await refreshSessions(); await refreshMessages(selected.id);
      onNotify("Applied " + latestProposal.files.length + " reviewed change(s) to shared cloud files. The next role is queued.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not apply the cloud proposal."); }
    finally { setBusy(false); }
  }

  async function queueNextStep(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !selected || !["needs_review", "failed", "completed"].includes(selected.status)) return;
    setBusy(true); setError("");
    if (feedback.trim()) {
      const messageResult = await supabase.from("agent_messages").insert({
        project_id: projectId, session_id: selected.id, role: "user", actor_type: "human", actor_id: userId,
        content: feedback.trim(), metadata: { handoff_feedback: true }
      });
      if (messageResult.error) { setBusy(false); setError(messageResult.error.message); return; }
    }
    const update = await supabase.from("agent_sessions").update({
      status: "queued", last_error: null,
      current_agent: selected.current_agent === "planner" && selected.checkpoint?.proposed_paths?.length ? "coder" : selected.current_agent
    }).eq("id", selected.id);
    if (update.error) { setBusy(false); setError(update.error.message); return; }
    setFeedback("");
    await refreshSessions();
    await refreshMessages(selected.id);
    setBusy(false);
    onNotify("Agent session queued. Context and previous steps are preserved.");
  }

  const providerLabel = providerNames.length ? providerNames.join(" · ") : "No server-side model provider configured";
  return <section className="agent-console">
    <div className="agent-console-header">
      <div>
        <div className="section-kicker">PERSISTENT AGENT WORKSPACE</div>
        <h2>Work continues <em>with context.</em></h2>
        <p>Planner, Coder, Reviewer and QA roles share one durable session. RELAY routes requests across the providers configured on this PC.</p>
      </div>
      <div className="agent-console-head-actions">
        <div className={"agent-relay-state " + workerStatus}><span/>{workerStatus === "ready" ? "CLOUD AGENTS READY" : workerStatus === "needs-key" ? "ADD CLOUD MODEL KEY" : workerStatus === "offline" ? "CLOUD AGENTS OFFLINE" : "CHECKING"}</div>
        <button className="button secondary" onClick={() => void checkWorker()}><RefreshCw size={14}/> Check worker</button>
        <button className="button primary" onClick={() => setShowCreate(value => !value)}><Plus size={15}/> New agent session</button>
      </div>
    </div>

    <div className="agent-relay-info">
      <div className="agent-relay-icon"><Workflow size={17}/></div>
      <div><strong>{workerStatus === "ready" ? "Cloud model routing available" : workerStatus === "needs-key" ? "Cloud agent needs a model provider" : workerStatus === "offline" ? "Connect cloud agent service" : "Checking local worker"}</strong><span>{workerMessage || providerLabel}. Provider API keys stay in Vercel environment variables; this browser sends only the signed-in user token and approved project context.</span></div>
      <button className="text-action" onClick={() => window.dispatchEvent(new CustomEvent("continuum-open-local-ide"))}>Open desktop app <ArrowUpRight size={14}/></button>
    </div>

    {showCreate && <form className="agent-create-card" onSubmit={createSession}>
      <div className="agent-create-heading"><div><div className="section-kicker">NEW DURABLE SESSION</div><h3>Give the agents a goal</h3></div><button type="button" className="icon-quiet" onClick={() => setShowCreate(false)} aria-label="Close"><X size={17}/></button></div>
      <div className="agent-create-grid">
        <label>Session title<input value={title} onChange={e => setTitle(e.target.value)} required minLength={2} maxLength={160} placeholder="e.g. Add telemetry event pipeline"/></label>
        <label>Start with<select value={role} onChange={e => setRole(e.target.value as AgentRole)}><option value="planner">Planner</option><option value="coder">Coder</option><option value="reviewer">Reviewer</option><option value="qa">QA</option></select></label>
        <label>Related project task<select value={taskId} onChange={e => setTaskId(e.target.value)}><option value="">No linked task</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
        <label className="agent-path-label">Focus file paths <small>One relative path per line; leave blank for key project manifests.</small><textarea rows={3} value={focusPaths} onChange={e => setFocusPaths(e.target.value)} placeholder={"apps/web/src/App.tsx\nservices/api/app/main.py"}/></label>
        <label className="agent-goal-label">Goal and acceptance criteria<textarea rows={5} required value={goal} onChange={e => setGoal(e.target.value)} placeholder="Describe the outcome, constraints, tests to add, and what must not change."/></label>
      </div>
      <div className="agent-create-footer"><span><ShieldCheck size={14}/> Changes are proposed first. Protected paths are checked by the worker before apply.</span><button className="button primary" type="submit" disabled={busy}><Plus size={14}/> Queue session</button></div>
    </form>}

    {error && <div className="inline-error"><AlertTriangle size={15}/><span>{error}</span><button className="icon-quiet" onClick={() => setError("")} aria-label="Dismiss"><X size={14}/></button></div>}

    <div className="agent-console-grid">
      <aside className="agent-session-list panel">
        <div className="agent-session-list-header"><div><div className="section-kicker">SESSION QUEUE</div><h3>Persistent work</h3></div><span>{sessions.length}</span></div>
        {sessions.length ? sessions.map(item => <button key={item.id} className={"agent-session-item " + (item.id === selectedId ? "selected" : "")} onClick={() => setSelectedId(item.id)}>
          <span className={"agent-session-dot " + item.status}>{item.status === "completed" ? <Check size={12}/> : item.status === "failed" ? <AlertTriangle size={12}/> : item.status === "running" ? <RefreshCw size={12}/> : <Circle size={7}/>}</span>
          <span className="agent-session-item-main"><strong>{item.title}</strong><small>{roleName(item.current_agent)} · {statusName(item.status)}</small><em>{new Date(item.updated_at).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</em></span>
          <ChevronRight size={14}/>
        </button>) : <div className="agent-empty-list"><Bot size={22}/><strong>No agent sessions</strong><span>Queue a project goal to create the first durable thread.</span></div>}
      </aside>

      <section className="agent-session-detail panel">
        {selected ? <>
          <div className="agent-detail-head">
            <div><div className="section-kicker">{selected.id.slice(0,8)} / {selected.task_id ? "TASK LINKED" : "PROJECT SESSION"}</div><h3>{selected.title}</h3><p>{selected.goal}</p></div>
            <span className={"agent-status-tag " + selected.status}>{statusName(selected.status)}</span>
          </div>
          <div className="agent-messages">
            {messages.map(message => {
              const payload = proposalFrom(message);
              return <article className={"agent-message " + message.role} key={message.id}>
                <div className="agent-message-avatar">{message.role === "assistant" ? <Bot size={15}/> : message.role === "tool" ? <Terminal size={14}/> : <Circle size={10}/>}</div>
                <div className="agent-message-body">
                  <div className="agent-message-meta"><strong>{message.role === "assistant" ? "RELAY agent" : message.role === "tool" ? "Worker record" : message.role === "system" ? "System" : message.actor_id === userId ? "You" : "Collaborator"}</strong><span>{new Date(message.created_at).toLocaleString()}</span>{message.metadata?.provider && <span>{message.metadata.provider}{message.metadata.model ? " / " + message.metadata.model : ""}{message.metadata.fallback_used ? " · fallback" : ""}</span>}</div>
                  {payload ? <>
                    <p>{payload.summary}</p>
                    {payload.review_notes && <p className="agent-review-notes">{payload.review_notes}</p>}
                    {payload.files.length > 0 && <div className="agent-proposed-files"><div className="section-kicker">PROPOSED SOURCE CHANGES</div>{payload.files.map(file => <div key={file.path}><FileCode2 size={14}/><span>{file.path}</span><small>{new TextEncoder().encode(file.content).length.toLocaleString()} bytes</small></div>)}</div>}
                    <div className="agent-message-tail"><span>Next role: {roleName(payload.next_role)}</span><span>{message.metadata?.attempts ? "Provider attempts: " + message.metadata.attempts : ""}</span></div>
                  </> : <p className="agent-message-text">{message.content}</p>}
                </div>
              </article>;
            })}
          </div>
          {selected.status === "failed" && selected.last_error && <div className="agent-last-error"><AlertTriangle size={14}/><span>{selected.last_error}</span></div>}
          <div className="agent-detail-actions">
            {selected.status === "queued" && <button className="button primary" onClick={() => void runStep()} disabled={busy || workerStatus !== "ready"}><Play size={14}/> Run next cloud step</button>}
            {selected.status === "needs_review" && latestProposal?.files?.length ? <button className="button primary" onClick={() => void applyProposal()} disabled={busy || workerStatus !== "ready"}><CheckCircle2 size={14}/> Apply proposal to shared files</button> : null}
            {["needs_review", "failed", "completed"].includes(selected.status) && <form className="agent-continue-form" onSubmit={queueNextStep}><label>Continue / revise context<textarea rows={2} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Optional feedback, test results, or next instruction…"/></label><button className="button secondary" type="submit" disabled={busy}><ArrowDownRight size={14}/>{selected.status === "failed" ? "Retry with saved context" : selected.status === "completed" ? "Reopen session" : "Queue next step"}</button></form>}
            {selected.status === "running" && <div className="agent-running-note"><RefreshCw size={14}/> A cloud model is handling this step. Session status and message history are saved in the cloud.</div>}
          </div>
        </> : <div className="agent-session-empty"><div><Sparkles size={24}/></div><div className="section-kicker">AGENT CONTEXT</div><h3>Select a session<br/><em>or start with a goal.</em></h3><p>Each step is recorded, so you can switch provider, role, or PC without restating the project from scratch.</p><button className="button primary" onClick={() => setShowCreate(true)}><Plus size={15}/> New agent session</button></div>}
      </section>
    </div>
    <div className="agent-console-foot"><span><Activity size={13}/> Shared session history persists across providers and PCs.</span><span><ShieldCheck size={13}/> Proposal first · explicit apply · no automatic Git push or deployment.</span></div>
  </section>;
}
