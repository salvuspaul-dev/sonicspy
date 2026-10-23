# Tonedrop Radio: data over AM/FM broadcast audio

Feasibility test, 2026-10-23. Simulation plus one over-the-air check on a real phone. Nothing was transmitted on any radio frequency.

## Answer

**Go for FM** with the profiles Tonedrop already ships. Fast decoded all 16 runs at every simulated FM level down to −5 dB; turbo lost 1 of 16 at 0 and −5 dB. A phone decoded simulated-FM audio played through a laptop speaker.

**Go for AM only with a narrow-band voice.** AM's audio stops near 4.5 kHz, and every current Tonedrop profile reaches 7 kHz, so all of them failed AM in every run. Two voices that do fit worked:

- A candidate profile kept between 600 and 3,412 Hz (`radio-am` below) passed 16/16 down to 0 dB.
- ggwave's fastest protocol, which today's app already decodes, passed 16/16 at 10 dB and above. It gives out 5 dB sooner than `radio-am`.

**No-go for stealth on any radio.** Its 17–18.5 kHz tones sit above FM's 15 kHz stereo-encoder filter and far above AM's band.

In a 5-minute slot, FM carries about 7.6 KB with turbo, roughly 95 short bulletins. AM carries 4.3 KB with `radio-am` (about 54 bulletins), or 7.6 KB with ggwave fastest where reception is good.

## What was tested

`tools/radio-channel.mjs` models the full path from station to phone:

