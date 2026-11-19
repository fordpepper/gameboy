# Game Boy (web)

A Game Boy (DMG) emulator that runs in the browser, built for tablets: big touch controls, 60 fps locked to the display refresh, sound, battery saves.

- `gb.js` – emulator core (CPU, PPU, timers, APU, MBC1/2/3/5). No DOM; runs under Node too (`node test.js rom.gb`).
- `index.html`, `app.js` – UI, touch/keyboard/gamepad input, audio, ROM library (IndexedDB).
- `sw.js`, `manifest.webmanifest` – offline support / "Add to Home Screen" (HTTPS only).
- `serve.sh` – serve it on your LAN instead.

Bring your own ROMs (load them from the in-app menu; they are stored only in your browser). ROMs are git-ignored.

## Multiplayer

Menu → Multiplayer. One host, up to 7 friends, joined with a 6-character code (relayed through ntfy.sh; manual long codes also work). Everyone connects directly to the host over WebRTC.

- **Race** (Super Mario Land): everyone plays their own game; the others appear as numbered ghost Marios in your world. Only Mario's position/pose is shared (a few hundred bytes per second), nothing is simulated for other players, and pausing can't desync anything.
- **Co-op**: everyone controls one Mario in lockstep. Split controls hand each player a share of the buttons (up to one button each at 8 players); shared lets everyone press everything. A paused player pauses the game for everybody.
- Priority: *Low data* batches inputs (default); *Low delay* sends every frame.

Everyone needs the same ROM file in the app.
