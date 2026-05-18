Use this tool when the user asks to **install** or **import** a skill from a GitHub URL.

When a URL is present, prefer this tool over `create_skill`.

Rules:
1. Pass the URL exactly as provided by the user.
2. If the user asks for a custom installed name, set `skill_name`.
3. This tool installs recursively from the linked GitHub path and keeps internal file/folder structure.
4. After success, report installed skill name, target path, and source URL/ref.
5. If it fails, surface the exact error and do not fallback to `create_skill` unless user explicitly asks to generate a new skill manually.
