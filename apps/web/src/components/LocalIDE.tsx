import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { EditorView } from "@codemirror/view";
import { supabase } from "../lib/supabase";
import { AlertTriangle, ChevronRight, Code2, FileCode2, FilePlus2, GitBranch, GitCommit, GitCompare, Play, RefreshCw, Save, Search, Settings2, ShieldCheck, Terminal, X } from "lucide-react";

type LocalFile = { path: string; size: number; extension: string };
type Reply = { exit_code?: number; output?: string; truncated?: boolean; detail?: string };
type PathLock = { id: string; project_id: string; path: string; reason: string; locked_by: string; is_locked: boolean; created_at: string; updated_at: string };
type LocalGrant = { resource_id: string; user_id: string; permitted_action: string; expires_at: string | null; revoked_at: string | null };
type Props = { projectId: string; userId: string; accessToken: string; isOwner: boolean; onNotify: (message: string) => void };
const CONFIG_KEY = "continuum.local-worker.config";
const darkEditor = EditorView.theme({
  "&": { height: "100%", backgroundColor: "#20211e", color: "#e9e5da", fontSize: "12px" },
  ".cm-scroller": { fontFamily: "'DM Mono', Consolas, monospace", lineHeight: "1.75", overflow: "auto" },
  ".cm-gutters": { backgroundColor: "#20211e", color: "#66685e", border: "none", borderRight: "1px solid #32342f" },
  ".cm-activeLine": { backgroundColor: "#ffffff06" }, ".cm-cursor": { borderLeftColor: "#e27759" }, ".cm-focused": { outline: "none" }
}, { dark: true });
function extensionsFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  if (["ts", "tsx"].includes(ext ?? "")) return [javascript({ typescript: true, jsx: true })];
  if (["js", "jsx", "mjs"].includes(ext ?? "")) return [javascript({ jsx: true })];
  if (ext === "py") return [python()];
  if (["html", "htm", "xml", "svg"].includes(ext ?? "")) return [html()];
  if (["css", "scss"].includes(ext ?? "")) return [css()];
  if (ext === "json") return [json()];
  if (["md", "mdx"].includes(ext ?? "")) return [markdown()];
  return [];
}
function leaf(path: string) { return path.split("/").pop() ?? path; }
function parseArgs(raw: string) {
  return (raw.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map(part => ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) ? part.slice(1, -1) : part);
}
function normalizeWorkerUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw.trim()); }
  catch { throw new Error("Enter the loopback worker URL, for example http://127.0.0.1:4318."); }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("For safety, the local IDE only sends its worker token to localhost, 127.0.0.1, or [::1] over HTTP.");
  }
  return parsed.origin;
}
function savedConfig() {
  try {
    // The worker token can run build/test commands on this PC, so keep it out of long-lived localStorage:
    // only the URL persists; the token lives for the browser session.
    const raw = localStorage.getItem(CONFIG_KEY);
    const token = sessionStorage.getItem(CONFIG_KEY + ".token") || "";
    if (!raw) return { url: "http://127.0.0.1:4318", token };
    const value = JSON.parse(raw) as { url?: string };
    return { url: value.url || "http://127.0.0.1:4318", token };
  } catch { return { url: "http://127.0.0.1:4318", token: "" }; }
}

