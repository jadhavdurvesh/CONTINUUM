import { useEffect, useState } from "react";
import {
  Activity, Archive, ArrowDownRight, ArrowUpRight, Bot, Boxes, CalendarDays,
  CheckCircle2, ChevronDown, CircleHelp, Command, FileText, FlaskConical,
  FolderKanban, GitBranch, LockKeyhole, Plus, Search, Settings2, ShieldCheck,
  ShieldAlert, Sparkles, Target, TimerReset, Workflow, Zap
} from "lucide-react";

type Health = { status: string; service: string; version?: string };
type NavItem = { label: string; icon: typeof Command; group: string };

const navItems: NavItem[] = [
  { label: "Overview", icon: Command, group: "WORKSPACE" },
  { label: "Workstreams", icon: Boxes, group: "WORKSPACE" },
  { label: "Tasks & milestones", icon: FolderKanban, group: "WORKSPACE" },
  { label: "Documentation", icon: FileText, group: "WORKSPACE" },
  { label: "AI workforce", icon: Bot, group: "OPERATIONS" },
  { label: "Tests & quality", icon: FlaskConical, group: "OPERATIONS" },
  { label: "Repositories", icon: GitBranch, group: "OPERATIONS" },
  { label: "Activity & audit", icon: Activity, group: "GOVERNANCE" },
  { label: "Protected resources", icon: LockKeyhole, group: "GOVERNANCE" },
  { label: "Access & permissions", icon: ShieldCheck, group: "GOVERNANCE" }
];

