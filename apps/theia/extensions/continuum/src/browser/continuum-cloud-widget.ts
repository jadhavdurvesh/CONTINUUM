import * as React from '@theia/core/shared/react';
import { injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

type Project = { id: string; name: string; description: string | null; status: string };
type AgentSession = { id: string; project_id: string; title: string; goal: string; status: string; current_agent: string; focus_paths: string[]; last_error: string | null; updated_at: string };
type AgentMessage = { id: string; role: string; content: string; actor_type: string; created_at: string };
const h = React.createElement;
const CONFIG_KEY = 'continuum.cloud.config';
const AUTH_STORAGE_KEY = 'continuum.theia.auth';
const AGENT_API = 'https://continuum-dun-ten.vercel.app';
const MAX_FILES = 12;
const MAX_FILE_CHARS = 12000;
const MAX_CONTEXT_CHARS = 75000;

const rootStyle: React.CSSProperties = { padding: 14, height: '100%', overflow: 'auto', boxSizing: 'border-box', color: 'var(--theia-ui-foreground)', fontSize: 12 };
const cardStyle: React.CSSProperties = { border: '1px solid var(--theia-widget-border, var(--theia-panel-border))', borderRadius: 7, padding: 12, marginBottom: 11, background: 'var(--theia-sideBar-background)' };
const titleStyle: React.CSSProperties = { fontSize: 13, fontWeight: 700, marginBottom: 9 };
const textStyle: React.CSSProperties = { color: 'var(--theia-descriptionForeground)', lineHeight: 1.5, margin: '5px 0 9px' };
const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 9 };
const labelStyle: React.CSSProperties = { color: 'var(--theia-descriptionForeground)', fontSize: 11 };
const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px', borderRadius: 4, border: '1px solid var(--theia-input-border, var(--theia-widget-border))', background: 'var(--theia-input-background)', color: 'var(--theia-input-foreground)' };
const buttonStyle: React.CSSProperties = { cursor: 'pointer', borderRadius: 4, padding: '7px 9px', marginRight: 5, marginTop: 3, color: 'var(--theia-button-foreground)', background: 'var(--theia-button-background)', border: '1px solid var(--theia-button-border, transparent)' };
const secondaryStyle: React.CSSProperties = { ...buttonStyle, background: 'transparent', color: 'var(--theia-foreground)', border: '1px solid var(--theia-widget-border)' };
const errorStyle: React.CSSProperties = { color: 'var(--theia-errorForeground, #e06c75)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '8px 0' };
const messageStyle: React.CSSProperties = { background: 'var(--theia-editor-background)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 8, marginTop: 6, borderRadius: 4, maxHeight: 180, overflow: 'auto', lineHeight: 1.5 };
const itemStyle: React.CSSProperties = { width: '100%', textAlign: 'left', cursor: 'pointer', padding: 8, margin: '5px 0', color: 'var(--theia-foreground)', background: 'transparent', border: '1px solid var(--theia-widget-border)', borderRadius: 5 };

@injectable()
export class ContinuumCloudWidget extends ReactWidget {
  static readonly ID = 'continuum.cloud.control';
  static readonly LABEL = 'CONTINUUM Cloud';
  private configUrl = '';
  private publishableKey = '';
  private email = '';
  private password = '';
  private session: Session | null = null;
  private client: SupabaseClient | null = null;
  private authSubscription: { unsubscribe: () => void } | undefined;
  private projects: Project[] = [];
  private projectId = '';
  private sessions: AgentSession[] = [];
  private sessionId = '';
  private messages: AgentMessage[] = [];
  private titleInput = '';
  private goalInput = '';
  private focusInput = '';
  private busy = false;
  private error = '';
  private notice = '';
  private serviceMessage = 'Not checked yet';
  private providers: string[] = [];
  private showConfig = false;
  private disposed = false;

  @postConstruct()
  protected init(): void {
    this.id = ContinuumCloudWidget.ID;
    this.title.label = ContinuumCloudWidget.LABEL;
    this.title.caption = 'Shared projects and cloud agents';
    this.title.closable = true;
    this.title.iconClass = 'fa fa-cloud';
    try {
      const stored = JSON.parse(window.localStorage.getItem(CONFIG_KEY) || 'null') as { url?: string; publishableKey?: string } | null;
      this.configUrl = stored?.url || '';
      this.publishableKey = stored?.publishableKey || '';
      if (this.configUrl && this.publishableKey) this.initializeClient();
    } catch {
      this.error = 'Saved cloud settings are invalid. Please re-enter them.';
    }
    this.update();
  }

  override dispose(): void {
    this.disposed = true;
    this.authSubscription?.unsubscribe();
    if (this.client) void this.client.auth.stopAutoRefresh();
    super.dispose();
  }

  private initializeClient(): void {
    this.authSubscription?.unsubscribe();
    if (this.client) void this.client.auth.stopAutoRefresh();
    const url = this.configUrl.trim().replace(/\/+$/, '');
    const key = this.publishableKey.trim();
    if (!url || !key) { this.client = null; this.session = null; this.update(); return; }
    const client = createClient(url, key, {
      auth: { storageKey: AUTH_STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    this.client = client;
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      this.session = session;
      this.update();
      Promise.resolve().then(() => {
        if (this.disposed || client !== this.client) return;
        if (session) void this.refreshProjects();
        else { this.projects = []; this.sessions = []; this.messages = []; this.projectId = ''; this.sessionId = ''; this.update(); }
      });
    });
    this.authSubscription = data.subscription;
    void client.auth.getSession().then(({ data: result, error }) => {
      if (this.disposed || client !== this.client) return;
      if (error) this.error = error.message;
      this.session = result.session;
      this.update();
      if (this.session) void this.refreshProjects();
    }).catch(() => { this.error = 'Could not restore sign-in. Check the Supabase configuration.'; this.update(); });
  }

  private async saveConfig(): Promise<void> {
    this.error = ''; this.notice = '';
    const url = this.configUrl.trim().replace(/\/+$/, '');
    const key = this.publishableKey.trim();
    try {
      const parsed = new URL(url);
      const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !local) throw new Error('Use an HTTPS Supabase URL.');
      if (!parsed.hostname.endsWith('.supabase.co') && !local) throw new Error('Enter the Supabase project URL, not a dashboard URL.');
      if (!key) throw new Error('Enter the public publishable/anon key.');
      if (/^sb_secret_/i.test(key) || /service.role/i.test(key)) throw new Error('Supabase secret/service-role keys are prohibited in the desktop.');
      const payload = key.split('.')[1];
      if (payload) {
        try {
          const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string };
          if (claims.role === 'service_role') throw new Error('Service-role keys are prohibited in the desktop.');
        } catch (e) {
          if (e instanceof Error && e.message.includes('Service-role')) throw e;
        }
      }
      window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ url, publishableKey: key }));
      this.configUrl = url; this.publishableKey = key;
      this.initializeClient();
      this.notice = 'Public cloud connection settings saved on this device.';
    } catch (e) { this.error = e instanceof Error ? e.message : 'Invalid cloud settings.'; }
    this.update();
  }

  private async signIn(): Promise<void> {
    if (!this.client) return;
    this.busy = true; this.error = ''; this.notice = ''; this.update();
    try {
      const { error } = await this.client.auth.signInWithPassword({ email: this.email.trim(), password: this.password });
      this.password = '';
      if (error) throw error;
      this.notice = 'Signed in. Loading shared projects…';
    } catch (e) { this.error = e instanceof Error ? e.message : 'Sign-in failed.'; }
    finally { this.busy = false; this.update(); }
  }

  private async signOut(): Promise<void> {
    if (!this.client) return;
    this.busy = true; this.update();
    try {
      const { error } = await this.client.auth.signOut();
      if (error) throw error;
      this.notice = 'Signed out.';
    } catch (e) { this.error = e instanceof Error ? e.message : 'Could not sign out.'; }
    finally { this.busy = false; this.update(); }
  }

  private async refreshProjects(): Promise<void> {
    const client = this.client;
    if (!client || !this.session) return;
    this.busy = true; this.error = ''; this.update();
    try {
      const { data, error } = await client.from('projects').select('id,name,description,status').order('created_at', { ascending: true });
      if (error) throw error;
      this.projects = (data ?? []) as Project[];
      if (!this.projects.some(p => p.id === this.projectId)) this.projectId = this.projects[0]?.id || '';
      await this.checkService();
      await this.refreshSessions();
    } catch (e) { this.error = e instanceof Error ? e.message : 'Could not load projects; check workspace membership and Supabase RLS.'; }
    finally { this.busy = false; this.update(); }
  }

  private async checkService(): Promise<void> {
    try {
      const response = await fetch(AGENT_API + '/api/agents/status', { credentials: 'omit' });
      const data = await response.json() as { providers?: string[]; message?: string };
      if (!response.ok) throw new Error(data.message || 'Agent service is unavailable.');
      this.providers = Array.isArray(data.providers) ? data.providers : [];
      this.serviceMessage = data.message || 'Vercel agent endpoint responded.';
    } catch (e) {
      this.providers = [];
      this.serviceMessage = e instanceof Error ? e.message : 'Could not reach Vercel.';
    }
  }

  private async refreshSessions(): Promise<void> {
    const client = this.client;
    const projectId = this.projectId;
    if (!client || !projectId) {
      this.sessions = [];
      this.messages = [];
      this.sessionId = '';
      this.update();
      return;
    }
    const { data, error } = await client.from('agent_sessions')
      .select('id,project_id,title,goal,status,current_agent,focus_paths,last_error,updated_at')
      .eq('project_id', projectId).order('updated_at', { ascending: false }).limit(30);
    if (error) throw error;
    // A slower response for a previously selected project must not overwrite
    // the list for the project the user has switched to in the meantime.
    if (client !== this.client || projectId !== this.projectId) return;
    this.sessions = (data ?? []) as AgentSession[];
    if (!this.sessions.some(s => s.id === this.sessionId)) this.sessionId = this.sessions[0]?.id || '';
    await this.refreshMessages();
    this.update();
  }

  private async refreshMessages(): Promise<void> {
    const client = this.client;
    const projectId = this.projectId;
    const sessionId = this.sessionId;
    if (!client || !projectId || !sessionId) {
      this.messages = [];
      this.update();
      return;
    }
    const { data, error } = await client.from('agent_messages').select('id,role,content,actor_type,created_at')
      .eq('project_id', projectId).eq('session_id', sessionId)
      .order('created_at', { ascending: false }).limit(12);
    if (error) throw error;
    // Ignore stale responses from an earlier project/session selection.
    if (client !== this.client || projectId !== this.projectId || sessionId !== this.sessionId) return;
    this.messages = ((data ?? []) as AgentMessage[]).reverse();
    this.update();
  }

  private async selectSession(id: string): Promise<void> {
    this.sessionId = id; this.update();
    try { await this.refreshMessages(); }
    catch (e) { this.error = e instanceof Error ? e.message : 'Could not load messages.'; }
    this.update();
  }

  private async createSession(): Promise<void> {
    const client = this.client;
    const userId = this.session?.user.id;
    if (!client || !userId || !this.projectId) return;
    const title = this.titleInput.trim();
    const goal = this.goalInput.trim();
    if (title.length < 2 || !goal) { this.error = 'Enter a title and goal.'; this.update(); return; }
    this.busy = true; this.error = ''; this.notice = ''; this.update();
    try {
      const focus = this.focusInput.split(/\r?\n/).map(p => p.trim()).filter(Boolean).slice(0, MAX_FILES);
      const { data, error } = await client.from('agent_sessions').insert({
        project_id: this.projectId, title: title.slice(0, 160), goal: goal.slice(0, 20000),
        current_agent: 'planner', status: 'queued', focus_paths: focus, requested_by: userId
      }).select('id,project_id,title,goal,status,current_agent,focus_paths,last_error,updated_at').single();
      if (error || !data) throw error ?? new Error('Session creation failed.');
      const initial = await client.from('agent_messages').insert({
        project_id: this.projectId, session_id: data.id, role: 'user', actor_type: 'human',
        actor_id: userId, content: goal.slice(0, 20000), metadata: { initial_goal: true, focus_paths: focus }
      });
      this.titleInput = ''; this.goalInput = ''; this.focusInput = ''; this.sessionId = data.id;
      await this.refreshSessions();
      this.sessionId = data.id;
      await this.refreshMessages();
      this.notice = initial.error ? 'Session created, but its first message was not saved: ' + initial.error.message : 'Agent session created and queued.';
    } catch (e) { this.error = e instanceof Error ? e.message : 'Could not create the session.'; }
    finally { this.busy = false; this.update(); }
  }

  private async runStep(): Promise<void> {
    const client = this.client;
    const token = this.session?.access_token;
    const selected = this.sessions.find(s => s.id === this.sessionId);
    if (!client || !token || !selected || selected.status !== 'queued') return;
    this.busy = true; this.error = ''; this.notice = ''; this.update();
    try {
      const { data, error } = await client.from('code_files').select('path,content').eq('project_id', this.projectId).order('path').limit(500);
      if (error) throw error;
      const focus = new Set(selected.focus_paths || []);
      const candidates = ((data ?? []) as { path: string; content: string }[]).filter(f => !focus.size || focus.has(f.path)).slice(0, MAX_FILES);
      const context: { path: string; content: string }[] = [];
      let total = 0;
      for (const file of candidates) {
        const content = file.content.slice(0, MAX_FILE_CHARS);
        if (total + content.length > MAX_CONTEXT_CHARS) break;
        total += content.length; context.push({ path: file.path, content });
      }
      const response = await fetch(AGENT_API + '/api/agents/run-step', {
        method: 'POST', credentials: 'omit',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: this.projectId, session_id: selected.id, workspace_context: context })
      });
      const result = await response.json().catch(() => ({})) as { error?: string; provider?: string; attempts?: number };
      if (!response.ok) throw new Error(result.error || 'Agent request failed with HTTP ' + response.status + '.');
      this.notice = 'Agent step completed via ' + (result.provider || 'Vercel') + ((result.attempts || 1) > 1 ? ' with provider fallback.' : '.');
      await this.refreshSessions();
      this.sessionId = selected.id;
      await this.refreshMessages();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Agent run failed.';
      try { await this.refreshSessions(); } catch { /* Preserve the primary error. */ }
    } finally { this.busy = false; this.update(); }
  }

  private field(label: string, value: string, updateValue: (value: string) => void, type = 'text', placeholder = ''): React.ReactElement {
    return h('label', { style: fieldStyle },
      h('span', { style: labelStyle }, label),
      h('input', { type, value, placeholder, style: inputStyle,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => { updateValue(event.target.value); this.update(); } })
    );
  }

  private button(text: string, action: () => void, disabled = false, primary = false): React.ReactElement {
    return h('button', {
      type: 'button', disabled: disabled || this.busy, onClick: action,
      style: { ...(primary ? buttonStyle : secondaryStyle), opacity: disabled || this.busy ? 0.55 : 1 }
    }, text);
  }

  private renderConfig(): React.ReactNode {
    return h('section', { style: cardStyle },
      h('div', { style: titleStyle }, 'Connect Supabase'),
      h('p', { style: textStyle }, 'Use the same Supabase project as the existing CONTINUUM dashboard. The desktop accepts only a public publishable/anon key. Never enter a service-role or AI-provider key here.'),
      this.field('Supabase project URL', this.configUrl, v => { this.configUrl = v; }, 'url', 'https://your-project.supabase.co'),
      this.field('Publishable / anon key', this.publishableKey, v => { this.publishableKey = v; }, 'password', 'Public client key'),
      this.button('Save settings', () => void this.saveConfig(), !this.configUrl.trim() || !this.publishableKey.trim(), true),
      this.button('Reset settings', () => {
        window.localStorage.removeItem(CONFIG_KEY); window.localStorage.removeItem(AUTH_STORAGE_KEY);
        this.authSubscription?.unsubscribe();
        if (this.client) void this.client.auth.stopAutoRefresh();
        this.client = null; this.session = null;
        this.configUrl = ''; this.publishableKey = ''; this.projects = []; this.sessions = []; this.messages = [];
        this.projectId = ''; this.sessionId = ''; this.error = ''; this.notice = ''; this.update();
      })
    );
  }

  private renderAuth(): React.ReactNode {
    return h('section', { style: cardStyle },
      h('div', { style: titleStyle }, 'Sign in to CONTINUUM'),
      h('p', { style: textStyle }, 'Use your existing Supabase account. Membership and row-level security remain enforced by Supabase.'),
      this.field('Email', this.email, v => { this.email = v; }, 'email', 'you@example.com'),
      this.field('Password', this.password, v => { this.password = v; }, 'password', 'Account password'),
      this.button('Sign in', () => void this.signIn(), !this.email.trim() || !this.password, true),
      this.button('Cloud settings', () => { this.showConfig = !this.showConfig; this.update(); })
    );
  }

  private renderCloud(): React.ReactNode {
    const selected = this.sessions.find(s => s.id === this.sessionId);
    const sessionButtons = this.sessions.map(s => h('button', {
      key: s.id, type: 'button', style: { ...itemStyle, ...(s.id === this.sessionId ? { borderColor: 'var(--theia-focusBorder)' } : {}) },
      onClick: () => void this.selectSession(s.id)
    },
      h('strong', null, s.title),
      h('div', { style: { ...textStyle, marginBottom: 0 } }, s.current_agent + ' · ' + s.status.replace(/_/g, ' ')),
      s.last_error ? h('div', { style: errorStyle }, s.last_error.slice(0, 200)) : null
    ));
    const messageCards = this.messages.map(m => {
      let text = m.content;
      try {
        const payload = JSON.parse(m.content) as { summary?: string; files?: { path: string }[]; review_notes?: string; next_role?: string };
        if (typeof payload.summary === 'string') {
          text = payload.summary;
          if (payload.files?.length) text += '\nProposed files: ' + payload.files.map(f => f.path).join(', ');
          if (payload.review_notes) text += '\nReview notes: ' + payload.review_notes;
          if (payload.next_role) text += '\nNext role: ' + payload.next_role;
          text += '\n\nReview proposals in the existing CONTINUUM workspace. This panel does not silently write files to your computer.';
        }
      } catch { /* ordinary user/agent text */ }
      return h('div', { key: m.id, style: messageStyle },
        h('strong', null, m.role === 'assistant' ? 'CONTINUUM Agent' : m.role === 'user' ? 'You' : m.role),
        h('div', null, text.slice(0, 2500))
      );
    });
    return h(React.Fragment, null,
      h('section', { style: cardStyle },
        h('div', { style: titleStyle }, this.session?.user.email || 'Signed in'),
        h('div', { style: textStyle }, 'Authenticated using your saved Supabase session.'),
        h('label', { style: fieldStyle }, h('span', { style: labelStyle }, 'Shared project'),
          h('select', { style: inputStyle, value: this.projectId, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
            this.projectId = event.target.value; this.sessionId = '';
            void this.refreshSessions().catch(e => { this.error = e.message; this.update(); });
            this.update();
          } },
            h('option', { value: '' }, this.projects.length ? 'Choose a project…' : 'No shared projects'),
            ...this.projects.map(p => h('option', { key: p.id, value: p.id }, p.name))
          )
        ),
        h('div', { style: textStyle }, this.projects.length + ' accessible project(s) · access governed by Supabase RLS.'),
        this.button('Refresh projects / sessions', () => void this.refreshProjects(), !this.projectId),
        this.button('Sign out', () => void this.signOut())
      ),
      h('section', { style: cardStyle },
        h('div', { style: titleStyle }, 'Vercel cloud agents'),
        h('div', { style: textStyle }, this.serviceMessage),
        h('div', { style: textStyle }, this.providers.length ? 'Configured providers: ' + this.providers.join(', ') : 'Provider availability is reported by the hosted endpoint.'),
        this.button('Check service', () => void this.checkService().then(() => this.update()))
      ),
      h('section', { style: cardStyle },
        h('div', { style: titleStyle }, 'New agent session'),
        this.field('Title', this.titleInput, v => { this.titleInput = v; }, 'text', 'Review the sensor driver'),
        h('label', { style: fieldStyle }, h('span', { style: labelStyle }, 'Goal / instructions'),
          h('textarea', { style: { ...inputStyle, minHeight: 76, resize: 'vertical', fontFamily: 'inherit' }, value: this.goalInput,
            placeholder: 'Describe the engineering task and desired result…',
            onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { this.goalInput = event.target.value; this.update(); } })
        ),
        h('label', { style: fieldStyle }, h('span', { style: labelStyle }, 'Optional focus paths (one per line)'),
          h('textarea', { style: { ...inputStyle, minHeight: 48, resize: 'vertical', fontFamily: 'inherit' }, value: this.focusInput,
            placeholder: 'src/main.ts\nREADME.md',
            onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { this.focusInput = event.target.value; this.update(); } })
        ),
        this.button('Create queued session', () => void this.createSession(), !this.projectId || this.titleInput.trim().length < 2 || !this.goalInput.trim(), true)
      ),
      h('section', { style: cardStyle },
        h('div', { style: titleStyle }, 'Shared agent sessions'),
        this.sessions.length ? h(React.Fragment, null, ...sessionButtons) : h('div', { style: textStyle }, 'No agent sessions in this project yet.'),
        selected ? h(React.Fragment, null,
          h('div', { style: { ...titleStyle, marginTop: 12 } }, selected.title),
          h('div', { style: textStyle }, selected.goal.slice(0, 700)),
          h('div', { style: textStyle }, 'Role: ' + selected.current_agent + ' · Status: ' + selected.status),
          this.button('Run one agent step', () => void this.runStep(), selected.status !== 'queued', true),
          this.button('Refresh conversation', () => void this.selectSession(selected.id)),
          h('div', { style: { ...titleStyle, marginTop: 12 } }, 'Recent conversation'),
          ...(messageCards.length ? messageCards : [h('div', { key: 'empty', style: textStyle }, 'No messages yet.')])
        ) : null
      )
    );
  }

  protected render(): React.ReactNode {
    const children: React.ReactNode[] = [
      h('header', { key: 'header', style: { ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('div', null, h('div', { style: { ...titleStyle, marginBottom: 2, letterSpacing: 1.5 } }, 'CONTINUUM'),
          h('div', { style: labelStyle }, 'ENGINEERING OS / CLOUD CONTROL')),
        h('span', { style: { fontSize: 10, color: 'var(--theia-descriptionForeground)' } }, 'THEIA')
      )
    ];
    if (this.error) children.push(h('div', { key: 'error', style: errorStyle }, this.error));
    if (this.notice) children.push(h('div', { key: 'notice', style: { ...textStyle, color: 'var(--theia-terminal-ansiGreen, #6abf69)' } }, this.notice));
    if (!this.client) children.push(h(React.Fragment, { key: 'config' }, this.renderConfig()));
    else if (!this.session) {
      children.push(h(React.Fragment, { key: 'auth' }, this.renderAuth()));
      if (this.showConfig) children.push(h(React.Fragment, { key: 'config' }, this.renderConfig()));
    } else children.push(h(React.Fragment, { key: 'cloud' }, this.renderCloud()));
    return h('div', { style: rootStyle }, ...children);
  }
}
