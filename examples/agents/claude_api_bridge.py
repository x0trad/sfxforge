"""
Connect a Claude API agent (e.g. a Hermes child agent) to the local sfx-mcp server.

The Messages API's built-in MCP connector only reaches public HTTPS servers, so this
script runs sfx-mcp itself over stdio, offers its tools to Claude, and feeds tool
results back, including the preview images, so Claude can see each sound it makes.

    pip install anthropic mcp
    export ANTHROPIC_API_KEY=...
    python claude_api_bridge.py "Make a heavy punch and a 30 second fight track, then export a pack"

Settings come from environment variables:
    SFX_SERVER   path to sfx-forge/src/server.js   (default: ../../src/server.js next to this file)
    SFX_DIR      where sounds and WAVs are written  (default: ./sfx)
    SFX_TOOLS    optional comma-separated allowlist, e.g. "generate_music,remix_music,render_sound"
    SFX_MODEL    model id                          (default: claude-sonnet-5-5)
"""
import asyncio
import os
import sys

from anthropic import Anthropic
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.environ.get("SFX_SERVER", os.path.join(HERE, "..", "..", "src", "server.js"))
SFX_DIR = os.path.abspath(os.environ.get("SFX_DIR", "sfx"))
ALLOW = {t.strip() for t in os.environ.get("SFX_TOOLS", "").split(",") if t.strip()}
MODEL = os.environ.get("SFX_MODEL", "claude-sonnet-5-5")

SYSTEM = (
    "You are the sound designer for a 2D fighting game. Use the sfx tools to create sound effects and music. "
    "Every render returns numbers and a preview image (rows of hits on top, waveform below): look at them, "
    "then refine with edit_sound, apply_macro, mutate_sound or remix_music before exporting. "
    "Keep impacts short (under 0.4 s) and music loops 30-45 s unless told otherwise."
)


def server_params():
    env = dict(os.environ, SFX_DIR=SFX_DIR)
    return StdioServerParameters(command="node", args=[os.path.abspath(SERVER)], env=env)


def _get(obj, *names, default=None):
    """Read a field under either spelling (the mcp package renamed camelCase fields to snake_case)."""
    for n in names:
        v = getattr(obj, n, None)
        if v is not None:
            return v
    return default


def to_claude_tools(mcp_tools):
    return [
        {"name": t.name, "description": t.description or "", "input_schema": _get(t, "input_schema", "inputSchema")}
        for t in mcp_tools
        if not ALLOW or t.name in ALLOW
    ]


def to_tool_result(block_id, result):
    """MCP tool result -> Claude tool_result block (text and images pass through)."""
    content = []
    for c in result.content:
        if c.type == "text":
            content.append({"type": "text", "text": c.text})
        elif c.type == "image":
            content.append({"type": "image", "source": {"type": "base64", "media_type": _get(c, "mime_type", "mimeType"), "data": c.data}})
    return {"type": "tool_result", "tool_use_id": block_id, "content": content or [{"type": "text", "text": "(no output)"}],
            "is_error": bool(_get(result, "is_error", "isError", default=False))}


async def run(task, max_turns=20):
    client = Anthropic()
    async with stdio_client(server_params()) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = to_claude_tools((await session.list_tools()).tools)
            messages = [{"role": "user", "content": task}]
            for _ in range(max_turns):
                resp = client.messages.create(model=MODEL, max_tokens=4000, system=SYSTEM, tools=tools, messages=messages)
                messages.append({"role": "assistant", "content": resp.content})
                for b in resp.content:
                    if b.type == "text" and b.text.strip():
                        print(b.text)
                if resp.stop_reason != "tool_use":
                    return
                results = []
                for b in resp.content:
                    if b.type == "tool_use":
                        print(f"  → {b.name}")
                        results.append(to_tool_result(b.id, await session.call_tool(b.name, b.input)))
                messages.append({"role": "user", "content": results})


if __name__ == "__main__":
    asyncio.run(run(" ".join(sys.argv[1:]) or "Make a light punch, a heavy punch and a 30 second fight track, then export_pack them."))