function App() {
  const [active, setActive] = useState("Overview");
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);

  async function checkApi() {
    setChecking(true);
    try {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error("API returned an error");
      setHealth(await response.json() as Health);
    } catch {
      setHealth(null);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => { void checkApi(); }, []);

  const sections = ["WORKSPACE", "OPERATIONS", "GOVERNANCE"];
  const activePage = active === "Overview" ? "Project overview" : active;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><Command size={21} strokeWidth={2.2} /></div>
          <div><div className="brand-name">CONTINUUM</div><div className="brand-caption">PROJECT OPERATING SYSTEM</div></div>
        </div>

        <button className="workspace-switcher" type="button">
          <div className="workspace-avatar">M</div>
          <div className="workspace-text"><strong>My workspace</strong><span>Private workspace</span></div>
          <ChevronDown size={15} />
        </button>

        <div className="nav">
          {sections.map((section) => (
            <div className="nav-section" key={section}>
              <div className="nav-heading">{section}</div>
              {navItems.filter((item) => item.group === section).map((item) => {
                const Icon = item.icon;
                return (
                  <button className={`nav-item ${active === item.label ? "active" : ""}`}
                    key={item.label} onClick={() => setActive(item.label)} type="button">
                    <Icon size={17} strokeWidth={1.8} /><span>{item.label}</span>
                    {item.label === "Protected resources" && <span className="nav-dot" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="connection-card">
            <div className="connection-row"><span className={`status-light ${health ? "online" : ""}`} />API connection</div>
            <p>{health ? "Backend reachable" : checking ? "Checking local API…" : "Local API unavailable"}</p>
            <button type="button" onClick={() => void checkApi()} className="text-button">
              {checking ? "Checking…" : "Check connection"}
            </button>
          </div>
          <button className="nav-item settings-item" onClick={() => setActive("Settings")} type="button">
            <Settings2 size={17} /><span>Settings</span>
          </button>
          <div className="user-chip">
            <div className="user-avatar">U</div>
            <div className="workspace-text"><strong>Local preview</strong><span>Authentication not configured</span></div>
            <CircleHelp size={16} />
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><strong>{activePage}</strong></div>
          <div className="top-actions">
            <div className="local-badge"><span className="status-light online" />Local preview</div>
            <button className="icon-button" aria-label="Search" type="button"><Search size={18} /></button>
            <button className="icon-button" aria-label="Settings" type="button" onClick={() => setActive("Settings")}><Settings2 size={18} /></button>
          </div>
        </header>

        <div className="page-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow"><Sparkles size={14} /> YOUR PROJECT COMMAND CENTER</div>
              <h1>{active === "Overview" ? "Good to have you here." : active}</h1>
              <p>{active === "Overview" ? "A clear view of the work, evidence, and decisions that move your project forward." : `The ${active.toLowerCase()} workspace will appear here as this module is implemented.`}</p>
            </div>
            <button className="primary-button" type="button" onClick={() => setActive("Tasks & milestones")}><Plus size={17} /> Plan your first task</button>
          </div>

          {active === "Overview" ? (
            <>
              <div className="metric-grid">
                <Metric title="Project completion" value="—" unit="Not measured" icon={Target} tone="violet" />
                <Metric title="Active tasks" value="—" unit="No task data yet" icon={Workflow} tone="blue" />
                <Metric title="Tests passing" value="—" unit="No test runs recorded" icon={FlaskConical} tone="green" />
                <Metric title="Open blockers" value="—" unit="No issue data yet" icon={ShieldAlert} tone="orange" />
              </div>

              <div className="content-grid">
                <section className="panel progress-panel">
                  <div className="panel-heading"><div><h2>Project pulse</h2><p>Health metrics will be computed from recorded evidence.</p></div><button className="subtle-button" type="button">All activity <ArrowUpRight size={14} /></button></div>
                  <div className="empty-state large-empty">
                    <div className="empty-orbit"><Activity size={23} /></div>
                    <h3>Your project story starts here</h3>
                    <p>Create a project and its first milestone to start tracking verified progress, risks, and delivery.</p>
                    <button className="secondary-button" type="button" onClick={() => setActive("Workstreams")}>Explore workstreams <ArrowDownRight size={15} /></button>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-heading"><div><h2>System status</h2><p>Local development services</p></div><button className="icon-button small" type="button" aria-label="Refresh status" onClick={() => void checkApi()}><TimerReset size={16} /></button></div>
                  <div className="system-list">
                    <StatusLine icon={Command} label="Web dashboard" value="Running" good />
                    <StatusLine icon={Activity} label="API service" value={health ? "Connected" : checking ? "Checking" : "Not connected"} good={Boolean(health)} />
                    <StatusLine icon={Boxes} label="Project database" value="Not configured" />
                    <StatusLine icon={Bot} label="Agent orchestrator" value="Not configured" />
                    <StatusLine icon={ShieldCheck} label="Access controls" value="Not configured" />
                  </div>
                  <div className="note-strip"><LockKeyhole size={16} /><span>Project data and protected-resource controls are not active in this preview.</span></div>
                </section>
              </div>

              <div className="lower-grid">
                <section className="panel">
                  <div className="panel-heading"><div><h2>Next milestones</h2><p>Planned delivery checkpoints</p></div><CalendarDays size={17} className="muted-icon" /></div>
                  <div className="empty-state compact-empty"><Target size={22} /><strong>No milestones created</strong><span>Milestones will appear here when you add them.</span></div>
                </section>
                <section className="panel">
                  <div className="panel-heading"><div><h2>Latest activity</h2><p>Changes by people, agents, and automation</p></div><Activity size={17} className="muted-icon" /></div>
                  <div className="empty-state compact-empty"><Archive size={22} /><strong>No activity recorded</strong><span>Auditable events will appear here once project operations are connected.</span></div>
                </section>
              </div>
            </>
          ) : (
            <section className="panel module-placeholder">
              <div className="empty-orbit"><Boxes size={23} /></div>
              <h2>{active}</h2>
              <p>This module is represented in navigation but is not implemented yet. Its underlying data and permissions must be built before it can safely edit shared project state.</p>
              <div className="placeholder-foot"><ShieldCheck size={16} /><span>Planned with audit history and backend-enforced permissions.</span></div>
            </section>
          )}
          <footer><span>CONTINUUM · Initial development scaffold</span><span><LockKeyhole size={12} /> Private workspace concept</span></footer>
        </div>
      </main>
    </div>
  );
}

function Metric({ title, value, unit, icon: Icon, tone }: {
  title: string; value: string; unit: string;
  icon: typeof Target; tone: "violet" | "blue" | "green" | "orange";
}) {
  return <section className="metric-card">
    <div className="metric-top"><span>{title}</span><span className={`metric-icon ${tone}`}><Icon size={17} /></span></div>
    <div className="metric-value">{value}</div><div className="metric-unit">{unit}</div>
  </section>;
}

function StatusLine({ icon: Icon, label, value, good = false }: {
  icon: typeof Command; label: string; value: string; good?: boolean;
}) {
  return <div className="system-line"><div className="system-label"><Icon size={16} /><span>{label}</span></div><div className="system-value"><span className={`status-light ${good ? "online" : ""}`} />{value}</div></div>;
}

export default App;
