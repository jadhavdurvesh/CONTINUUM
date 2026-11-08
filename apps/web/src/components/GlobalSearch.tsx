import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { supabase } from "../lib/supabase";

type Hit = { type: string; id: string; title: string; status: string | null; snippet: string; updated_at: string };
type Item = { kind: "page"; label: string } | { kind: "hit"; hit: Hit };
type Props = { projectId: string; pages: string[]; open: boolean; onClose: () => void; onNavigate: (page: string) => void };

const LABEL: Record<string, string> = { task: "Task", requirement: "Requirement", document: "Document", decision: "Decision", issue: "Defect", milestone: "Milestone", release: "Release", test_case: "Test" };
const PAGE: Record<string, string> = { task: "Plan", requirement: "Evidence", document: "Documentation", decision: "Documentation", issue: "Quality", milestone: "Plan", release: "Releases", test_case: "Quality" };

/** One palette for the whole workspace: jump to any page, or find any task, document, decision, defect or release. */
export default function GlobalSearch({ projectId, pages, open, onClose, onNavigate }: Props) {
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

  const text = query.trim().toLowerCase();
  const pageItems = useMemo<Item[]>(() => pages.filter((label) => !text || label.toLowerCase().includes(text)).slice(0, text ? 4 : 8).map((label) => ({ kind: "page", label })), [pages, text]);
  const items: Item[] = [...pageItems, ...hits.map((hit): Item => ({ kind: "hit", hit }))];

  if (!open) return null;
  const choose = (item: Item) => { onNavigate(item.kind === "page" ? item.label : PAGE[item.hit.type] ?? "Overview"); onClose(); };

  return <div className="search-backdrop" role="dialog" aria-modal="true" aria-label="Search the project" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="search-panel">
      <div className="search-input"><Search size={16}/><input ref={input} value={query} placeholder="Search work, documents and decisions, or jump to a page…" aria-label="Search"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(value + 1, Math.max(items.length - 1, 0))); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); }
          else if (event.key === "Enter" && items[active]) choose(items[active]);
        }}/><kbd>Esc</kbd></div>
      <div className="search-results">
        {message && <p className="evidence-empty">{message}</p>}
        {pageItems.length > 0 && <div className="search-group">{text ? "Pages" : "Go to"}</div>}
        {items.map((item, index) => <div key={index}>
          {index === pageItems.length && hits.length > 0 && <div className="search-group">Results</div>}
          {item.kind === "page"
            ? <button className={"search-hit" + (index === active ? " active" : "")} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}><span className="search-hit-copy"><strong>{item.label}</strong></span><span className="search-enter"><CornerDownLeft size={12}/></span></button>
            : <button className={"search-hit" + (index === active ? " active" : "")} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
                <span className="evidence-pill">{LABEL[item.hit.type] ?? item.hit.type}</span>
                <span className="search-hit-copy"><strong>{item.hit.title}</strong>{item.hit.snippet && <small>{item.hit.snippet.replace(/\s+/g, " ")}</small>}</span>
                {item.hit.status && <span className="evidence-pill">{item.hit.status.replace("_", " ")}</span>}</button>}
        </div>)}
        {text.length >= 2 && !hits.length && !message && <p className="evidence-empty">No matching work or documents for “{query.trim()}”.</p>}
      </div>
    </div>
  </div>;
}
