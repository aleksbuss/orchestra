## Orchestra v0.1.3 - OAuth Native CLI Providers

Patch release focused on OAuth-native provider integration and reliability improvements for API transports.

### Highlights

- Added API-native OAuth transport for `codex-cli` and `gemini-cli` providers.
- Added provider auth endpoints for CLI OAuth connect/status checks.
- Updated Settings flow to `Provider -> Method -> Connect -> Model`.
- Added dynamic CLI model discovery with fallback presets.
- Fixed invalid URL failures for Anthropic and Google when base URL is missing/empty.
- Version bump to `0.1.3` across package metadata and `GET /api/health`.

### Upgrade Notes

- No migration step required.
- Existing API key providers continue to work as before.
- For CLI providers, run CLI login first (`codex login` / `gemini` OAuth login), then use OAuth mode in Orchestra.

### Links

- Full release snapshot: `docs/releases/0.1.3-oauth-native-cli-providers.md`
- Installation and update guide: `README.md`
