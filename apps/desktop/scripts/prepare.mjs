import { cp, mkdir, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const repoRoot = path.resolve(desktop, "../..");
const renderer = path.join(desktop, "renderer");

await rm(renderer, { recursive: true, force: true });
await mkdir(renderer, { recursive: true });
await cp(path.join(repoRoot, "apps/web/dist"), renderer, { recursive: true });
await copyFile(path.join(repoRoot, "LICENSE"), path.join(desktop, "LICENSE"));
console.log("Prepared dashboard assets and license terms for the installer.");
