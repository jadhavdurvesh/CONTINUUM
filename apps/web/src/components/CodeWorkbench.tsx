import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Code2, FileCode2, FilePlus2, FileText, Folder, GitBranch, History, LockKeyhole, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2, X } from "lucide-react";
import { supabase } from "../lib/supabase";

type CodeFile = { id: string; project_id: string; path: string; language: string; content: string; version: number; created_by: string; updated_by: string | null; created_at: string; updated_at: string };
type FileVersion = { id: string; code_file_id: string | null; path: string; language: string; version: number; content: string; saved_by: string | null; saved_at: string };
type Props = { projectId: string; userId: string; isOwner: boolean; onNotify: (message: string) => void };

const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "#20211e", color: "#e9e5da", fontSize: "12px" },
  ".cm-scroller": { fontFamily: "'DM Mono', 'Cascadia Code', Consolas, monospace", lineHeight: "1.75", overflow: "auto" },
  ".cm-gutters": { backgroundColor: "#20211e", color: "#66685e", border: "none", borderRight: "1px solid #32342f" },
  ".cm-activeLineGutter": { backgroundColor: "#2a2c27", color: "#bab5a6" },
  ".cm-activeLine": { backgroundColor: "#ffffff06" },
  ".cm-cursor": { borderLeftColor: "#e27759" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "#6f4c405d !important" },
  ".cm-focused": { outline: "none" },
  ".cm-tooltip": { backgroundColor: "#292b26", color: "#ede7da", border: "1px solid #45473e" }
}, { dark: true });

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string,string> = { ts:"typescript",tsx:"typescript",js:"javascript",jsx:"javascript",mjs:"javascript",py:"python",html:"html",htm:"html",css:"css",scss:"css",json:"json",md:"markdown",mdx:"markdown",yml:"yaml",yaml:"yaml",xml:"html",sql:"sql",sh:"shell",bash:"shell",c:"c",h:"c",cpp:"cpp",hpp:"cpp",java:"java",kt:"kotlin",rs:"rust",go:"go",txt:"plaintext",env:"shell",toml:"toml",ino:"cpp" };
  return map[ext] ?? "plaintext";
}
function languageExtensions(language: string) {
  switch (language) {
    case "typescript": return [javascript({typescript:true,jsx:true})];
    case "javascript": return [javascript({jsx:true})];
    case "python": return [python()];
    case "html": return [html()];
    case "css": return [css()];
    case "json": return [json()];
    case "markdown": return [markdown()];
    default: return [];
  }
}
function safePath(path: string) {
  const value = path.trim().replace(/\\/g, "/");
  return Boolean(value && value.length <= 240 && !value.startsWith("/") && !/^[a-z]:/i.test(value)
    && value.split("/").every(part => part && part !== "." && part !== ".." && !/[<>:"|?*\u0000-\u001f]/.test(part)));
}
function basename(path: string) { return path.split("/").pop() ?? path; }

export default function CodeWorkbench({ projectId, userId, isOwner, onNotify }: Props) {
  const [files, setFiles] = useState<CodeFile[]>([]);
  const [locks, setLocks] = useState<any[]>([]);
  const [grants, setGrants] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [tabs, setTabs] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [filterText, setFilterText] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newContent, setNewContent] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<FileVersion[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [conflict, setConflict] = useState<CodeFile | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [fileActions, setFileActions] = useState(false);
  const [lastSaved, setLastSaved] = useState("");
  const draftRef = useRef(draft);
  const dirtyRef = useRef(dirty);
  const selectedRef = useRef(selectedId);
  draftRef.current = draft;
  dirtyRef.current = dirty;
  selectedRef.current = selectedId;

  const selected = files.find(file => file.id === selectedId) ?? null;
  const lock = locks.find(item => item.resource_type === "code_file" && item.resource_id === selected?.id);
  const isLocked = Boolean(lock?.is_locked);
  const ownGrant = grants.some(grant => grant.resource_id === selected?.id && grant.user_id === userId && grant.permitted_action === "edit" && !grant.revoked_at && (!grant.expires_at || new Date(grant.expires_at).getTime() > Date.now()));
  const canEdit = !isLocked || ownGrant;
  const filteredFiles = useMemo(() => files.filter(file => file.path.toLowerCase().includes(filterText.toLowerCase())), [files, filterText]);
  const langs = useMemo(() => selected ? languageExtensions(selected.language) : [], [selected?.language]);

  const refresh = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [filesResult, locksResult, grantsResult] = await Promise.all([
      supabase.from("code_files").select("*").eq("project_id", projectId).order("path", {ascending:true}),
      supabase.from("resource_locks").select("*").eq("project_id", projectId).eq("resource_type","code_file").eq("is_locked",true),
      supabase.from("permission_grants").select("*").eq("project_id",projectId).eq("resource_type","code_file").eq("user_id",userId).is("revoked_at",null)
    ]);
    if (filesResult.error) setError(filesResult.error.message);
    else {
      const list = (filesResult.data ?? []) as CodeFile[];
      setFiles(list);
      setSelectedId(current => list.some(file => file.id === current) ? current : list[0]?.id ?? "");
      setTabs(current => {
        const open = current.filter(id => list.some(file => file.id === id));
        return open.length ? open : (list[0] ? [list[0].id] : []);
      });
    }
    if (locksResult.error) setError(old => old || locksResult.error.message);
    else setLocks(locksResult.data ?? []);
    if (!grantsResult.error) setGrants(grantsResult.data ?? []);
    setLoading(false);
  }, [projectId,userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!selected) {
      setDraft("");
      setDirty(false);
      return;
    }
    if (dirtyRef.current && selected.id === selectedRef.current) return;
    setDraft(selected.content);
    setDirty(false);
    setConflict(null);
  }, [selected?.id,selected?.version]);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    const filter = "project_id=eq." + projectId;
    const channel = client.channel("code-workbench-" + projectId)
      .on("postgres_changes",{event:"*",schema:"public",table:"code_files",filter},(payload:any)=>{
        if (payload.eventType === "DELETE") {
          const old = payload.old as Partial<CodeFile>;
          setFiles(current=>current.filter(file=>file.id!==old.id));
          setTabs(current=>current.filter(id=>id!==old.id));
          setSelectedId(current=>current===old.id?"":current);
          return;
        }
        const incoming = payload.new as CodeFile;
        setFiles(current=>{
          const exists=current.some(file=>file.id===incoming.id);
          return (exists?current.map(file=>file.id===incoming.id?incoming:file):[...current,incoming]).sort((a,b)=>a.path.localeCompare(b.path));
        });
        if (incoming.id===selectedRef.current) {
          if (dirtyRef.current && incoming.content!==draftRef.current && incoming.updated_by!==userId) setConflict(incoming);
          else if (incoming.content===draftRef.current) { setConflict(null); setDirty(false); }
        }
      })
      .on("postgres_changes",{event:"*",schema:"public",table:"resource_locks",filter},()=>{
        void client.from("resource_locks").select("*").eq("project_id",projectId).eq("resource_type","code_file").eq("is_locked",true).then(({data})=>setLocks(data??[]));
      })
      .on("postgres_changes",{event:"*",schema:"public",table:"permission_grants",filter},()=>{
        void client.from("permission_grants").select("*").eq("project_id",projectId).eq("resource_type","code_file").eq("user_id",userId).is("revoked_at",null).then(({data})=>setGrants(data??[]));
      }).subscribe();
    return () => { void client.removeChannel(channel); };
  },[projectId,userId,refresh]);

  function openFile(file: CodeFile) {
    if (dirty && selected && selected.id!==file.id && !window.confirm("Discard unsaved edits and open another file?")) return;
    setSelectedId(file.id);
    setTabs(current=>current.includes(file.id)?current:[...current,file.id]);
    setDraft(file.content);
    setDirty(false);
    setShowHistory(false);
    setConflict(null);
  }

  async function saveFile() {
    if (!supabase || !selected || saving || !dirty || !canEdit) return;
    if (new TextEncoder().encode(draft).length>1500000) { onNotify("This file exceeds the 1.5 MB limit."); return; }
    setSaving(true);
    setError("");
    const {data,error:saveError}=await supabase.from("code_files").update({content:draft,updated_by:userId})
      .eq("id",selected.id).eq("version",selected.version).select("*").maybeSingle();
    setSaving(false);
    if (saveError) {
      setError(saveError.message);
      onNotify(saveError.message.toLowerCase().includes("protected")?"File is protected. Request permission or ask the owner to unlock it.":"Save failed; your editor draft remains.");
      return;
    }
    if (!data) {
      const latest=await supabase.from("code_files").select("*").eq("id",selected.id).maybeSingle();
      if (latest.data) setConflict(latest.data as CodeFile);
      onNotify("A collaborator changed this file. Your draft is preserved; resolve the conflict before retrying.");
      return;
    }
    const saved=data as CodeFile;
    setFiles(current=>current.map(file=>file.id===saved.id?saved:file));
    setDraft(saved.content);
    setDirty(false);
    setConflict(null);
    setLastSaved(new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}));
    onNotify("Saved version "+saved.version+".");
  }

  async function createFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    const path=newPath.trim().replace(/\\/g,"/");
    if (!safePath(path)) { onNotify("Enter a safe relative path, for example src/main.py."); return; }
    if (files.some(file=>file.path.toLowerCase()===path.toLowerCase())) { onNotify("A file with that path already exists."); return; }
    if (new TextEncoder().encode(newContent).length>1500000) { onNotify("Files must be under 1.5 MB."); return; }
    const {data,error:createError}=await supabase.from("code_files").insert({project_id:projectId,path,language:languageFor(path),content:newContent,version:1,created_by:userId}).select("*").single();
    if (createError) { onNotify(createError.message); return; }
    const file=data as CodeFile;
    setFiles(current=>[...current,file].sort((a,b)=>a.path.localeCompare(b.path)));
    setSelectedId(file.id);
    setTabs(current=>[...new Set([...current,file.id])]);
    setDraft(file.content);
    setDirty(false);
    setNewPath("");
    setNewContent("");
    setShowCreate(false);
    onNotify("Created "+file.path+".");
  }

  async function toggleLock() {
    if (!supabase || !selected || !isOwner) return;
    if (lock) {
      const {error:unlockError}=await supabase.from("resource_locks").update({is_locked:false}).eq("id",lock.id);
      if (unlockError) onNotify(unlockError.message); else onNotify("File unlocked.");
    } else {
      const {error:lockError}=await supabase.from("resource_locks").upsert({project_id:projectId,resource_type:"code_file",resource_id:selected.id,reason:"Protected by project owner",locked_by:userId,is_locked:true},{onConflict:"project_id,resource_type,resource_id"});
      if (lockError) onNotify(lockError.message); else onNotify("File protected from editing.");
    }
    const {data}=await supabase.from("resource_locks").select("*").eq("project_id",projectId).eq("resource_type","code_file").eq("is_locked",true);
    setLocks(data??[]);
  }

  async function loadHistory() {
    if (!supabase || !selected) return;
    setLoadingHistory(true);
    const {data,error:historyError}=await supabase.from("code_file_versions").select("*").eq("code_file_id",selected.id).order("version",{ascending:false}).limit(30);
    if (historyError) onNotify(historyError.message); else setHistory((data??[]) as FileVersion[]);
    setLoadingHistory(false);
    setShowHistory(true);
  }
  function restoreVersion(version: FileVersion) {
    if (!canEdit) { onNotify("This file is protected; request access or ask the owner to unlock it."); return; }
    if (dirty && !window.confirm("Replace your unsaved draft with this historical version?")) return;
    setDraft(version.content);
    setDirty(true);
    setConflict(null);
    setShowHistory(false);
    onNotify("Historical version loaded as a draft. Save to create a new version.");
  }
  async function deleteFile() {
    if (!supabase || !selected || !isOwner || isLocked) return;
    if (!window.confirm("Delete "+selected.path+"? Prior saved versions remain in history.")) return;
    const {error:deleteError}=await supabase.from("code_files").delete().eq("id",selected.id);
    if (deleteError) { onNotify(deleteError.message); return; }
    setFiles(current=>current.filter(file=>file.id!==selected.id));
    setTabs(current=>current.filter(id=>id!==selected.id));
    setSelectedId("");
    setDraft("");
    setDirty(false);
    onNotify("File deleted.");
  }

  const treeItems=useMemo(()=>{
    const folders=new Set<string>();
    for (const file of filteredFiles) {
      const parts=file.path.split("/");
      let current="";
      for(let i=0;i<parts.length-1;i++){current=current?current+"/"+parts[i]:parts[i];folders.add(current);}
    }
    return [
      ...[...folders].map(path=>({path,folder:true as const,file:undefined})),
      ...filteredFiles.map(file=>({path:file.path,folder:false as const,file}))
    ].sort((a,b)=>a.path.split("/").length-b.path.split("/").length||a.path.localeCompare(b.path));
  },[filteredFiles]);

  function keyboardShortcut(event: KeyboardEvent<HTMLElement>) {
    if ((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="s") { event.preventDefault(); void saveFile(); }
    if ((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="p") { event.preventDefault(); document.querySelector<HTMLInputElement>(".ide-search input")?.focus(); }
  }

  if (!supabase) return <section className="workbench-setup"><Code2 size={25}/><h2>Connect the shared cloud workspace</h2><p>Configure the hosted database URL and publishable key first. Files are stored in the cloud and shared across authorized accounts.</p></section>;

  return <section className="code-workbench" onKeyDownCapture={keyboardShortcut}>
    <div className="ide-toolbar">
      <div className="ide-breadcrumb"><span>WORKSPACE</span><ChevronRight size={13}/><strong>Code Workbench</strong>{selected&&<><ChevronRight size={13}/><span>{selected.path}</span></>}</div>
      <div className="ide-toolbar-actions"><span className="ide-cloud"><span className="online-pulse"/> CLOUD FILES</span><button className="ide-icon-button" title="Refresh files" onClick={()=>void refresh()}><RefreshCw size={15}/></button><button className="ide-action" onClick={()=>setShowCreate(true)}><FilePlus2 size={15}/> New file</button></div>
    </div>
    <div className="ide-main">
      {sidebarVisible&&<aside className="ide-file-sidebar">
        <div className="ide-sidebar-head"><div><span>EXPLORER</span><strong>{files.length} FILE{files.length===1?"":"S"}</strong></div><div className="ide-mini-actions"><button title="New file" onClick={()=>setShowCreate(true)}><Plus size={15}/></button><button title="Refresh" onClick={()=>void refresh()}><RefreshCw size={14}/></button><button title="Hide explorer" onClick={()=>setSidebarVisible(false)}><PanelLeftClose size={14}/></button></div></div>
        <label className="ide-search"><Search size={13}/><input value={filterText} onChange={event=>setFilterText(event.target.value)} placeholder="Find files…"/></label>
        <div className="ide-tree-root"><ChevronDown size={13}/><span>PROJECT FILES</span></div>
        {loading?<div className="ide-empty-tree">Loading files…</div>:error?<div className="ide-error-tree"><AlertTriangle size={15}/>{error}</div>:treeItems.length===0?<div className="ide-empty-tree"><FileText size={20}/><span>No files yet</span><button onClick={()=>setShowCreate(true)}>Create first file</button></div>:<div className="ide-tree">{treeItems.map(item=>{
          const parts=item.path.split("/");
          const file=item.file;
          return <button type="button" key={(file?.id??item.path)} className={"ide-tree-item "+(file?.id===selectedId?"active":"")+(item.folder?" folder":"")} style={{paddingLeft:10+(parts.length-1)*13}} onClick={()=>file&&openFile(file)} disabled={item.folder}>
            {item.folder?<Folder size={14}/>:<FileCode2 size={14}/>}<span>{basename(item.path)}</span>{file&&locks.some(l=>l.resource_id===file.id)&&<LockKeyhole size={11} className="ide-lock-mark"/>}
          </button>;
        })}</div>}
        <div className="ide-sidebar-foot"><ShieldCheck size={13}/><span>Shared · versioned saves</span></div>
      </aside>}
      <div className="ide-editor-column">
        <div className="ide-tabs">
          {!sidebarVisible&&<button className="ide-tab-restore" onClick={()=>setSidebarVisible(true)} title="Show explorer"><PanelLeftOpen size={15}/></button>}
          {tabs.map(id=>files.find(file=>file.id===id)).filter((file):file is CodeFile=>Boolean(file)).map(file=><button type="button" key={file.id} className={"ide-tab "+(file.id===selectedId?"current":"")} onClick={()=>openFile(file)}><FileCode2 size={13}/><span>{basename(file.path)}</span>{file.id===selectedId&&dirty&&<i/>}<span className="tab-close" onClick={event=>{event.stopPropagation();if(selectedId===file.id&&dirty&&!window.confirm("Close this tab and discard unsaved edits?"))return;setTabs(ids=>ids.filter(id=>id!==file.id));if(selectedId===file.id){setSelectedId("");setDraft("");setDirty(false);}}}><X size={12}/></span></button>)}
          {tabs.length===0&&<div className="ide-no-tab">No file open</div>}
          <div className="ide-tabs-spacer"/>
          {selected&&<button type="button" className={"ide-tab-action "+(showHistory?"on":"")} title="Version history" onClick={()=>showHistory?setShowHistory(false):void loadHistory()}><History size={15}/></button>}
          {selected&&<button type="button" className="ide-tab-action" title="File actions" onClick={()=>setFileActions(open=>!open)}><MoreHorizontal size={16}/></button>}
          {fileActions&&selected&&<div className="ide-file-menu">{isOwner&&<button onClick={()=>{setFileActions(false);onNotify("File: "+selected.path+" · version "+selected.version);}}><FileText size={14}/> File information</button>}{isOwner&&<button onClick={()=>{void toggleLock();setFileActions(false);}}><LockKeyhole size={14}/>{isLocked?"Unlock file":"Protect file"}</button>}{isOwner&&<button className="danger" disabled={isLocked} onClick={()=>{void deleteFile();setFileActions(false);}}><Trash2 size={14}/> Delete file</button>}</div>}
        </div>
        {conflict&&<div className="ide-conflict"><AlertTriangle size={15}/><div><strong>Cloud version changed</strong><span>Your editor draft is preserved. Load the latest cloud copy, or keep your draft and manually reconcile before saving.</span></div><button onClick={()=>{setFiles(current=>current.map(file=>file.id===conflict.id?conflict:file));setDraft(conflict.content);setDirty(false);setConflict(null);}}>Load cloud version</button><button className="ide-conflict-dismiss" onClick={()=>setConflict(null)} title="Keep draft"><X size={14}/></button></div>}
        {showHistory&&selected?<div className="ide-history-view"><div className="ide-history-heading"><div><span>VERSION CONTROL</span><h3>Saved history</h3><p>Older saved contents are retained as read-only snapshots.</p></div><button className="ide-icon-button" onClick={()=>setShowHistory(false)}><X size={16}/></button></div>{loadingHistory?<div className="ide-history-empty">Loading history…</div>:history.length===0?<div className="ide-history-empty">No previous versions yet. Your first change will create history.</div>:<div className="ide-history-list">{history.map(version=><div className="ide-history-row" key={version.id}><div className="history-version">v{version.version}</div><div className="history-copy"><strong>{version.path}</strong><span>{new Date(version.saved_at).toLocaleString()} · {version.saved_by===userId?"You":"Collaborator"}</span></div><button onClick={()=>restoreVersion(version)} disabled={!canEdit}>Load draft</button></div>)}</div>}</div>:selected?<div className="ide-editor-wrap">
          <div className="ide-file-meta"><div><FileCode2 size={14}/><span>{selected.path}</span><span className="ide-meta-dot">·</span><span>{selected.language}</span><span className="ide-version">v{selected.version}</span></div><div className="ide-file-state">{isLocked&&!canEdit?<span className="ide-state-locked"><LockKeyhole size={12}/> Protected</span>:dirty?<span className="ide-state-dirty"><i/> Unsaved</span>:<span className="ide-state-saved"><Check size={12}/>{lastSaved?"Saved "+lastSaved:"Saved to cloud"}</span>}</div></div>
          {isLocked&&!canEdit&&<div className="ide-locked-banner"><LockKeyhole size={14}/><span>This file is protected. Request a temporary edit grant or ask the owner to unlock it.</span></div>}
          <div className="ide-code-area"><CodeMirror value={draft} height="100%" theme={editorTheme} extensions={langs} editable={canEdit} readOnly={!canEdit} onChange={value=>{setDraft(value);setDirty(value!==selected.content);setConflict(null);}} basicSetup={{lineNumbers:true,foldGutter:true,highlightActiveLine:true,highlightActiveLineGutter:true,closeBrackets:true,autocompletion:true,indentOnInput:true,searchKeymap:true}}/></div>
          <div className="ide-statusbar"><div><span className="statusbar-branch"><GitBranch size={12}/> cloud-workspace</span><span>UTF-8</span><span>{selected.language}</span><span>v{selected.version}</span></div><div><span>{draft.split("\n").length} lines</span><span>{new TextEncoder().encode(draft).length.toLocaleString()} bytes</span><button className="ide-save-button" onClick={()=>void saveFile()} disabled={!dirty||saving||!canEdit}>{saving?<RefreshCw size={13}/>:<Save size={13}/>} {saving?"Saving":dirty?"Save changes":"Saved"} <kbd>Ctrl S</kbd></button></div></div>
        </div>:<div className="ide-welcome"><div className="ide-welcome-mark"><Code2 size={27}/></div><div className="ide-welcome-kicker">CONTINUUM / CODE WORKBENCH</div><h2>Make the next change<br/><em>with the whole project in view.</em></h2><p>Choose a source file from the explorer or create one. Saves are versioned and sync to other signed-in workspace members.</p><button className="ide-action primary" onClick={()=>setShowCreate(true)}><FilePlus2 size={15}/> Create a file</button><div className="ide-shortcuts"><span><kbd>Ctrl</kbd> <kbd>S</kbd> Save</span><span><kbd>Ctrl</kbd> <kbd>P</kbd> Find files</span></div></div>}
        <div className="ide-bottom-panel"><div className="ide-bottom-title"><span><ChevronRight size={13}/> OUTPUT</span><span className="ide-output-label">WORKSPACE</span><button onClick={()=>onNotify("Terminal, Git worktrees and builds require the companion worker service; it is not enabled yet.")}>Terminal status</button></div><div className="ide-output-text">{error||(selected?"This editor saves shared cloud files. It does not execute code on your PC.":"Select or create a file to start. Files are shared across authorized workspace accounts.")}</div></div>
      </div>
    </div>
    <div className="ide-footer"><span><span className="online-pulse"/> CLOUD WORKSPACE</span><span>Versioned saves</span><span>Local terminal and builds require the worker service.</span></div>
    {showCreate&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setShowCreate(false);}}><section className="modal ide-create-modal"><div className="modal-head"><div><div className="section-kicker">NEW SOURCE FILE</div><h2>Create in shared workspace</h2></div><button className="icon-quiet" onClick={()=>setShowCreate(false)} aria-label="Close"><X size={18}/></button></div><form className="modal-form" onSubmit={createFile}><label>Relative file path<input autoFocus value={newPath} onChange={event=>setNewPath(event.target.value)} required maxLength={240} placeholder="src/main.py"/></label><label>Initial contents<textarea rows={8} value={newContent} onChange={event=>setNewContent(event.target.value)} placeholder="# Start writing…"/></label><div className="ide-create-hint"><ShieldCheck size={14}/> Stored as a versioned cloud file; this does not write into a local Git checkout.</div><div className="modal-actions"><button type="button" className="button secondary" onClick={()=>setShowCreate(false)}>Cancel</button><button type="submit" className="button primary"><Plus size={15}/> Create file</button></div></form></section></div>}
  </section>;
}
