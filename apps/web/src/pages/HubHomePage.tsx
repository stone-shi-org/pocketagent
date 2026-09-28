import { Suspense, useState } from 'react';
import { AddHostDialog } from '../components/AddHostDialog.js';
import { HostSheet } from '../components/HostSheet.js';
import { Icon } from '../components/Icon.js';
import { PushToggle } from '../components/PushToggle.js';
import { findHostByManageId } from '../hosts/host-status.js';
import { overflowMenuItems } from '../hosts/hub-view.js';
import type { HostDirectory } from '../hosts/directory.js';
import type { HostNav } from '../hosts/HostNav.js';
import { BindHostDialog } from '../components/BindHostDialog.js';
import { EditHostDialog } from '../components/EditHostDialog.js';
import { HubPage } from '../lazy-pages.js';
import { OverflowMenu, menuHandlers } from './ProjectsPage.js';

/**
 * The phone's Hub view (PA-110): `HubPage` under the same header shape the
 * phone's home screen uses — title, the switcher chip, the overflow menu.
 *
 * The chip reads "Hub" and opens the same `HostSheet` with the Hub entry
 * selected, so the way back to a host is exactly the way here. The menu is
 * `overflowMenuItems({ view: 'hub' })`: Hub items only, which on a Hub with no
 * hosts is the entire point — there is no server for anything else to reach.
 */
export function HubHomePage({
  nav,
  directory,
  onOpenTemplates,
  onOpenTemplate,
  onApiError,
  onLogout,
}: {
  nav: HostNav;
  directory: HostDirectory;
  onOpenTemplates: () => void;
  onOpenTemplate: (templateId: string) => void;
  onApiError: (error: unknown) => void;
  onLogout: () => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSheet, setShowSheet] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [bindId, setBindId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const hosts = directory.hosts;

  return (
    <div className="app hub-home">
      <header className="home-bar">
        <div className="home-title">
          <strong>Remote</strong>
          <button
            type="button"
            className="host-chip as-button"
            onClick={() => setShowSheet(true)}
            aria-label="Switch host"
            title="Switch host"
          >
            <Icon name="hub" />
            <span className="host-name">Hub</span>
          </button>
        </div>
        <span className="spacer" />
        <PushToggle compact />
        <button
          type="button"
          className="round-btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="More"
          aria-expanded={menuOpen}
        >
          <Icon name="ellipsis" size={20} />
        </button>
        {menuOpen && (
          <OverflowMenu
            onClose={() => setMenuOpen(false)}
            items={overflowMenuItems({ view: 'hub', source: directory.source, layout: 'phone' })}
            handlers={menuHandlers(
              (action) => {
                setMenuOpen(false);
                action();
              },
              {
                refresh: () => directory.refresh(),
                // No 'hub-overview': this page *is* the overview, and an item
                // with no handler is not rendered.
                'hub-add-host': () => setShowAdd(true),
                'hub-templates': onOpenTemplates,
                signout: onLogout,
              },
            )}
          />
        )}
      </header>

      <div className="home-scroll">
        <Suspense fallback={<div className="spinner">Loading…</div>}>
          <HubPage
            directory={directory}
            onOpenHost={(hostId) => nav.goToHost(hostId)}
            onOpenTemplates={onOpenTemplates}
            onOpenTemplate={onOpenTemplate}
            onApiError={onApiError}
          />
        </Suspense>
      </div>

      {showSheet && (
        <HostSheet
          hosts={hosts}
          hubVersion={directory.hubVersion}
          selectedHostId={null}
          hub={{ active: true, onSelect: () => undefined }}
          onSelectAll={() => nav.goToHost(null)}
          onSelect={(hostId) => nav.goToHost(hostId)}
          onAdd={() => setShowAdd(true)}
          onRemove={(hostId) => void directory.remove(hostId)}
          onBind={(hostId) => setBindId(hostId)}
          onEdit={(hostId) => setEditId(hostId)}
          onClose={() => setShowSheet(false)}
          canManage={directory.canManage}
        />
      )}
      {showAdd && <AddHostDialog directory={directory} onClose={() => setShowAdd(false)} />}
      {bindId !== null && (
        <BindHostDialog
          directory={directory}
          hostId={bindId}
          hostLabel={findHostByManageId(hosts, bindId)?.label ?? bindId}
          alreadyBound={findHostByManageId(hosts, bindId)?.hubBound === true}
          onClose={() => setBindId(null)}
        />
      )}
      {editId !== null &&
        (() => {
          const record = findHostByManageId(hosts, editId);
          return record ? (
            <EditHostDialog directory={directory} host={record} onClose={() => setEditId(null)} />
          ) : null;
        })()}
    </div>
  );
}
