/**
 * Step by step: bringing a new application onto the platform, on the
 * Integrations page. Two sides: what platform staff do here, and what the
 * application's team does in its own repository, with Hearth (a generic
 * application, github.com/subaiah/hearth) as the worked example. Choosing an
 * application shows which of the platform steps it has done.
 * docs/PRODUCT_INTEGRATION.md has the full contract.
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, CheckCircle2, ChevronDown, Circle, MinusCircle } from 'lucide-react';
import { CopyBox } from './CopyBox';
import { selectClass } from './ui';

/** What the guide needs from an Integrations row */
export interface GuideApplication {
  id: string;
  name: string;
  manifestImportedAt: string | null;
  signIn: { enabled: boolean; backchannelLogout: boolean } | null;
  lifecycle: { callback: boolean; userEvents: boolean };
  credentials: { active: number; lastUsedAt: string | null };
  appToApp: { exposes: number; consumes: number };
  organizations: { total: number; ready: number };
  events: { lastDeliveredAt: string | null };
  health: { status: 'UP' | 'DEGRADED' | 'DOWN' | null } | null;
}

type State = 'done' | 'todo' | 'optional';
type Side = 'platform' | 'application';

interface Step {
  title: string;
  where?: string;
  body: ReactNode;
  /** Platform steps only: whether the chosen application has done it */
  state?: (a: GuideApplication) => State;
}

const OPEN_KEY = 'integration-guide-open';

function remembered(fallback: boolean) {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

export default function IntegrationGuide({ applications }: { applications: GuideApplication[] }) {
  const [open, setOpen] = useState(() => remembered(applications.length === 0));
  const [side, setSide] = useState<Side>('platform');
  const [chosenId, setChosenId] = useState('');
  const chosen = applications.find((a) => a.id === chosenId) ?? null;
  const hub = window.location.origin;

  const toggle = () => {
    setOpen(!open);
    try { localStorage.setItem(OPEN_KEY, open ? '0' : '1'); } catch { /* not kept */ }
  };

  const steps = side === 'platform' ? platformSteps(hub) : applicationSteps(hub);
  const done = chosen ? platformSteps(hub).filter((s) => s.state?.(chosen) === 'done').length : 0;
  const counted = chosen ? platformSteps(hub).filter((s) => s.state && s.state(chosen) !== 'optional').length : 0;

  return (
    <section aria-labelledby="integration-guide" className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
      <h2 id="integration-guide">
        <button type="button" onClick={toggle} aria-expanded={open}
          className="w-full flex items-center gap-3 p-5 text-left">
          <BookOpen size={18} className="text-blue-600 dark:text-blue-400 shrink-0" aria-hidden />
          <span className="flex-1 min-w-0">
            <span className="block font-semibold text-slate-800 dark:text-white">Integrating a new application</span>
            <span className="block text-sm font-normal text-slate-500 dark:text-slate-400">Step by step, on the platform and in the application, with Hearth as the example</span>
          </span>
          <ChevronDown size={18} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </button>
      </h2>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div role="tablist" aria-label="Whose steps" className="inline-flex rounded-md border border-slate-300 dark:border-slate-600 p-0.5">
              {([['platform', 'On the platform'], ['application', 'In the application']] as const).map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={side === key} onClick={() => setSide(key)}
                  className={`px-3 py-1.5 text-sm rounded ${side === key ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}`}>
                  {label}
                </button>
              ))}
            </div>
            {side === 'platform' && applications.length > 0 && (
              <label className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-2">
                Progress for
                <select className={`${selectClass} w-auto`} value={chosenId} onChange={(e) => setChosenId(e.target.value)}>
                  <option value="">Choose an application</option>
                  {applications.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
          </div>

          <p className="text-sm text-slate-600 dark:text-slate-300">
            {side === 'platform'
              ? <>What platform staff do here, once the application is deployed. Secrets are shown <strong>once</strong>: pass each one straight to whoever runs the application.</>
              : <>What the application's team builds in its own repository. Hearth already does all of it: its repository is a working reference for a new application.</>}
            {chosen && side === 'platform' && <> <strong>{chosen.name}</strong>: {done} of {counted} steps done.</>}
          </p>

          <ol className="space-y-3">
            {steps.map((s, i) => {
              const state = side === 'platform' && chosen ? s.state?.(chosen) : undefined;
              return (
                <li key={s.title} className="flex gap-3 rounded-md border border-slate-200 dark:border-slate-700 p-4">
                  <StepMark n={i + 1} state={state} />
                  <div className="min-w-0 flex-1 space-y-2 text-sm text-slate-700 dark:text-slate-200">
                    <h3 className="font-medium text-slate-900 dark:text-white">
                      {s.title}
                      {state && <span className="sr-only">{state === 'done' ? ' (done)' : state === 'optional' ? ' (optional, not used)' : ' (to do)'}</span>}
                    </h3>
                    {s.where && <p className="text-xs text-slate-500 dark:text-slate-400">{s.where}</p>}
                    {s.body}
                  </div>
                </li>
              );
            })}
          </ol>

          <p className="text-sm text-slate-600 dark:text-slate-300">
            Before going live, go through the checklist at the end of <code className="text-xs">docs/PRODUCT_INTEGRATION.md</code> in the platform's repository. It is the full contract.
          </p>
        </div>
      )}
    </section>
  );
}

function StepMark({ n, state }: { n: number; state?: State }) {
  if (state === 'done') return <CheckCircle2 size={22} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
  if (state === 'optional') return <MinusCircle size={22} className="shrink-0 text-slate-400" aria-hidden />;
  if (state === 'todo') return <Circle size={22} className="shrink-0 text-amber-500" aria-hidden />;
  return <span className="shrink-0 w-[22px] h-[22px] rounded-full bg-slate-100 dark:bg-slate-700 text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center justify-center" aria-hidden>{n}</span>;
}

const Code = ({ children }: { children: ReactNode }) => <code className="text-xs font-mono bg-slate-100 dark:bg-slate-900 rounded px-1 py-0.5 [overflow-wrap:anywhere]">{children}</code>;

function Block({ children, label }: { children: string; label: string }) {
  return <pre aria-label={label} className="text-xs font-mono bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md p-3 overflow-x-auto whitespace-pre">{children}</pre>;
}

function Example({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md bg-blue-50 dark:bg-blue-500/10 border border-blue-100 dark:border-blue-500/20 p-3 space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">Hearth</p>
      {children}
    </div>
  );
}

const PageLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="text-blue-600 hover:text-blue-700 dark:text-blue-400">{children}</Link>
);

