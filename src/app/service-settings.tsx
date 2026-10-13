"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DEFAULT_SERVICE_SETTINGS, ServiceSettingsSchema, type ServiceSettings } from "@/services/settings";

interface Snapshot { revision: number; settings: ServiceSettings; available: boolean; }
interface Readiness { enabled: boolean; state: string; ready: boolean; nextAttemptAt: number; read?: boolean; write?: boolean; }
interface ConnectionReadiness {
  generation: number;
  accountConnected: boolean;
  services: { reminders: Readiness; drive: Readiness };
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message ?? "Settings could not be loaded. Try again.");
  return result;
}

function Toggle({ id, label, checked, disabled, onChange }: {
  id: string; label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  return <label className="service-setting-toggle" htmlFor={id}>
    <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} />
    <span>{label}</span>
  </label>;
}

export default function ServiceSettingsPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<ServiceSettings>(DEFAULT_SERVICE_SETTINGS);
  const [readiness, setReadiness] = useState<ConnectionReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [saved, connection] = await Promise.all([
        request<Snapshot>("/api/settings"),
        request<ConnectionReadiness>("/api/connection").catch(() => null),
      ]);
      const parsed = ServiceSettingsSchema.parse(saved.settings);
      setSnapshot(saved); setDraft(parsed); setReadiness(connection); setNotice("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Settings could not be loaded. Try again.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    let active = true;
    const updateReadiness = () => void request<ConnectionReadiness>("/api/connection")
      .then(value => { if (active) setReadiness(value); })
      .catch(() => { if (active) setReadiness(null); });
    window.addEventListener("icloud-services-changed", updateReadiness);
    return () => { active = false; window.removeEventListener("icloud-services-changed", updateReadiness); };
  }, []);

  function change(next: ServiceSettings) {
    setDraft(ServiceSettingsSchema.parse(next)); setNotice("");
  }

  async function save() {
    if (!snapshot?.available || saving) return;
    const parsed = ServiceSettingsSchema.safeParse(draft);
    if (!parsed.success) { setError("Drive browsing must be enabled before enabling contents, upload, or organize access."); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      const saved = await request<Snapshot>("/api/settings", { expectedRevision: snapshot.revision, settings: parsed.data });
      setSnapshot(saved); setDraft(saved.settings); setNotice("Service preferences saved.");
      setReadiness(await request<ConnectionReadiness>("/api/connection"));
      window.dispatchEvent(new Event("icloud-services-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preferences could not be saved. Reload and try again.");
    } finally { setSaving(false); }
  }

  async function approve(service: "drive" | "reminders", restartApproval = false) {
    if (!readiness) return;
    setSaving(true); setError("");
    try {
      setReadiness(await request<ConnectionReadiness>(`/api/${service}/approve`, { expectedGeneration: readiness.generation, restartApproval }));
      window.dispatchEvent(new Event("icloud-services-changed"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Apple approval could not be checked."); }
    finally { setSaving(false); }
  }
  const remindersReadReady = readiness?.services.reminders.read === true;
  const remindersWriteReady = readiness?.services.reminders.write === true;
  const driveReady = readiness?.services.drive.ready === true;
  const approvalActions = (service: "drive" | "reminders") => {
    const current = readiness?.services[service];
    if (!current?.enabled || current.ready) return null;
    return <div className="action-row">
      <Button variant="outline" disabled={saving || !readiness?.accountConnected} onClick={() => void approve(service)}>
        {current.state === "DEVICE_APPROVAL_PENDING" ? "Check Apple approval" : `Approve ${service === "drive" ? "Drive" : "Reminders"} access`}
      </Button>
      {["ERROR", "DEVICE_APPROVAL_PENDING"].includes(current.state) && <Button variant="ghost" disabled={saving || !readiness?.accountConnected} onClick={() => void approve(service, true)}>Start new approval</Button>}
      <span className="fine-print">{current.state.replaceAll("_", " ").toLowerCase()}. Approval is checked only when you request it.</span>
    </div>;
  };
  const changed = !!snapshot && JSON.stringify(snapshot.settings) !== JSON.stringify(draft);
  const unavailable = !loading && snapshot?.available === false;
  const disabled = loading || saving || !snapshot?.available;

  return <section className="dashboard-card service-settings" aria-labelledby="service-settings-title">
    <div className="card-heading"><div><h2 id="service-settings-title">Services</h2><p>Choose what your agent may access. These settings apply to the dashboard, HTTP API and agent tools. Turning a service off stops new operations; it does not delete your iCloud data.</p></div></div>
    {loading && <p role="status">Loading service preferences…</p>}
    {unavailable && <p className="fine-print" role="status">Saved preferences are unavailable until the service settings migration is applied. The displayed defaults preserve existing Reminders access and keep Drive off.</p>}
    {error && <p className="connection-error" role="alert">{error}</p>}
    {notice && <p className="fine-print" role="status">{notice}</p>}

    <fieldset className="service-setting-group" disabled={disabled}>
      <legend>Reminders</legend>
      <p>Default: enabled, with reading and writing enabled. Existing deployment and Apple connection gates still apply.</p>
      <Toggle id="reminders-enabled" label="Enable Reminders" checked={draft.reminders.enabled} onChange={enabled => change({ ...draft, reminders: { ...draft.reminders, enabled } })} />
      <div className="service-setting-operations">
        <Toggle id="reminders-read" label="Read reminders and lists" checked={draft.reminders.read} disabled={!draft.reminders.enabled} onChange={read => change({ ...draft, reminders: { ...draft.reminders, read } })} />
        <Toggle id="reminders-write" label="Create, edit, complete, reopen, and delete reminders" checked={draft.reminders.write} disabled={!draft.reminders.enabled} onChange={write => change({ ...draft, reminders: { ...draft.reminders, write } })} />
      </div>
      <p className="fine-print">Read readiness: {remindersReadReady ? "Apple connection and deployment gates are ready." : !snapshot?.settings.reminders.enabled || !snapshot.settings.reminders.read ? "Disabled by the saved preference." : "Not ready yet. A saved preference does not connect Apple or override deployment approvals."}</p>
      <p className="fine-print">Write readiness: {remindersWriteReady ? "Apple connection, write capability, and deployment gates are ready." : !snapshot?.settings.reminders.enabled || !snapshot.settings.reminders.write ? "Disabled by the saved preference." : "Not ready yet. A saved preference does not connect Apple or override deployment approvals."}</p>
      {approvalActions("reminders")}
    </fieldset>

    <fieldset className="service-setting-group" disabled={disabled}>
      <legend>iCloud Drive</legend>
      <p>Default: disabled, with all operation groups disabled. Save your preferences, then approve Drive access with Apple.</p>
      <Toggle id="drive-enabled" label="Enable iCloud Drive" checked={draft.drive.enabled} onChange={enabled => change({ ...draft, drive: { ...draft.drive, enabled, browse: draft.drive.browse || enabled && (draft.drive.contents || draft.drive.upload || draft.drive.organize) } })} />
      <div className="service-setting-operations">
        <Toggle id="drive-browse" label="Browse folders and file metadata" checked={draft.drive.browse} disabled={!draft.drive.enabled} onChange={browse => change({ ...draft, drive: { ...draft.drive, browse, ...(!browse ? { contents: false, upload: false, organize: false } : {}) } })} />
        <Toggle id="drive-contents" label="Read and download file contents" checked={draft.drive.contents} disabled={!draft.drive.enabled || !draft.drive.browse} onChange={contents => change({ ...draft, drive: { ...draft.drive, contents } })} />
        <Toggle id="drive-upload" label="Upload new files" checked={draft.drive.upload} disabled={!draft.drive.enabled || !draft.drive.browse} onChange={upload => change({ ...draft, drive: { ...draft.drive, upload } })} />
        <Toggle id="drive-organize" label="Create, rename, and move folders and files" checked={draft.drive.organize} disabled={!draft.drive.enabled || !draft.drive.browse} onChange={organize => change({ ...draft, drive: { ...draft.drive, organize } })} />
      </div>
      <p className="fine-print">Browse is required for contents, upload, and organize. Upload does not require reading file contents. Read/download exposes file bytes. Organize excludes deletion, sharing, and replacing existing file contents.</p>
      <p className="fine-print">Readiness: {driveReady ? "Drive access is ready." : "Save the desired permissions and approve Drive access below."}</p>
      {approvalActions("drive")}
    </fieldset>

    <div className="action-row">
      <Button className="action-primary" disabled={disabled || !changed} onClick={() => void save()}>{saving ? "Saving preferences…" : "Save service preferences"}</Button>
      <Button variant="outline" disabled={loading || saving} onClick={() => void refresh()}>Reload preferences</Button>
    </div>
  </section>;
}
