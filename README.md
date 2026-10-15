# SonicSpy

Send text, files and raw bytes between phones, laptops and AI agents **over audible sound** — no network, no pairing, no accounts. A speaker plays a stream of tones; anything with a microphone that is within earshot decodes it.

It is useful when there is no usable link: no Wi-Fi, no cellular, no Bluetooth permission, air-gapped machines, or a room full of devices that all need the same payload at once. One transmitter can hand data to many receivers simultaneously, because sound is a broadcast medium — there is no connection to establish, and no limit on how many listeners there are.

## What it does

- **Text, files and hex** — send a sentence, a document, an image or arbitrary bytes.
- **Broadcast, not unicast** — a laptop plays a loop of frames; every phone in the room that is listening collects the same payload. Devices can join halfway through and still reconstruct the whole thing.
- **Music carrier** — hide the data inside music that is already playing, so a normal playlist doubles as a data channel.
- **Real-time receive** — a live spectrum display shows signal strength and which tones are arriving, with per-transfer progress.
- **Loops long messages** — a long message is repeated so late arrivals still get every chunk, and the receiver reassembles them in any order.
- **A CLI for agents** — AI agents and scripts talk to each other by writing and reading WAV files, so no human or microphone is needed for a machine-to-machine hop.

## Honest status

Verified by automated tests and by rendering in a real browser:

- 90 unit tests covering the modem and protocol pass (clean loopback on all three profiles, 10 dB and 4 dB SNR, interference from music, late join mid-broadcast, byte-for-byte binary integrity, corrupted frames rejected by CRC, out-of-order and duplicate chunks).
- A separate suite models the impairments that only exist between two physical devices, none of which appear in an idealised channel: independent sample clocks (drift up to ±1000 ppm, both directions, on every profile), transducer frequency response (500 Hz high-pass and 7.5 kHz low-pass), an overdriven amplifier clipping to a quarter of full scale, DC offset plus 50 Hz mains hum, a room reflection arriving 18 ms late, and a capture callback delivering audio in awkward chunk sizes (single samples, primes, random 1–8192, 64 K blocks).
- A real-browser smoke test drives the actual UI in Brave/Chromium: encoding, decoding, the in-page self-test on all three profiles, and the diagnostics view all pass.
- The Android APK builds, is correctly signed, declares the microphone permissions, and contains the full application.

**Not yet verified:** a live speaker-to-microphone transfer on physical hardware. Every path has been exercised electrically (rendered audio into a decoded buffer) and in a real browser, but nobody has yet held two phones apart and watched a file cross the gap. That test needs two devices and a quiet room. Treat real-world range and reliability as unmeasured.

## Measured throughput

Sound is a slow channel, and this project does not pretend otherwise. These are measured payload rates, and they follow directly from the symbol rate (93.75 symbols/s) and the frame overhead:

| Profile | Tones | Bits/symbol | Repeats | Payload throughput |
| --- | --- | --- | --- | --- |
| `robust` | 8 | 3 | 2 | ~13 B/s |
| `fast` | 16 | 4 | 1 | ~33 B/s |
| `turbo` | 32 | 5 | 1 | ~40 B/s |

A 100 KB file is therefore a several-minute broadcast at best. The UI shows an estimate before you send, so nothing is a surprise. Compression (gzip, applied automatically when it actually shrinks the data) is the single biggest real-world speedup, because it happens before the bytes reach the air.

## Quick start

```bash
npm test          # run the modem and protocol test suite
npm run serve     # static dev server on http://localhost:5177
```

Open the page in two devices on the same machine or in the same room, press **Listen** on one and **Send** on the other. Grant microphone access when asked.

### CLI (agents and scripts)

```bash
# Encode text to a WAV you can play
node tools/sonicspy-cli.mjs encode --profile fast --text "meet at 0400" --out msg.wav

# Decode a WAV back to text (profile is auto-detected)
node tools/sonicspy-cli.mjs decode --in msg.wav

# Verify the modem end to end without any audio hardware
node tools/sonicspy-cli.mjs selftest
```

## Building the Android APK

The APK in `dist/sonicspy.apk` is a **debug-signed** build: it installs by sideloading on any device, but it is not suitable for store distribution. To build it yourself:

