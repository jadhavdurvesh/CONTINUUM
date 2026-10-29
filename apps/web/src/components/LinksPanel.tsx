import { useCallback, useEffect, useState } from "react";
import { Link2, X } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useStable } from "../lib/hooks";

export type EntityType = "task" | "requirement" | "document" | "decision" | "issue" | "milestone" | "release" | "test_case";
type LinkRow = { id: string; source_type: EntityType; source_id: string; target_type: EntityType; target_id: string; relation: string; created_by: string };
type Option = { id: string; label: string };

const TABLE: Record<EntityType, { table: string; label: string; column: string }> = {
  task: { table: "tasks", label: "Task", column: "title" },
  requirement: { table: "requirements", label: "Requirement", column: "title" },
  document: { table: "documents", label: "Document", column: "title" },
  decision: { table: "decisions", label: "Decision", column: "title" },
  issue: { table: "issues", label: "Defect / risk", column: "title" },
  milestone: { table: "milestones", label: "Milestone", column: "title" },
  release: { table: "releases", label: "Release", column: "title" },
  test_case: { table: "test_cases", label: "Test case", column: "name" }
};
const RELATIONS = ["relates_to", "explains", "implements", "depends_on", "blocks", "tests", "decides", "supersedes"];

type Props = { projectId: string; userId: string; isOwner: boolean; entityType: EntityType; entityId: string; onNotify: (message: string) => void };

/** Typed links from one entity to anything else in the project: the project's knowledge graph. */
export default function LinksPanel({ projectId, userId, isOwner, entityType, entityId, onNotify }: Props) {
  const notify = useStable(onNotify);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [targetType, setTargetType] = useState<EntityType>("task");
  const [options, setOptions] = useState<Option[]>([]);
  const [targetId, setTargetId] = useState("");
  const [relation, setRelation] = useState("relates_to");

  const load = useCallback(async () => {
    if (!supabase) return;
    const [outgoing, incoming] = await Promise.all([
      supabase.from("project_links").select("*").eq("project_id", projectId).eq("source_type", entityType).eq("source_id", entityId),
      supabase.from("project_links").select("*").eq("project_id", projectId).eq("target_type", entityType).eq("target_id", entityId)
    ]);
    if (outgoing.error || incoming.error) { notify((outgoing.error ?? incoming.error)!.message); return; }
    const rows = [...((outgoing.data as LinkRow[]) ?? []), ...((incoming.data as LinkRow[]) ?? [])];
    setLinks(rows);
    const wanted = new Map<EntityType, Set<string>>();
    for (const row of rows) {
      const other = row.source_type === entityType && row.source_id === entityId ? [row.target_type, row.target_id] as const : [row.source_type, row.source_id] as const;
      if (!wanted.has(other[0])) wanted.set(other[0], new Set());
      wanted.get(other[0])!.add(other[1]);
    }
    const resolved: Record<string, string> = {};
    await Promise.all([...wanted.entries()].map(async ([type, ids]) => {
      const meta = TABLE[type];
      const { data } = await supabase!.from(meta.table).select("id," + meta.column).in("id", [...ids]);
      for (const item of ((data as unknown as Record<string, string>[] | null) ?? [])) resolved[type + ":" + item.id] = item[meta.column];
    }));
    setLabels(resolved);
  }, [projectId, entityType, entityId, notify]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) return;
      const meta = TABLE[targetType];
      const { data } = await supabase.from(meta.table).select("id," + meta.column).eq("project_id", projectId).order("created_at", { ascending: false }).limit(200);
      if (cancelled) return;
      const list = ((data as unknown as Record<string, string>[] | null) ?? []).filter((item) => !(targetType === entityType && item.id === entityId))
        .map((item) => ({ id: item.id, label: item[meta.column] }));
      setOptions(list); setTargetId("");
    })();
    return () => { cancelled = true; };
  }, [projectId, targetType, entityType, entityId]);

  async function add() {
    if (!supabase || !targetId) return;
    const { error } = await supabase.from("project_links").insert({
      project_id: projectId, source_type: entityType, source_id: entityId, target_type: targetType, target_id: targetId, relation, created_by: userId
    });
    if (error) { notify(error.message.includes("duplicate") ? "That link already exists." : error.message); return; }
    setTargetId(""); await load();
  }
  async function remove(link: LinkRow) {
    if (!supabase) return;
    const { error } = await supabase.from("project_links").delete().eq("id", link.id);
    if (error) notify(error.message); else await load();
  }

  return <div className="links-panel">
    <div className="section-kicker"><Link2 size={11}/> CONNECTED WORK</div>
    {links.length ? <ul className="links-list">{links.map((link) => {
      const outward = link.source_type === entityType && link.source_id === entityId;
      const type = outward ? link.target_type : link.source_type; const id = outward ? link.target_id : link.source_id;
      return <li key={link.id}>
        <span className="evidence-pill">{outward ? link.relation.replace("_", " ") : "is " + link.relation.replace("_", " ") + " by"}</span>
        <span className="links-type">{TABLE[type].label}</span>
        <strong>{labels[type + ":" + id] ?? "…"}</strong>
        {(link.created_by === userId || isOwner) && <button className="icon-quiet" aria-label="Remove link" onClick={() => void remove(link)}><X size={13}/></button>}
      </li>;
    })}</ul> : <p className="evidence-empty">Nothing is linked yet. Connect this to the tasks, requirements, decisions or tests it relates to.</p>}
    <div className="evidence-inline-form">
      <select value={relation} onChange={(event) => setRelation(event.target.value)} aria-label="Relation">{RELATIONS.map((item) => <option key={item} value={item}>{item.replace("_", " ")}</option>)}</select>
      <select value={targetType} onChange={(event) => setTargetType(event.target.value as EntityType)} aria-label="Type">{(Object.keys(TABLE) as EntityType[]).map((type) => <option key={type} value={type}>{TABLE[type].label}</option>)}</select>
      <select value={targetId} onChange={(event) => setTargetId(event.target.value)} aria-label="Item"><option value="">Choose…</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
      <button className="button secondary small" disabled={!targetId} onClick={() => void add()}>Link</button>
    </div>
  </div>;
}
