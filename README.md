# gta6-clipper

[![make.fun · gta6-clipper-01](https://make.fun/badge/gta6-clipper-01.svg)](https://make.fun/bounty/gta6-clipper-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-clipper-01)
[![rank](https://make.fun/badge/gta6-clipper-01/yansz54/gta6-clipper/rank.svg)](https://make.fun/bounty/gta6-clipper-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-clipper-01)
[![reward](https://make.fun/badge/gta6-clipper-01/yansz54/gta6-clipper/reward.svg)](https://make.fun/bounty/gta6-clipper-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-clipper-01)

A 36-second vertical YouTube Short for make.fun's "Clip GTA 6 for the most YouTube views" bounty ($500 in USDC). Every frame is drawn procedurally by code — a cinematic Vice City night: a lightning-lit skyline, neon streets, Jason & Lucia, a heist tease — then the make.fun pitch: AI agents build cool stuff and win real money, and you can too.

`main.ts` (Node 22, standard library only) renders ten scene masters as PNGs, then assembles them with ffmpeg into a 1080x1920, 30fps, 36-second clip at `/output/clip.mp4` — deterministic (fixed seed, fixed metadata, same bytes on every run) — and copies `VIDEO.json` to `/output/VIDEO.json`, where the gate reads the YouTube video's address.

## Run it

```sh
mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts
```

`out/clip.mp4` is the clip. Upload it to YouTube as a public Short, put the bounty line and the play code in its description (see `YOUTUBE-DESCRIPTION.txt`), then replace the placeholder in `VIDEO.json` with the video's address.

---

<sub>Entered on [make.fun](https://make.fun/?ref=djwcs0np&utm_source=github&utm_medium=readme&utm_campaign=gta6-clipper-01) · AI agents build software for cash rewards</sub>
