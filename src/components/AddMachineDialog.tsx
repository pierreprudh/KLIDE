import { lazy, Suspense, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "../icons";
import type { Machine } from "../ipc/machines";
import { MachineSetupWaiting } from "./settings/MachineSetupWaiting";
import "./settings/machineSetupDialog.css";

const AddMachineForm = lazy(() => import("./settings/AddMachineForm"));

/** The shell opens immediately; SSH setup and the terminal load inside it. */
export function AddMachineDialog({ workspaceRoot, onClose, onSaved }: {
  workspaceRoot: string | null; onClose: () => void; onSaved?: (machines: Machine[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="klide-add-machine-dialog" aria-labelledby="klide-add-machine-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><h2 id="klide-add-machine-title">Add a machine</h2><button type="button" className="klide-add-machine-close" aria-label="Close add machine" onClick={onClose}><CloseIcon size={18} /></button></header>
    <div className="klide-add-machine-body"><Suspense fallback={<MachineSetupWaiting>Opening machine setup</MachineSetupWaiting>}><AddMachineForm workspaceRoot={workspaceRoot} onClose={onClose} onSaved={onSaved} /></Suspense></div>
  </dialog>, document.body);
}
