# Connect a model on another machine

Open Settings → API → Self-hosted endpoints → Add self-hosted endpoint.
Enter a name and the OpenAI-compatible API base URL. Examples:

- HTTPS server: `https://llm.example.com/v1`
- Private Tailscale server: `http://100.64.1.2:8000/v1`
- Existing SSH tunnel: `http://127.0.0.1:18080/v1`

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
or issue a model generation request. Empty listings are shown explicitly.

Choose the saved endpoint as the intelligence source for a compatible harness.
Existing native and delegate source selection remains in control: this does not
change your selected agent runtime. Model listing does not establish coding or
tool compatibility. Run the separate live verification protocol when needed.

The agent and Workspace stay local; only inference requests reach the endpoint.
Remote agent execution, remote Workspace paths, host installation and machine
discovery remain separate work. No model or server is started automatically.
