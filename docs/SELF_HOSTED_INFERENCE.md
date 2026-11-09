# Connect a model on another machine

Open Settings → API → Self-hosted endpoints → Add self-hosted endpoint.
The dialog offers **API URL** and **Tailscale quick setup**. Both save an ordinary
OpenAI-compatible endpoint; Tailscale is a way to reach it, not another API format.

With **API URL**, enter a name and the server's full API base URL. Examples:

- HTTPS server: `https://llm.example.com/v1`
- Private Tailscale server: `http://100.64.1.2:8000/v1`
- Existing SSH tunnel: `http://127.0.0.1:18080/v1`

With **Tailscale quick setup**:

1. Connect this Mac and the inference server to the same tailnet.
2. Make the already-running model API reachable on the server's Tailscale
   interface; a server listening only on loopback is not directly reachable.
3. Enter the Tailscale IP or machine name and the actual API port. The shortcut
   builds `http://<machine>:<port>/v1` and displays it before testing or saving.

The shortcut uses HTTP over Tailscale's encrypted network. For an HTTPS endpoint,
an IPv6 literal, or a different API path, paste the full address under **API URL**.
Klide does not install Tailscale, discover machines, or configure the server.

For example, when llama.cpp is already listening on the VPS's loopback port 8081,
start a tunnel yourself with `ssh -N -L 18080:127.0.0.1:8081 user@your-vps`.
Keep it running while using the endpoint. Klide does not install or start anything
on the remote machine in this slice.

Set an optional bearer token reference such as `${LAB_TOKEN}`. Put the value in
the open Workspace's `.env`, the process environment, or `~/.klide/.env`. Testing
resolves the reference in Rust and never returns the value to the interface.

Choose **Test connection** before saving. The check reads `/models` with a
10-second timeout and 2 MiB response limit. It reports authentication, address,
redirect and response-format problems separately, without echoing response bodies.
Select a reported model as the default, then save. Testing does not save config
or issue a model generation request. Models explicitly marked as embedding or
OCR are excluded from chat defaults, using the same task interpretation as the
existing provider picker. Unknown tasks remain available without claiming
verified chat support. Empty chat listings are shown explicitly.

**Model options** also accepts an exact default model ID. Context length is set
on the inference server.

Choose the saved endpoint as the intelligence source for a compatible harness.
Existing native and delegate source selection remains in control: this does not
change your selected agent runtime. Model listing does not establish coding or
tool compatibility. Run the separate live verification protocol when needed.

The agent and Workspace stay local; only inference requests reach the endpoint.
Remote agent execution, remote Workspace paths, host installation and machine
discovery remain separate work. No model or server is started automatically.
