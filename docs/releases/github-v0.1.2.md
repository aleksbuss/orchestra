## Orchestra v0.1.2 - Dark Theme and Python Recovery

Patch release focused on UX polish and Python runtime resilience: dark mode controls, safer dependency recovery, and cleaner project file tree output.

### Highlights

- Added `Dashboard -> Settings -> Appearance -> Dark mode` toggle.
- Applied saved dark mode directly in root layout for consistent initial render.
- Improved Python package recovery with project-local virtualenv fallback when system pip is blocked.
- Python execution now prefers `.venv`/`venv` interpreter and environment when present.
- Hidden `.venv` and `venv` from project file tree output.
- Version bump to `0.1.2` across package metadata and `GET /api/health`.

### Upgrade Notes

- No migration step required.
- Existing projects keep working without changes.
- Projects with local virtualenvs now get automatic interpreter preference for Python execution.

### Links

- Full release snapshot: `docs/releases/0.1.2-dark-theme-python-recovery.md`
- Installation and update guide: `README.md`
