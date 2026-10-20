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
assert.equal(extension.theiaExtensions?.[0]?.frontend, "lib/browser/continuum-frontend-module", "Custom frontend module must be included");

const requiredPaths = [
  "apps/theia/extensions/continuum/src/browser/continuum-contribution.ts",
  "apps/theia/extensions/continuum/src/browser/continuum-frontend-module.ts",
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

console.log(`CONTINUUM Theia config validated: ${theiaVersions.length} Theia packages pinned to 1.76.0; existing Supabase/Vercel/native services retained.`);