export default function LocalIDE({ projectId, userId, accessToken, isOwner, onNotify }: Props) {
  const [config, setConfig] = useState(savedConfig);
  const [showSettings, setShowSettings] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [workspace, setWorkspace] = useState<{ name: string; branch: string } | null>(null);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [draft, setDraft] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [output, setOutput] = useState("Connect the local worker to inspect your actual repository.");
  const [outputTitle, setOutputTitle] = useState("WORKER OUTPUT");
  const [command, setCommand] = useState("npm run build");
  const [commitMessage, setCommitMessage] = useState("Update source from CONTINUUM IDE");
  const [statusText, setStatusText] = useState("");
  const [diffText, setDiffText] = useState("");
  const [panel, setPanel] = useState<"terminal" | "git">("terminal");
  const [pathLocks, setPathLocks] = useState<PathLock[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<any[]>([]);
  const [localGrants, setLocalGrants] = useState<LocalGrant[]>([]);
  const [governanceError, setGovernanceError] = useState("");
  const dirty = draft !== savedContent;
  const visibleFiles = useMemo(() => files.filter(file => file.path.toLowerCase().includes(filter.toLowerCase())), [files, filter]);
  const selectedLock = pathLocks.find(lock => lock.path === selectedPath && lock.is_locked);
  const hasLocalGrant = Boolean(selectedLock && localGrants.some(grant =>
    grant.resource_id === selectedLock.id && grant.user_id === userId && grant.permitted_action === "edit"
    && !grant.revoked_at && (!grant.expires_at || new Date(grant.expires_at).getTime() > Date.now())
  ));
  const canEditLocal = !selectedLock || hasLocalGrant;
  const hasBlockingPathLocks = pathLocks.some(lock => lock.is_locked && !localGrants.some(grant =>
    grant.resource_id === lock.id && grant.user_id === userId && grant.permitted_action === "edit"
    && !grant.revoked_at && (!grant.expires_at || new Date(grant.expires_at).getTime() > Date.now())
  ));

  const refreshGovernance = useCallback(async () => {
    if (!supabase) return;
    const [lockResult, requestResult, grantResult] = await Promise.all([
      supabase.from("repository_path_locks").select("*").eq("project_id", projectId).order("path", { ascending: true }),
      supabase.from("permission_requests").select("*").eq("project_id", projectId).eq("resource_type", "local_file").eq("status", "pending").order("created_at", { ascending: true }),
      supabase.from("permission_grants").select("*").eq("project_id", projectId).eq("resource_type", "local_file").eq("user_id", userId).is("revoked_at", null)
    ]);
    if (lockResult.error) setGovernanceError(lockResult.error.message);
    else { setPathLocks((lockResult.data ?? []) as PathLock[]); setGovernanceError(""); }
    if (!requestResult.error) setPermissionRequests(requestResult.data ?? []);
    if (!grantResult.error) setLocalGrants((grantResult.data ?? []) as LocalGrant[]);
  }, [projectId, userId]);

  useEffect(() => {
    void refreshGovernance();
    const client = supabase;
    if (!client) return;
    const filter = "project_id=eq." + projectId;
    const channel = client.channel("local-ide-governance-" + projectId)
      .on("postgres_changes", { event: "*", schema: "public", table: "repository_path_locks", filter }, () => void refreshGovernance())
      .on("postgres_changes", { event: "*", schema: "public", table: "permission_requests", filter }, () => void refreshGovernance())
      .on("postgres_changes", { event: "*", schema: "public", table: "permission_grants", filter }, () => void refreshGovernance())
      .subscribe();
    return () => { void client.removeChannel(channel); };
  }, [projectId, refreshGovernance]);
  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const url = normalizeWorkerUrl(config.url);
    const headers = new Headers(init.headers);
    headers.set("Authorization", "Bearer " + config.token.trim());
    if (!projectId || !accessToken) throw new Error("Your CONTINUUM sign-in is missing. Sign out and sign in again before editing local files.");
    headers.set("X-Continuum-Project-Id", projectId);
    headers.set("X-Continuum-User-Token", accessToken);
    if (init.body) headers.set("Content-Type", "application/json");
    let response: Response;
    try { response = await fetch(url + path, { ...init, headers, mode: "cors", credentials: "omit" }); }
    catch { throw new Error("Could not reach the local worker. Keep it running on this PC and add this website's exact origin to CONTINUUM_ALLOWED_ORIGINS."); }
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Worker request failed (" + response.status + ").");
    return data;
  }, [config.url, config.token, projectId, accessToken]);

  const openFile = useCallback(async (path: string) => {
    if (path === selectedPath) return;
    if (dirty && !window.confirm("Discard unsaved edits and open another file?")) return;
    try {
      const data = await api("/api/worker/file?path=" + encodeURIComponent(path)) as { content: string; path: string };
      setSelectedPath(data.path); setDraft(data.content); setSavedContent(data.content); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not open file."); }
  }, [api, dirty, selectedPath]);

  const refreshFiles = useCallback(async (openFirst = false) => {
    const data = await api("/api/worker/files") as { files: LocalFile[]; truncated?: boolean };
    const nextFiles = data.files ?? [];
    setFiles(nextFiles);
    const nextPath = openFirst || !selectedPath || !nextFiles.some(file => file.path === selectedPath) ? (nextFiles[0]?.path ?? "") : selectedPath;
    if (nextPath && (openFirst || nextPath !== selectedPath)) {
      const opened = await api("/api/worker/file?path=" + encodeURIComponent(nextPath)) as { content: string; path: string };
      setSelectedPath(opened.path); setDraft(opened.content); setSavedContent(opened.content);
    } else if (!nextPath) {
      setSelectedPath(""); setDraft(""); setSavedContent("");
    }
    if (data.truncated) setOutput("Showing the first 2,000 files. Generated directories are excluded.");
  }, [api, selectedPath]);

  const connect = useCallback(async () => {
    setConnecting(true); setError("");
    try {
      const url = normalizeWorkerUrl(config.url);
      const healthResponse = await fetch(url + "/api/worker/health", { mode: "cors", credentials: "omit" });
      if (!healthResponse.ok) throw new Error("Local worker health check failed.");
      const health = await healthResponse.json() as { paired?: boolean };
      if (!health.paired) throw new Error("The worker needs CONTINUUM_WORKSPACE_ROOT and a 32+ character CONTINUUM_WORKER_TOKEN.");
      localStorage.setItem(CONFIG_KEY, JSON.stringify({ url }));
      sessionStorage.setItem(CONFIG_KEY + ".token", config.token.trim());
      const details = await api("/api/worker/workspace") as { name: string; branch: string };
      setWorkspace(details);
      await refreshFiles(true);
      setConnected(true); setShowSettings(false);
      setOutput("Connected to " + details.name + " on branch " + details.branch + ".");
      setOutputTitle("WORKER CONNECTED");
    } catch (e) {
      setConnected(false);
      setError(e instanceof Error ? e.message : "Could not connect to local worker.");
    } finally { setConnecting(false); }
  }, [api, config, refreshFiles]);

  useEffect(() => {
    if (config.token.trim().length >= 32) void connect();
  // Use the stored pairing settings once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveFile() {
    if (!connected || !selectedPath || !dirty || saving) return;
    if (!canEditLocal) { onNotify("That path is protected by the project owner. Request access or ask the owner to unlock it."); return; }
    setSaving(true); setError("");
    try {
      await api("/api/worker/file", { method: "PUT", body: JSON.stringify({ path: selectedPath, content: draft }) });
      setSavedContent(draft);
      setFiles(current => current.map(file => file.path === selectedPath ? { ...file, size: new TextEncoder().encode(draft).length } : file));
      setOutput("Saved " + selectedPath + " to the local checkout."); setOutputTitle("FILE SAVED");
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed."); }
    finally { setSaving(false); }
  }

  async function runCommand(args: string[]) {
    if (!connected || busy) return;
    const readOnlyGit = args[0] === "git" && ["status", "diff", "branch", "log"].includes(args[1] ?? "");
    if (hasBlockingPathLocks && !readOnlyGit) {
      onNotify("A protected repository path is active. Unlock it or grant access before running commands that may change files.");
      return;
    }
    setBusy(true); setError(""); setOutputTitle("RUNNING"); setOutput("Starting " + args.join(" ") + "…");
    try {
      const result = await api("/api/worker/run", { method: "POST", body: JSON.stringify({ command: args }) }) as Reply;
      setOutputTitle(result.exit_code === 0 ? "EXIT 0" : "EXIT " + result.exit_code);
      setOutput((result.output || "(No output)") + (result.truncated ? "\n\n[Output truncated or command timed out]" : ""));
    } catch (e) { setError(e instanceof Error ? e.message : "Command failed."); }
    finally { setBusy(false); }
  }

  async function loadGitStatus() {
    if (!connected) return;
    setPanel("git"); setBusy(true);
    try {
      const [status, diff] = await Promise.all([api("/api/worker/git/status") as Promise<Reply>, api("/api/worker/git/diff") as Promise<Reply>]);
      setStatusText(status.output ?? "Git status unavailable."); setDiffText(diff.output ?? "Diff unavailable.");
      setOutputTitle("GIT STATUS"); setOutput((status.output || "Working tree clean") + "\n\n" + (diff.output || "No unstaged diff."));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not inspect Git."); }
    finally { setBusy(false); }
  }

  async function commitCurrentFile() {
    if (!connected || !selectedPath || dirty || busy) return;
    if (!canEditLocal) { onNotify("This file is protected. Unlock it or grant access before committing it."); return; }
    if (!window.confirm("Create a local Git commit containing only " + selectedPath + "? This will not push or deploy.")) return;
    setBusy(true); setError("");
    try {
      const result = await api("/api/worker/git/commit", { method: "POST", body: JSON.stringify({ message: commitMessage, paths: [selectedPath] }) }) as Reply;
      setOutputTitle(result.exit_code === 0 ? "COMMIT CREATED" : "COMMIT FAILED");
      setOutput((result.output || "Git returned no output.") + "\n\nNothing was pushed or deployed.");
      const status = await api("/api/worker/git/status") as Reply;
      setStatusText(status.output ?? "");
    } catch (e) { setError(e instanceof Error ? e.message : "Commit failed."); }
    finally { setBusy(false); }
  }

  async function togglePathLock() {
    if (!supabase || !projectId || !userId || !selectedPath || !isOwner) return;
    const prior = pathLocks.find(lock => lock.path === selectedPath);
    const nextLocked = !prior?.is_locked;
    const { error: lockError } = await supabase.from("repository_path_locks").upsert({
      project_id: projectId, path: selectedPath, reason: "Protected by project owner", locked_by: userId, is_locked: nextLocked
    }, { onConflict: "project_id,path" });
    if (lockError) { setError(lockError.message); return; }
    onNotify(nextLocked ? "Repository path protected across the shared workspace." : "Repository path unlocked.");
    await refreshGovernance();
  }

  async function requestLocalEdit() {
    if (!supabase || !projectId || !selectedLock || canEditLocal) return;
    const { error: requestError } = await supabase.from("permission_requests").insert({
      project_id: projectId, resource_type: "local_file", resource_id: selectedLock.id,
      requested_action: "edit", reason: "Requesting permission to edit local repository path " + selectedPath
    });
    if (requestError) { setError(requestError.message); return; }
    onNotify("Edit request sent to the project owner.");
    await refreshGovernance();
  }

  async function reviewLocalPermission(request: any, approve: boolean) {
    if (!supabase || !isOwner) return;
    const { error: reviewError } = await supabase.rpc("review_permission_request", {
      p_request_id: request.id, p_approve: approve, p_grant_hours: 24
    });
    if (reviewError) { setError(reviewError.message); return; }
    onNotify(approve ? "Local repository edit access granted for 24 hours." : "Local repository edit request declined.");
    await refreshGovernance();
  }

  function editorShortcut(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveFile(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") { event.preventDefault(); document.querySelector<HTMLInputElement>(".local-ide-search input")?.focus(); }
  }

  async function createFile() {
    const path = window.prompt("New relative file path (example: src/main.py)");
    if (!path?.trim()) return;
    try {
      const newPath = path.trim().replace(/\\/g, "/");
      if (pathLocks.some(lock => lock.path === newPath && lock.is_locked)) {
        onNotify("That path is protected. Unlock it before creating a new file at the same path.");
        return;
      }
      await api("/api/worker/file", { method: "POST", body: JSON.stringify({ path: newPath, content: "" }) });
      await refreshFiles(false);
      setSelectedPath(path.trim()); setDraft(""); setSavedContent("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create file."); }
  }

  const activeExt = selectedPath.split(".").pop()?.toLowerCase() ?? "text";
  return <section className="local-ide" onKeyDownCapture={editorShortcut}>
    <div className="local-ide-toolbar">
      <div className="local-ide-breadcrumb"><span>LOCAL WORKSPACE</span><ChevronRight size={13}/><strong>{workspace?.name ?? "Not connected"}</strong>{selectedPath && <><ChevronRight size={13}/><span>{selectedPath}</span></>}</div>
      <div className="local-ide-actions">
        {selectedPath && connected && isOwner && <button className="local-ide-action" onClick={() => void togglePathLock()}><ShieldCheck size={14}/>{selectedLock ? "Unlock file" : "Protect file"}</button>}
        {selectedPath && connected && !isOwner && selectedLock && !canEditLocal && <button className="local-ide-action" onClick={() => void requestLocalEdit()}><ShieldCheck size={14}/> Request edit</button>}
        <span className={"local-ide-status " + (connected ? "connected" : "")}><i/>{connected ? "WORKER ONLINE" : "WORKER OFFLINE"}</span>
        <button className="local-ide-icon" title="Refresh files" disabled={!connected} onClick={() => void refreshFiles()}><RefreshCw size={15}/></button>
        <button className="local-ide-action" onClick={() => setShowSettings(value => !value)}><Settings2 size={14}/> Connection</button></div>
    </div>
    {showSettings && <div className="local-ide-connection">
      <div className="local-ide-connection-copy"><strong>Connect to your own PC</strong><span>The worker reads only the repository folder configured on that computer. URL and token stay in this browser's local storage.</span></div>
      <label>Worker URL<input value={config.url} onChange={event => setConfig(value => ({ ...value, url: event.target.value }))} placeholder="http://127.0.0.1:4318"/></label>
      <label>Pairing token<input type="password" value={config.token} onChange={event => setConfig(value => ({ ...value, token: event.target.value }))} placeholder="Paste the worker token"/></label>
      <button className="local-ide-action primary" disabled={connecting || !config.token.trim()} onClick={() => void connect()}>{connecting ? <RefreshCw size={14}/> : <ShieldCheck size={14}/>} {connecting ? "Connecting…" : "Connect"}</button>
    </div>}
    {error && <div className="local-ide-error"><AlertTriangle size={15}/><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss"><X size={14}/></button></div>}
    {governanceError && <div className="local-ide-error"><AlertTriangle size={15}/><span>Cloud path-lock state could not be loaded: {governanceError}. Writes fail closed until corrected.</span></div>}
    {selectedLock && <div className="local-ide-lock-banner"><ShieldCheck size={14}/><span><strong>Protected path:</strong> {selectedPath} · {selectedLock.reason}{canEditLocal ? " · Temporary edit access is active." : " · Writes and local commits are blocked until the owner unlocks it or grants access."}</span></div>}
    <div className="local-ide-layout">
      <aside className="local-ide-explorer">
        <div className="local-ide-explorer-head"><span>EXPLORER <b>{files.length}</b></span><button disabled={!connected} onClick={() => void createFile()} title="New file"><FilePlus2 size={15}/></button></div>
        <label className="local-ide-search"><Search size={13}/><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Find files…"/></label>
        <div className="local-ide-tree">{!connected ? <div className="local-ide-empty">Start the worker and connect to see your actual repository files.</div> : visibleFiles.length ? visibleFiles.map(file => <button key={file.path} className={"local-ide-file " + (selectedPath === file.path ? "active" : "")} onClick={() => void openFile(file.path)}><FileCode2 size={14}/><span>{file.path}</span><small>{file.size > 1024 ? Math.round(file.size / 1024) + "k" : file.size + "b"}</small></button>) : <div className="local-ide-empty">No matching files.</div>}</div>
        <div className="local-ide-explorer-foot"><ShieldCheck size={13}/> Secrets and generated folders hidden</div>
      </aside>
      <div className="local-ide-editor-column">
        <div className="local-ide-tab"><FileCode2 size={14}/><span>{selectedPath ? leaf(selectedPath) : "No file open"}</span>{dirty && <i/>}<div className="local-ide-tab-spacer"/><span className="local-ide-language">{activeExt}</span><button disabled={!selectedPath || !dirty || saving || !canEditLocal} onClick={() => void saveFile()} className="local-ide-save"><Save size={13}/>{saving ? "Saving…" : dirty ? "Save" : "Saved"} <kbd>Ctrl S</kbd></button></div>
        <div className="local-ide-code">{selectedPath ? <CodeMirror value={draft} height="100%" theme={darkEditor} extensions={extensionsFor(selectedPath)} onChange={setDraft} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, highlightActiveLineGutter: true, closeBrackets: true, autocompletion: true, indentOnInput: true, searchKeymap: true }}/> : <div className="local-ide-welcome"><Code2 size={30}/><span>CONTINUUM / LOCAL IDE</span><h2>Your repository.<br/><em>Your tools.</em></h2><p>Connect the local worker to edit actual files, inspect Git changes, and run approved build/test commands.</p></div>}</div>
        <div className="local-ide-statusbar"><span><GitBranch size={12}/>{workspace?.branch ?? "no branch"}</span><span>UTF-8</span><span>{draft.split("\n").length} lines</span><span>{new TextEncoder().encode(draft).length.toLocaleString()} bytes</span><div className="local-ide-tab-spacer"/><span>{dirty ? "UNSAVED CHANGES" : "LOCAL CHECKOUT"}</span></div>
        <div className="local-ide-tools">
          <div className="local-ide-tool-tabs"><button className={panel === "terminal" ? "active" : ""} onClick={() => setPanel("terminal")}><Terminal size={14}/> TERMINAL / TASKS</button><button className={panel === "git" ? "active" : ""} onClick={() => void loadGitStatus()}><GitCompare size={14}/> SOURCE CONTROL</button><div className="local-ide-tab-spacer"/><button title="Clear output" onClick={() => setOutput("")}><X size={14}/></button></div>
          {panel === "terminal" ? <div className="local-ide-runner"><div className="local-ide-command"><span>$</span><input value={command} onChange={event => setCommand(event.target.value)} placeholder="npm run build"/><button disabled={!connected || busy} onClick={() => void runCommand(parseArgs(command))}><Play size={13}/> Run</button></div><div className="local-ide-presets"><button disabled={!connected || busy} onClick={() => void runCommand(["npm", "run", "build"])}>Build</button><button disabled={!connected || busy} onClick={() => void runCommand(["npm", "test"])}>Test</button><button disabled={!connected || busy} onClick={() => void runCommand(["npm", "run", "lint"])}>Lint</button><button disabled={!connected || busy} onClick={() => void runCommand(["python", "-m", "pytest"])}>Pytest</button><button disabled={!connected || busy} onClick={() => void runCommand(["git", "status", "--short", "--branch"])}>Git status</button></div></div> : <div className="local-ide-git">{isOwner && permissionRequests.length > 0 && <div className="local-ide-lock-requests"><div className="local-ide-git-heading"><strong>Owner approval queue</strong><span>{permissionRequests.length} pending</span></div>{permissionRequests.map(request => { const pathLock = pathLocks.find(lock => lock.id === request.resource_id); return <div className="local-ide-lock-request" key={request.id}><div><strong>{pathLock?.path ?? "Repository file"}</strong><small>Requested by {String(request.requested_by).slice(0,8)}…</small></div><button onClick={() => void reviewLocalPermission(request,false)} disabled={busy}>Deny</button><button onClick={() => void reviewLocalPermission(request,true)} className="grant" disabled={busy}>Grant 24h</button></div>; })}</div>}<div className="local-ide-git-heading"><strong>Working tree</strong><button disabled={!connected || busy} onClick={() => void loadGitStatus()}><RefreshCw size={13}/> Refresh</button></div><pre>{statusText || "Select Source Control to inspect the working tree."}</pre><div className="local-ide-git-heading"><strong>Unstaged diff</strong><span>{diffText ? "Available" : "No diff loaded"}</span></div><pre>{diffText || "No unstaged diff, or diff has not been loaded."}</pre><label>Commit message<input value={commitMessage} onChange={event => setCommitMessage(event.target.value)} maxLength={160}/></label><button className="local-ide-action primary" disabled={!connected || !selectedPath || dirty || busy || !commitMessage.trim() || !canEditLocal} onClick={() => void commitCurrentFile()}><GitCommit size={14}/> Commit selected file only</button><small>Commits locally after confirmation. No push, merge, or deployment.</small></div>}
          <div className="local-ide-output-head"><span>{outputTitle}</span><span>{busy ? "RUNNING" : "READY"}</span></div><pre className="local-ide-output">{output || "No output yet."}</pre>
        </div>
      </div>
    </div>
    <div className="local-ide-footer"><span><i/>{connected ? "LOCAL WORKER CONNECTED" : "LOCAL WORKER REQUIRED"}</span><span>Explicit commands · No automatic push or deployment</span></div>
  </section>;
}
