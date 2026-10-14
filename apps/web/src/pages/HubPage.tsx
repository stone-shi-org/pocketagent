import { useCallback, useEffect, useState } from 'react';
import {
  negotiateProtocol,
  PROTOCOL_VERSION,
  type DiscoveredHubHost,
  type HubDiscoveryResponse,
  type PushStatusResponse,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import {
  getHubDiscovery,
  getHubPushStatus,
  listHubTemplates,
  refreshHubDiscovery,
  sendHubTestPush,
} from '../api/hub.js';
import { AddHostDialog } from '../components/AddHostDialog.js';
import { BindHostDialog } from '../components/BindHostDialog.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { EditHostDialog } from '../components/EditHostDialog.js';
import { ExportFromHostDialog } from '../components/ExportFromHostDialog.js';
import { FleetAgentCard } from '../components/FleetAgentCard.js';
import { fleetChatFor } from '../hosts/fleet.js';
import { Icon } from '../components/Icon.js';
import { formatRelative } from '../components/StatusBadge.js';
import type { HostDirectory } from '../hosts/directory.js';
import {
  findHostByManageId,
  hostDotClass,
  hostDriftMessage,
  hostStatusSummary,
  type HostRecord,
} from '../hosts/host-status.js';

interface Props {
  directory: HostDirectory;
  /** Switches to one host's own view, by routing id. */
  onOpenHost: (hostId: string) => void;
  onOpenTemplates: () => void;
  onOpenTemplate: (templateId: string) => void;
  /** PA-134: open a Pocket Agent chat on a host (routing id), for the Fleet agent. */
  onOpenFleetChat: (hostId: string, chatId: string) => void;
  onApiError: (error: unknown) => void;
}

/** Discovery changes when a machine boots or leaves; a few seconds' lag is invisible. */
const DISCOVERY_POLL_MS = 10_000;
const PUSH_POLL_MS = 30_000;

/**
 * The Hub's own home (PA-110).
 *
 * The reported bug was that a Hub had no UI of its own: it served the
 * backend bundle unmodified, so a Hub with no hosts showed "New chat",
 * Settings and the rest, none of which had anything behind them. This is
 * what the Hub tile opens instead, and what a Hub with no hosts lands on —
 * everything here is the Hub's, and nothing here is any one host's:
 *
 * - **Hosts** — every registry row as a card, with the verdicts the rail and
 *   sheet already compute (`HostRecord`) plus the two the Hub alone knows:
 *   whether it holds a credential, and whether its push relay is connected.
 *   The management actions that used to live only in the host sheet are
 *   here too, with room to explain themselves.
 * - **On this network** — backends heard advertising over mDNS, each a
 *   one-click prefilled "Add". Suggestions only: adding one is the ordinary
 *   add, and binding still takes that backend's master token.
 * - **Config templates** — the entry point that used to sit in a *host's*
 *   Settings page, which was the wrong place: a template belongs to the Hub.
 *
 * Talks only to the Hub origin (`api/hub.ts`, `directory`) — never through a
 * host-scoped client, since there may be no host at all.
 */
export function HubPage({
  directory,
  onOpenHost,
  onOpenTemplates,
  onOpenTemplate,
  onOpenFleetChat,
  onApiError,
}: Props): JSX.Element {
  const [discovery, setDiscovery] = useState<HubDiscoveryResponse | null>(null);
  const [scanning, setScanning] = useState(false);
  const [push, setPush] = useState<PushStatusResponse | null>(null);
  const [templateCount, setTemplateCount] = useState<number | null>(null);
  const [adding, setAdding] = useState<{ label?: string; basePath?: string } | null>(null);
  const [bindId, setBindId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [exportFrom, setExportFrom] = useState<string | null | undefined>(undefined);
  const [removing, setRemoving] = useState<HostRecord | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const hosts = directory.hosts;
  const hostKey = hosts.map((host) => `${host.endpoint.id}:${String(host.hubBound)}`).join('|');
  const byManageId = (id: string): HostRecord | null =>
    hosts.find((host) => (host.hubHostId ?? host.endpoint.id) === id) ?? null;

  const loadDiscovery = useCallback(async () => {
    try {
      setDiscovery(await getHubDiscovery());
    } catch (error) {
      onApiError(error);
    }
  }, [onApiError]);

  useEffect(() => {
    void loadDiscovery();
    const timer = setInterval(() => void loadDiscovery(), DISCOVERY_POLL_MS);
    return () => clearInterval(timer);
  }, [loadDiscovery]);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void getHubPushStatus()
        .then((status) => {
          if (!cancelled) setPush(status);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, PUSH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // Re-read when the host list changes: a host added from this page has no
    // relay row until the Hub has connected to it, and the next 30 s poll is
    // too late for the card that just appeared.
  }, [hostKey]);

  useEffect(() => {
    void listHubTemplates()
      .then((templates) => setTemplateCount(templates.length))
      .catch((error: unknown) => onApiError(error));
  }, [onApiError]);

  const scan = async (): Promise<void> => {
    setScanning(true);
    try {
      setDiscovery(await refreshHubDiscovery());
    } catch (error) {
      onApiError(error);
    } finally {
      setScanning(false);
    }
  };

  const remove = async (host: HostRecord): Promise<void> => {
    setRemoveBusy(true);
    const problem = await directory.remove(host.hubHostId ?? host.endpoint.id);
    setRemoveBusy(false);
    setRemoving(null);
    setNotice(problem);
    void loadDiscovery();
  };

  const testPush = async (): Promise<void> => {
    try {
      const result = await sendHubTestPush();
      setNotice(
        result.sent === 0
          ? 'No browser is subscribed to this Hub yet — turn notifications on from the bell first.'
          : `Test notification sent to ${result.sent} browser${result.sent === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      onApiError(error);
      setNotice(error instanceof ApiError ? error.message : 'Could not send a test notification.');
    }
  };

  const online = hosts.filter((host) => host.status === 'online').length;
  const unbound = hosts.filter((host) => host.hubBound === false).length;

  return (
    <div className="hub-page">
      <header className="hub-page-head">
        <div className="hub-page-icon">
          <Icon name="hub" size={24} />
        </div>
        <div className="hub-page-title">
          <h1>Hub</h1>
          <p>
            {hosts.length === 0
              ? 'No hosts yet'
              : `${hosts.length} host${hosts.length === 1 ? '' : 's'} · ${online} online${
                  unbound > 0 ? ` · ${unbound} not bound` : ''
                }`}
            {directory.hubVersion !== null && ` · Hub ${directory.hubVersion}`}
          </p>
        </div>
        <button type="button" className="primary hub-page-add" onClick={() => setAdding({})}>
          <Icon name="plus" size={16} />
          Add host
        </button>
      </header>

      {notice && (
        <div className="notice inline info hub-notice" role="status">
          {notice}
          <button type="button" className="round-btn plain" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      <section className="hub-section" aria-labelledby="hub-hosts-heading">
        <h2 id="hub-hosts-heading">Hosts</h2>
        {hosts.length === 0 ? (
          <div className="hub-empty">
            <p>
              A Hub is one front door to several PocketAgent backends. It has nothing to show until
              one is added — by address, or from the backends it has heard on this network below.
            </p>
            <button type="button" className="primary" onClick={() => setAdding({})}>
              <Icon name="plus" size={16} />
              Add your first host
            </button>
          </div>
        ) : (
          <div className="hub-host-grid">
            {hosts.map((host) => (
              <HostCard
                key={host.endpoint.id}
                host={host}
                push={push?.hosts?.[host.hubHostId ?? host.endpoint.id] ?? null}
                onOpen={() => onOpenHost(host.endpoint.id)}
                onBind={() => setBindId(host.hubHostId ?? host.endpoint.id)}
                onEdit={() => setEditId(host.hubHostId ?? host.endpoint.id)}
                onExport={() => setExportFrom(host.hubHostId)}
                onRemove={() => setRemoving(host)}
              />
            ))}
          </div>
        )}
      </section>

      <FleetAgentCard
        hosts={hosts}
        onApiError={onApiError}
        onOpenChat={(fleet) => {
          const coordinator = fleet.coordinatorHostId ? findHostByManageId(hosts, fleet.coordinatorHostId) : null;
          if (!coordinator || !fleet.pocketAgentId) return;
          void fleetChatFor(coordinator.endpoint, fleet.pocketAgentId)
            .then((chatId) => onOpenFleetChat(coordinator.endpoint.id, chatId))
            .catch(onApiError);
        }}
      />

      <DiscoverySection
        discovery={discovery}
        scanning={scanning}
        onScan={() => void scan()}
        onAdd={(found) => setAdding({ label: found.hostname || found.name, basePath: found.baseUrl })}
        labelFor={(id) => byManageId(id)?.label ?? id}
      />

      <section className="hub-section" aria-labelledby="hub-templates-heading">
        <h2 id="hub-templates-heading">Config templates</h2>
        <div className="hub-row-card">
          <Icon name="template" size={20} className="hub-row-icon" />
          <div className="hub-row-main">
            <strong>
              {templateCount === null
                ? 'Templates'
                : templateCount === 0
                  ? 'No templates yet'
                  : `${templateCount} template${templateCount === 1 ? '' : 's'}`}
            </strong>
            <span>
              Pocket Agents, MCP registries, custom Claude providers, skills and the Pocket Agent LLM
              endpoint — defined once here, provisioned onto any bound host. Never synced afterwards.
            </span>
          </div>
          <div className="hub-row-actions">
            {hosts.some((host) => host.hubBound) && (
              <button type="button" onClick={() => setExportFrom(null)}>
                Export from a host…
              </button>
            )}
            <button type="button" className="primary" onClick={onOpenTemplates}>
              Open templates
            </button>
          </div>
        </div>
      </section>

      <section className="hub-section" aria-labelledby="hub-push-heading">
        <h2 id="hub-push-heading">Notifications</h2>
        <div className="hub-row-card">
          <Icon name="bell" size={20} className="hub-row-icon" />
          <div className="hub-row-main">
            <strong>
              {push === null
                ? 'Approval notifications'
                : !push.enabled
                  ? 'Notifications are unavailable on this Hub'
                  : `${push.subscriptions} browser${push.subscriptions === 1 ? '' : 's'} subscribed`}
            </strong>
            <span>
              The Hub relays every bound host’s approval alerts to browsers subscribed here. Each
              host’s card says whether its stream is connected.
            </span>
          </div>
          <div className="hub-row-actions">
            <button type="button" onClick={() => void testPush()} disabled={push?.enabled === false}>
              Send test
            </button>
          </div>
        </div>
      </section>

      {adding !== null && (
        <AddHostDialog
          directory={directory}
          initial={adding}
          onClose={() => {
            setAdding(null);
            void loadDiscovery();
          }}
        />
      )}

      {bindId !== null && (
        <BindHostDialog
          directory={directory}
          hostId={bindId}
          hostLabel={byManageId(bindId)?.label ?? bindId}
          alreadyBound={byManageId(bindId)?.hubBound === true}
          onClose={() => setBindId(null)}
        />
      )}

      {editId !== null &&
        (() => {
          const record = byManageId(editId);
          return record ? (
            <EditHostDialog directory={directory} host={record} onClose={() => setEditId(null)} />
          ) : null;
        })()}

      {exportFrom !== undefined && (
        <ExportFromHostDialog
          preselectedHostId={exportFrom}
          onClose={() => setExportFrom(undefined)}
          onExported={(templateId) => {
            setExportFrom(undefined);
            onOpenTemplate(templateId);
          }}
          onApiError={onApiError}
        />
      )}

      {removing !== null && (
        <ConfirmDialog
          title={`Remove ${removing.label}?`}
          body={
            'The Hub forgets this host and asks it to revoke the Hub’s credential. Nothing on the ' +
            'host itself is touched — its sessions, chats and settings stay, and it can be added again.'
          }
          confirmLabel="Remove host"
          busy={removeBusy}
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

function formatPlatformBadge(platform: string, arch: string): string {
  const osLabel =
    platform === 'darwin'
      ? 'macOS'
      : platform === 'linux'
        ? 'Linux'
        : platform === 'win32'
          ? 'Windows'
          : platform;
  return `${osLabel} · ${arch}`;
}

function formatAgentSetupLabel(setupState: string): string {
  switch (setupState) {
    case 'ready':
      return 'ready';
    case 'signed-out':
      return 'sign in needed';
    case 'not-installed':
      return 'not installed';
    default:
      return 'installed';
  }
}

function HostCard({
  host,
  push,
  onOpen,
  onBind,
  onEdit,
  onExport,
  onRemove,
}: {
  host: HostRecord;
  push: { ok: boolean; status: string; reason?: string } | null;
  onOpen: () => void;
  onBind: () => void;
  onEdit: () => void;
  onExport: () => void;
  onRemove: () => void;
}): JSX.Element {
  const drift = hostDriftMessage(host);
  const caps = host.capabilities ?? null;
  const card = caps?.status === 'ok' ? caps.card : null;
  return (
    <article className="hub-host-card">
      <header className="hub-host-card-head">
        <span className={hostDotClass(host.status)} aria-hidden="true" />
        <Icon name="host" size={18} />
        <strong className="hub-host-card-name">{host.label}</strong>
        {card !== null && (
          <span
            className="hub-pill hub-platform-pill"
            title={`${card.platform} ${card.arch} · ${card.osVersion}`}
          >
            {formatPlatformBadge(card.platform, card.arch)}
          </span>
        )}
        {host.isDefault && (
          <span className="hub-pill" title="Also mounted at the bare /api/* root, so links without a host segment reach it">
            default
          </span>
        )}
      </header>
      <dl className="hub-host-facts">
        {host.reportedName !== null && host.reportedName !== host.label && (
          <>
            <dt>Hostname</dt>
            <dd>{host.reportedName}</dd>
          </>
        )}
        {host.hubBaseUrl !== null && (
          <>
            <dt>Address</dt>
            <dd className="hub-mono">{host.hubBaseUrl}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>
          {hostStatusSummary(host)}
          {host.version !== null && ` · ${host.version}`}
        </dd>
        <dt>Credential</dt>
        <dd className={host.hubBound === false ? 'warn' : undefined}>
          {host.hubBound === false ? 'Not bound — the Hub cannot reach it yet' : 'Bound'}
        </dd>
        {push !== null && (
          <>
            <dt>Alerts</dt>
            <dd className={push.ok ? undefined : 'warn'}>{push.ok ? 'Relayed' : (push.reason ?? push.status)}</dd>
          </>
        )}
      </dl>
      {caps?.status === 'unavailable' && (
        <p className="hub-host-cap-unavailable">Capabilities unavailable (upgrade host)</p>
      )}
      {card !== null && (
        <div className="hub-host-capabilities">
          {card.description.trim() !== '' && (
            <p className="hub-host-cap-desc">{card.description}</p>
          )}
          {card.tags.length > 0 && (
            <div className="hub-host-cap-tags" aria-label="Host tags">
              {card.tags.map((tag) => (
                <span key={tag} className="hub-pill hub-tag-pill">
                  {tag}
                </span>
              ))}
            </div>
          )}
          <dl className="hub-host-facts hub-host-cap-facts">
            <dt>Agents</dt>
            <dd className="hub-cap-list">
              {card.agents.filter((a) => a.available).length === 0 ? (
                <span className="hub-muted">None installed</span>
              ) : (
                card.agents
                  .filter((a) => a.available)
                  .map((a) => (
                    <span
                      key={a.id}
                      className={`hub-cap-chip${
                        a.setupState === 'ready'
                          ? ' ok'
                          : a.setupState === 'signed-out'
                            ? ' warn'
                            : ''
                      }`}
                      title={a.setupDetail ?? a.setupState}
                    >
                      {a.displayName} ({formatAgentSetupLabel(a.setupState)})
                    </span>
                  ))
              )}
            </dd>
            <dt>Tools</dt>
            <dd className="hub-cap-list">
              {card.executables.length === 0 ? (
                <span className="hub-muted">None detected</span>
              ) : (
                card.executables.map((exe) => (
                  <code key={exe} className="hub-cap-chip hub-mono">
                    {exe}
                  </code>
                ))
              )}
            </dd>
            {card.projects.length > 0 && (
              <>
                <dt>Projects</dt>
                <dd>{card.projects.map((p) => p.label).join(', ')}</dd>
              </>
            )}
            {card.pocketAgents.length > 0 && (
              <>
                <dt>Pocket Agents</dt>
                <dd>{card.pocketAgents.map((pa) => pa.name).join(', ')}</dd>
              </>
            )}
            {card.hasWorkspaceIndex !== undefined && (
              <>
                <dt>Workspace index</dt>
                <dd>{card.hasWorkspaceIndex ? 'Available' : 'None'}</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {host.message && <p className="hub-host-problem">{host.message}</p>}
      {drift !== null && <p className="hub-host-note">{drift}</p>}
      <footer className="hub-host-actions">
        <button type="button" className="primary" onClick={onOpen} disabled={host.hubBound === false}>
          Open
        </button>
        <button type="button" onClick={onBind}>
          <Icon name="key" size={14} />
          {host.hubBound ? 'Re-bind' : 'Bind'}
        </button>
        <span className="spacer" />
        {host.hubBound && (
          <button type="button" className="round-btn plain" onClick={onExport} title="Export a configuration to a template" aria-label={`Export from ${host.label}`}>
            <Icon name="template" size={16} />
          </button>
        )}
        <button type="button" className="round-btn plain" onClick={onEdit} title="Rename or change address" aria-label={`Edit ${host.label}`}>
          <Icon name="edit" size={16} />
        </button>
        <button type="button" className="round-btn plain hub-danger" onClick={onRemove} title="Remove from the Hub" aria-label={`Remove ${host.label}`}>
          <Icon name="trash" size={16} />
        </button>
      </footer>
    </article>
  );
}

function DiscoverySection({
  discovery,
  scanning,
  onScan,
  onAdd,
  labelFor,
}: {
  discovery: HubDiscoveryResponse | null;
  scanning: boolean;
  onScan: () => void;
  onAdd: (found: DiscoveredHubHost) => void;
  labelFor: (hostId: string) => string;
}): JSX.Element {
  const listening = discovery?.state === 'listening';
  return (
    <section className="hub-section" aria-labelledby="hub-discovery-heading">
      <div className="hub-section-head">
        <h2 id="hub-discovery-heading">On this network</h2>
        {listening && (
          <button type="button" className="round-btn plain hub-scan" onClick={onScan} disabled={scanning}>
            <Icon name="rotate" size={15} />
            {scanning ? 'Scanning…' : 'Scan again'}
          </button>
        )}
      </div>
      {discovery === null ? (
        <p className="hub-muted">Looking…</p>
      ) : discovery.state !== 'listening' && discovery.state !== 'starting' ? (
        // `disabled` and `failed` both explain themselves; the Hub works either way.
        <p className="hub-muted">{discovery.message}</p>
      ) : discovery.hosts.length === 0 ? (
        <p className="hub-muted">
          No backend is advertising here. A backend announces itself when started with{' '}
          <code>POCKETAGENT_MDNS_ADVERTISE=true</code> and a non-loopback <code>HOST</code>, and it
          has to share a LAN or a Docker network with this Hub, since mDNS does not cross routers.
          Under Docker Compose the variable belongs in the service’s <code>environment:</code> —
          a project’s <code>.env</code> is not passed into the container.
        </p>
      ) : (
        <ul className="hub-discovered">
          {discovery.hosts.map((found) => {
            // Only a range that was advertised can disagree; an advertiser that
            // sent none (`unreachable` in `negotiateProtocol`'s terms) is not
            // evidence of anything until it is added and probed properly.
            const incompatible =
              found.protocol !== null && !negotiateProtocol(PROTOCOL_VERSION, found.protocol).compatible;
            return (
              <li key={found.instance} className="hub-discovered-row">
                <Icon name="broadcast" size={18} className="hub-row-icon" />
                <div className="hub-row-main">
                  <strong>{found.hostname || found.name}</strong>
                  <span className="hub-mono">{found.baseUrl}</span>
                  <span>
                    {found.version !== null ? `Server ${found.version}` : 'Version unknown'}
                    {incompatible && ' · incompatible with this Hub’s UI'}
                    {` · seen ${formatRelative(found.lastSeenAt)}`}
                  </span>
                </div>
                <div className="hub-row-actions">
                  {found.registeredHostId !== null ? (
                    <span className="hub-pill ok" title={`Registered as ${labelFor(found.registeredHostId)}`}>
                      Added
                    </span>
                  ) : (
                    <button type="button" onClick={() => onAdd(found)}>
                      Add…
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
