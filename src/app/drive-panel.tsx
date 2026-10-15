"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, File, FileText, Folder, FolderPlus, RefreshCw, Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DriveItem } from "@/icloud/drive";
import { DRIVE_FILE_BYTES, DRIVE_FILE_LIMIT_LABEL } from "@/drive/limits";
import { uploadDriveFile, pendingDriveUpload, discardDriveUpload } from "@/lib/drive-upload";

const ROOT = "FOLDER::com.apple.CloudDocs::root";
interface Connection { generation: number; services: { drive: { enabled: boolean; ready: boolean; browse: boolean; contents: boolean; upload: boolean; organize: boolean } }; }
interface Listing { folder: DriveItem; items: DriveItem[]; complete: boolean; }
interface Operation { operationId: string; phase: string; result?: unknown; }
interface TextPreview { item: DriveItem; content: string; bytesRead: number; truncated: boolean; }
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json() as { error?: { message?: string } } & Operation;
  if (!response.ok) throw new Error(result.error?.message ?? "The Drive request did not finish.");
  return result as T;
}

export default function DrivePanel() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [trail, setTrail] = useState<{ id: string; name: string; shareContext?: string }[]>([{ id: ROOT, name: "iCloud Drive" }]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [name, setName] = useState(""), [query, setQuery] = useState("");
  const [matches, setMatches] = useState<DriveItem[] | null>(null);
  const [continuation, setContinuation] = useState<string | null>(null);
  const [searchComplete, setSearchComplete] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<string | null>(null);
  const [preview, setPreview] = useState<TextPreview | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folder = trail[trail.length - 1]!;
  const access = connection?.services.drive;
  const refreshStatus = useCallback(async () => {
    try {
      const next = await call<Connection>("/api/connection");
      setConnection(previous => {
        if (previous?.generation !== next.generation || !next.services.drive.browse) { setListing(null); setMatches(null); setTrail([{ id: ROOT, name: "iCloud Drive" }]); }
        if (previous?.generation !== next.generation || !next.services.drive.contents) setPreview(null);
        return next;
      });
    } catch { setConnection(null); setListing(null); setMatches(null); setPreview(null); }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      try { const id = pendingDriveUpload(); setOperation(id); setPendingUpload(id); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "The retained upload could not be read."); }
      void refreshStatus();
    }, 0);
    window.addEventListener("icloud-services-changed", refreshStatus);
    return () => { clearTimeout(timer); window.removeEventListener("icloud-services-changed", refreshStatus); };
  }, [refreshStatus]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Drive is unavailable.");
      window.dispatchEvent(new Event("icloud-services-changed"));
    }
    finally {
      setBusy(false);
      try { setPendingUpload(pendingDriveUpload()); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "The retained upload could not be read."); }
    }
  }
  const context = { expectedGeneration: connection?.generation };
  async function browse(nextTrail = trail) {
    const result = await call<Listing>("/api/drive/list", { ...context, folderId: nextTrail[nextTrail.length - 1]!.id, shareContext: nextTrail[nextTrail.length - 1]!.shareContext });
    setListing(result); setTrail(nextTrail); setMatches(null); setContinuation(null); setPreview(null);
  }
  async function find(more = false) {
    const result = await call<{ items: DriveItem[]; complete: boolean; continuation: string | null }>("/api/drive/search", { ...context, folderId: folder.id, shareContext: folder.shareContext, query, ...(more && continuation ? { continuation } : {}) });
    setMatches(previous => more ? [...(previous ?? []), ...result.items] : result.items); setContinuation(result.continuation); setSearchComplete(result.complete);
  }
  async function download(item: DriveItem) {
    const result = await call<{ url: string }>("/api/drive/download", { ...context, itemId: item.id, shareContext: item.shareContext });
    // Same-origin owner authentication is retained by the browser. The handle
    // never contains an Apple signed URL or turns into a public share.
    const link = document.createElement("a"); link.href = result.url; link.download = item.name; link.click();
  }
  async function previewText(item: DriveItem) {
    setPreview(null);
    setPreview(await call<TextPreview>("/api/drive/read", { ...context, itemId: item.id, shareContext: item.shareContext, encoding: "utf8", previewBytes: 8192 }));
  }
  function retain(result: Operation) {
    setOperation(result.operationId);
    setNotice(result.phase === "confirmed" ? "Change confirmed by Apple." : `Operation ${result.phase}. Inspect its status before starting another change.`);
  }
  async function upload(file: globalThis.File) {
    if (file.size > DRIVE_FILE_BYTES) throw new Error(`Choose a file no larger than ${DRIVE_FILE_LIMIT_LABEL}.`);
    const result = await uploadDriveFile(file, { ...context, parentId: folder.id }, (text, id) => { setNotice(text); if (id) setOperation(id); });
    retain(result); await browse();
  }
  const items = matches ?? listing?.items ?? [];
  return <section className="dashboard-card drive-panel" aria-labelledby="drive-title">
    <div className="card-heading"><div className="card-icon"><Folder size={22} aria-hidden="true" /></div><div><h2 id="drive-title">iCloud Drive</h2><p>Browse your own and shared Drive folders. Transfer files and organise owned items.</p></div></div>
    {!access?.browse ? <p className="fine-print">{access?.enabled ? "Save browsing permission and approve Drive access in Services above." : "Enable iCloud Drive in Services above to get started."}</p> : <>
      <nav className="drive-breadcrumbs" aria-label="Drive folder">{trail.map((entry, index) => <Button variant="ghost" key={`${entry.id}-${index}`} disabled={busy} onClick={() => void run(() => browse(trail.slice(0, index + 1)))}>{entry.name}</Button>)}</nav>
      {folder.shareContext && <p className="fine-print">Shared folder: browsing and downloads are available. Changes to shared items are not supported.</p>}
      <div className="action-row"><Button variant="outline" disabled={busy} onClick={() => void run(() => browse())}><RefreshCw size={16} />Refresh folder</Button>
        {access.upload && !folder.shareContext && <><input ref={fileInput} type="file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void run(() => upload(file)); }} /><Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={16} />Upload file (up to {DRIVE_FILE_LIMIT_LABEL})</Button></>}
      </div>
      {pendingUpload && access.upload && <p className="fine-print">Interrupted a large upload? Reselect the same file in its original folder to resume. <Button variant="ghost" disabled={busy} onClick={() => void run(async () => { await discardDriveUpload(pendingUpload); setNotice("Staged data discarded. Any Apple operation receipt is retained."); })}>Discard staged data</Button></p>}
      <form className="drive-form" onSubmit={event => { event.preventDefault(); void run(() => find()); }}><label htmlFor="drive-search">Find file or folder names within this folder</label><div className="action-row"><input id="drive-search" value={query} maxLength={200} disabled={busy || !!continuation} onChange={event => setQuery(event.target.value)} /><Button variant="outline" disabled={busy || !query.trim()} type="submit"><Search size={16} />Search</Button>{matches && <Button variant="ghost" disabled={busy} onClick={() => { setMatches(null); setContinuation(null); }}>Clear search</Button>}</div></form>
      {access.organize && !folder.shareContext && <form className="drive-form" onSubmit={event => { event.preventDefault(); void run(async () => { const operationId = crypto.randomUUID(); setOperation(operationId); retain(await call<Operation>("/api/drive/create-folder", { ...context, parentId: folder.id, name, operationId })); setName(""); await browse(); }); }}><label htmlFor="drive-folder-name">New folder name</label><div className="action-row"><input id="drive-folder-name" value={name} maxLength={255} disabled={busy} onChange={event => setName(event.target.value)} /><Button type="submit" variant="outline" disabled={busy || !name.trim()}><FolderPlus size={16} />Create folder</Button></div></form>}
      <ul className="drive-items">{items.map(item => <li key={`${item.id}|${item.shareContext ?? ""}`}><span className="drive-item-name">{item.type === "folder" ? <Folder size={18} /> : <File size={18} />}{item.name}</span><span className="fine-print">{item.size === null ? "Folder" : `${Math.ceil(item.size / 1024)} KiB`}</span>{item.type === "folder" ? <Button variant="ghost" disabled={busy} onClick={() => void run(() => browse([...trail, { id: item.id, name: item.name, shareContext: item.shareContext }]))}>Open</Button> : access.contents && <><Button variant="ghost" disabled={busy || item.package || (item.size ?? Infinity) > DRIVE_FILE_BYTES} onClick={() => void run(() => previewText(item))}><FileText size={16} />Preview text</Button><Button variant="ghost" disabled={busy || (item.size ?? Infinity) > DRIVE_FILE_BYTES} onClick={() => void run(() => download(item))}><Download size={16} />{item.package ? "Download archive" : "Download"}</Button></>}</li>)}</ul>
      {preview && <div className="drive-preview"><h3>Text preview: {preview.item.name}</h3><p className="fine-print">Read {preview.bytesRead} leading bytes. {preview.truncated ? "This preview is truncated; download the file for its full contents." : "The preview contains the file's text."} Previews support UTF-8 text and do not extract PDF or Office document contents.</p><pre>{preview.content}</pre><Button variant="ghost" onClick={() => setPreview(null)}>Close preview</Button></div>}
      {listing && !items.length && <p className="fine-print">{matches ? "No matches in the folders checked so far." : listing.complete ? "This folder is empty." : "No supported items are visible in this incomplete listing."}</p>}
      {listing && !listing.complete && matches === null && <p className="fine-print">This listing is incomplete. Some items are outside the supported scope or response budget.</p>}
      {matches && <p className="fine-print">{searchComplete ? "Finished this supported folder-tree search." : "Search is incomplete."} {continuation && <Button variant="outline" disabled={busy} onClick={() => void run(() => find(true))}>Continue search</Button>}</p>}
    </>}
    {busy && <p role="status" className="fine-print">Working with iCloud Drive…</p>}
    {error && <p role="alert" className="connection-error">{error}</p>}
    {notice && <p role="status" className="fine-print">{notice}</p>}
    {operation && <div className="drive-operation"><p className="fine-print">Retained operation: <code>{operation}</code>. If interrupted, inspect it before starting another upload or folder creation.</p><Button variant="outline" disabled={busy || !access?.browse} onClick={() => void run(async () => retain(await call<Operation>("/api/drive/operation", { ...context, operationId: operation })))}>Inspect operation</Button></div>}
  </section>;
}