export function platformSteps(hub: string): Step[] {
  return [
    {
      title: 'Get the application\'s manifest, with its real addresses',
      where: 'In the application\'s repository, e.g. hearth.manifest.json',
      body: (
        <>
          <p>The manifest says everything the platform needs: its sign-in addresses, permissions, menu, events, limits and the components it offers. Before importing, make sure <Code>baseUrl</Code>, the redirect and logout addresses, <Code>provisioning.callbackUrl</Code>, <Code>health.url</Code> and any <Code>embeds</Code> script address point at where the application is actually deployed, not an example address.</p>
          <Example><p>Replace every <Code>https://hearth.example.com</Code> with Hearth's address, e.g. <Code>https://hearth.your-domain</Code>. Keep the <Code>localhost</Code> redirect only if developers sign in against this platform.</p></Example>
        </>
      ),
      state: (a) => (a.manifestImportedAt ? 'done' : 'todo'),
    },
    {
      title: 'Check, then import it',
      where: 'Customers → Applications → Import manifest',
      body: (
        <>
          <p>Paste the manifest and press <strong>Check</strong>: it lists every problem and what an import would change, without saving anything. Then <strong>Import</strong>. Importing again later updates the application and keeps its credentials.</p>
          <p>The first import shows two secrets, <strong>once</strong>:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>the sign-in <strong>client ID and secret</strong>, for the application's server that signs people in;</li>
            <li>the <strong>signing secret</strong> for lifecycle events, so the application can check they came from here.</li>
          </ul>
          <Example>
            <p>Client ID and secret go in Hearth's BFF as <Code>OIDC_CLIENT_ID</Code> and <Code>OIDC_CLIENT_SECRET</Code>. The signing secret goes in Hearth's backend as <Code>PLATFORM_WEBHOOK_SECRET</Code>.</p>
          </Example>
          <p>Open <PageLink to="/platform/applications">Applications</PageLink></p>
        </>
      ),
      state: (a) => (a.signIn ? 'done' : 'todo'),
    },
    {
      title: 'Give its server a service credential',
      where: 'Customers → Applications → the application → Service credentials → New credential',
      body: (
        <>
          <p>The application's server uses it to call API v1: to read the organizations and people that have it, and to use the platform's services. Tick only the scopes it needs.</p>
          <Example>
            <p>Scopes: <Code>organizations.read</Code>, <Code>members.read</Code>, <Code>notifications.send</Code>, <Code>audit.write</Code>. The credential's ID and secret go in Hearth's backend as <Code>PLATFORM_CLIENT_ID</Code> and <Code>PLATFORM_CLIENT_SECRET</Code>.</p>
          </Example>
        </>
      ),
      state: (a) => (a.credentials.active ? 'done' : 'todo'),
    },
    {
      title: 'Tell the application where the platform is',
      where: 'In the application\'s settings',
      body: (
        <>
          <p>The application finds sign-in and API v1 from the platform's issuer:</p>
          <CopyBox value={`${hub}/api/oidc`} label="Issuer" />
          <Example>
            <p>Set it as <Code>OIDC_ISSUER</Code> in the BFF and <Code>PLATFORM_ISSUER</Code> in the backend; API v1 is found next to it. Restart Hearth.</p>
          </Example>
          <p className="text-xs text-slate-500 dark:text-slate-400">If the application runs on the same server, on the same Docker network, its callback may use an inside address: list its host in the platform's <Code>PRODUCT_CALLBACK_ALLOWED_HOSTS</Code>.</p>
        </>
      ),
      state: (a) => (a.credentials.lastUsedAt || a.events.lastDeliveredAt ? 'done' : 'todo'),
    },
    {
      title: 'Check that it answers',
      where: 'This page, the application\'s card',
      body: (
        <p>With <Code>health.url</Code> in the manifest, the platform checks it every minute. The card shows <strong>Up</strong> with its version once the application is reachable from here. Down usually means a wrong address, or a firewall between the two.</p>
      ),
      state: (a) => (!a.health ? 'optional' : a.health.status === 'UP' ? 'done' : 'todo'),
    },
    {
      title: 'Set its limits and prices for each plan (optional)',
      where: 'Customers → Applications → the application → Plans and usage',
      body: (
        <>
          <p>The limits the manifest declares get a value per plan. The application is told them when an organization gets it, and again when they change. Prices are charged on the organization's own subscription.</p>
          <Example><p>Message history in days, largest file, storage, and whether AI agents and huddles are included.</p></Example>
        </>
      ),
    },
    {
      title: 'An organization turns it on',
      where: 'Tenant portal → Organization → Entitlements (the organization\'s administrator)',
      body: (
        <>
          <p>The platform sends the application <Code>organization.entitled</Code>, and it sets the organization up. Its card here shows the organization as <strong>setting up</strong>, then <strong>ready</strong>. If setup fails, the reason is shown on the card.</p>
          <Example><p>Hearth creates the organization's workspace and a #general channel.</p></Example>
        </>
      ),
      state: (a) => (!a.lifecycle.callback ? 'optional' : a.organizations.ready ? 'done' : 'todo'),
    },
    {
      title: 'The organization grants its permissions',
      where: 'Tenant portal → People → Role assignments (the organization\'s administrator)',
      body: (
        <>
          <p>The manifest's permissions appear in the role editor under the application's name. People get them through roles, and the application reads them from the sign-in token.</p>
          <Example><p><Code>hearth:admin</Code> for whoever manages chat; <Code>hearth.channels:create</Code> for people who may create channels.</p></Example>
        </>
      ),
    },
    {
      title: 'Open it',
      where: 'Tenant portal → Workspace → Applications, or the application\'s menu in the sidebar',
      body: (
        <p>Someone in the organization opens it and signs in with their organization account. This page then shows sign-in on, lifecycle events delivered and nothing waiting.</p>
      ),
      state: (a) => (a.signIn?.enabled && a.organizations.ready ? 'done' : 'todo'),
    },
    {
      title: 'Let other applications use it (optional)',
      where: 'Both applications\' manifests; then Tenant portal → Organization → Entitlements',
      body: (
        <>
          <p>An application that offers an API or components lists its scopes under <Code>api.scopes</Code> and its components under <Code>embeds</Code>. An application that uses them lists the scopes under <Code>consumes</Code>, with a reason. Import both again. Each organization sees the connection on its Entitlements page and can block it.</p>
          <Example>
            <p>To show Hearth's chat in AppForge, AppForge's manifest consumes <Code>hearth.threads:read</Code> and <Code>hearth.threads:write</Code>, and AppForge's address goes in Hearth's <Code>BFF_EMBED_ORIGINS</Code>. Hearth's <Code>docs/embedding/appforge.md</Code> has the code for AppForge's side.</p>
          </Example>
        </>
      ),
      state: (a) => (a.appToApp.exposes || a.appToApp.consumes ? 'done' : 'optional'),
    },
  ];
}

