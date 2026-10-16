"""Offline ACP conformance fixture. No model, provider credentials or filesystem edits."""
import json
import sys


def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)


def update(text):
    send({"method": "session/update", "params": {"sessionId": "fixture", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}})


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
    elif method in ("session/new", "session/load"):
        assert request["params"]["cwd"]
        assert isinstance(request["params"]["mcpServers"], list)
        if method == "session/load":
            update("Replayed history must stay invisible")
        result = {"sessionId": "fixture"}
    elif method == "session/prompt":
        update("Hello ")
        send({"id": "permission-1", "method": "session/request_permission", "params": {"sessionId": "fixture", "toolCall": {"toolCallId": "tool-1", "kind": "execute", "rawInput": {"command": "echo fixture"}}, "options": [{"optionId": "allow_once", "kind": "allow_once"}, {"optionId": "deny", "kind": "reject_once"}]}})
        reply = json.loads(sys.stdin.readline())
        assert reply["id"] == "permission-1"
        assert reply["result"]["outcome"] == {"outcome": "selected", "optionId": "deny"}
        update("world.")
        result = {"stopReason": "end_turn", "usage": {"inputTokens": 10, "outputTokens": 3, "totalTokens": 13}}
    else:
        send({"id": request["id"], "error": {"code": -32601, "message": "Unknown method"}})
        continue
    send({"id": request["id"], "result": result})
