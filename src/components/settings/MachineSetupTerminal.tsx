import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { terminalLook } from "../../terminalTheme";
import "@xterm/xterm/css/xterm.css";

/** Optional diagnostic view. Opening or hiding it never restarts setup. */
export default function MachineSetupTerminal({ id, output, onInput }: {
  id: string; output: string; onInput: (data: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const lastOutput = useRef("");
  const input = useRef(onInput);
  input.current = onInput;
  useEffect(() => {
    const view = new Terminal({ ...terminalLook(), fontSize: 12, cursorBlink: true, scrollback: 1500 });
    const fit = new FitAddon();
    view.loadAddon(fit); view.open(container.current!); view.focus(); terminal.current = view;
    lastOutput.current = "";
    const listener = view.onData((data) => input.current(data));
    const observer = new ResizeObserver(() => {
      fit.fit();
      void invoke("pty_resize", { id, rows: view.rows, cols: view.cols }).catch(() => {});
    });
    observer.observe(container.current!);
    return () => { observer.disconnect(); listener.dispose(); view.dispose(); terminal.current = null; };
  }, [id]);
  useEffect(() => {
    const view = terminal.current;
    if (!view) return;
    if (output.startsWith(lastOutput.current)) view.write(output.slice(lastOutput.current.length));
    else { view.reset(); view.write(output); }
    lastOutput.current = output;
  }, [output, id]);
  return <div ref={container} className="klide-machine-terminal" aria-label="Remote setup terminal" />;
}
