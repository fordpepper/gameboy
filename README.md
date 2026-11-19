# Game Boy (web)

A Game Boy (DMG) emulator that runs in the browser, built for tablets: big touch controls, 60 fps locked to the display refresh, sound, battery saves.

- `gb.js` – emulator core (CPU, PPU, timers, APU, MBC1/2/3/5). No DOM; runs under Node too (`node test.js rom.gb`).
- `index.html`, `app.js` – UI, touch/keyboard/gamepad input, audio, ROM library (IndexedDB).
- `sw.js`, `manifest.webmanifest` – offline support / "Add to Home Screen" (HTTPS only).
- `serve.sh` – serve it on your LAN instead.

Bring your own ROMs (load them from the in-app menu; they are stored only in your browser). ROMs are git-ignored.

## Multiplayer

Menu → Multiplayer: host/join over a direct WebRTC connection by swapping a code (no server). Modes: Race (see your friend's game in a corner window), Co-op split controls, Co-op shared controls. Both players need the same ROM. The emulator is deterministic, so only inputs are exchanged; checksums detect desyncs.