export function applicationSteps(hub: string): Step[] {
  return [
    {
      title: 'Deploy it on its own address',
      body: (
        <>
          <p>The application keeps its own server, database and releases. It needs a public <Code>https://</Code> address the platform and browsers can reach, and a health address that answers <Code>200</Code> with <Code>{'{ "status": "ok", "version": "…" }'}</Code> within 5 seconds.</p>
          <Example><p>Two services, the BFF (sign-in, sessions, the components' script) and the API, with Postgres. <Code>GET /health</Code> on each.</p></Example>
        </>
      ),
    },
    {
      title: 'Write its manifest',
      body: (
        <>
          <p>Keep it in the repository, at version 2. <Code>productId</Code> can't change later, and permission names start with it. Declare what it may send: notifications and audit events. Declare what it offers: API scopes, components and limits.</p>
          <Block label="Manifest outline">{`{
  "manifestVersion": 2,
  "productId": "hearth",
  "name": "Hearth",
  "version": "0.5.0",
  "kind": "generic",
  "baseUrl": "https://hearth.your-domain",
  "signIn": { "clientType": "CONFIDENTIAL",
              "redirectUris": ["https://hearth.your-domain/auth/callback"],
              "openPath": "/auth/login",
              "backchannelLogoutUri": "https://hearth.your-domain/auth/backchannel-logout" },
  "provisioning": { "callbackUrl": "https://hearth.your-domain/platform/events",
                    "userEvents": true, "deletesDataOnDeprovision": true },
  "permissions": [{ "name": "hearth:admin", "description": "Manage Hearth" }],
  "menu": [{ "label": "Chat", "path": "/", "icon": "MessageSquare" }],
  "health": { "url": "https://hearth.your-domain/health" }
}`}</Block>
          <p className="text-xs text-slate-500 dark:text-slate-400">Hearth's full manifest also has notifications, audit events, API scopes, limits and embeds: <Code>hearth.manifest.json</Code>.</p>
        </>
      ),
    },
    {
      title: 'Sign people in through the platform',
      body: (
        <>
          <p>OpenID Connect with PKCE, from the server. Key people and organizations by <Code>sub</Code> and <Code>tenant_id</Code>, never by email. Take access from the token's <Code>permissions</Code> (and <Code>scoped_permissions</Code>). Handle back-channel logout by ending that person's sessions.</p>
          <Example>
            <Block label="Hearth BFF settings">{`OIDC_ISSUER=${hub}/api/oidc
OIDC_CLIENT_ID=<from the import>
OIDC_CLIENT_SECRET=<from the import>
BFF_PUBLIC_ORIGIN=https://hearth.your-domain`}</Block>
          </Example>
        </>
      ),
    },
    {
      title: 'Set organizations up when they turn it on',
      body: (
        <>
          <p>Lifecycle events arrive at <Code>provisioning.callbackUrl</Code>, signed. Check the signature, handle each event once, and answer within 10 seconds. If setup takes longer, answer <Code>202</Code> and report back with <Code>lifecycle.report</Code>. Answer unknown event types with <Code>2xx</Code>. With <Code>userEvents</Code>, end a person's sessions when they're deactivated or removed.</p>
          <Example>
            <Block label="Hearth backend settings">{`PLATFORM_ISSUER=${hub}/api/oidc
PLATFORM_WEBHOOK_SECRET=<from the import>
PLATFORM_CLIENT_ID=<service credential>
PLATFORM_CLIENT_SECRET=<service credential>`}</Block>
            <p><Code>organization.entitled</Code> creates the tenant and its workspace; <Code>organization.deprovisioning_requested</Code> deletes its data when the platform asks for that.</p>
          </Example>
        </>
      ),
    },
    {
      title: 'Use the platform rather than building its own',
      body: (
        <>
          <p>With the service credential, from the server, read people and groups from API v1, send declared notifications, and write declared audit events. Report usage if it has metered features. Keep every query scoped to the organization, with a test that proves one organization can't read another's data.</p>
          <Example><p>Names and the people picker come from API v1. Mentions and direct messages are platform notifications. Moderators' deletions go to the organization's audit log. Row-level security on every table.</p></Example>
        </>
      ),
    },
    {
      title: 'Offer components to other applications (generic applications)',
      body: (
        <>
          <p>Web Components that host pages load with a script. The host's server exchanges the person's token for one addressed to this application (<Code>resource=urn:mt:app:&lt;productId&gt;</Code>). The component never signs in inside a frame. Allow the host's origin for CORS.</p>
          <Example>
            <Block label="Hearth embed">{`<script type="module" src="https://hearth.your-domain/embed/v1/hearth.js"></script>
<hearth-chat style="height: 600px"></hearth-chat>
<script type="module">
  document.querySelector('hearth-chat').tokenProvider =
    () => fetch('/embed-token/hearth').then((r) => r.json()).then((d) => d.token);
</script>`}</Block>
            <p>Hosts' origins go in <Code>BFF_EMBED_ORIGINS</Code>.</p>
          </Example>
        </>
      ),
    },
    {
      title: 'Test against the platform before going live',
      body: (
        <p>Sign in as two people in two organizations. Check that each sees only their own organization, that a role change reaches the application, and that turning the application off for an organization ends its access. Hearth's <Code>npm run test:e2e:platform</Code> does this against a stand-in platform, and is a good starting point.</p>
      ),
    },
  ];
}
