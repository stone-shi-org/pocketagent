/**
 * A `SelectRow` alike for a form with an explicit Save.
 *
 * `SettingsPage`'s own `SelectRow` always fires immediately (auto-save, one
 * field at a time), while a value picked in the cron or webhook editor is only
 * sent once the whole form is submitted. Same row shell and CSS classes, just a
 * plain `value`/`onChange` rather than a save call.
 *
 * Lifted out of `CronJobEditorPage` when the webhook editor needed the identical
 * thing for another seven rows — a second copy of a row this subtle is
 * guaranteed to drift, which is the same reuse argument that already applies to
 * `NumberRow`/`SectionCard`/`TextRow` coming straight from `SettingsPage`.
 */
export function SelectRowNative({
  label,
  help,
  value,
  options,
  busy,
  onChange,
}: {
  label: string;
  help?: string;
  value: string;
  options: { value: string; label: string }[];
  busy?: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-row-info">
          <label className="settings-row-label">{label}</label>
          {help && <p className="transport-hint">{help}</p>}
        </div>
        <div className="settings-row-control settings-select-control">
          <select
            className="settings-select"
            value={value}
            disabled={busy}
            onChange={(e) => onChange(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
