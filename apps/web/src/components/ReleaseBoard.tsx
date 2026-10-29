import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, PackageCheck, RefreshCw, Rocket } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useStable } from "../lib/hooks";
import LinksPanel from "./LinksPanel";

type Release = { id: string; version_label: string; title: string; status: string; release_notes: string | null; commit_sha: string | null; released_at: string | null };
type Readiness = { ready: boolean; blockers: string[]; requirements: { id: string; title: string; status: string }[] };
type Requirement = { id: string; title: string; status: string };
type Props = { projectId: string; userId: string; isOwner: boolean; onNotify: (message: string) => void; onChanged: () => void };

const EDITABLE_STATUS = ["planned", "building", "verification", "failed"];

export default function ReleaseBoard({ projectId, userId, isOwner, onNotify, onChanged }: Props) {
  const notify = useStable(onNotify);
  const [releases, setReleases] = useState<Release[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [notes, setNotes] = useState("");
  const [sha, setSha] = useState("");

  const selected = releases.find((release) => release.id === selectedId) ?? null;
  const frozen = !!selected && ["released", "rolled_back"].includes(selected.status);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [releaseResult, requirementResult] = await Promise.all([
      supabase.from("releases").select("id,version_label,title,status,release_notes,commit_sha,released_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(100),
      supabase.from("requirements").select("id,title,status").eq("project_id", projectId).order("created_at", { ascending: true }).limit(300)
    ]);
    const error = releaseResult.error ?? requirementResult.error;
    if (error) notify(error.message);
    setReleases((releaseResult.data as Release[] | null) ?? []); setRequirements((requirementResult.data as Requirement[] | null) ?? []);
  }, [projectId, notify]);
  useEffect(() => { void load(); }, [load]);

  const loadReadiness = useCallback(async (releaseId: string) => {
    if (!supabase) return;
    const { data, error } = await supabase.rpc("release_readiness", { p_release_id: releaseId });
    if (error) notify(error.message);
    setReadiness((data as Readiness | null) ?? null);
  }, [notify]);

  useEffect(() => {
    if (!selectedId) { setReadiness(null); return; }
    void loadReadiness(selectedId);
  }, [selectedId, releases, loadReadiness]);

  function choose(release: Release) { setSelectedId(release.id); setNotes(release.release_notes ?? ""); setSha(release.commit_sha ?? ""); }

  async function run(action: PromiseLike<{ error: { message: string } | null }>, success: string) {
    const { error } = await action;
    if (error) { notify(error.message); return false; }
    notify(success); await load(); onChanged(); return true;
  }

  async function generateNotes() {
    if (!supabase || !selected || !readiness) return;
    const ids = readiness.requirements.map((requirement) => requirement.id);
    const { data } = ids.length ? await supabase.from("tasks").select("title,requirement_id,status").in("requirement_id", ids).eq("status", "done") : { data: [] };
    const doneTasks = (data as { title: string; requirement_id: string }[] | null) ?? [];
    const lines = ["# " + selected.version_label + " — " + selected.title, "", "## Verified requirements", ""];
    for (const requirement of readiness.requirements) {
      lines.push("- " + requirement.title + (requirement.status === "verified" ? "" : " (NOT VERIFIED)"));
      for (const task of doneTasks.filter((item) => item.requirement_id === requirement.id)) lines.push("  - " + task.title);
    }
    setNotes(lines.join("\n"));
  }

  const scopeIds = new Set(readiness?.requirements.map((requirement) => requirement.id) ?? []);

  return <div className="knowledge">
    <div className="pm-split">
      <section className="panel pm-side">
        <div className="section-kicker">RELEASES</div>
        <form className="evidence-inline-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
          const label = String(data.get("label") ?? "").trim(); const title = String(data.get("title") ?? "").trim();
          if (!label || title.length < 2) { notify("Give the release a version and a title."); return; }
          void run(supabase!.from("releases").insert({ project_id: projectId, version_label: label, title, created_by: userId }), "Release created.").then(() => form.reset()); }}>
          <input name="label" placeholder="v0.1.0" maxLength={40} style={{ maxWidth: 90, minWidth: 70 }}/><input name="title" placeholder="Release title" maxLength={180}/><button className="button primary small">Create</button></form>
        <div className="pm-list">{releases.length ? releases.map((release) => <button key={release.id} className={"pm-list-item" + (release.id === selectedId ? " selected" : "")} onClick={() => choose(release)}>
          <strong>{release.version_label} · {release.title}</strong><span>{release.status.replace("_", " ")}{release.released_at ? " · " + new Date(release.released_at).toLocaleDateString() : ""}</span></button>)
          : <p className="evidence-empty">No releases yet. Create one and scope it to the requirements it must deliver.</p>}</div>
      </section>

      <section className="panel pm-main">
        {selected ? <>
          <div className="pm-main-head"><h2 className="pm-title">{selected.version_label} — {selected.title}</h2>
            <span className={"evidence-pill " + (selected.status === "released" || selected.status === "ready" ? "ok" : "")}>{selected.status.replace("_", " ")}</span>
            <button className="button secondary small" onClick={() => void loadReadiness(selected.id)}><RefreshCw size={13}/> Re-check</button></div>

          <div className="evidence-detail">
            <div className="section-kicker"><PackageCheck size={11}/> READINESS</div>
            {readiness?.blockers.length ? <ul className="evidence-blockers">{readiness.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
              : <p className="evidence-ok"><CheckCircle2 size={12}/> Every requirement in scope is verified and no high-severity defect is open.</p>}
          </div>

          <div className="links-panel"><div className="section-kicker">SCOPE — REQUIREMENTS DELIVERED</div>
            {requirements.length ? requirements.map((requirement) => { const inScope = scopeIds.has(requirement.id);
              return <label className="pm-scope-row" key={requirement.id}>
                <input type="checkbox" checked={inScope} disabled={frozen} onChange={() => void run(inScope
                  ? supabase!.from("release_requirements").delete().eq("release_id", selected.id).eq("requirement_id", requirement.id)
                  : supabase!.from("release_requirements").insert({ project_id: projectId, release_id: selected.id, requirement_id: requirement.id, created_by: userId }), inScope ? "Removed from scope." : "Added to scope.").then(() => loadReadiness(selected.id))}/>
                <span>{requirement.title}</span><span className={"evidence-pill " + (requirement.status === "verified" ? "ok" : "warn")}>{requirement.status}</span></label>; })
              : <p className="evidence-empty">Add requirements on the Evidence page first.</p>}
            {frozen && <p className="evidence-footnote">The scope of a released version is frozen.</p>}</div>

          <div className="links-panel"><div className="section-kicker">RELEASE NOTES</div>
            <textarea className="md-editor short" value={notes} disabled={frozen} onChange={(event) => setNotes(event.target.value)} placeholder="Generate notes from the verified scope, then edit."/>
            <div className="evidence-actions"><button className="button secondary small" disabled={frozen} onClick={() => void generateNotes()}>Generate from scope</button>
              <button className="button secondary small" disabled={frozen || notes === (selected.release_notes ?? "")} onClick={() => void run(supabase!.from("releases").update({ release_notes: notes }).eq("id", selected.id), "Notes saved.")}>Save notes</button></div></div>

          {!frozen && <div className="links-panel"><div className="section-kicker"><Rocket size={11}/> PROMOTE</div>
            <div className="evidence-inline-form">
              <select value={EDITABLE_STATUS.includes(selected.status) ? selected.status : ""} onChange={(event) => event.target.value && void run(supabase!.from("releases").update({ status: event.target.value }).eq("id", selected.id), "Status updated.")} aria-label="Release stage">
                {!EDITABLE_STATUS.includes(selected.status) && <option value="">{selected.status}</option>}{EDITABLE_STATUS.map((status) => <option key={status} value={status}>{status.replace("_", " ")}</option>)}</select>
              <button className="button secondary small" disabled={selected.status === "ready"} onClick={() => void run(supabase!.from("releases").update({ status: "ready" }).eq("id", selected.id), "Release marked ready.")}>Mark ready</button></div>
            {isOwner ? <div className="evidence-inline-form"><input value={sha} onChange={(event) => setSha(event.target.value)} placeholder="Commit SHA being released" maxLength={64}/>
              <button className="button primary small" disabled={!readiness?.ready || !sha.trim()} onClick={() => void run(supabase!.from("releases").update({ status: "released", commit_sha: sha.trim() }).eq("id", selected.id), "Release published.")}>Release</button></div>
              : <p className="evidence-footnote">Only project owners can publish a release.</p>}</div>}

          <LinksPanel key={selected.id} projectId={projectId} userId={userId} isOwner={isOwner} entityType="release" entityId={selected.id} onNotify={onNotify}/>
        </> : <div className="empty-inline"><div className="empty-inline-icon"><Rocket size={17}/></div><strong>Select or create a release</strong><p>A release is ready only when everything in its scope is verified and nothing serious is open.</p></div>}
      </section>
    </div>
  </div>;
}
