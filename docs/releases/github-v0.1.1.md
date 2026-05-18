## Orchestra v0.1.1 - Unified Context

Generalized release that consolidates the full platform surface into one project-centric workflow: chat + tools, memory + knowledge, skills + MCP, cron automation, and external messaging integrations.

### Highlights

- Added raw MCP config save endpoint: `PUT /api/projects/[id]/mcp`.
- Added direct `servers.json` editing with save/reset in `Dashboard -> MCP`.
- Added same MCP editing controls in project details context panel.
- Added editable project instructions with save/reset in project details.
- Added MCP content validation/normalization before writing `.meta/mcp/servers.json`.
- Version bump to `0.1.1` across package metadata and health response.

### Platform Coverage

- Dashboard modules: `chat`, `projects`, `memory`, `skills`, `mcp`, `cron`, `settings`, `api`, `messengers`.
- API modules: auth, chat, projects, skills, MCP, memory, knowledge, cron, external API, Telegram integration, files, models, settings, health, realtime events.
- Bundled skills catalog: `38` skills available for per-project install.

### Upgrade Notes

- Existing MCP configs continue to work (Cursor `mcpServers` and legacy `servers` are both supported).
- `GET /api/health` now reports version `0.1.1`.
- No migration step required for existing `data/` projects.

### Links

- Full release snapshot: `docs/releases/0.1.1-unified-context.md`
- Installation and update guide: `README.md`
