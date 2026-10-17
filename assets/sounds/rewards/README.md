# Reward dialogue

Original synthetic soldier dialogue generated with Qwen3-TTS, Ryan speaker,
English, instructed to shout a short aggressive, triumphant squad callout.
Model: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice (Apache-2.0).
Revision: `0c0e3051f131929182e2c023b9537f8b1c68adfe`.
Runtime: https://github.com/QwenLM/Qwen3-TTS (Apache-2.0).
The first two Ryan takes used the official public demo; the other five used
local CPU inference with the same speaker and direction. No real person
was cloned. Clips are trimmed, peak-normalized and encoded as mono MP3.
Build script: `scripts/build-reward-voices.py`.

- Money in the bag!
- Got him! And my money!
- In the bag!
- Ha! Just got paid!
- Yee-haw! Got it!
- Bagged it!
- Sweet money!

Played only for a server-confirmed local kill through the master audio mix.
No overlapping dialogue, immediate repeat, or playback while muted/dead.
The model is not downloaded by players; the game serves these MP3 clips.
