# Changelog

## [Unreleased]

## [1.2.0] — 2026-02-22

### Added
- **Claude memory** — persistent context file (`claude-context.txt`) injected into Claude's system prompt on every request
- `!remember <fact>` — save a fact to Claude's memory from any room
- `!memory` — list all saved memories with numbers
- `!forget <number>` — remove a specific memory by number
- Memory commands respond as Claude (green bubble) and work in any room
- `claude-context.txt` is gitignored; one fact per line; editable directly or via chat commands

## [1.1.0] — 2026-02-22

### Added
- **Claude AI bot** — powered by Claude Haiku (`claude-haiku-4-5-20251001`) via Anthropic API
- `!claude <question>` — ask Claude anything from any room
- `#claude` room — every message auto-triggers Claude; full conversation context maintained
- Animated thinking indicator (pulsing green dots) while API call is in flight
- Claude messages styled in green, distinct from HomeBot's purple
- Recent room history passed as context for more relevant responses
- Graceful fallback with friendly error message if `CLAUDE_API_KEY` is not set
- `.env` / `.env.example` for API key configuration
- `!help` updated to include Claude commands

### Dependencies
- Added `@anthropic-ai/sdk`
- Added `dotenv`

## [1.0.1] — 2026-02-20 (approx)

### Added
- **HomeBot** — built-in command bot responding to `!ping`, `!uptime`, `!who`, `!storage`, `!network`, `!version`, `!help`
- HomeBot filtered from the People list; purple monospace bubble styling

## [1.0.0] — Initial release

### Added
- Room-based chat over local Wi-Fi — no cloud, no accounts
- Direct messages (DMs) with unread badges and browser notifications
- Private rooms (invite-only, hidden from non-members)
- Image upload and paste from clipboard; camera capture on mobile
- Link preview cards (Open Graph metadata)
- Offline messaging — messages persist; history loads on reconnect
- Drag-to-reorder rooms in the sidebar
- Message deletion (own messages only)
- Installable PWA — add to home screen on iOS and Android
- Windows server management script (`Manage-HomeChat.ps1`) with Task Scheduler auto-start
- Flat-file persistence (`messages.ndjson`, `rooms.json`)
