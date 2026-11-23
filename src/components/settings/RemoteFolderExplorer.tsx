import { useEffect, useRef, useState } from "react";
import { machineRemoteCreateDirectory, machineRemoteDirectories, type RemoteDirectories } from "../../ipc/machines";
import { errMessage } from "../../errors";
import { FolderIcon } from "../../icons";
import { GhostButton } from "./controls";

export default function RemoteFolderExplorer({ machineId, onChoose, onCancel }: {
  machineId: string; onChoose: (path: string) => void; onCancel: () => void;
}) {
  const [listing, setListing] = useState<RemoteDirectories | null>(null);
  const [address, setAddress] = useState("~");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(0);
  async function load(path: string) {
    const version = ++request.current;
    setLoading(true); setError("");
    try {
      const result = await machineRemoteDirectories(machineId, path);
      if (version === request.current) { setListing(result); setAddress(result.path); }
    } catch (reason) { if (version === request.current) setError(errMessage(reason)); }
    finally { if (version === request.current) setLoading(false); }
  }
  useEffect(() => { void load("~"); return () => { ++request.current; }; }, [machineId]);
  async function create() {
    if (!listing || !name.trim()) return;
    const version = ++request.current;
    setLoading(true); setError("");
    try {
      const result = await machineRemoteCreateDirectory(machineId, listing.path, name.trim());
      if (version === request.current) { setListing(result); setAddress(result.path); setCreating(false); setName(""); }
    } catch (reason) { if (version === request.current) setError(errMessage(reason)); }
    finally { if (version === request.current) setLoading(false); }
  }
  return <section className="klide-remote-folders" aria-label="Remote folder explorer" aria-busy={loading}>
    <form className="klide-remote-folder-address" onSubmit={(event) => { event.preventDefault(); if (address.trim()) void load(address.trim()); }}>
      <GhostButton disabled={loading} onClick={() => { void load("~"); }}>Home</GhostButton>
      <GhostButton disabled={loading || !listing?.parent} onClick={() => { if (listing?.parent) void load(listing.parent); }}>Up</GhostButton>
      <input className="klide-field" aria-label="Remote location" value={address} onChange={(event) => setAddress(event.target.value)} />
      <button type="submit" className="klide-button klide-button-ghost" disabled={loading || !address.trim()}>Go</button>
    </form>
    <div className="klide-remote-folder-list" role="list" aria-label="Remote folders">
      {listing?.entries.map((entry) => <div role="listitem" key={entry.path}><button type="button" disabled={loading} onClick={() => { void load(entry.path); }}><FolderIcon size={16} /><span>{entry.name}</span></button></div>)}
      {loading ? <p role="status">Loading folders…</p> : !error && !listing?.entries.length ? <p>No folders here.</p> : null}
    </div>
    {listing?.truncated && <p>Showing the first 500 folders. Enter a more specific location above.</p>}
    {error && <p role="alert" className="klide-add-machine-error">{error}</p>}
    {creating && <form className="klide-remote-folder-create" onSubmit={(event) => { event.preventDefault(); void create(); }}><input className="klide-field" aria-label="New folder name" value={name} onChange={(event) => setName(event.target.value)} autoFocus disabled={loading} /><button type="submit" className="klide-button klide-button-ghost" disabled={loading || !name.trim()}>Create folder</button></form>}
    <div className="klide-machine-actions"><GhostButton disabled={loading || !listing || !!error} onClick={() => { if (listing) onChoose(listing.path); }}>Choose this folder</GhostButton><GhostButton disabled={loading || !listing} onClick={() => setCreating((open) => !open)}>New folder</GhostButton><GhostButton onClick={onCancel}>Cancel</GhostButton></div>
  </section>;
}
