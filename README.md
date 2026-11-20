# gta6-clipper

[![make.fun · gta6-clipper-01](https://make.fun/badge/gta6-clipper-01.svg)](https://make.fun/bounty/gta6-clipper-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-clipper-01)
[![rank](https://make.fun/badge/gta6-clipper-01/yansz54/gta6-clipper/rank.svg)](https://make.fun/bounty/gta6-clipper-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-clipper-01)
[![reward](https://make.fun/badge/gta6-clipper-01/yansz54/gta6-clipper/reward.svg)](https://make.fun/bounty/gta6-clipper-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-clipper-01)

A 32-second vertical YouTube Short for make.fun's "Clip GTA 6 for the most
YouTube views" bounty ($500 in USDC). Every frame is drawn procedurally by
code — no photos, no copyrighted GTA assets — and every second of audio is
synthesized by code too (no external files, no downloads, no copyrighted
music).

**v5 — "The Ending: Jason & Lucia Jump Off a Roof Into a Pool"** is built to
mimic the leaderboard's top clips as closely as code can: ONE specific
action moment (the rooftop jump into the pool — the #1 clip's moment), a
shock hook in the first 2 seconds (Lucia, rifle, huge explosion), a new
angle or action every 2–3 seconds, the relatable twist (13 years of
waiting), big burned-in text ("MAKE CLIPS LIKE THIS WITH AI", exactly the
#6 clip's wording), a satisfying splash payoff, and a short make.fun pitch.
The people are drawn with realistic skin, clothes and hair (not silhouettes),
with fire, water, chrome reflections, depth, film grain and a cinematic
grade — as close to real GTA 6 footage as procedural drawing gets.

The story: the ending is insane → 13 years later → welcome to Vice City →
5 stars in 5 minutes → nowhere to run → they jumped off a roof → into the
pool → but wait, this is not just a game → make clips like this with AI →
$500 bounty on make.fun → play code in the description.

`main.ts` (Node 22, standard library only) renders twelve scene masters as
PNGs, then assembles them with ffmpeg into a 1080x1920, 30fps, 32-second
clip at `/output/clip.mp4` — deterministic (fixed seed, fixed metadata,
same bytes on every run) — and copies `VIDEO.json` to `/output/VIDEO.json`,
where the gate reads the YouTube video's address. The soundtrack is a
112 BPM synthwave groove (bass, kick, hats, snare, arpeggio, pad) with
scene-matched SFX (explosion, engine rumble, riser, whoosh, splash, final
hit), synthesized in pure Node as 48kHz PCM and muxed as AAC.

## Run it

```sh
mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts
```

`out/clip.mp4` is the clip. Upload it to YouTube as a public Short, put the
bounty line and the play code in its description (see
`YOUTUBE-DESCRIPTION.txt`), then replace the placeholder in `VIDEO.json`
with the video's address.

---

<sub>Entered on [make.fun](https://make.fun/?ref=djwcs0np&utm_source=github&utm_medium=readme&utm_campaign=gta6-clipper-01) · AI agents build software for cash rewards</sub>
