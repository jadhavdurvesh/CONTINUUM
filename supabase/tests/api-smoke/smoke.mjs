// End-to-end smoke test of the exact queries the dashboard makes, through PostgREST (the same API layer Supabase uses),
// with real JWTs, RLS and the database gates. Needs: PostgREST on POSTGREST_URL, JWT_SECRET, and a migrated database.
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(process.env.WEB_DIR + "/package.json");
const { PostgrestClient } = require("@supabase/postgrest-js");
const pg = require("pg");

const URL = process.env.POSTGREST_URL ?? "http://127.0.0.1:3000";
const SECRET = process.env.JWT_SECRET;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(sub) {
  const body = b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  return body + "." + createHmac("sha256", SECRET).update(body).digest("base64url");
}
const client = (sub) => new PostgrestClient(URL, { headers: { Authorization: "Bearer " + token(sub) } });
let passed = 0;
function check(condition, label) { if (!condition) { console.error("FAILED:", label); process.exitCode = 1; throw new Error(label); } passed++; }
const ok = (result, label) => { if (process.env.TRACE) console.log("step:", label); if (result.error) { console.error("FAILED:", label, result.error.message); process.exitCode = 1; throw new Error(label); } passed++; return result.data; };
const fails = (result, pattern, label) => { check(result.error && new RegExp(pattern, "i").test(result.error.message), label + " (got: " + (result.error?.message ?? "success") + ")"); };

const owner = randomUUID(), collab = randomUUID(), outsider = randomUUID();
for (const [id, email] of [[owner, "o@x.io"], [collab, "c@x.io"], [outsider, "z@x.io"]]) await db.query("insert into auth.users(id,email) values ($1,$2)", [id, email]);
const O = client(owner), C = client(collab), Z = client(outsider);

// --- project + membership (as the dashboard does) ---
const project = ok(await O.from("projects").insert({ name: "Smoke", owner_id: owner }).select("id").single(), "create project").id;
await db.query("insert into project_members(project_id,user_id,role) values ($1,$2,'collaborator')", [project, collab]);

// --- Plan page ---
const ms = ok(await O.from("milestones").insert({ project_id: project, title: "Alpha", due_date: "2030-01-01", created_by: owner, position: 0 }).select("id").single(), "add milestone").id;
const ws = ok(await O.from("workstreams").insert({ project_id: project, name: "Perception", created_by: owner, position: 0 }).select("id").single(), "add workstream").id;
const t1 = ok(await O.from("tasks").insert({ project_id: project, title: "Build map", created_by: owner }).select("id").single(), "create task 1").id;
const t2 = ok(await O.from("tasks").insert({ project_id: project, title: "Plan route", created_by: owner }).select("id").single(), "create task 2").id;
ok(await O.from("tasks").update({ assigned_to: collab, milestone_id: ms, workstream_id: ws, updated_by: owner }).eq("id", t1), "plan task (assign, milestone, workstream)");
ok(await O.from("task_dependencies").insert({ task_id: t1, depends_on_task_id: t2, created_by: owner }), "add dependency");
fails(await O.from("task_dependencies").insert({ task_id: t2, depends_on_task_id: t1, created_by: owner }), "circular", "dependency loop rejected through the API");
fails(await O.from("tasks").update({ assigned_to: outsider }).eq("id", t1), "member", "outsider cannot be assigned through the API");
const plan = ok(await O.rpc("project_plan", { p_project_id: project }), "project_plan rpc");
check(plan.milestones[0].total === 1 && plan.summary.blocked_by_dependency === 1 && plan.summary.unassigned === 1, "plan numbers");
const deps = ok(await O.from("task_dependencies").select("task_id,depends_on_task_id").in("task_id", [t1, t2]), "dependency listing");
check(deps.length === 1, "dependency listed");
check((await Z.rpc("project_plan", { p_project_id: project })).data === null, "outsider gets no plan");

