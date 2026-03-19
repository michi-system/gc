# GC Greenfield

This folder is the reset point for the next version.

## Rules

- Build from scratch inside `greenfield/`.
- Do not import application code from the legacy root app.
- Use the old app only as reference material.
- The only legacy area intentionally carried over is Google OAuth / Gmail / Calendar behavior, re-implemented in a smaller form here.

## Phase 1 Scope

- Google OAuth for Gmail and Google Calendar
- Show connection status
- List readable calendars
- Render Google Calendar events with FullCalendar
- Keep local state in `greenfield/.local/`

## Out of Scope for Now

- SwiftUI
- Task generation
- Student matching
- Gmail parsing
- Form autofill orchestration
- SQLite migration from the legacy app

## Commands

```bash
cd greenfield
npm run dev
```

App URL:

```text
http://127.0.0.1:3141
```

## Google OAuth Notes

- Put your desktop OAuth client JSON at `greenfield/config/google-oauth-client.json`, or set it in the UI.
- Redirect URI for desktop client JSON is:

```text
http://127.0.0.1:3141/auth/google/callback
```

## Why This Exists

The root repository currently mixes:

- legacy web UI
- Tauri packaging
- SwiftUI native UI
- task generation and sync logic

That makes iteration expensive. `greenfield/` is the clean boundary for rebuilding the product with a much smaller surface area.

## External UI Choice

- Calendar UI uses FullCalendar `6.1.20` from CDN.
- This version is intentionally the stable `6.x` line rather than the current `v7 beta`.
