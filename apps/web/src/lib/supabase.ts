import { createClient } from "@supabase/supabase-js";

type RuntimeCloudConfig = { url: string; publishableKey: string };

function readRuntimeCloudConfig(): RuntimeCloudConfig | null {
  try {
    const raw = window.localStorage.getItem("continuum.cloud.config");
    if (!raw) return null;
    const config = JSON.parse(raw) as Partial<RuntimeCloudConfig>;
    if (typeof config.url === "string" && typeof config.publishableKey === "string"
      && config.url.trim() && config.publishableKey.trim()) {
      return { url: config.url.trim(), publishableKey: config.publishableKey.trim() };
    }
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
  return null;
}

const runtimeConfig = typeof window !== "undefined" ? readRuntimeCloudConfig() : null;
const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const envKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

// Build-time values take precedence. Desktop builds can be configured after
// installation without embedding environment variables into the installer.
const url = envUrl?.trim() || runtimeConfig?.url;
const publishableKey = envKey?.trim() || runtimeConfig?.publishableKey;

export const cloudConfigured = Boolean(url && publishableKey);
export const supabase = cloudConfigured
  ? createClient(url!, publishableKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;

export type Project = {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "paused" | "completed";
  owner_id: string;
  created_at: string;
};

export type Task = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked";
  priority: "low" | "normal" | "high" | "critical";
  due_date: string | null;
  assigned_to: string | null;
  created_by: string;
  updated_at: string;
  created_at: string;
};

export type ActivityEvent = {
  id: string;
  project_id: string;
  actor_id: string | null;
  actor_type: "human" | "agent" | "system";
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
};