- **FM.** Station processing: AGC, a 3-band compressor driven into a peak limiter and clipper. Then 75 µs pre-emphasis and the 15 kHz stereo-encoder filter. At the receiver, noise rising with frequency (FM's triangular noise), then de-emphasis.
- **AM.** The same processing without pre-emphasis, a 4.5 kHz transmitter filter (9 kHz channels), static (hiss plus lightning-style crackle) and a cheap receiver's rolloff above 3.5 kHz.
- **Room (baseline, no radio).** The acoustic stage alone.

Every channel ends in that same acoustic stage: a small radio speaker (180 Hz–12 kHz), a furnished room with the phone about half a metre away (RT60 250 ms, direct-to-reverberant +6 dB), background hum, and a phone microphone.

The sweep sent 16 different 79-byte bulletins per cell, for example "#3 Rain from 14:00, wind 23 km/h. Maize 383/90kg at Kasese. Clinic open Sat 9-1." A cell counts a run as a success only when the exact text comes back.

**What "SNR" means here.** For FM and AM it is the reception quality: signal against receiver noise across the whole audio band after the receiver. For the room channel it is signal against room hum. A tone modem puts all its power into one narrow tone at a time, so it decodes at wideband SNRs where speech or music would be unlistenable. Anyone tuned to a station on purpose has reception far better than 20 dB. The failure points found here are a wide margin, not an operating point. Every voice tested failed every run at −10 dB and below.

### What each band lets through

Measured with a two-tone signal and a 1 kHz reference, averaged over 6 seeds, with no noise:

| | 600 Hz | 3 kHz | 5 kHz | 7 kHz | 10 kHz | 15 kHz | 17.5 kHz |
|---|---:|---:|---:|---:|---:|---:|---:|
| room | +3 | +4 | — | +2 | 0 | −5 | −14 |
| FM | flat | flat | flat | flat | +5 | −12 | −48 |
| AM | flat | flat | −13 | −45 | −85 | — | — |

(dB relative to 1 kHz; "flat" is within ±2 dB.)

## Results

16 runs per cell. Each cell shows exact-text decodes out of 16. "B/s" is delivered bytes per second of air at the best SNR, with failures counted.

**FM**

| voice | 20 dB | 10 dB | 5 dB | 0 dB | −5 dB | airtime | B/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| tonedrop:robust | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 11.0 s | 7.2 |
| tonedrop:fast | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 3.8 s | 20.8 |
| tonedrop:turbo | 16/16 | 16/16 | 16/16 | 15/16 | 15/16 | 3.2 s | 25.2 |
| tonedrop:stealth | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 8.0 s | 0.0 |
| radio-am | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 5.5 s | 14.4 |
| radio-fm | 16/16 | 16/16 | 16/16 | 16/16 | 15/16 | 3.2 s | 25.2 |
| gg-normal | 14/16 | 15/16 | 15/16 | 7/16 | 3/16 | 8.0 s | 9.3 |
| gg-fast | 15/16 | 15/16 | 14/16 | 10/16 | 2/16 | 5.6 s | 13.3 |
| gg-fastest | 16/16 | 15/16 | 15/16 | 12/16 | 5/16 | 3.1 s | 25.4 |

**AM**

| voice | 20 dB | 10 dB | 5 dB | 0 dB | −5 dB | airtime | B/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| tonedrop:robust | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 11.0 s | 0.0 |
| tonedrop:fast | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 3.8 s | 0.0 |
| tonedrop:turbo | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 3.2 s | 0.0 |
| tonedrop:stealth | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 8.0 s | 0.0 |
| radio-am | 16/16 | 16/16 | 16/16 | 16/16 | 0/16 | 5.5 s | 14.4 |
| radio-fm | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 3.2 s | 0.0 |
| gg-normal | 15/16 | 15/16 | 15/16 | 8/16 | 0/16 | 8.0 s | 9.3 |
| gg-fast | 15/16 | 15/16 | 15/16 | 4/16 | 0/16 | 5.6 s | 13.3 |
| gg-fastest | 16/16 | 16/16 | 13/16 | 0/16 | 0/16 | 3.1 s | 25.4 |

**Room only, no radio (baseline)**

| voice | 20 dB | 10 dB | 5 dB | 0 dB | −5 dB | airtime | B/s |
|---|---:|---:|---:|---:|---:|---:|---:|
| tonedrop:robust | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 11.0 s | 7.2 |
| tonedrop:fast | 16/16 | 16/16 | 16/16 | 16/16 | 14/16 | 3.8 s | 20.8 |
| tonedrop:turbo | 16/16 | 16/16 | 16/16 | 16/16 | 11/16 | 3.2 s | 25.2 |
| tonedrop:stealth | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 8.0 s | 9.9 |
| radio-am | 16/16 | 16/16 | 16/16 | 15/16 | 0/16 | 5.5 s | 14.4 |
| radio-fm | 16/16 | 16/16 | 16/16 | 16/16 | 15/16 | 3.2 s | 25.2 |
| gg-normal | 15/16 | 15/16 | 15/16 | 15/16 | 5/16 | 8.0 s | 9.3 |
| gg-fast | 15/16 | 15/16 | 15/16 | 14/16 | 6/16 | 5.6 s | 13.3 |
| gg-fastest | 16/16 | 16/16 | 16/16 | 16/16 | 8/16 | 3.1 s | 25.4 |

Stealth passing the room baseline is a flattering result. The modelled speaker loses only 14 dB at 17.5 kHz, and many real radio speakers lose more.

Profiles under test:

- `tonedrop:*`: the four shipping profiles. Robust, fast and turbo span 1,200–7,012 Hz; stealth spans 17,250–18,562 Hz.
- `radio-am`: a candidate. 8-ary FSK, two rotating tone sets (16 tones, 600–3,412 Hz), Reed-Solomon at 50 %, sent once.
- `radio-fm`: a candidate. 32-ary FSK, two sets (64 tones, 600–12,412 Hz), Reed-Solomon at 25 %.
- `gg-*`: ggwave's audible protocols, which gibberlink uses.

ggwave refuses to encode some exact messages, because it would garble them (a known ggwave bug, which `web/src/ggwave.js` catches before sending). One of the 16 bulletins was refused on gg-normal and gg-fast with every padding tried. The tables count it as lost, which is why those rows top out at 15/16. gg-fastest refused none. ggwave also caps a message at 140 bytes, so longer content has to be split.

A low-SNR sweep (6 runs per cell, fast, turbo, radio-am, radio-fm, gg-fast and gg-fastest, FM and AM) found 0 decodes at −10, −15 and −20 dB for every voice on both channels.

### Over the air on a real phone

Simulated-radio WAVs were played from the laptop's speakers (ffplay). A RedMagic phone (NX809J) running the installed Tonedrop build (version 1.0, still labelled SonicSpy) listened in its Translate tab:

| Played | Channel | Phone heard |
|---|---|---|
| Tonedrop fast: "FM bulletin: rain from 14:00, maize 3200/90kg" | FM, 20 dB | the exact text |
| ggwave fast: "AM bulletin: clinic open Sat 9-1" | AM, 20 dB | the exact text |
| Tonedrop fast: "FM low signal: road to market closed" | FM, 5 dB | the exact text |
| Tonedrop fast, same bulletin | AM, 20 dB | nothing, as the sweep predicts |

This proves the simulated broadcast audio survives a real speaker, a real room and a real phone microphone. It does not prove anything about a real station's processing, which is the largest remaining unknown.

## What a 5-minute slot carries

Bytes per second of air, times 300 s, for back-to-back 79-byte bulletins at the 100 % success rates measured above:

| Band | Voice | B/s | Per 5 min | Bulletins |
|---|---|---:|---:|---:|
| FM | tonedrop:turbo | 25.2 | 7.6 KB | ~95 |
| FM | tonedrop:fast | 20.8 | 6.2 KB | ~79 |
| FM | tonedrop:robust | 7.2 | 2.2 KB | ~27 |
| AM | radio-am | 14.4 | 4.3 KB | ~54 |
| AM | gg-fastest, at 10 dB or better | 25.4 | 7.6 KB | ~96 |

A broadcast has listeners who tune in late. Tonedrop's broadcast loop lets them collect the frames they missed on the next pass, so airing the slot's content twice halves these figures and reaches nearly everyone.

## Modem settings radio needs

1. **AM:** keep every tone between about 600 and 3,400 Hz. The `radio-am` candidate does this at 14.4 B/s and has the most margin. To ship it, add it to `PROFILES` in `web/src/modem.js`. The app only decodes its built-in profiles, which is why the over-the-air AM check used ggwave. Until then, ggwave fastest works with today's app, but only where reception is good.
2. **FM:** use fast or turbo unchanged. The wider `radio-fm` candidate is no faster than turbo, and it was only marginally sturdier (room at −5 dB: 15/16 against turbo's 11/16), which isn't enough to justify another profile.
3. **Never stealth** on radio.
4. **Loop the slot.** Use broadcast-loop mode so a late listener finishes the message on the next pass.
5. **No level or processing workarounds were needed.** AGC, multiband compression, the limiter and pre-emphasis did not break any profile whose tones fit the band.

## Limits of this test

- **Station processing is modelled, not measured.** Real stations tune their processors differently, and some clip much harder than this model. A real chain is the first thing to test.
- **Not modelled:** FM multipath, AM fading and skywave, co-channel and adjacent-channel interference, stereo/mono switching, and the variety of real receivers.
- **One acoustic setting:** the phone half a metre from the speaker. Across a large room, the reverberant sound grows relative to the direct sound.
- **The over-the-air check** used one phone and the laptop's speaker. It was not a radio.
- **The Wave OFDM modem is pending.** It lives on `feat/tonedrop-wave`, which is not merged to `main`, so it is not in this sweep. Once it lands, add it to `VOICES` in `tools/radio-channel.mjs` and rerun.

## Next step

Put real station processing in the loop without transmitting anything. A community station's engineer can feed a test file through their processor into an off-air monitor or a dummy load and record the output. That recording can then be run through `translate`.

## Reproduce

```bash
node tools/radio-channel.mjs sweep --runs 16 --json results.json --wav-dir samples
node tools/radio-channel.mjs simulate --in message.wav --out message_am.wav --channel am --snr 10
node --test tests/radio.test.mjs
```
