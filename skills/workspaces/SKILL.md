---
name: bot-stage-workspaces
description: Draw or redraw a conversation's original pixel workspace in Bot Stage when explicitly requested.
---

Bot Stage requests an original 128×128 scene on the first turn using the user's
initial message as its sole creative brief. The conversation's own agent draws
the palette and rectangle geometry with `bot_stage_workspace`; no preset rooms,
title matching, hash-based selection, extra threads or external image service.
The result is saved per thread in plugin storage and published to the live UI.
Later turns preserve it. Use `replace: true` only for an explicit redraw request.

The tool accepts `{scene: {name, palette, rects}, replace?: boolean}`. Palette 0
fills the background. Rectangles are `[x,y,width,height,paletteIndex]`, integers
within 128×128, drawn in order. Use 3–24 colors and 20–256 rectangles. Draw an
entire original environment with three task-specific objects; keep the lower
left clear for the original animated bot and its expressions. No status text,
private details, scripts or external assets. Identical rendered scenes cannot
be reused by another thread.

New sessions receive these instructions automatically. Sessions already running
when the plugin was updated receive them at their next provider session start;
pending rooms remain empty rather than showing a reused scene. An existing
thread must use its first user message, excluding agent-only injected context.
If the native tool is unavailable in an older session, an authenticated CLI
fallback is `bb plugin rpc call bot-stage workspace_save --input-file <json>`:
the file contains the same input plus `threadId`. Do not send a message to or
restart another thread just to generate its workspace.
