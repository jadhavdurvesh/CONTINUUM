import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { supabase } from "../lib/supabase";

type Hit = { type: string; id: string; title: string; status: string | null; snippet: string; updated_at: string };
type Props = { projectId: string; open: boolean; onClose: () => void; onNavigate: (page: string) => void };

const LABEL: Record<string, string> = { task: "Task", requirement: "Requirement", document: "Document", decision: "Decision", issue: "Defect", milestone: "Milestone", release: "Release", test_case: "Test" };
const PAGE: Record<string, string> = { task: "Plan", requirement: "Evidence", document: "Documentation", decision: "Documentation", issue: "Quality", milestone: "Plan", release: "Releases", test_case: "Quality" };

/** Ctrl/⌘+K palette: one search box over every kind of project record. Row-level security decides what appears. */
export default function GlobalSearch({ projectId, open, onClose, onNavigate }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQuery(""); setHits([]); setActive(0); setMessage(""); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  useEffect(() => {
    if (!open || !supabase) return;
    const text = query.trim();
    if (text.length < 2) { setHits([]); setMessage(""); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { data, error } = await supabase!.rpc("search_project", { p_project_id: projectId, p_query: text, p_limit: 30 });
      if (cancelled) return;
      if (error) { setMessage(error.message.includes("search_project") ? "Search needs migration 202610290001 on your Supabase project." : error.message); setHits([]); return; }
      setMessage(""); setHits((data as Hit[] | null) ?? []); setActive(0);
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, open, projectId]);

  if (!open) return null;
  const choose = (hit: Hit) => { onNavigate(PAGE[hit.type] ?? "Overview"); onClose(); };

  return <div className="search-backdrop" role="dialog" aria-modal="true" aria-label="Search the project" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="search-panel">
      <div className="search-input"><Search size={15}/><input ref={input} value={query} placeholder="Search tasks, requirements, documents, decisions, defects, releases…" aria-label="Search"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(value + 1, Math.max(hits.length - 1, 0))); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); }
          else if (event.key === "Enter" && hits[active]) choose(hits[active]);
        }}/><kbd>Esc</kbd></div>
      <div className="search-results">
        {message && <p className="evidence-empty">{message}</p>}
        {!message && query.trim().length >= 2 && !hits.length && <p className="evidence-empty">Nothing matches “{query.trim()}”.</p>}
        {!message && query.trim().length < 2 && <p className="evidence-empty">Type at least two characters. Results come only from this project.</p>}
        {hits.map((hit, index) => <button key={hit.type + hit.id} className={"search-hit" + (index === active ? " active" : "")} onMouseEnter={() => setActive(index)} onClick={() => choose(hit)}>
          <span className="evidence-pill">{LABEL[hit.type] ?? hit.type}</span>
          <span className="search-hit-copy"><strong>{hit.title}</strong>{hit.snippet && <small>{hit.snippet.replace(/\s+/g, " ")}</small>}</span>
          {hit.status && <span className="evidence-pill">{hit.status.replace("_", " ")}</span>}
        </button>)}
      </div>
    </div>
  </div>;
}
