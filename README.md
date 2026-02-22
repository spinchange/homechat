# HomeChat

A local-network chat app for your household. No cloud, no accounts, no subscriptions — just open a browser on any device connected to your home Wi-Fi.

## Features

- **Rooms** — shared channels for any topic; drag to reorder
- **Private rooms** — invite-only rooms hidden from other members
- **Direct messages** — private one-on-one conversations with anyone, online or offline
- **Image sharing** — send photos from your library or directly from your camera
- **Link previews** — automatic preview cards for URLs
- **Offline messaging** — messages are stored; users see everything they missed when they reconnect
- **Browser notifications** — get notified of DMs when the tab is in the background
- **Installable PWA** — add to home screen on iPhone or Android for a native app feel

## Requirements

- [Node.js](https://nodejs.org) 18 or later
- All devices on the same Wi-Fi network

## Setup

```bash
git clone https://github.com/spinchange/homechat
cd homechat
npm install
node server.js
```

The console will print two URLs:

```
HomeChat running!
  Local:   http://localhost:3000
  Network: http://192.168.x.x:3000  ← open this on any other device
```

## Windows — server management

A PowerShell script handles the full lifecycle:

```powershell
.\Manage-HomeChat.ps1 start       # Start the server
.\Manage-HomeChat.ps1 stop        # Stop the server
.\Manage-HomeChat.ps1 restart     # Restart
.\Manage-HomeChat.ps1 status      # Show PID, URLs, uptime, and auto-start state
.\Manage-HomeChat.ps1 logs        # Tail the last 60 lines of server output
.\Manage-HomeChat.ps1 install     # Register auto-start at login (Windows Task Scheduler)
.\Manage-HomeChat.ps1 uninstall   # Remove auto-start
```

## Installing on phones (PWA)

**iPhone — Safari:** Open the network URL → tap Share → Add to Home Screen

**Android — Chrome:** Open the network URL → tap the menu → Add to Home Screen (or Install App)

Once installed it opens full-screen with no browser chrome, like a native app.

## Rooms

Default rooms: `general`, `finances`, `travel`, `kids`, `appointments`, `events`

- Any connected user can **create** a new room
- Rooms can be **reordered** by dragging the handle in the sidebar
- **Private rooms** are only visible to the members selected at creation time
- Only the room's creator can **delete** it; default rooms are permanent

## Data

All messages are stored locally in `messages.ndjson`. Uploaded images live in `public/uploads/`. Neither is tracked in git — your data stays on your machine.

To back up your history, copy those two paths somewhere safe.

## Limitations

- **No authentication** — the app is designed for a trusted home network. Name uniqueness is enforced while connected, but there is no password protection.
- **No HTTPS** — the server runs over plain HTTP on the local network. Camera capture and image sharing work fine; browser push notifications when the app is fully closed require HTTPS and are not supported.
- **Images are not cleaned up** — uploaded photos accumulate in `public/uploads/` indefinitely.
