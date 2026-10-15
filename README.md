# SFX Forge

**Live editor:** https://sfxforge.vercel.app

A visual game-audio synth for sound effects and short music tracks, plus an MCP server so AI agents can design them too.

Every sound is a small JSON score in the `sfx-forge/1` format: rows are layers, columns are 16th-note steps, and every hit is drawn as a glyph tile. The editor and the MCP server run the same zero-dependency engine (`src/engine.js`), so a sound renders sample-for-sample identically in the browser, in Node, and in your game's asset pipeline.

Inspired by [SQNCR](https://seq.halfof8.com) by halfof8, where the picture and the music are the same data.

## What's in here

| Path | What it is |
|---|---|
| `src/engine.js` | The synth: renderer, 22 SFX generators, randomizer, music composer, macros, WAV encoder. UMD, runs in Node, browsers and Web Workers. |
| `src/server.js` | MCP server over stdio. 15 tools. No dependencies. |
| `src/png.js` | Preview images (score strip + waveform) so an agent can see what it made. |
| `editor/editor.src.html` | The visual editor. `npm run build` inlines the engine into `dist/sfx-forge.html`. |
| `dist/index.html` | Built editor, a single file (also copied to `dist/sfx-forge.html`). Open it in a browser or host it on GitHub Pages. |
| `examples/` | A starter kit for a fighting game: 12 SFX and 3 music tracks. |
| `test/smoke.js` | Spawns the server and exercises every tool. |

## Editor

Use it at https://sfxforge.vercel.app, or open `dist/index.html` in any browser.

- **SFX generators:** coin, pickup, jump, laser, shoot, explosion, hit, punch, kick, block, hurt, whoosh, dash, powerup, blip, select, confirm, cancel, magic, KO, victory, game over.
- **RANDOM (乱):** builds a sound from scratch out of 1 to 4 random layers. WILDNESS goes from tidy blips to layered chaos.
- **MUSIC:** writes a full 10 to 60 second track in nine styles: chiptune 電, fight 闘, city pop 街, synthwave 夜, lo-fi 雨, house 舞, drum & bass 速, trap 影, boss battle 王. Each track has drums, bass, chords, a lead melody and often arps, hat rolls or percussion. The song structure varies: intro, A, B, break and outro, with possible cold opens, half-time sections, key changes and different endings.
- **乱 RANDOM SONG:** picks a style for you. With WILDNESS above about 40% it can mash two styles together (for example *trap × city pop*), and it adds more drum variation, generated chord progressions, key changes and extra percussion.
- **REMIX:** keep a track but roll **new drums**, **new bass**, **new chords** or a **new melody** (keys `1` to `4`), or move the key and tempo up and down. New chords also move the bass and melody to fit the new harmony, keeping their rhythm.
- **Editing:** click the score to place hits, double-click to remove them. Every layer has pitch sweep, FM, ADSR, filter sweep, vibrato, drive, bit-crush and repeats. There are seven one-knob macros (pitch, length, punch, grit, space, distance, retro), plus mutate and a history strip of every roll.
- **Export:** WAV and JSON.
- **Keys:** `Space` play, `R` random sound, `Shift R` random song, `1` to `4` remix a part, `G` new seed, `M` mutate, `[` `]` step through history.
- **Deep links:** `#chiptune`, `#lofi-123` (style and seed), `#punch-7` (category and seed).

When the page runs as a Claude artifact it also gets a shared library that agents can write to, and an *Ask Claude* box that turns a description into a sound. Standalone, those two features switch off and everything else works.

## MCP server

Needs Node 18 or newer and nothing else.

```bash
npm test   # smoke test
```

Add it to your MCP client (Claude Desktop, Claude Code, or any MCP host):

```json
{
  "mcpServers": {
    "sfx": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/sfx-forge/src/server.js"],
      "env": { "SFX_DIR": "/ABSOLUTE/PATH/your-game/assets/sfx" }
    }
  }
}
```

Claude Code: `claude mcp add --transport stdio --scope project --env SFX_DIR=$PWD/assets/sfx sfx -- node /ABSOLUTE/PATH/sfx-forge/src/server.js`

Your own agent on the Claude API (for example a Python orchestrator): the API's built-in MCP connector only reaches public HTTPS servers, so run sfx-mcp from your code instead. `examples/agents/claude_api_bridge.py` does this in about 60 lines. It starts the server over stdio, offers its tools to Claude, passes results and preview images back, and takes an optional tool allowlist (`SFX_TOOLS`).

```bash
pip install anthropic mcp
SFX_DIR=./assets/sfx python examples/agents/claude_api_bridge.py "Make a heavy punch and a 30 second boss track, then export a pack"
```

| Tool | What it does |
|---|---|
| `list_categories` | Generators, music styles, macros, waves and the format reference |
| `list_sounds` | Sounds saved in `SFX_DIR` |
| `generate_sound` | Category (or `random` with `wildness`) + seed → saved sound, WAV, stats, preview image |
| `generate_music` | Style (or `random`), seconds, wildness, BPM, seed → arranged track |
| `remix_music` | Reroll `drums`, `bass`, `chords` or `lead` of a track, or transpose and change BPM |
| `variations` | N candidates of a category, or N mutations of a sound |
| `get_sound` / `set_sound` | Full JSON out and in (round-trips with the editor) |
| `edit_sound` | Deep-merge patches into the master, any layer, or add and remove layers |
| `mutate_sound` | Random nudge, sfxr style (keeps songs in tune) |
| `apply_macro` | `pitch`, `length`, `punch`, `grit`, `space`, `distance`, `retro` |
| `render_sound` | WAV, mono or stereo, at 22.05, 44.1 or 48 kHz |
| `play_sound` | Plays through local speakers (afplay, PowerShell or aplay) |
| `export_pack` | A folder of WAVs plus `manifest.json` for your game engine |
| `delete_sound` | Removes the JSON and the WAV |

Example prompts:

- "Make 4 punch variations, keep the snappiest, then a heavy version with `length 1.4` and `pitch -3`."
- "Write a 40-second fight track at 165 BPM and export it with the SFX pack, mono 22 kHz."
- "Make 3 random songs at wildness 0.7, keep the best one, then give it new drums until the groove is heavier."
- "Roll 6 random sounds at wildness 0.3 and keep the two that sound most like a coin pickup."

## Format `sfx-forge/1`

```jsonc
{
  "id": "smash-heavy-punch", "name": "heavy punch", "category": "punch", "seed": 21,
  "length": 0.43, "steps": 16, "swing": 0,           // step time = length / steps
  "master": { "gain": 0.9, "reverb": 0.1, "room": 0.3, "delay": 0, "delayTime": 0.12, "feedback": 0.3, "normalize": true },
  "layers": [{
    "name": "body", "wave": "sine",                   // sine|square|saw|triangle|noise|pulse|fm|metal
    "freq": 180, "freqEnd": 50, "slide": 0.1, "curve": 1,
    "jump": null, "vib": { "rate": 0, "depth": 0 }, "fm": { "ratio": 2, "index": 2 },
    "amp": { "a": 0.0005, "h": 0.01, "d": 0.15, "s": 0, "r": 0.04 },
    "filter": { "type": "lp", "cutoff": 6000, "cutoffEnd": 900, "q": 0.8 },
    "crush": { "bits": 16, "rate": 1 }, "drive": 0.5, "gain": 0.9, "pan": 0,
    "repeat": { "count": 0, "interval": 0.06, "decay": 0.6, "pitch": 0 },
    "hits": [{ "t": 1, "note": 0, "vel": 1, "len": 0.12 }]   // t = step, note = semitones
  }]
}
```

Music tracks add `style`, `styleLabel`, `bpm`, `key`, `bars`, `sections` and `compose` (the seeds that let a track be remixed). Limits are 64 seconds, 1024 steps and 16 layers. Noise layers use `freq` as grain rate, so low values sound crunchy.

Rendering from your own code:

```js
const SFX = require('./src/engine');
const sound = SFX.gen('music', 42, { style: 'chiptune', seconds: 32 });
const wav = SFX.encodeWav(SFX.render(sound));   // Uint8Array, 16-bit stereo 44.1 kHz
```

## How it works

Each hit becomes a voice rendered sample by sample: oscillator or noise, exponential pitch sweep, a TPT state-variable filter with cutoff sweep, ADSR, drive, bit-crush. Voices are mixed with equal-power panning, then go through a ping-pong delay and a small Freeverb-style reverb. The mix is soft-clipped, normalized to -1 dB, and trimmed of trailing silence. Everything is seeded (mulberry32), so the same JSON always gives the same samples.

The music composer works in two layers of randomness. The song seed picks the style, tempo, key, scale and structure. Then each part has its own seed: drums (kit, kick pattern and its per-bar mutations, fills, hats, extra percussion), bass (sound, pattern, approach notes), chords (progression, voicing, comping rhythm, sound) and lead (sound, two 2-bar motifs snapped to chord tones on strong beats, an answer phrase, arp shape). That is what lets REMIX swap one part and keep the rest. WILDNESS raises the odds of everything unusual.
