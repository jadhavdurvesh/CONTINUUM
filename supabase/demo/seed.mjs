// Demo data for screenshots and local exploration: a believable robotics project with every kind of record.
// Usage: (cd apps/web && npm install --no-save pg) && WEB_DIR=<apps/web> DATABASE_URL=postgres://... node seed.mjs
// The database must already have all migrations applied (and the auth stub from supabase/tests/supabase_stub.sql outside Supabase).
import { createRequire } from "node:module";
const require = createRequire(process.env.WEB_DIR + "/package.json");
const pg = require("pg");
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// The first 8 hex characters differ per id, so CI task references (ct-xxxxxxxx) are unambiguous.
const id = (n) => (n * 7919 + 4096).toString(16).padStart(8, "0").slice(-8) + "-0000-4000-8000-" + String(n).padStart(12, "0");
const U = { dur: id(1), aar: id(2), pri: id(3), sam: id(4) };
const P = id(100);
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values
  ($1,'durvesh@continuum.dev','{"display_name":"Durvesh Jadhav"}'), ($2,'aarav@continuum.dev','{"display_name":"Aarav Mehta"}'),
  ($3,'priya@continuum.dev','{"display_name":"Priya Nair"}'), ($4,'sam@continuum.dev','{"display_name":"Sam Carter"}')`, [U.dur, U.aar, U.pri, U.sam]);
async function as(user, sql, params = []) {
  await db.query("begin"); await db.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
  try { const r = await db.query(sql, params); await db.query("commit"); return r.rows; } catch (e) { await db.query("rollback"); throw e; }
}
const day = (n) => `current_date + ${n}`;

await as(U.dur, `insert into projects (id, name, description, owner_id) values ($1,'Robot Vision System','Real-time object detection and closed-loop grasping for the warehouse picking arm.',$2)`, [P, U.dur]);
for (const u of [U.aar, U.pri, U.sam]) await db.query("insert into project_members (project_id,user_id,role,invited_by) values ($1,$2,'collaborator',$3)", [P, u, U.dur]);

const ws = { perc: id(110), ctrl: id(111), infra: id(112) };
await as(U.dur, `insert into workstreams (id, project_id, name, position, created_by) values ($1,$4,'Perception',0,$5),($2,$4,'Control',1,$5),($3,$4,'Infrastructure',2,$5)`, [ws.perc, ws.ctrl, ws.infra, P, U.dur]);
const ms = { proto: id(120), alpha: id(121), beta: id(122), v1: id(123) };
await as(U.dur, `insert into milestones (id, project_id, title, due_date, status, position, created_by) values
  ($1,$5,'Prototype bring-up',${day(-20)},'planned',0,$6),($2,$5,'Alpha: object detection',${day(12)},'in_progress',1,$6),
  ($3,$5,'Beta: closed-loop grasping',${day(46)},'planned',2,$6),($4,$5,'v1.0 field trial',${day(95)},'planned',3,$6)`, [ms.proto, ms.alpha, ms.beta, ms.v1, P, U.dur]);
const rq = { fps: id(130), pose: id(131), stop: id(132), ota: id(133) };
await as(U.dur, `insert into requirements (id, project_id, key, title, description, status, workstream_id, created_by) values
  ($1,$5,'REQ-1','Detect target objects at 30 fps','The vision pipeline must sustain 30 frames per second on the edge GPU with at least 95% recall.','approved',$6,$9),
  ($2,$5,'REQ-2','Pose estimate error under 2 cm','6-DoF pose of a detected object must be within 2 cm and 3 degrees of ground truth.','approved',$6,$9),
  ($3,$5,'REQ-3','Safe stop within 150 ms','Any fault must bring the arm to a controlled stop within 150 ms.','in_progress',$7,$9),
  ($4,$5,'REQ-4','Over-the-air updates','Signed firmware can be updated without physical access.','proposed',$8,$9)`, [rq.fps, rq.pose, rq.stop, rq.ota, P, ws.perc, ws.ctrl, ws.infra, U.dur]);

const T = (n) => id(200 + n);
const tasks = [
  [1, "Camera calibration pipeline", "done", "high", U.aar, ws.perc, ms.proto, null, -18, false],
  [2, "Set up edge GPU runtime", "done", "normal", U.sam, ws.infra, ms.proto, null, -16, false],
  [3, "Train detector v1", "in_review", "high", U.aar, ws.perc, ms.alpha, rq.fps, 4, true],
  [4, "Optimise inference to 30 fps", "in_progress", "critical", U.aar, ws.perc, ms.alpha, rq.fps, 9, true],
  [5, "Pose estimation module", "in_progress", "high", U.pri, ws.perc, ms.alpha, rq.pose, 11, true],
  [6, "Dataset labelling QA", "todo", "normal", U.dur, ws.perc, ms.alpha, null, -2, true],
  [7, "Grasp planner prototype", "todo", "high", U.sam, ws.ctrl, ms.beta, rq.pose, 30, true],
  [8, "Emergency stop controller", "in_progress", "critical", U.sam, ws.ctrl, ms.beta, rq.stop, 24, true],
  [9, "Stop latency benchmark", "blocked", "high", U.sam, ws.ctrl, ms.beta, rq.stop, 28, true],
  [10, "CI pipeline for the vision stack", "done", "normal", U.sam, ws.infra, ms.alpha, null, -6, false],
  [11, "Signed firmware bundle format", "backlog", "normal", U.dur, ws.infra, ms.v1, rq.ota, 80, true],
  [12, "Field-trial site survey", "todo", "low", U.dur, null, ms.v1, null, 70, true],
  [13, "Hand-eye calibration refinement", "in_progress", "normal", U.aar, ws.perc, ms.alpha, rq.pose, 7, true],
  [14, "Telemetry dashboard", "todo", "low", U.pri, ws.infra, ms.beta, null, 40, true],
];
for (const [n, title, status, prio, who, w, m, r, due, ev] of tasks)
  await as(U.dur, `insert into tasks (id, project_id, title, description, status, priority, assigned_to, workstream_id, milestone_id, requirement_id, due_date, requires_evidence, created_by, updated_by)
                   values ($1,$2,$3,'See the linked requirement for acceptance criteria.',$4,$5,$6,$7,$8,$9, ${day(due)}, $10, $11, $11)`, [T(n), P, title, status, prio, who, w, m, r, ev, U.dur]);
await as(U.dur, "update milestones set status='completed' where id=$1", [ms.proto]);
await db.query(`insert into task_dependencies (task_id, depends_on_task_id, created_by) values ($1,$2,$7),($3,$4,$7),($5,$6,$7)`, [T(4), T(3), T(9), T(8), T(7), T(5), U.dur]);

const tc = { recall: id(300), fps: id(301), pose: id(302), stop: id(303) };
await as(U.dur, `insert into test_cases (id, project_id, requirement_id, task_id, name, test_kind, is_required, ci_check, created_by) values
  ($1,$5,$6,$9,'Recall of at least 95% on the pick set','automated',true,'unit-tests',$10),
  ($2,$5,$6,$11,'Sustains 30 fps for 10 minutes','performance',true,'perf-smoke',$10),
  ($3,$5,$7,$12,'Pose error under 2 cm on 200 frames','acceptance',true,null,$10),
  ($4,$5,$8,$13,'Fault-to-stop under 150 ms','performance',true,null,$10)`, [tc.recall, tc.fps, tc.pose, tc.stop, P, rq.fps, rq.pose, rq.stop, T(3), U.dur, T(4), T(5), T(8)]);
await as(U.aar, `insert into test_runs (project_id, test_case_id, task_id, result, environment, summary, executed_by, actor_type, source, duration_ms) values
  ($1,$2,$3,'failed','manual','recall 93.8%, below target',$4,'human','manual',181000),
  ($1,$2,$3,'passed','local-worker','recall 96.1% on 4,012 images',$4,'human','local-worker',176000)`, [P, tc.recall, T(3), U.aar]);
await as(U.dur, `insert into task_reviews (project_id, task_id, decision, notes) values ($1,$2,'approved','Metrics reproduce from the eval notebook.')`, [P, T(3)]);
await as(U.pri, `insert into test_runs (project_id, test_case_id, task_id, result, environment, summary, executed_by, actor_type, source) values ($1,$2,$3,'failed','manual','median error 2.7 cm, over budget',$4,'human','manual')`, [P, tc.pose, T(5), U.pri]);
await db.query(`select public.record_ci_run($1,'unit-tests','success',$2,'run-8801-1','https://github.com/example/robot-vision/actions/runs/8801',array[$3],now()-interval '3 minutes',now()-interval '1 minute','validate / unit-tests: success')`, [P, "a".repeat(40), T(3).slice(0, 8)]);
await db.query(`select public.record_ci_run($1,'perf-smoke','failure',$2,'run-8802-1','https://github.com/example/robot-vision/actions/runs/8802',array[$3],now()-interval '40 minutes',now()-interval '36 minutes','validate / perf-smoke: failure')`, [P, "b".repeat(40), T(4).slice(0, 8)]);

await as(U.pri, `insert into issues (project_id, task_id, title, description, issue_type, severity, status, assigned_to, created_by) values
  ($1,$2,'Pose jumps when two cups overlap','Keypoint association swaps IDs between overlapping objects.','bug','critical','open',$3,$4),
  ($1,$5,'Watchdog false trips under CPU load','Stop controller occasionally trips when the host is saturated.','bug','high','in_progress',$6,$6),
  ($1,null,'Warehouse Wi-Fi coverage is uncertain','OTA updates may fail in the far aisle.','risk','normal','open',null,$4)`, [P, T(5), U.dur, U.pri, T(8), U.sam]);

const doc = id(400);
await as(U.dur, `insert into documents (id, project_id, title, document_type, content_markdown, workstream_id, created_by) values ($1,$2,'Perception architecture','architecture',$3,$4,$5)`,
  [doc, P, `# Perception architecture

