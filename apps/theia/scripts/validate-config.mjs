import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const appRoot = join(repo, "apps/theia");
const app = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const extensionRoot = join(appRoot, "extensions/continuum");
const extension = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));

assert.equal(app.productName, "CONTINUUM", "The packaged desktop name must stay CONTINUUM");
assert.equal(app.theia?.target, "electron", "Theia desktop target must be Electron");
assert.equal(app.theia?.frontend?.config?.applicationName, "CONTINUUM", "Theia window branding must stay CONTINUUM");
assert.equal(app.build?.appId, "tech.dmjgroup.continuum", "Installer app ID must be stable");
assert.equal(app.dependencies?.["@continuum/ide-extension"], extension.version, "Local extension version must match app dependency");
assert.ok(app.workspaces?.includes("extensions/continuum"), "The custom extension must be in the Yarn workspace");
assert.ok(app.dependencies?.["@theia/electron"], "Theia Electron target package must be a runtime dependency");

const theiaVersions = Object.entries(app.dependencies ?? {}).filter(([name]) => name.startsWith("@theia/"));
assert.ok(theiaVersions.length >= 25, "Expected a full workbench package set");
for (const [name, version] of theiaVersions) {
  assert.equal(version, "1.76.0", `${name} must be pinned to the same Theia release`);
}
assert.equal(extension.dependencies?.["@theia/core"], "1.76.0", "Extension API must match the app Theia release");
assert.ok(extension.dependencies?.["@supabase/supabase-js"], "Cloud panel must use the established Supabase JS client");
assert.equal(extension.theiaExtensions?.[0]?.frontend, "lib/browser/continuum-frontend-module", "Custom frontend module must be included");

const requiredPaths = [
  "apps/theia/extensions/continuum/src/browser/continuum-contribution.ts",
  "apps/theia/extensions/continuum/src/browser/continuum-frontend-module.ts",
  "apps/theia/extensions/continuum/src/browser/continuum-cloud-widget.ts",
  "apps/web/api/agents/cors.ts",
  "apps/web/scripts/test-agent-cors.ts",
  "apps/theia/resources/continuum-splash.svg",
  "apps/web/api/agents/status.ts",
  "apps/web/api/agents/run-step.ts",
  "supabase/migrations/202610170001_cloud_workspace.sql",
  "supabase/migrations/202610180003_agent_sessions.sql",
  "apps/native/main.py",
  ".github/workflows/build-installers.yml"
];
for (const path of requiredPaths) {
  assert.ok(existsSync(join(repo, path)), `Expected existing integration file: ${path}`);
}

const contrib = readFileSync(join(appRoot, "extensions/continuum/src/browser/continuum-contribution.ts"), "utf8");
assert.match(contrib, /continuum\.openCloudWorkspace/, "Custom cloud workspace command must exist");
assert.match(contrib, /https:\/\/continuum-dun-ten\.vercel\.app\//, "Cloud command must open the current public dashboard URL");
assert.doesNotMatch(
  contrib,
  /(OPENAI_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*[:=]\s*['"][^'"]+['"]/,
  "The desktop extension must not embed server credentials"
);

const cloudWidget = readFileSync(join(appRoot, "extensions/continuum/src/browser/continuum-cloud-widget.ts"), "utf8");
const cloudModule = readFileSync(join(appRoot, "extensions/continuum/src/browser/continuum-frontend-module.ts"), "utf8");
const contribution = readFileSync(join(appRoot, "extensions/continuum/src/browser/continuum-contribution.ts"), "utf8");
assert.match(cloudModule, /WidgetFactory/, "Cloud panel must be registered as a Theia widget");
assert.match(cloudModule, /ContinuumCloudWidget\.ID/, "Cloud widget must have a stable factory ID");
assert.match(contribution, /continuum\.openCloudPanel/, "Theia must provide a command to open the cloud panel");
assert.match(cloudWidget, /agent_sessions/, "Cloud panel must use durable Supabase sessions");
assert.match(cloudWidget, /agent_messages/, "Cloud panel must show shared agent history");
assert.match(cloudWidget, /api\/agents\/run-step/, "Cloud panel must invoke the existing Vercel endpoint");
assert.match(cloudWidget, /MAX_CONTEXT_CHARS/, "Context sent to the agent must be bounded");
assert.match(cloudWidget, /service_role/, "Cloud panel must reject service-role credentials");
assert.match(cloudWidget, /sb_secret_/, "Cloud panel must reject modern Supabase secret keys");
assert.match(cloudWidget, /subscribeProjectChanges/, "Cloud panel must subscribe to project-scoped live changes");
assert.match(cloudWidget, /private realtimeStatus:/, "Cloud panel must track its live-sync state");
assert.match(cloudWidget, /channel\.subscribe\(\(status, error\)/, "Cloud panel must handle Realtime subscription status transitions");
assert.match(cloudWidget, /Reconnect live sync/, "Cloud panel must expose a reconnect action");
assert.match(cloudWidget, /Supabase Realtime reported/, "Cloud panel must display subscription failures");
assert.match(cloudWidget, /table: 'agent_sessions'/, "Agent session changes must refresh through Supabase Realtime");
assert.match(cloudWidget, /table: 'agent_messages'/, "Shared conversation changes must refresh through Supabase Realtime");
assert.match(cloudWidget, /clearRealtime\(\)/, "Realtime channels must be cleaned up during widget lifecycle transitions");
assert.match(cloudWidget, /removeChannel\(channel\)/, "Realtime subscriptions must be removed on cleanup");
assert.match(cloudWidget, /selected project changed while preparing agent context/, "Agent execution must stay bound to the selected project");
assert.match(readFileSync(join(repo, "apps/web/api/agents/cors.ts"), "utf8"), /Access-Control-Allow-Origin/, "Cloud API must restrict cross-origin access");
console.log(`CONTINUUM Theia config validated: ${theiaVersions.length} Theia packages pinned to 1.76.0; shared Supabase/Vercel services retained.`);