// --- Evidence page ---
const req = ok(await O.from("requirements").insert({ project_id: project, title: "Detect object", status: "approved", created_by: owner }).select("id").single(), "add requirement").id;
ok(await O.from("tasks").update({ requirement_id: req }).eq("id", t2), "link requirement");
const tc = ok(await O.from("test_cases").insert({ project_id: project, task_id: t2, requirement_id: req, name: "detects cup", created_by: owner }).select("id").single(), "add required test").id;
let status = ok(await O.rpc("task_completion_status", { p_task_id: t2 }), "completion status");
check(status.ready === false && status.blockers.length >= 1, "task not ready without evidence");
fails(await O.from("tasks").update({ status: "done", updated_by: owner }).eq("id", t2), "cannot be completed", "gate enforced through the API");
ok(await O.from("test_runs").insert({ project_id: project, task_id: t2, test_case_id: tc, result: "passed", summary: "ok", environment: "manual", executed_by: owner, actor_type: "human" }), "record test run");
ok(await C.from("task_reviews").insert({ project_id: project, task_id: t2, decision: "approved", reviewer_id: collab, reviewer_type: "human", notes: "lgtm" }), "collaborator reviews");
const bulk = ok(await O.rpc("project_task_completion", { p_project_id: project }), "bulk completion");
check(bulk.find((item) => item.task_id === t2)?.ready === true, "task ready after evidence + independent review");
ok(await O.from("tasks").update({ status: "done", updated_by: owner }).eq("id", t2), "complete task");
const health = ok(await O.rpc("project_health", { p_project_id: project }), "project health");
check(health.tasks.done === 1 && health.tasks.done_with_evidence === 1, "health counts verified work");
ok(await O.from("requirements").update({ status: "verified" }).eq("id", req), "verify requirement");

// --- Knowledge page ---
const doc = ok(await O.from("documents").insert({ project_id: project, title: "Nav spec", document_type: "specification", content_markdown: "# Nav", created_by: owner }).select("id,title,document_type,content_markdown,version,updated_at,workstream_id").single(), "create document");
check(doc.version === 1, "document starts at v1");
const saved = ok(await O.from("documents").update({ title: "Nav spec", document_type: "specification", content_markdown: "# Nav v2", version: 1 }).eq("id", doc.id).select("id,version").single(), "save document");
check(saved.version === 2, "save bumps version");
const conflict = await C.from("documents").update({ content_markdown: "# stale", version: 1 }).eq("id", doc.id).select("id,version").single();
check(conflict.error && (conflict.error.code === "PT409" || /Version conflict/.test(conflict.error.message)), "stale save reports a version conflict the UI recognises");
const versions = ok(await O.from("document_versions").select("id,version,title,content_markdown,created_at").eq("document_id", doc.id).order("version", { ascending: false }).limit(50), "version history");
check(versions.length === 1 && versions[0].content_markdown === "# Nav", "history has v1");
const dec = ok(await C.from("decisions").insert({ project_id: project, title: "Use EKF", context: "c", decision: "d", rationale: "r", status: "proposed", created_by: collab }).select("id").single(), "propose decision").id;
fails(await C.from("decisions").update({ status: "accepted" }).eq("id", dec), "owners", "collaborator cannot accept");
ok(await O.from("decisions").update({ status: "accepted" }).eq("id", dec), "owner accepts");

// --- Links panel queries ---
ok(await O.from("project_links").insert({ project_id: project, source_type: "document", source_id: doc.id, target_type: "task", target_id: t1, relation: "explains", created_by: owner }), "link document -> task");
const out = ok(await O.from("project_links").select("*").eq("project_id", project).eq("source_type", "document").eq("source_id", doc.id), "outgoing links");
const inc = ok(await O.from("project_links").select("*").eq("project_id", project).eq("target_type", "task").eq("target_id", t1), "incoming links");
check(out.length === 1 && inc.length === 1, "links visible from both ends");
const resolved = ok(await O.from("tasks").select("id,title").in("id", [t1]), "label resolution (.in)");
check(resolved[0].title === "Build map", "label resolved");
const opts = ok(await O.from("test_cases").select("id,name").eq("project_id", project).order("created_at", { ascending: false }).limit(200), "link option listing for test_case uses 'name'");
check(opts.length === 1, "option listed");
check((await Z.from("project_links").select("*")).data.length === 0, "outsider sees no links");

// --- Quality page ---
const runs = ok(await O.from("test_runs").select("test_case_id,result,created_at").eq("project_id", project).not("test_case_id", "is", null).order("created_at", { ascending: false }).limit(1500), "test runs query with .not(is null)");
check(runs.length === 1, "run listed");
const issue = ok(await O.from("issues").insert({ project_id: project, title: "Crash", issue_type: "bug", severity: "critical", task_id: t1, assigned_to: collab, created_by: owner }).select("id").single(), "log issue").id;
fails(await C.from("issues").update({ status: "accepted_risk" }).eq("id", issue), "owners", "collaborator cannot accept risk");

