import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, FilePlus2, Gavel, History, RefreshCw, Save } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useStable } from "../lib/hooks";
import { renderMarkdown } from "../lib/markdown";
import LinksPanel from "./LinksPanel";

type Doc = { id: string; title: string; document_type: string; content_markdown: string; version: number; updated_at: string; workstream_id: string | null };
type DocVersion = { id: string; version: number; title: string; content_markdown: string; created_at: string };
type Decision = { id: string; title: string; context: string; decision: string; rationale: string; status: string; decided_by: string | null; created_at: string };
type Props = { projectId: string; userId: string; isOwner: boolean; onNotify: (message: string) => void };

const DOC_TYPES = ["note", "specification", "architecture", "research", "runbook", "meeting"];
const DECISION_LABEL: Record<string, string> = { proposed: "Proposed", accepted: "Accepted", superseded: "Superseded", rejected: "Rejected" };

export default function KnowledgeBase({ projectId, userId, isOwner, onNotify }: Props) {
  const notify = useStable(onNotify);
  const [tab, setTab] = useState<"documents" | "decisions">("documents");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState({ title: "", type: "note", content: "" });
  const [baseVersion, setBaseVersion] = useState(1);
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [preview, setPreview] = useState(true);
  const [viewing, setViewing] = useState<DocVersion | null>(null);
  const [conflict, setConflict] = useState(false);
  const [search, setSearch] = useState("");
  const [openDecision, setOpenDecision] = useState("");

  const selected = docs.find((doc) => doc.id === selectedId) ?? null;
  const dirty = !!selected && (draft.title !== selected.title || draft.type !== selected.document_type || draft.content !== selected.content_markdown);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [docResult, decisionResult] = await Promise.all([
      supabase.from("documents").select("id,title,document_type,content_markdown,version,updated_at,workstream_id").eq("project_id", projectId).order("updated_at", { ascending: false }).limit(300),
      supabase.from("decisions").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(300)
    ]);
    if (docResult.error || decisionResult.error) notify((docResult.error ?? decisionResult.error)!.message);
    setDocs((docResult.data as Doc[] | null) ?? []);
    setDecisions((decisionResult.data as Decision[] | null) ?? []);
  }, [projectId, notify]);
  useEffect(() => { void load(); }, [load]);

  const loadVersions = useCallback(async (documentId: string) => {
    if (!supabase) return;
    const { data, error } = await supabase.from("document_versions").select("id,version,title,content_markdown,created_at").eq("document_id", documentId).order("version", { ascending: false }).limit(50);
    if (error) notify(error.message);
    setVersions((data as DocVersion[] | null) ?? []);
  }, [notify]);

  function open(doc: Doc) {
    if (dirty && !window.confirm("Discard unsaved changes to this document?")) return;
    setSelectedId(doc.id); setDraft({ title: doc.title, type: doc.document_type, content: doc.content_markdown });
    setBaseVersion(doc.version); setConflict(false); setViewing(null); void loadVersions(doc.id);
  }

  async function createDoc(form: FormData) {
    if (!supabase) return;
    const title = String(form.get("title") ?? "").trim();
    if (title.length < 2) { notify("Give the document a title."); return; }
    const { data, error } = await supabase.from("documents").insert({
      project_id: projectId, title, document_type: String(form.get("type") ?? "note"), content_markdown: "# " + title + "\n\n", created_by: userId
    }).select("id,title,document_type,content_markdown,version,updated_at,workstream_id").single();
    if (error) { notify(error.message); return; }
    await load(); open(data as Doc);
  }

  async function save() {
    if (!supabase || !selected) return;
    const { data, error } = await supabase.from("documents").update({
      title: draft.title.trim() || selected.title, document_type: draft.type, content_markdown: draft.content, version: baseVersion
    }).eq("id", selected.id).select("id,title,document_type,content_markdown,version,updated_at,workstream_id").single();
    if (error) {
      if (error.code === "PT409" || error.message.includes("Version conflict")) { setConflict(true); notify("Someone else saved this document first. Reload to see their version."); }
      else notify(error.message);
      return;
    }
    const saved = data as Doc;
    setBaseVersion(saved.version); setConflict(false); notify("Saved as version " + saved.version + ".");
    await load(); void loadVersions(saved.id);
  }

  async function reload() {
    if (!supabase || !selected) return;
    const { data } = await supabase.from("documents").select("id,title,document_type,content_markdown,version,updated_at,workstream_id").eq("id", selected.id).single();
    if (data) { const doc = data as Doc; setDraft({ title: doc.title, type: doc.document_type, content: doc.content_markdown }); setBaseVersion(doc.version); setConflict(false); await load(); void loadVersions(doc.id); }
  }

  async function proposeDecision(form: FormData) {
    if (!supabase) return;
    const title = String(form.get("title") ?? "").trim();
    if (title.length < 2) { notify("Give the decision a title."); return; }
    const { error } = await supabase.from("decisions").insert({
      project_id: projectId, title, context: String(form.get("context") ?? ""), decision: String(form.get("decision") ?? ""),
      rationale: String(form.get("rationale") ?? ""), status: "proposed", created_by: userId
    });
    if (error) notify(error.message); else { notify("Decision proposed."); await load(); }
  }
  async function setDecisionStatus(decision: Decision, status: string) {
    if (!supabase) return;
    const { error } = await supabase.from("decisions").update({ status }).eq("id", decision.id);
    if (error) notify(error.message); else { notify("Decision " + status + "."); await load(); }
  }

  const filtered = useMemo(() => docs.filter((doc) => !search || doc.title.toLowerCase().includes(search.toLowerCase())), [docs, search]);

  return <div className="knowledge">
    <div className="pm-tabs" role="tablist">
      <button role="tab" aria-selected={tab === "documents"} className={tab === "documents" ? "active" : ""} onClick={() => setTab("documents")}><BookOpen size={13}/> Documents <span>{docs.length}</span></button>
      <button role="tab" aria-selected={tab === "decisions"} className={tab === "decisions" ? "active" : ""} onClick={() => setTab("decisions")}><Gavel size={13}/> Decisions <span>{decisions.length}</span></button>
    </div>

    {tab === "documents" && <div className="pm-split">
      <section className="panel pm-side">
        <div className="section-kicker">PROJECT KNOWLEDGE</div>
        <div className="search-field"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a document…"/></div>
        <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void createDoc(new FormData(form)).then(() => form.reset()); }}>
          <input name="title" placeholder="New document title" maxLength={180}/>
          <select name="type" defaultValue="note">{DOC_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select>
          <button className="button primary small"><FilePlus2 size={13}/> Create</button>
        </form>
        <div className="pm-list">{filtered.length ? filtered.map((doc) => <button key={doc.id} className={"pm-list-item" + (doc.id === selectedId ? " selected" : "")} onClick={() => open(doc)}>
          <strong>{doc.title}</strong><span>{doc.document_type} · v{doc.version} · {new Date(doc.updated_at).toLocaleDateString()}</span></button>) : <p className="evidence-empty">No documents yet. Write the first specification or architecture note.</p>}</div>
      </section>

      <section className="panel pm-main">
        {selected ? <>
          <div className="pm-main-head">
            <input className="pm-title-input" value={draft.title} maxLength={180} onChange={(event) => setDraft({ ...draft, title: event.target.value })} aria-label="Document title"/>
            <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })} aria-label="Document type">{DOC_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select>
            <button className="button secondary small" onClick={() => setPreview(!preview)}>{preview ? "Edit" : "Preview"}</button>
            <button className="button primary small" disabled={!dirty || conflict} onClick={() => void save()}><Save size={13}/> Save</button>
          </div>
          {conflict && <div className="inline-error">Another version was saved while you were editing. <button className="text-action" onClick={() => void reload()}><RefreshCw size={12}/> Reload latest (your edits will be replaced)</button></div>}
          {viewing ? <div className="pm-version-view">
            <div className="pm-version-banner">Viewing version {viewing.version} from {new Date(viewing.created_at).toLocaleString()}
              <button className="button secondary small" onClick={() => { setDraft({ ...draft, title: viewing.title, content: viewing.content_markdown }); setViewing(null); setPreview(false); }}>Restore as new edit</button>
              <button className="button secondary small" onClick={() => setViewing(null)}>Back</button></div>
            <div className="md-preview">{renderMarkdown(viewing.content_markdown)}</div>
          </div> : preview ? <div className="md-preview">{draft.content.trim() ? renderMarkdown(draft.content) : <p className="evidence-empty">This document is empty. Choose Edit to start writing.</p>}</div>
            : <textarea className="md-editor" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} spellCheck placeholder="Write in Markdown…" aria-label="Document content"/>}
          <div className="pm-columns">
            <LinksPanel key={selected.id} projectId={projectId} userId={userId} isOwner={isOwner} entityType="document" entityId={selected.id} onNotify={onNotify}/>
            <div className="links-panel"><div className="section-kicker"><History size={11}/> HISTORY</div>
              {versions.length ? <ul className="links-list">{versions.map((version) => <li key={version.id}><span className="evidence-pill">v{version.version}</span><span>{new Date(version.created_at).toLocaleString()}</span>
                <button className="text-action" onClick={() => setViewing(version)}>View</button></li>)}</ul> : <p className="evidence-empty">Earlier versions appear here after the first edit. Current: v{selected.version}.</p>}</div>
          </div>
        </> : <div className="empty-inline"><div className="empty-inline-icon"><BookOpen size={17}/></div><strong>Select or create a document</strong><p>Specifications, architecture notes, research and runbooks live here, versioned and linked to the work they explain.</p></div>}
      </section>
    </div>}

    {tab === "decisions" && <section className="panel full-panel">
      <div className="panel-heading"><div><div className="section-kicker">ARCHITECTURE DECISION RECORDS</div><h2>Decisions</h2><p>Anyone can propose. Owners accept. Accepted decisions are immutable; supersede them instead of rewriting history.</p></div></div>
      <form className="decision-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void proposeDecision(new FormData(form)).then(() => form.reset()); }}>
        <input name="title" placeholder="Decision title, e.g. Use an extended Kalman filter for state estimation" maxLength={180}/>
        <textarea name="context" placeholder="Context: what forces are at play?" rows={2}/>
        <textarea name="decision" placeholder="Decision: what will we do?" rows={2}/>
        <textarea name="rationale" placeholder="Rationale: why this over the alternatives?" rows={2}/>
        <button className="button primary small">Propose decision</button>
      </form>
      {decisions.length ? decisions.map((decision) => <div className="decision-row" key={decision.id}>
        <div className="evidence-task-head">
          <div className="protected-copy"><strong>{decision.title}</strong><span>{new Date(decision.created_at).toLocaleDateString()}</span></div>
          <span className={"evidence-pill " + (decision.status === "accepted" ? "ok" : decision.status === "proposed" ? "" : "warn")}>{DECISION_LABEL[decision.status] ?? decision.status}</span>
          {isOwner && decision.status === "proposed" && <><button className="button primary small" onClick={() => void setDecisionStatus(decision, "accepted")}>Accept</button><button className="button secondary small" onClick={() => void setDecisionStatus(decision, "rejected")}>Reject</button></>}
          {isOwner && decision.status === "accepted" && <button className="button secondary small" onClick={() => void setDecisionStatus(decision, "superseded")}>Supersede</button>}
          <button className="button secondary small" onClick={() => setOpenDecision(openDecision === decision.id ? "" : decision.id)}>{openDecision === decision.id ? "Close" : "Details"}</button>
        </div>
        {openDecision === decision.id && <div className="evidence-detail">
          {decision.context && <><strong>Context</strong><p>{decision.context}</p></>}
          {decision.decision && <><strong>Decision</strong><p>{decision.decision}</p></>}
          {decision.rationale && <><strong>Rationale</strong><p>{decision.rationale}</p></>}
          <LinksPanel projectId={projectId} userId={userId} isOwner={isOwner} entityType="decision" entityId={decision.id} onNotify={onNotify}/>
        </div>}
      </div>) : <p className="evidence-empty">No decisions recorded. Capture the next architecture choice so the team and its agents can rely on it.</p>}
    </section>}
  </div>;
}