```bash
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

The result lands in `android/app/build/outputs/apk/debug/`. To produce a properly signed release build, generate your own keystore and add a `signingConfigs` block to `android/app/build.gradle` — never reuse the debug key, and never commit a keystore to the repository.

`android/local.properties` must point at your Android SDK (`sdk.dir=...`). It is gitignored, because it is machine-specific.

### Android microphone note

Listening requires `RECORD_AUDIO`. Capacitor's `BridgeWebChromeClient` converts the WebView's audio-capture request into an Android runtime permission prompt and only grants capture after you allow it, so the app will ask the first time you press **Listen**. Sending, the music carrier and the self-test all work without any permission.

## How it works

The modem is **MFSK** (multiple frequency-shift keying) with a non-coherent detector:

- Each symbol is one tone drawn from a set of `M` evenly spaced frequencies, sent for a fixed duration. `M` tones carry `log2(M)` bits, which is the whole knob between robustness and speed: fewer, more widely spaced tones survive noise and cheap speakers; more tones move data faster and need a quiet room.
- The receiver measures energy at each candidate frequency with the **Goertzel algorithm** over a Hann window, and picks the strongest. Goertzel is used instead of a full FFT because only a handful of known frequencies matter, which makes it cheap enough to run continuously on a phone.
- Symbol duration is defined in **seconds** (`512 / 48000`), not in samples, so a 44.1 kHz device and a 48 kHz device agree on the timing and can talk to each other.
- A **preamble** of 16 symbols alternating between the lowest and highest tone precedes every frame, so a receiver can lock on mid-broadcast. It evaluates only two tones, keeping the search loop cheap.
- Tones run from 1200 Hz upward (7012.5 Hz at the top of `turbo`), which sits comfortably inside the passband of phone speakers and microphones.

### Frame format

Every frame is self-contained — preamble, header, payload, checksum — so a receiver never needs earlier frames to parse a later one. All integers are big-endian.

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

Files travel in a small container (magic `SPF1`) carrying the filename, MIME type and length with varint encoding.

**There is no forward error correction.** Integrity comes from the CRC-16 on each frame plus repetition and reassembly: a frame that fails its checksum is discarded, and the receiver waits for the repeat. Adding FEC (Reed-Solomon or a convolutional code) is the most valuable next improvement, and the frame header has room for it.

## Security and trust

Received audio is treated as **untrusted input**, because anyone within earshot can transmit:

- Decoded content is inserted into the page as text nodes, never as HTML, so a malicious sender cannot inject markup.
- Filenames are stripped of path separators before a download can be offered.
- A frame that fails its CRC is dropped rather than partially used.

The channel itself is **not encrypted and not authenticated**. Anyone in the room can hear, record and decode it, and anyone in the room can transmit. Do not send secrets over the air. Anyone claiming otherwise about a system like this is mistaken about the physics: a microphone in a room hears everything.

## Repository layout

```
web/src/modem.js        DSP core: profiles, modulator, streaming demodulator, CRC
web/src/protocol.js     framing, chunking, reassembly, hex helpers
web/src/transfer.js     file container, gzip, transfer estimates
web/src/audio.js        Web Audio I/O, music carrier, WAV read/write
web/src/app.js          UI wiring, spectrum display, in-page self-test
tools/sonicspy-cli.mjs  encode/decode/selftest for agents and scripts
tools/serve.mjs         dependency-free static server
tests/                  modem, protocol and real-browser smoke tests
android/                Capacitor native project
```

The DSP core (`modem.js`, `protocol.js`, `transfer.js`) has no DOM or Web Audio dependency at all. That is deliberate: the same code runs under Node in the test suite and in the browser, so the tests exercise the real thing rather than a copy of it.

## Known limitations

- **No forward error correction** (see above).
- **Clock drift is tolerated to ±1000 ppm, measured.** Real crystals sit at ±20–100 ppm, so that is 10–50× of margin. The measured cliff is ±5000 ppm, where `robust` stops decoding: every profile shares a symbol duration, but `robust` needs the most symbols per frame, so its frame lasts longest and accumulates the most timing error (about 1.1 symbol periods at that error rate). Timing is re-acquired from each frame's preamble, but symbols *within* a frame are read at fixed offsets, so error accumulates over a frame's length. Fixing it would mean intra-frame timing tracking, which is not worth the complexity for error 50× beyond specification.
- **Throughput is bounded by physics**, not by optimisation.
- **Range is untested on real hardware.** Expect a few metres in a quiet room, less with background noise.
- The three moderate `npm audit` warnings are in `uuid`, pulled in transitively by the Capacitor **CLI's** iOS project helper. They affect build tooling only and are not present in the shipped APK. The suggested fix is a downgrade of the CLI, which is why it has not been applied.
- The Android build here uses the debug keystore, so it will not pass store review as-is.

## License

MIT — see [LICENSE](LICENSE).
