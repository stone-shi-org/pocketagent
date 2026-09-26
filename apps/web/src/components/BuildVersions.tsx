import { formatBuildInfo } from '../version.js';

/**
 * Which build of which component is running, labelled (PA-107).
 *
 * The line this replaces was the *web bundle's* `formatBuildInfo()` with no
 * label, so "0.1.0+225b7594" read as the server's version — true standalone,
 * where the backend serves the bundle, and false behind a Hub, which serves
 * it itself. So each line now names its component:
 *
 * - **Server** — the selected host's own `HostInfo.version`
 *   (`serverVersionLine`), which is what `/health` reports and what PA-69's
 *   drift badge compares, so the two cannot disagree about one machine.
 * - **Hub** — only when a Hub is present (`HostDirectory.hubVersion`, from the
 *   Hub's own `/health`). Standalone there is no such line at all, rather
 *   than an empty one.
 * - The bundle itself stays reachable in the tooltip, because "is this tab
 *   stale?" is still a real question after a deploy.
 *
 * One line per component rather than one ellipsised string, which is what
 * the truncation bug was: `white-space: nowrap` cut the build date off.
 */
export function BuildVersions({
  server,
  serverDetail,
  drift,
  hubVersion,
  className,
}: {
  /** E.g. "Server 1.2.3"; null until a host has reported one. */
  server: string | null;
  /** Per-host breakdown for the aggregated view, tooltip only. */
  serverDetail?: string | null;
  /** PA-69's drift sentence for the selected host, or null. */
  drift?: string | null;
  hubVersion: string | null;
  className: string;
}): JSX.Element {
  const bundle = `Web UI ${formatBuildInfo()}`;
  const title = [serverDetail, drift, bundle].filter(Boolean).join('\n');
  return (
    <span className={className} title={title}>
      <span className="build-version-line">
        {server ?? 'Server …'}
        {drift && <span className="build-version-update"> · update available</span>}
      </span>
      {hubVersion !== null && <span className="build-version-line">Hub {hubVersion}</span>}
    </span>
  );
}
