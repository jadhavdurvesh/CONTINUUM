import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowDownRight, ArrowUpRight, Bell, BookOpen, Bot, Boxes, CalendarDays,
  Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Command,
  FileText, FlaskConical, GitBranch, HardDrive, LayoutGrid, LockKeyhole, LogOut,
  Menu, MoreHorizontal, Plus, Radio, Search, Settings2, ShieldCheck, ShieldEllipsis,
  Sparkles, Target, Users, Workflow, X, Zap
} from "lucide-react";
import { cloudConfigured, supabase, type ActivityEvent, type Project, type Task } from "./lib/supabase";

type Page = "Overview" | "Tasks" | "Activity" | "Protected resources" | "Agents & workers" | "Documentation" | "Settings";
type TaskStatus = Task["status"];

const statusLabels: Record<TaskStatus, string> = {
  backlog: "Backlog", todo: "Todo", in_progress: "In progress",
  in_review: "In review", done: "Done", blocked: "Blocked"
};
const statusOrder: TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "done", "blocked"];
const nav: { section: string; label: Page; icon: typeof LayoutGrid }[] = [
  { section: "PROJECT", label: "Overview", icon: LayoutGrid },
  { section: "PROJECT", label: "Tasks", icon: CheckCheck },
  { section: "PROJECT", label: "Documentation", icon: BookOpen },
  { section: "SYSTEM", label: "Agents & workers", icon: Bot },
  { section: "SYSTEM", label: "Activity", icon: Activity },
  { section: "GOVERNANCE", label: "Protected resources", icon: LockKeyhole },
  { section: "GOVERNANCE", label: "Settings", icon: Settings2 }
];

