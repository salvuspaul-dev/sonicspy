# Tonedrop

Send text, files and raw bytes between phones, laptops and AI agents **over audible sound** — no network, no pairing, no accounts. A speaker plays a stream of tones; anything with a microphone that is within earshot decodes it.

It is useful when there is no usable link: no Wi-Fi, no cellular, no Bluetooth permission, air-gapped machines, or a room full of devices that all need the same payload at once. One transmitter can hand data to many receivers simultaneously, because sound is a broadcast medium — there is no connection to establish, and no limit on how many listeners there are.

**Tonedrop Link** is its protocol for AI agents talking to each other over sound. It opens in [gibberlink](https://github.com/PennyroyalTea/gibberlink)'s language, so any gibberlink agent understands it, then two Tonedrop peers upgrade on the spot to Tonedrop's own modes: messages of any length, files, stealth under music, and error correction with a CRC so a message arrives exactly or not at all.

## What it does

- **Tonedrop Link** — agents (or people) open a link; it starts in gibberlink-compatible ggwave, recognises another Tonedrop peer in the first exchange and moves to the fastest mode both speak, or to stealth if either side prefers it. A plain gibberlink agent is answered in gibberlink.
- **Universal translator** — one microphone, every machine language at once: Tonedrop in all four modes, ggwave and gibberlink (with sender ids), DTMF, Morse and tap code, written down as one transcript. Type text and say it in any of them.
- **ggwave and gibberlink compatible** — the official ggwave build is vendored unmodified, so Tonedrop sends and receives every ggwave protocol, audible and ultrasound.
- **Text, files and hex** — send a sentence, a document, an image or arbitrary bytes.
- **Broadcast, not unicast** — a laptop plays a loop of frames; every phone in the room that is listening collects the same payload. Devices can join halfway through and still reconstruct the whole thing.
- **Music carrier** — a record player that hides the data inside the song it plays, so a normal playlist doubles as a data channel. Music and broadcast pause independently.
- **Built for real rooms** — a room keeps ringing with every tone long after it stops. Rotating tone sets, echo-cancelling detection and Reed-Solomon error correction keep transfers working through that echo, not only in a quiet lab.
- **Real-time receive** — a live spectrum display shows signal strength and which tones are arriving, with per-transfer progress.
- **Loops long messages** — a long message is repeated so late arrivals still get every chunk, and the receiver reassembles them in any order.
- **Stealth mode** — play any song and hide messages inside it at 17–18.6 kHz, above what most adults hear and above almost everything in recorded music. Listeners hear only the song; a phone running Tonedrop reads the message.
- **Morse, tap code and DTMF** — type text to see and hear its code, paste a code to read it, or let the microphone decode one live: a tone, a radio, a whistle, or knuckles knocking on a table. Morse auto-tunes to the pitch and learns the sender's speed; the tap decoder follows the knocker's tempo.
- **A CLI for agents** — AI agents and scripts talk to each other by writing and reading WAV files, so no human or microphone is needed for a machine-to-machine hop. The same CLI speaks Morse, tap code, DTMF and ggwave, and `translate --json` turns any recording into one event per line.

## Honest status

Verified on real hardware — a RedMagic phone (Android 16) running the APK, laptop speakers half a metre away, an ordinary noisy room:

- **Laptop speaker → phone mic:** Tonedrop `robust`, `fast` and `turbo` messages arrive exactly through the Listen tab. Through the Translate tab, a mixed broadcast comes out as four exact lines: a gibberlink message with its sender id, a Tonedrop `turbo` message, DTMF `*123#` and Morse `SOS`. Of seven such broadcasts, one lost its `turbo` message: `turbo` is the close-range mode and sends each frame once, where `robust` sends it twice.
- **Tonedrop Link on the phone:** a Tonedrop peer's hello over the air linked the two on `turbo`; a 183-character message and a JSON file then arrived whole, the file with a Download button. A fresh link answered a plain gibberlink agent in gibberlink.
- **Phone speaker → its own mic:** all ten voices tested arrived exactly — Tonedrop `fast`, `turbo`, `robust` and `stealth` (17–18.6 kHz), ggwave audible fast and fastest, ggwave ultrasound, DTMF and Morse.
- That hardware testing found four real defects, each now fixed with a regression test: a fixed squelch level that discarded every real frame (the phone heard −46 dBFS, the gate sat at −34); DTMF rejecting keys whose two tones arrived 9–18 dB apart; Morse keying on room noise after the decoder started on silence; and a second transmission layering over one still on air.

Verified by automated tests and by rendering in a real browser:

- 265 tests pass, covering the modem, Reed-Solomon codec, signalling codes, protocol, file container, ggwave interop, the translator and Tonedrop Link end to end (clean loopback on all four profiles, 10, 4 and 2 dB SNR, signals that start anywhere relative to the receiver's search grid, interference from music, late join mid-broadcast, byte-for-byte binary integrity, corrupted frames rejected by CRC, out-of-order and duplicate chunks, and a 48 kHz transmitter received by a 44.1 kHz receiver).
- A reverberant-room suite models what actually breaks acoustic links: a room that keeps ringing with each tone for hundreds of milliseconds. The first version of this modem decoded **no frames at all** at half a metre to a metre in a furnished room. Two defects were behind it — a symbol-timing lock that settled up to half a symbol early, and a detector that mistook the previous tone's echo for the current one — and both are fixed, each with a regression test that fails on the old code.
- An adversarial suite assumes the sender is hostile, because anyone in earshot can transmit. It covers messages past the 16-bit chunk limit, frames numbering themselves outside their declared total, headers fuzzed with random fields, conflicting chunk totals across a reused message id, unbounded message-id churn, truncated file containers, corrupt and endlessly expanding gzip, and payload integrity across every byte value. Seven defects it found are fixed; each is recorded at the top of `tests/adversarial.test.mjs`.
- A separate suite models the impairments that only exist between two physical devices, none of which appear in an idealised channel: independent sample clocks (drift up to ±1000 ppm, both directions, on every profile), transducer frequency response (500 Hz high-pass and 7.5 kHz low-pass), an overdriven amplifier clipping to a quarter of full scale, DC offset plus 50 Hz mains hum, a room reflection arriving 18 ms late, and a capture callback delivering audio in awkward chunk sizes (single samples, primes, random 1–8192, 64 K blocks).
- Real-browser suites drive the actual UI in Brave/Chromium: encoding, decoding, the in-page self-test on all four profiles, every panel at desktop and phone width, the Codes tab, and the Translate tab decoding a four-protocol recording in the page itself.
- A 400-run stress test of the Link handshake with random sender ids and random alignment: 0 failures (6 needed one retry).
- The Android APK builds, is correctly signed, declares the microphone permissions, and contains the full application.

**Not yet verified:** two phones linking to each other. With one phone available, the phone's receive path was tested from laptop speakers and its transmit path by hearing itself, but a second device has not yet heard the phone. Range beyond about a metre, and stealth from laptop speakers (the 17–19.5 kHz band arrived about 45 dB down on this laptop, too weak to decode reliably), are unmeasured.

## Tonedrop Link and gibberlink

Gibberlink showed two AI voice agents recognising each other and switching to ggwave tones. Tonedrop Link speaks that language and goes further:

| | gibberlink (ggwave) | Tonedrop |
| --- | --- | --- |
| Talks to gibberlink agents | yes | yes — the Link opens in gibberlink's `XY$text` format over ggwave |
| Longest message | 140 bytes; ggwave cuts longer input silently | any length, chunked and reassembled in any order |
| Files | no | yes, with name and type, gzip when it helps |
| Wrong bytes delivered as right | possible — see below | no: Reed-Solomon repairs, a CRC rejects what it cannot |
| Near-inaudible | gibberlink uses audible tones; ggwave also has ultrasound protocols | `stealth` mode, 17–18.6 kHz, tested under music 20 dB louder |
| Listener joining late | misses the message | a broadcast loop lets late listeners collect every chunk |
| Speed | ~10–28 B/s (normal to fastest, measured) | ~8–30 B/s (`robust` to `turbo`) |
| Recognising a peer | the language models decide in conversation | an acoustic handshake that carries a check byte |

Speed is a wash at the top end; the differences are integrity, length, files and stealth.

**ggwave can deliver garbled text as if it were fine.** With no noise at all, on a perfect digital loopback, ggwave 0.4.0 from npm decodes `ABCDE` on its audible fast and fastest protocols as different bytes at 2 of 32 sample alignments, and reports success; the build gibberlink ships garbles it the same way. Its dual-tone protocols fail for ordinary sentences. It has no CRC behind its short Reed-Solomon code. Tonedrop therefore decodes every ggwave message it is about to send at 16 alignments first and refuses one that would arrive wrong, never sends the dual-tone protocols, puts a check byte on its own handshake, and repeats an unanswered hello with different padding. Once two Tonedrop peers are linked, ggwave is no longer used. Two smaller traps are handled too: ggwave's decoder silently finds nothing unless each block is a whole number of its 1024-sample frames, and it holds only four instances at once.

## Translator

The **Translate** tab listens for Tonedrop (all four modes), ggwave/gibberlink and DTMF at once; Morse and tap code can be switched on, since in a noisy room (a fan, a hum) they write down noise. Each message appears once, labelled with its protocol and, for gibberlink, its sender id. Morse and tap code are read from rhythm alone, so the tones of every other protocol look like Morse to them: while a structured protocol is on air their letters are set aside, and their decoders restart afterwards. On the phone the whole translator uses about 5% of one core's real time.

The same tab speaks: type text and play it, or save it as a WAV, as any Tonedrop mode, any ggwave protocol, Morse, DTMF or tap code.

```bash
node tools/tonedrop-cli.mjs say --text "is it better now?" --as gg-fast --from AB --out gb.wav
node tools/tonedrop-cli.mjs translate --in recording.wav
node tools/tonedrop-cli.mjs translate --in recording.wav --json   # one event per line, for agents
```

In the page, `window.tonedrop.link` is the live link, so an agent driving the browser can call `say()` and `sendFile()` directly.

## Throughput

Sound is a slow channel, and this project does not pretend otherwise. These payload rates follow from the symbol rate (93.75 symbols/s) and everything a frame spends on air — preamble, header, error-correction parity and the gap before the next frame:

| Profile | Bits/symbol | Tone sets | Parity | Repeats | Payload throughput |
| --- | --- | --- | --- | --- | --- |
| `robust` | 3 | 4 | 50% | 2 | ~8 B/s |
| `fast` | 4 | 2 | 25% | 1 | ~25 B/s |
| `turbo` | 5 | 1 | 25% | 1 | ~30 B/s |
| `stealth` | 2 | 2 | 50% | 1 | ~11 B/s |

That is still several times faster than typing (40 words a minute is about 3–4 characters a second), and `fast` moves a 100-character message in about four and a half seconds. A 100 KB file is a long broadcast at any setting. The UI shows an estimate before you send, so nothing is a surprise. Compression (gzip, applied automatically when it actually shrinks the data) is the single biggest real-world speedup, because it happens before the bytes reach the air.

## Measured reliability

Share of full 64-byte frames decoded in a single pass, measured in simulation over 20–30 trials per cell. A broadcast loop repeats every frame, so a frame lost on one pass is collected on the next.

| Condition | robust | fast | turbo | stealth |
| --- | --- | --- | --- | --- |
| White noise at −10 dB SNR | 97% | 100% | 100% | 100% |
| Furnished room, ~0.5–1 m (RT60 300 ms, echo energy equal to direct) | 100% | 95% | 80% | 75% |
| Live room, long echo (RT60 600 ms, echo equal to direct) | 100% | 100% | 85% | 90% |
| Across a room (RT60 300 ms, echo 4× direct) | 55% | 0% | 0% | 5% |
| A 40 ms burst of loud clatter landing mid-frame | 100% | 100% | 100% | 100% |

In the same furnished-room case the original modem decoded 0% on every profile. Pick `robust` for anything beyond arm's length; `turbo` is for devices side by side.

## Stealth: messages inside a song

Open **Music carrier**: it is a record player. Load any track and press **Play music**; the record turns while the song plays. Type a message (or set one up on **Send**) and press **Start broadcast**; the record glows and reads *On air*. Music and broadcast pause and resume on their own, so the song can keep playing with the broadcast paused, or the other way round. The broadcast hides as **Stealth** by default; the receiving device opens **Listen**, where **Hear every mode** (on by default) means it does not need to pick the same mode. A test decodes stealth frames under a music bed more than 20 dB louder than the data, with broadband hiss at the data's own level.

Stealth is the default hiding place because of what it sounds like, not only what it measures. Its pitch glides from one tone to the next instead of jumping, which keeps its power below 15 kHz under -80 dB of the signal (a hard jump put -47 dB there, where the ear is tens of dB keener than at 18 kHz). Wave Ultra measures as clean on paper, but it sounds hundreds of tones at once; a phone speaker driven hard turns their beating into a hiss in the audible band (about -50 dB through a model of a speaker with 2% second-order distortion, against -131 dB for Stealth). And when a loud song leaves less room than the data level needs, the song is held a little lower for as long as the broadcast runs, so the two never clip together.

Honest limits: the speaker and microphone must reach 18.6 kHz. Most phones and laptops do; some cheap speakers, Bluetooth codecs and video-call audio paths cut everything above 16 kHz, and then nothing arrives. Children, pets and some young adults can hear that band as a faint whine. "Stealth" means unnoticed by ear, not secret — anyone running a receiver hears the bytes.

## Signalling codes

The **Codes** tab and the CLI handle three classic codes in both directions:

| Code | Written form | Sound | Decoder |
| --- | --- | --- | --- |
| Morse | `... --- ...`, words split by ` / ` | keyed tone, 5–40 wpm, 300–1500 Hz | auto-tunes to the pitch; learns the speed from the first marks and re-learns after a pause |
| Tap code | `52 11 44` (row, column of the 5×5 square; K is sent as C) | knocks | onset detection; follows the knocker's tempo; a missed knock costs one letter, not the rest |
| DTMF | `0–9 * # A–D` | phone keypad tone pairs | standard dual-tone test with energy checks, so music and speech do not dial digits |

Tested: Morse round-trips from 8 to 35 wpm, at any pitch in range, at −10 dB broadband SNR, across a change of sender speed and through a noisy room; knocks round-trip at different tempos and in noise; DTMF survives noise, 50 ms tones, 44.1 kHz capture and row and column tones arriving up to 18 dB apart; noise, a held whistle, a single held keypad tone and music chords never decode as anything. Over the air on a real phone, DTMF and Morse decode exactly from laptop speakers and from the phone's own speaker. Tap code has not been tested with real knocks.

```bash
node tools/tonedrop-cli.mjs code --type morse --text "sos" --out sos.wav --wpm 20
node tools/tonedrop-cli.mjs code --type morse --in recording.wav
node tools/tonedrop-cli.mjs code --type tap --code "52 11 44 15 42"
```

## Quick start

```bash
npm test          # run the modem and protocol test suite
npm run serve     # static dev server on http://localhost:5177
```

Open the page in two devices on the same machine or in the same room, press **Listen** on one and **Send** on the other. Grant microphone access when asked.

### CLI (agents and scripts)

```bash
# Encode text to a WAV you can play
node tools/tonedrop-cli.mjs encode --profile fast --text "meet at 0400" --out msg.wav

# Decode a WAV back to text (profile is auto-detected)
node tools/tonedrop-cli.mjs decode --in msg.wav

# Verify the modem end to end without any audio hardware
node tools/tonedrop-cli.mjs selftest
```

## Building the Android APK

The APK in `dist/tonedrop.apk` is a **debug-signed** build: it installs by sideloading on any device, but it is not suitable for store distribution. To build it yourself:

```bash
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

The result lands in `android/app/build/outputs/apk/debug/`.

For a signed release (`./gradlew bundleRelease` for Google Play, `assembleRelease` for an APK), generate your own keystore outside the repository and put these four properties in `~/.gradle/gradle.properties`: `SONICSPY_UPLOAD_STORE_FILE`, `SONICSPY_UPLOAD_KEY_ALIAS`, `SONICSPY_UPLOAD_STORE_PASSWORD`, `SONICSPY_UPLOAD_KEY_PASSWORD`. Without them, release builds come out unsigned. Never commit a keystore.

The icon, splash screens and store graphics are rendered from `tools/brand/mark.svg` by `node tools/make-store-assets.mjs`; the Play listing text lives in `store/listing.md` and the privacy policy in `web/privacy.html`.

`android/local.properties` must point at your Android SDK (`sdk.dir=...`). It is gitignored, because it is machine-specific.

### Android microphone note

Listening requires `RECORD_AUDIO`. Capacitor's `BridgeWebChromeClient` converts the WebView's audio-capture request into an Android runtime permission prompt and only grants capture after you allow it, so the app will ask the first time you press **Listen**. Sending, the music carrier and the self-test all work without any permission.

## How it works

The modem is **MFSK** (multiple frequency-shift keying) with a non-coherent detector:

- Each symbol is one tone drawn from a set of `M` evenly spaced frequencies, sent for a fixed duration. `M` tones carry `log2(M)` bits, which is the whole knob between robustness and speed: fewer, more widely spaced tones survive noise and cheap speakers; more tones move data faster and need a quiet room.
- The receiver measures energy at each candidate frequency with the **Goertzel algorithm** over a Hann window, and picks the strongest. Goertzel is used instead of a full FFT because only a handful of known frequencies matter, which makes it cheap enough to run continuously on a phone.
- Symbol duration is defined in **seconds** (`512 / 48000`), not in samples, so a 44.1 kHz device and a 48 kHz device agree on the timing and can talk to each other.
- A **preamble** of 16 symbols alternating between the lowest and highest tone precedes every frame, so a receiver can lock on mid-broadcast. Detection and timing both judge how much each tone *changed* between neighbouring windows rather than how loud it is: a decaying echo adds almost equally to neighbouring windows, so the difference cancels it.
- **Rotating tone sets.** A room rings with each tone for hundreds of milliseconds, far longer than a 10.7 ms symbol, so the last few symbols are still sounding while the next one is read. Measured with known timing, 100% of symbol errors in a reverberant room were a tone sent in the previous eight symbols. Consecutive symbols therefore cycle through interleaved tone sets (4 in `robust`, 2 in `fast`), so the tones still ringing are not even candidates, and each candidate is scored by how much it rose since its set was last used.
- **Reed-Solomon error correction** over GF(256) repairs the symbols that still go wrong; the CRC remains the final word on integrity, because a code pushed past its capacity can occasionally "correct" to the wrong data.
- The audible profiles use 32 tones from 1200 Hz to 7012.5 Hz, comfortably inside the passband of phone speakers and microphones; `stealth` uses 8 tones from 17250 Hz to 18562.5 Hz. Every frame fades in and out over 4 ms, because a tone switched on abruptly clicks across the whole spectrum — audible even when the tone is not.

### Frame format

Every frame is self-contained — preamble, header, payload, checksum, parity — so a receiver never needs earlier frames to parse a later one. All integers are big-endian. This is protocol version 2; version 1 frames carried no parity and are not compatible.

| Field | Bytes | Notes |
| --- | --- | --- |
| Preamble | 16 symbols | alternates lowest/highest tone |
| `SYNC` | 3 | `a5 c3 5a` |
| `VER` | 1 | currently `1` |
| `FLAGS` | 1 | bit 0 = binary, bit 1 = gzip |
| `MSGID` | 4 | random per message; identifies repeats |
| `SEQ` | 2 | increments per broadcast generation |
| `CHUNK_INDEX` | 2 | position of this chunk |
| `CHUNK_TOTAL` | 2 | chunks in the message |
| `PAYLOAD_LEN` | 2 | bytes of payload in this frame |
| `PAYLOAD` | variable | up to `chunkBytes` |
| `CRC-16` | 2 | CCITT-FALSE over everything preceding |

On air, the frame travels as two Reed-Solomon codewords. The 17-byte prefix (`SYNC` … `PAYLOAD_LEN`) carries 8 parity bytes of its own, enough to repair any 4 bad bytes, because its length field must be trustworthy before the receiver knows how much audio the rest occupies. The payload and CRC form the second codeword, with parity of a quarter of their size (half in `robust`, minimum 4 bytes). A header that cannot be repaired, or whose length no codeword could hold, is discarded at once rather than leaving the receiver waiting for audio that will never be a frame.

Files travel in a small container (magic `SPF1`) carrying the filename, MIME type and length with varint encoding.

## Security and trust

Received audio is treated as **untrusted input**, because anyone within earshot can transmit:

- Decoded content is inserted into the page as text nodes, never as HTML, so a malicious sender cannot inject markup.
- Filenames are stripped of path separators before a download can be offered.
- A frame that fails its CRC is dropped rather than partially used.

The channel itself is **not encrypted and not authenticated**. Anyone in the room can hear, record and decode it, and anyone in the room can transmit. Do not send secrets over the air. Anyone claiming otherwise about a system like this is mistaken about the physics: a microphone in a room hears everything.

## Repository layout

```
web/src/modem.js        DSP core: profiles, modulator, streaming demodulator, CRC
web/src/rs.js           Reed-Solomon encoder and decoder over GF(256)
web/src/codes.js        Morse, tap code and DTMF: encoders, synthesis, live decoders
web/src/ggwave.js       ggwave/gibberlink: encode with self-check, streaming decode, XY$ framing
web/src/translator.js   every protocol decoded from one stream; text spoken as any of them
web/src/link.js         Tonedrop Link: handshake, mode upgrade, text and files
web/src/protocol.js     framing, chunking, reassembly, hex helpers
web/src/transfer.js     file container, gzip, transfer estimates
web/src/audio.js        Web Audio I/O, music carrier, WAV read/write
web/src/app.js          UI wiring, spectrum display, in-page self-test
web/src/ui-link.js      the Link and Translate tabs
web/vendor/ggwave.js    ggwave 0.4.0, unmodified (MIT, Georgi Gerganov)
tools/tonedrop-cli.mjs  encode/decode/say/translate/selftest for agents and scripts
tools/serve.mjs         dependency-free static server
tests/                  modem, protocol, adversarial and real-browser tests
android/                Capacitor native project
```

The DSP core (`modem.js`, `rs.js`, `protocol.js`, `transfer.js`) has no DOM or Web Audio dependency at all. That is deliberate: the same code runs under Node in the test suite and in the browser, so the tests exercise the real thing rather than a copy of it.

## Known limitations

- **Distance in a live room is the limit, not noise.** Single-pass frame survival is high to about a metre and falls with distance as echo overtakes the direct sound (55% for `robust` where the echo carries four times the direct energy; `fast` and `turbo` do not work there). A broadcast loop recovers lost frames on later passes. The figures above come from a simulated room; real-hardware range is still unmeasured.
- **Clock drift is tolerated to ±2000 ppm, measured.** Real crystals sit at ±20–100 ppm, so that is 20–100× of margin. Decoding starts failing at ±3000 ppm. Timing is re-acquired from each frame's preamble, but symbols *within* a frame are read at fixed offsets, so error accumulates over a frame's length; parity made frames longer, which is why this limit fell from ±5000 ppm. Intra-frame timing tracking would raise it, which is not worth the complexity for error 20× beyond specification.
- **Throughput is bounded by physics**, not by optimisation.
- **Receiver sensitivity.** Measured on hardware: a RedMagic phone (Android 16) half a metre from laptop speakers at two-thirds volume heard the 7 kHz preamble tone at about −46 dBFS, with the room some 35 dB below it. The old fixed gate of 0.02 (−34 dBFS) discarded that clean frame. The squelch now defaults to 0.002 (−54 dBFS), and the real gate is relative: the preamble tones must stand 6 dB above tones the preamble never uses, which scales with any microphone's gain. A low gate cannot produce false messages, because every header must pass Reed-Solomon repair, the sync word and the CRC; a test confirms that loud noise and music produce no frames at the lowest setting (0.001), and decoding stays far faster than real time.
- The three moderate `npm audit` warnings are in `uuid`, pulled in transitively by the Capacitor **CLI's** iOS project helper. They affect build tooling only and are not present in the shipped APK. The suggested fix is a downgrade of the CLI, which is why it has not been applied.
- The Android build here uses the debug keystore, so it will not pass store review as-is.

## License

MIT — see [LICENSE](LICENSE). `web/vendor/ggwave.js` is [ggwave](https://github.com/ggerganov/ggwave) 0.4.0 by Georgi Gerganov, also MIT; its licence is in `web/vendor/ggwave-LICENSE.txt`.