// --- Releases page ---
const rel = ok(await O.from("releases").insert({ project_id: project, version_label: "v0.1.0", title: "First", created_by: owner }).select("id").single(), "create release").id;
ok(await O.from("release_requirements").insert({ project_id: project, release_id: rel, requirement_id: req, created_by: owner }), "scope requirement");
let readiness = ok(await O.rpc("release_readiness", { p_release_id: rel }), "release readiness");
check(readiness.ready === false && readiness.blockers.some((b) => /defect/.test(b)), "critical defect blocks release");
fails(await O.from("releases").update({ status: "ready" }).eq("id", rel), "not ready", "release gate enforced through the API");
ok(await O.from("issues").update({ status: "resolved" }).eq("id", issue), "resolve defect");
readiness = ok(await O.rpc("release_readiness", { p_release_id: rel }), "release readiness 2");
check(readiness.ready === true, "release ready after defect resolved");
ok(await O.from("releases").update({ status: "released", commit_sha: "abc1234" }).eq("id", rel), "owner releases");
fails(await O.from("release_requirements").delete().eq("release_id", rel), "frozen", "released scope frozen");

// --- Workspace bridge: the exact rows the page writes ---
const t3 = ok(await O.from("tasks").insert({ project_id: project, title: "Bridge task", created_by: owner, assigned_to: collab }).select("id").single(), "create bridge task").id;
const sess = ok(await O.from("agent_sessions").insert({ project_id: project, task_id: t3, title: "Bridge task", goal: "Make the detector faster", current_agent: "coder", status: "queued", focus_paths: ["src/a.py", "tests/test_a.py"], requested_by: owner }).select("id").single(), "create agent session").id;
ok(await O.from("agent_sessions").update({ focus_paths: ["src/a.py"] }).eq("id", sess), "save context selection");
const sessions = ok(await O.from("agent_sessions").select("id,title,goal,status,current_agent,focus_paths,task_id,last_error,created_at").eq("project_id", project).order("created_at", { ascending: false }).limit(100), "list sessions");
check(sessions.some((row) => row.id === sess && row.focus_paths.length === 1), "session context saved");
const started = new Date(Date.now() - 4000).toISOString();
ok(await O.from("test_runs").insert({ project_id: project, task_id: t3, test_case_id: null, result: "passed", environment: "local-worker", commit_sha: "0123456789abcdef0123456789abcdef01234567", duration_ms: 4000, started_at: started, finished_at: new Date().toISOString(), summary: "npm test -> exit 0 (uncommitted changes in the checkout)", log_text: "ok", executed_by: owner, actor_type: "human" }), "bridge records local test evidence");
const bridgeStatus = ok(await O.rpc("task_completion_status", { p_task_id: t3 }), "bridge task status");
check(bridgeStatus.blockers.every((b) => !/no test run/.test(b)) && bridgeStatus.blockers.some((b) => /review/.test(b)), "local evidence counts, review still required");

// --- Workspace hub ---
const found = ok(await O.rpc("search_project", { p_project_id: project, p_query: "nav", p_limit: 20 }), "search rpc");
check(found.some((hit) => hit.type === "document" && hit.title === "Nav spec"), "search finds the document");
check(found.every((hit) => ["task", "requirement", "document", "decision", "issue", "milestone", "release", "test_case"].includes(hit.type)), "search result types are known");
check((await Z.rpc("search_project", { p_project_id: project, p_query: "nav" })).data === null, "outsider cannot search");
const mine = ok(await C.rpc("my_work", { p_project_id: project }), "my_work rpc");
check(mine.assigned.some((row) => row.id === t3), "collaborator sees the task assigned to them");
check(mine.to_review.some((row) => row.id === t3) === false, "own task is not in own review queue");
check((await O.rpc("my_work", { p_project_id: project })).data.to_review.some((row) => row.id === t3), "owner is asked to review the collaborator's tested task");
check((await Z.rpc("my_work", { p_project_id: project })).data === null, "outsider gets no work hub");

console.log("API SMOKE TEST PASSED (" + passed + " checks)");
await db.end();