function App() {
  const [page, setPage] = useState<Page>("Overview");
  const [session, setSession] = useState<any>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [locks, setLocks] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [grants, setGrants] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [toast, setToast] = useState("");
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const loadWorkspace = useCallback(async () => {
    if (!supabase || !session?.user) return;
    setLoading(true);
    setLoadError("");
    const result = await supabase.from("projects").select("*").order("created_at", { ascending: true });
    if (result.error) {
      setLoadError(result.error.message);
      setLoading(false);
      return;
    }
    const list = (result.data ?? []) as Project[];
    setProjects(list);
    setProject((current) => list.find((item) => item.id === current?.id) ?? list[0] ?? null);
    setLoading(false);
  }, [session?.user?.id]);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  const loadProjectData = useCallback(async () => {
    if (!supabase || !project) { setTasks([]); setEvents([]); setLocks([]); return; }
    const [taskResult, eventResult, lockResult, requestResult, grantResult] = await Promise.all([
      supabase.from("tasks").select("*").eq("project_id", project.id).order("created_at", { ascending: false }),
      supabase.from("activity_events").select("*").eq("project_id", project.id).order("created_at", { ascending: false }).limit(30),
      supabase.from("resource_locks").select("*").eq("project_id", project.id).eq("is_locked", true),
      supabase.from("permission_requests").select("*").eq("project_id", project.id).eq("status", "pending").order("created_at", { ascending: true }),
      supabase.from("permission_grants").select("*").eq("project_id", project.id).is("revoked_at", null)
    ]);
    if (taskResult.error) setLoadError(taskResult.error.message);
    else setTasks((taskResult.data ?? []) as Task[]);
    if (!eventResult.error) setEvents((eventResult.data ?? []) as ActivityEvent[]);
    if (!lockResult.error) setLocks(lockResult.data ?? []);
    if (!requestResult.error) setRequests(requestResult.data ?? []);
    if (!grantResult.error) setGrants(grantResult.data ?? []);  }, [project?.id, session?.user?.id]);

  useEffect(() => { void loadProjectData(); }, [loadProjectData]);

  useEffect(() => {
    if (!supabase || !project) return;
    const channel = supabase.channel(`project-live-${project.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `project_id=eq.${project.id}` }, () => void loadProjectData())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_events", filter: `project_id=eq.${project.id}` }, () => void loadProjectData())
      .on("postgres_changes", { event: "*", schema: "public", table: "resource_locks", filter: `project_id=eq.${project.id}` }, () => void loadProjectData())
      .on("postgres_changes", { event: "*", schema: "public", table: "permission_requests", filter: `project_id=eq.${project.id}` }, () => void loadProjectData())
      .on("postgres_changes", { event: "*", schema: "public", table: "permission_grants", filter: `project_id=eq.${project.id}` }, () => void loadProjectData())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [project?.id, loadProjectData]);

  const currentUserId = session?.user?.id as string | undefined;
  const isOwner = Boolean(project && currentUserId && project.owner_id === currentUserId);
  const doneCount = tasks.filter((task) => task.status === "done").length;
  const activeCount = tasks.filter((task) => ["todo", "in_progress", "in_review"].includes(task.status)).length;
  const blockedCount = tasks.filter((task) => task.status === "blocked").length;
  const completion = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;
  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const matchesText = `${task.title} ${task.description ?? ""}`.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "all" || task.status === filter;
    return matchesText && matchesFilter;
  }), [tasks, search, filter]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setAuthBusy(true); setAuthError("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setAuthError(error.message);
    setAuthBusy(false);
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setProjects([]); setProject(null); setTasks([]); setEvents([]);
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3500);
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !currentUserId) return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const description = String(data.get("description") ?? "").trim();
    if (!name) return;
    const { data: created, error } = await supabase.from("projects")
      .insert({ name, description, owner_id: currentUserId }).select("*").single();
    if (error) { notify(error.message); return; }
    setProjects((old) => [...old, created as Project]);
    setProject(created as Project);
    setShowProjectForm(false);
    setPage("Overview");
    notify("Project created in the shared cloud workspace.");
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !project || !currentUserId) return;
    const data = new FormData(event.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    if (!title) return;
    const { error } = await supabase.from("tasks").insert({
      project_id: project.id,
      title,
      description: String(data.get("description") ?? "").trim() || null,
      priority: String(data.get("priority") ?? "normal"),
      status: String(data.get("status") ?? "todo"),
      due_date: String(data.get("due_date") ?? "") || null,
      created_by: currentUserId
    });
    if (error) { notify(error.message); return; }
    setShowTaskForm(false);
    notify("Task saved. Connected PCs will receive the update.");
    void loadProjectData();
  }

  async function updateTaskStatus(task: Task, status: TaskStatus) {
    if (!supabase) return;
    const { error } = await supabase.from("tasks").update({ status, updated_by: currentUserId }).eq("id", task.id);
    if (error) notify(error.message);
    else notify("Task status updated.");
  }

  async function toggleLock(task: Task) {
    if (!supabase || !project || !currentUserId) return;
    const existing = locks.find((lock) => lock.resource_type === "task" && lock.resource_id === task.id);
    if (existing) {
      const { error } = await supabase.from("resource_locks").update({ is_locked: false }).eq("id", existing.id);
      if (error) notify(error.message);
      else notify("Protection removed.");
    } else {
      const { error } = await supabase.from("resource_locks").upsert({
        project_id: project.id, resource_type: "task", resource_id: task.id,
        locked_by: currentUserId, reason: "Protected by project owner", is_locked: true
      }, { onConflict: "project_id,resource_type,resource_id" });
      if (error) notify(error.message);
      else notify("Task protected. Other members need an explicit grant to edit it.");
    }
    void loadProjectData();
  }

  async function requestPermission(task: Task) {
    if (!supabase || !project) return;
    const { error } = await supabase.from("permission_requests").insert({
      project_id: project.id, resource_type: "task", resource_id: task.id,
      requested_action: "edit", reason: "Requesting permission to edit this protected task."
    });
    if (error) notify(error.message);
    else notify("Permission request sent to the project owner.");
  }

  if (!authReady) return <div className="boot-screen"><div className="brand-symbol"><Command size={23}/></div><span>Connecting to workspace…</span></div>;

  if (!cloudConfigured || !supabase) {
    return <CloudSetup />;
  }

  if (!session) {
    return <div className="auth-screen">
      <div className="auth-side">
        <div className="auth-brand"><div className="brand-symbol"><Command size={23}/></div><span>CONTINUUM</span></div>
        <div className="auth-message"><div className="eyebrow">YOUR ENGINEERING CONTROL ROOM</div><h1>Make the whole project<br/><em>move as one.</em></h1><p>Shared project state, real test evidence, clear ownership, and agents that can hand work off without losing context.</p></div>
        <div className="auth-foot"><span>PRIVATE WORKSPACE</span><span>·</span><span>CLOUD SYNCHRONIZED</span></div>
      </div>
      <div className="auth-main">
        <form className="auth-card" onSubmit={signIn}>
          <div className="auth-kicker">WELCOME BACK</div><h2>Sign in to your workspace</h2><p>Use the account invited to your private project.</p>
          <label>Email address<input autoComplete="username" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@example.com"/></label>
          <label>Password<input autoComplete="current-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="Your password"/></label>
          {authError && <div className="form-error">{authError}</div>}
          <button className="button primary full" disabled={authBusy}>{authBusy ? "Signing in…" : "Continue to workspace"} <ArrowDownRight size={16}/></button>
          <div className="auth-note"><LockKeyhole size={14}/> Invitation-only access. Account invitations are managed by the workspace owner.</div>
        </form>
      </div>
    </div>;
  }

  const pageTitle = page === "Overview" ? "Project overview" : page;
  const groupedNav = ["PROJECT", "SYSTEM", "GOVERNANCE"];
  const pageDescription: Record<Page, string> = {
    "Overview": "A live view of delivery, engineering health, and what needs attention.",
    "Tasks": "Track the work, the owner, and the next meaningful state change.",
    "Activity": "A chronological record of changes made by people and automation.",
    "Protected resources": "Explicit locks and permission requests for work that must not change casually.",
    "Agents & workers": "The cloud control plane for model routes, agent runs, and connected workstations.",
    "Documentation": "Decisions and technical knowledge will live alongside the work they explain.",
    "Settings": "Workspace membership, project configuration, and cloud connection details."
  };

  return <div className="app-shell">
    {mobileNav && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)}/>}
    <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
      <div className="brand-row"><div className="brand-symbol"><Command size={20}/></div><div className="brand-wordmark"><strong>CONTINUUM</strong><span>ENGINEERING OS</span></div><button className="icon-quiet mobile-close" onClick={() => setMobileNav(false)} aria-label="Close menu"><X size={17}/></button></div>
      <button className="project-switcher" onClick={() => setShowProjectForm(true)}><div className="project-monogram">{project?.name?.slice(0,1).toUpperCase() || "＋"}</div><div className="switcher-copy"><strong>{project?.name ?? "Create a project"}</strong><span>{project ? "Private workspace" : "Start the shared workspace"}</span></div><ChevronDown size={15}/></button>
      <nav className="sidebar-nav">
        {groupedNav.map((section) => <div className="nav-group" key={section}><div className="nav-section-label">{section}</div>
          {nav.filter((item) => item.section === section).map((item) => { const Icon = item.icon; return <button key={item.label} onClick={() => { setPage(item.label); setMobileNav(false); }} className={`nav-link ${page === item.label ? "selected" : ""}`}><Icon size={17} strokeWidth={1.8}/><span>{item.label}</span>{item.label === "Protected resources" && locks.length > 0 && <span className="nav-count">{locks.length}</span>}</button>; })}
        </div>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="cloud-mini"><div className="cloud-mini-top"><span className="online-pulse"/><span>SHARED CLOUD</span><span className="cloud-mini-state">LIVE</span></div><p>Changes sync across signed-in devices.</p></div>
        <button className="nav-link" onClick={() => setPage("Settings")}><CircleHelp size={17}/><span>Help & workspace setup</span></button>
        <div className="profile-row"><div className="avatar">{(session.user.email?.[0] ?? "U").toUpperCase()}</div><div className="profile-copy"><strong>{session.user.user_metadata?.display_name ?? session.user.email?.split("@")[0]}</strong><span>{isOwner ? "Workspace owner" : "Project collaborator"}</span></div><button className="icon-quiet" onClick={() => void signOut()} title="Sign out" aria-label="Sign out"><LogOut size={16}/></button></div>
      </div>
    </aside>

    <main className="main-area">
      <header className="topbar">
        <div className="topbar-left"><button className="icon-quiet menu-toggle" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={19}/></button><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={13}/><strong>{pageTitle}</strong></div></div>
        <div className="topbar-right"><div className="sync-status"><span className="online-pulse"/><span>Cloud connected</span></div><button className="top-icon" onClick={() => setShowCommand(true)} aria-label="Search workspace"><Search size={17}/><kbd>⌘ K</kbd></button><button className="top-icon notification" aria-label="Notifications"><Bell size={17}/><i/></button><div className="top-avatar">{(session.user.email?.[0] ?? "U").toUpperCase()}</div></div>
      </header>
      <div className="page-body">
        <div className="page-intro"><div><div className="eyebrow"><span className="eyebrow-mark"/> PROJECT CONTROL / {project ? project.status.toUpperCase() : "SETUP"}</div><h1>{page === "Overview" ? <>The work, <em>in context.</em></> : pageTitle}</h1><p>{pageDescription[page]}</p></div><div className="intro-actions"><button className="button secondary" onClick={() => void loadProjectData()}><Radio size={15}/> Refresh</button><button className="button primary" onClick={() => project ? setShowTaskForm(true) : setShowProjectForm(true)}><Plus size={16}/>{project ? "New task" : "New project"}</button></div></div>

        {loadError && <div className="inline-error"><ShieldEllipsis size={16}/><span>{loadError}</span></div>}
        {!project ? <section className="empty-project panel"><div className="empty-stamp"><Boxes size={24}/></div><div className="eyebrow">NO PROJECT SELECTED</div><h2>Give the work a home.</h2><p>Create your first shared project. Its tasks, decisions, audit history, locks, and agent activity will live in the cloud—not in a single PC or chat.</p><button className="button primary" onClick={() => setShowProjectForm(true)}><Plus size={16}/> Create the first project</button></section> :
        page === "Overview" ? <>
          <div className="overview-ribbon"><div className="ribbon-copy"><div className="ribbon-icon"><Zap size={17}/></div><div><strong>{project.name}</strong><span>{project.description || "Shared project space"} · Live workspace</span></div></div><div className="ribbon-meta"><span><Users size={15}/> Shared with your team</span><span><Clock3 size={15}/> Updated live</span></div></div>
          <div className="metric-grid">
            <MetricCard label="Completion" value={tasks.length ? `${completion}%` : "—"} note={tasks.length ? `${doneCount} of ${tasks.length} tasks complete` : "Awaiting first task"} icon={Target} accent="terracotta" progress={tasks.length ? completion : 0}/>
            <MetricCard label="In motion" value={String(activeCount)} note="Todo, active & review" icon={Workflow} accent="olive"/>
            <MetricCard label="Blocked" value={String(blockedCount)} note={blockedCount ? "Needs a decision" : "No recorded blockers"} icon={ShieldEllipsis} accent={blockedCount ? "terracotta" : "stone"}/>
            <MetricCard label="Protected" value={String(locks.length)} note="Resources under lock" icon={LockKeyhole} accent="plum"/>
          </div>
          <div className="dashboard-grid">
            <section className="panel task-panel"><div className="panel-heading"><div><div className="section-kicker">DELIVERY QUEUE</div><h2>Work in progress</h2><p>The latest tasks across your project.</p></div><button className="text-action" onClick={() => setPage("Tasks")}>View all <ArrowUpRight size={14}/></button></div>
              {tasks.length === 0 ? <EmptyInline icon={CheckCheck} title="No work has been recorded yet" text="Create a task to start a shared, auditable work queue." action="Add first task" onAction={() => setShowTaskForm(true)}/> :
                <div className="task-list">{tasks.slice(0,6).map((task) => <TaskRow key={task.id} task={task} locked={isLocked(locks, task)} canManage={isOwner} onStatus={updateTaskStatus} onLock={toggleLock} onRequest={requestPermission}/>)}</div>}
            </section>
            <section className="panel activity-panel"><div className="panel-heading"><div><div className="section-kicker">AUDIT STREAM</div><h2>Recent activity</h2><p>Who changed what, and when.</p></div><button className="icon-quiet" onClick={() => setPage("Activity")} aria-label="View all activity"><ArrowUpRight size={16}/></button></div>
              {events.length === 0 ? <EmptyInline icon={Activity} title="Nothing in the audit stream yet" text="Task changes and other recorded actions will appear here."/> :
                <div className="activity-list">{events.slice(0,6).map((event) => <ActivityRow key={event.id} event={event}/>)}</div>}
            </section>
          </div>
          <div className="bottom-grid">
            <section className="panel focus-panel"><div className="panel-heading"><div><div className="section-kicker">QUALITY GATE</div><h2>Test evidence</h2><p>Results will be linked to commits and task acceptance criteria.</p></div><FlaskConical size={18} className="muted-icon"/></div><div className="quality-empty"><div className="quality-graphic"><div className="quality-ring"><Check size={21}/></div><div className="quality-orbit orbit-one"/><div className="quality-orbit orbit-two"/></div><div><strong>No test runs connected</strong><span>Quality metrics stay blank until a test runner records real evidence.</span></div></div></section>
            <section className="panel workforce-panel"><div className="panel-heading"><div><div className="section-kicker">DISTRIBUTED WORK</div><h2>Agents & workstations</h2><p>Cloud coordination, local execution.</p></div><Bot size={18} className="muted-icon"/></div><div className="worker-callout"><div className="worker-icon"><Bot size={20}/></div><div><strong>Control plane ready to configure</strong><span>Worker heartbeats and agent handoffs are the next integration milestone.</span></div><button className="icon-quiet" onClick={() => setPage("Agents & workers")} aria-label="Open agents"><ArrowUpRight size={16}/></button></div></section>
          </div>
        </> : page === "Tasks" ? <section className="panel full-panel"><div className="panel-heading"><div><div className="section-kicker">PROJECT WORK</div><h2>Task register</h2><p>Task updates are stored in the shared cloud database.</p></div><button className="button primary" onClick={() => setShowTaskForm(true)}><Plus size={15}/> New task</button></div><div className="task-toolbar"><div className="search-field"><Search size={15}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a task…"/></div><select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter tasks"><option value="all">All statuses</option>{statusOrder.map(s => <option value={s} key={s}>{statusLabels[s]}</option>)}</select></div>{filteredTasks.length ? <div className="task-list full-task-list">{filteredTasks.map(task => <TaskRow key={task.id} task={task} locked={isLocked(locks, task)} canManage={isOwner} onStatus={updateTaskStatus} onLock={toggleLock} onRequest={requestPermission}/>)}</div> : <EmptyInline icon={Search} title="No matching tasks" text="Try another filter or create a task for this project." action="Create task" onAction={() => setShowTaskForm(true)}/>}</section> : page === "Activity" ? <section className="panel full-panel"><div className="panel-heading"><div><div className="section-kicker">TRACEABILITY</div><h2>Project activity</h2><p>Recorded events from the shared workspace.</p></div><Activity size={19} className="muted-icon"/></div>{events.length ? <div className="activity-list expanded-activity">{events.map(event => <ActivityRow key={event.id} event={event}/>)}</div> : <EmptyInline icon={Activity} title="The audit trail is empty" text="Create or update a task to record the first event."/>}</section> : page === "Protected resources" ? <section className="panel full-panel"><div className="panel-heading"><div><div className="section-kicker">CHANGE CONTROL</div><h2>Protected resources</h2><p>Locks are enforced in the database, not just hidden in the interface.</p></div><LockKeyhole size={19} className="muted-icon"/></div>{locks.length ? <div className="protected-list">{locks.map((lock) => { const task = tasks.find(t => t.id === lock.resource_id); return <div className="protected-row" key={lock.id}><div className="protected-icon"><LockKeyhole size={17}/></div><div className="protected-copy"><strong>{task?.title ?? "Protected resource"}</strong><span>{lock.reason} · {new Date(lock.created_at).toLocaleString()}</span></div>{isOwner && task && <button className="button secondary small" onClick={() => void toggleLock(task)}>Unlock</button>}</div>; })}</div> : <EmptyInline icon={ShieldCheck} title="Nothing is locked" text="Protect an important task from accidental edits. Only the project owner can create or remove locks."/>}<div className="governance-note"><ShieldCheck size={16}/><span>For a locked task, the database rejects edits unless the user has an active, resource-scoped permission grant. The owner can revoke protection.</span></div></section> : page === "Agents & workers" ? <section className="panel full-panel"><div className="panel-heading"><div><div className="section-kicker">EXECUTION CONTROL PLANE</div><h2>Agents & connected PCs</h2><p>Shared coordination lives in the cloud; coding tools execute only on authorized workers.</p></div><Bot size={19} className="muted-icon"/></div><div className="architecture-cards"><div className="architecture-card"><div className="architecture-icon cloud"><HardDrive size={19}/></div><span className="status-tag ready">CLOUD STATE</span><h3>Shared control plane</h3><p>Tasks, run records, permissions, checkpoints, and audit events persist centrally so another PC can pick up the work.</p></div><div className="architecture-card"><div className="architecture-icon worker"><Command size={19}/></div><span className="status-tag planned">WORKER AGENT</span><h3>Local execution nodes</h3><p>Each authorized PC will run a worker that claims scoped tasks, executes in an isolated workspace, and reports logs and checkpoints.</p></div><div className="architecture-card"><div className="architecture-icon route"><Workflow size={19}/></div><span className="status-tag planned">RELAY ADAPTER</span><h3>Model failover</h3><p>RELAY will route model calls and provider failures; project state and checkpoints remain independent of any model conversation.</p></div></div><div className="governance-note"><LockKeyhole size={16}/><span>Agent dispatch is not active yet. The worker gateway, signed registration, leases, heartbeat and cross-runtime checkpoint handoff must be completed before running autonomous work.</span></div></section> : page === "Documentation" ? <section className="panel full-panel"><div className="panel-heading"><div><div className="section-kicker">PROJECT KNOWLEDGE</div><h2>Knowledge base</h2><p>Decision records and documents will be linked to the tasks they explain.</p></div><FileText size={19} className="muted-icon"/></div><EmptyInline icon={BookOpen} title="Knowledge base not connected yet" text="The initial cloud schema focuses on projects, tasks, permissions, and audit events. Versioned document storage is a later phase."/></section> : <section className="panel full-panel"><div className="panel-heading"><div><div className="section-kicker">WORKSPACE ADMINISTRATION</div><h2>Workspace settings</h2><p>Account and cloud configuration.</p></div><Settings2 size={19} className="muted-icon"/></div><div className="settings-list"><div><span>Signed in as</span><strong>{session.user.email}</strong></div><div><span>Workspace role</span><strong>{isOwner ? "Owner" : "Collaborator"}</strong></div><div><span>Backend</span><strong>Hosted Supabase · PostgreSQL</strong></div><div><span>Realtime sync</span><strong>Subscribed for this project</strong></div><div><span>Project ID</span><code>{project.id}</code></div></div><button className="button secondary" onClick={() => void signOut()}><LogOut size={15}/> Sign out</button></section>}
        <footer className="page-footer"><span>CONTINUUM <i/> PRIVATE ENGINEERING WORKSPACE</span><span><span className="online-pulse"/> Shared cloud state · Changes are attributed</span></footer>
      </div>
    </main>

    {showTaskForm && <Modal title="Create a task" eyebrow="DELIVERY QUEUE" onClose={() => setShowTaskForm(false)}><form className="modal-form" onSubmit={createTask}><label>Task title<input name="title" required minLength={2} maxLength={180} autoFocus placeholder="e.g. Define telemetry message schema"/></label><label>Description<textarea name="description" rows={3} placeholder="What needs to be done? Include acceptance criteria if useful."/></label><div className="form-row"><label>Priority<select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="critical">Critical</option></select></label><label>Status<select name="status" defaultValue="todo">{statusOrder.map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}</select></label></div><label>Due date<input type="date" name="due_date"/></label><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setShowTaskForm(false)}>Cancel</button><button className="button primary" type="submit"><Plus size={15}/> Save task</button></div></form></Modal>}
    {showProjectForm && <Modal title="Create a project" eyebrow="NEW PROJECT SPACE" onClose={() => setShowProjectForm(false)}><form className="modal-form" onSubmit={createProject}><label>Project name<input name="name" required minLength={2} maxLength={100} autoFocus placeholder="Your megaproject name"/></label><label>Purpose and scope<textarea name="description" rows={4} placeholder="What are you building? What is in scope?"/></label><div className="modal-footnote"><LockKeyhole size={15}/> The project will be created in the shared cloud database and owned by your signed-in account.</div><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setShowProjectForm(false)}>Cancel</button><button className="button primary" type="submit"><Plus size={15}/> Create project</button></div></form></Modal>}
    {showCommand && <Modal title="Jump to…" eyebrow="WORKSPACE COMMAND" onClose={() => setShowCommand(false)}><div className="command-list">{nav.map((item) => { const Icon=item.icon; return <button key={item.label} onClick={() => { setPage(item.label); setShowCommand(false); }}><Icon size={17}/><span>{item.label}</span><ChevronRight size={14}/></button>; })}</div></Modal>}
    {toast && <div className="toast"><Check size={16}/>{toast}</div>}
    {loading && <div className="loading-indicator"><span className="online-pulse"/> Syncing cloud state</div>}
  </div>;
}

function CloudSetup() {
  return <div className="setup-screen"><div className="setup-top"><div className="brand-symbol"><Command size={22}/></div><span>CONTINUUM</span><span className="setup-pill">CLOUD CONFIGURATION</span></div><div className="setup-content"><div className="setup-illustration"><div className="setup-grid"/><div className="setup-node node-a"><HardDrive size={20}/></div><div className="setup-node node-b"><Users size={20}/></div><div className="setup-node node-c"><Radio size={20}/></div><div className="setup-link link-a"/><div className="setup-link link-b"/></div><div className="eyebrow">ONE SHARED SOURCE OF TRUTH</div><h1>Connect your<br/><em>cloud workspace.</em></h1><p>The dashboard is built for multiple PCs to share the same project state. Add a hosted Supabase project to enable sign-in, persistent tasks, protected resources, audit history, and live synchronization.</p><div className="setup-steps"><div><span>01</span><div><strong>Create the cloud database</strong><small>Create a Supabase project and apply the checked-in migration.</small></div><a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Open Supabase ↗</a></div><div><span>02</span><div><strong>Set frontend environment values</strong><small>Configure the project URL and publishable key in Vercel or <code>apps/web/.env.local</code>.</small></div></div><div><span>03</span><div><strong>Deploy the dashboard</strong><small>Deploy <code>apps/web</code> to Vercel. Both PCs then sign in to the same cloud workspace.</small></div><a href="https://vercel.com/new" target="_blank" rel="noreferrer">Open Vercel ↗</a></div></div><div className="setup-warning"><ShieldCheck size={17}/><span>No sample project data is being shown as real. The dashboard will activate when the cloud URL and publishable key are configured.</span></div></div><footer className="setup-footer">PRIVATE WORKSPACE <i/> CLOUD-FIRST ARCHITECTURE <i/> AUTHENTICATED ACCESS</footer></div>;
}

function MetricCard({ label, value, note, icon: Icon, accent, progress }: {label:string;value:string;note:string;icon:typeof Target;accent:string;progress?:number}) {
  return <div className="metric-card"><div className="metric-head"><span>{label}</span><div className={`metric-icon ${accent}`}><Icon size={17}/></div></div><div className="metric-value">{value}</div><div className="metric-note">{note}</div>{progress !== undefined && <div className="metric-progress"><span style={{width:`${progress}%`}}/></div>}</div>;
}
function EmptyInline({icon:Icon,title,text,action,onAction}:{icon:typeof Target;title:string;text:string;action?:string;onAction?:()=>void}) {
  return <div className="empty-inline"><div className="empty-inline-icon"><Icon size={19}/></div><strong>{title}</strong><p>{text}</p>{action && onAction && <button className="text-action" onClick={onAction}>{action} <ArrowDownRight size={14}/></button>}</div>;
}
function TaskRow({task,locked,canManage,onStatus,onLock,onRequest}:{task:Task;locked:boolean;canManage:boolean;onStatus:(task:Task,status:TaskStatus)=>void;onLock:(task:Task)=>void;onRequest:(task:Task)=>void}) {
  const priorityClass = `priority-${task.priority}`;
  return <div className="task-row"><div className={`task-status-glyph status-${task.status}`}>{task.status === "done" ? <Check size={13}/> : task.status === "blocked" ? <ShieldEllipsis size={13}/> : <span/>}</div><div className="task-main"><div className="task-title-line"><strong>{task.title}</strong>{locked && <LockKeyhole size={13} className="locked-icon"/>}</div><div className="task-subline"><span className={`priority-dot ${priorityClass}`}/><span>{task.priority}</span><span className="meta-separator">·</span><span>{new Date(task.created_at).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</span></div></div><div className="task-row-actions">{locked && !canManage ? <button className="small-action" onClick={() => onRequest(task)}>Request edit</button> : <select className={`status-select status-select-${task.status}`} aria-label={`Status for ${task.title}`} value={task.status} onChange={(e) => onStatus(task,e.target.value as TaskStatus)}>{statusOrder.map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}</select>}{canManage && <button className={`row-more ${locked ? "lock-active" : ""}`} onClick={() => onLock(task)} aria-label={locked ? "Unlock task" : "Protect task"} title={locked ? "Unlock task" : "Protect task"}><LockKeyhole size={14}/></button>}</div></div>;
}
function ActivityRow({event}:{event:ActivityEvent}) {
  const title = String(event.details?.title ?? event.entity_type);
  const actionLabel = event.action.replaceAll(".", " ");
  return <div className="activity-row"><div className={`activity-avatar actor-${event.actor_type}`}>{event.actor_type === "agent" ? <Bot size={14}/> : event.actor_type === "system" ? <Zap size={14}/> : <Users size={14}/>}</div><div className="activity-copy"><div><strong>{title}</strong><span>{actionLabel}</span></div><small>{event.actor_type === "human" ? "Workspace member" : event.actor_type === "agent" ? "AI agent" : "System"} · {relativeTime(event.created_at)}</small></div><ChevronRight size={14} className="activity-chevron"/></div>;
}
function Modal({title,eyebrow,onClose,children}:{title:string;eyebrow:string;onClose:()=>void;children:ReactNode}) {
  useEffect(() => { const handler=(e:KeyboardEvent)=>{if(e.key==="Escape")onClose();}; window.addEventListener("keydown",handler); return ()=>window.removeEventListener("keydown",handler); },[onClose]);
  return <div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)onClose();}}><section className="modal"><div className="modal-head"><div><div className="section-kicker">{eyebrow}</div><h2>{title}</h2></div><button className="icon-quiet" onClick={onClose} aria-label="Close dialog"><X size={18}/></button></div>{children}</section></div>;
}
function isLocked(locks:any[],task:Task) { return locks.some(lock=>lock.resource_type==="task" && lock.resource_id===task.id); }
function relativeTime(date:string) {
  const seconds=Math.max(0,Math.floor((Date.now()-new Date(date).getTime())/1000));
  if(seconds<60)return "just now"; if(seconds<3600)return `${Math.floor(seconds/60)}m ago`; if(seconds<86400)return `${Math.floor(seconds/3600)}h ago`; return `${Math.floor(seconds/86400)}d ago`;
}
export default App;