The perception stack turns camera frames into object poses the planner can trust.

## Pipeline

1. **Capture**: 1080p frames at 60 Hz from the wrist camera.
2. **Detect**: an INT8 detector returns boxes and keypoints.
3. **Pose**: PnP refinement with a robust loss.
4. **Track**: a constant-velocity filter smooths the pose.

## Budgets

- End-to-end latency: **under 33 ms**
- Pose error: **under 2 cm**

> Anything that blocks the 30 fps budget is a release blocker.

\`\`\`bash
python -m vision.bench --frames 600 --fps 30
\`\`\`

See [the TensorRT guide](https://docs.nvidia.com/deeplearning/tensorrt/) for quantisation notes.
`, ws.perc, U.dur]);
await as(U.pri, `insert into documents (project_id, title, document_type, content_markdown, created_by) values
  ($1,'Field trial runbook','runbook','# Field trial runbook\n\n- Charge both batteries\n- Run the pre-flight checklist\n- Start telemetry\n',$2),
  ($1,'Labelling guidelines','specification','# Labelling guidelines\n\nLabel the **graspable** surface, not the whole object.\n',$2)`, [P, U.pri]);
const dec = { ekf: id(410), onnx: id(411), tflite: id(412) };
await as(U.sam, `insert into decisions (id, project_id, title, context, decision, rationale, created_by) values
  ($1,$4,'Use an extended Kalman filter for tracking','Tracking noise is Gaussian enough for the pick set.','Adopt an EKF with a constant-velocity model.','Cheap, well understood, easy to bound latency.',$5),
  ($2,$4,'Move inference from ONNX Runtime to TensorRT','ONNX Runtime misses the 30 fps budget on the edge GPU.','Deploy TensorRT engines built per GPU model.','1.8x faster in our benchmark.',$5),
  ($3,$4,'Keep TFLite as the fallback runtime','Some customer hardware has no NVIDIA GPU.','Maintain a TFLite path for CPU-only devices.','Wider hardware reach.',$5)`, [dec.ekf, dec.onnx, dec.tflite, P, U.sam]);
