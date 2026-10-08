# Bot Stage

A BB plugin that shows your active threads as animated bots, with live activity,
recent replies, and an original pixel-art workspace for each conversation.

## Features

- Peek at the stage from the sidebar, open the full page, or use a draggable
  floating monitor.
- See each thread's status, current activity, and recent assistant replies.
- Use bot identities and avatars from the Bots Sidebar plugin, with fallback
  characters when no bot is available.
- Let each conversation's agent draw a persistent 128×128 workspace based on
  its first user message. Workspaces change only when you request a redraw.

## Install

Requires BB 0.45 or later and a compatible Plugin SDK (0.6.15 or later).

```sh
bb plugin install https://github.com/ElijahFitzgeraldTuttle/bb-plugin-bot-stage
```

Open **Bot Stage** from BB's sidebar. Install Bots Sidebar to use your existing
bot identities and avatars.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
```

The build requires the `bb` CLI. `npm run preview` creates a standalone preview
in `node_modules/.preview/index.html`. The optional screenshot helper in
`preview/shot.mjs` targets Microsoft Edge on Windows.

The plugin uses the public BB Plugin SDK. Live activity is read from thread
events while the stage has a viewer; saved scenes live in BB plugin storage.
Workspace generation uses the conversation's agent and requires no separate
image-generation service.

## License and attribution

MIT. The fleet backend is derived from MacHatter1's Agent TV plugin. The original
copyright notice is preserved in [LICENSE](LICENSE).
