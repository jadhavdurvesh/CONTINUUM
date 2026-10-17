import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed." });

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return reply(401, { error: "Sign-in is required." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return reply(500, { error: "Cloud function secrets are not configured." });

  let payload: { project_id?: string; email?: string };
  try { payload = await request.json(); } catch { return reply(400, { error: "Invalid JSON body." }); }
  const projectId = payload.project_id?.trim();
  const email = payload.email?.trim().toLowerCase();
  if (!projectId || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply(400, { error: "A valid project ID and email address are required." });
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authorization } }
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  const caller = userData.user;
  if (userError || !caller) return reply(401, { error: "The session is invalid or expired." });

  const { data: membership, error: membershipError } = await callerClient
    .from("project_members").select("role")
    .eq("project_id", projectId).eq("user_id", caller.id).maybeSingle();
  if (membershipError || membership?.role !== "owner") {
    return reply(403, { error: "Only this project's owner can invite a collaborator." });
  }
  if ((caller.email ?? "").toLowerCase() === email) return reply(400, { error: "This email already belongs to the owner." });

  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: usersData, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) return reply(502, { error: "Unable to check existing workspace accounts." });

  let target = usersData.users.find((candidate) => (candidate.email ?? "").toLowerCase() === email);
  let inviteSent = false;
  if (!target) {
    const { data: inviteData, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email);
    if (inviteError || !inviteData.user) return reply(502, { error: inviteError?.message ?? "The invitation could not be sent." });
    target = inviteData.user;
    inviteSent = true;
  }

  const { error: addError } = await admin.from("project_members").upsert({
    project_id: projectId, user_id: target.id, role: "collaborator", invited_by: caller.id
  }, { onConflict: "project_id,user_id" });
  if (addError) return reply(502, { error: "Membership could not be saved. Check project membership and retry." });

  await admin.from("activity_events").insert({
    project_id: projectId, actor_id: caller.id, actor_type: "human",
    action: inviteSent ? "member.invited" : "member.added",
    entity_type: "project_member", entity_id: target.id,
    details: { email, role: "collaborator", invite_sent: inviteSent }
  });

  return reply(200, {
    ok: true,
    invite_sent: inviteSent,
    message: inviteSent ? "Invitation email sent." : "Existing account added to the project."
  });
});