await as(U.dur, "update decisions set status='accepted' where id=$1", [dec.ekf]);
await as(U.dur, "update decisions set status='accepted' where id=$1", [dec.tflite]);
await as(U.dur, "update decisions set status='superseded' where id=$1", [dec.tflite]);

const rel = { v01: id(420), v02: id(421) };
await db.query(`insert into releases (id, project_id, version_label, title, status, commit_sha, released_at, created_by) values ($1,$2,'v0.1.0','Prototype bring-up','released','7fd02ab9c8e1f3a4b5c6d7e8f9a0b1c2d3e4f5a6', now() - interval '18 days', $3)`, [rel.v01, P, U.dur]);
await as(U.dur, `insert into releases (id, project_id, version_label, title, status, created_by) values ($1,$2,'v0.2.0','Alpha: object detection','building',$3)`, [rel.v02, P, U.dur]);
await db.query(`insert into release_requirements (project_id, release_id, requirement_id, created_by) values ($1,$2,$3,$5),($1,$2,$4,$5)`, [P, rel.v02, rq.fps, rq.pose, U.dur]);
await as(U.aar, `insert into agent_sessions (project_id, task_id, title, goal, current_agent, status, focus_paths, requested_by) values ($1,$2,'Optimise inference to 30 fps','Quantise the detector to INT8 and batch preprocessing while keeping recall above 95%.','coder','queued',array['vision/detect.py','vision/preprocess.py'],$3)`, [P, T(4), U.aar]);

console.log("seeded", (await db.query("select count(*) from tasks")).rows[0].count, "tasks");
await db.end();
