#!/usr/bin/env node
/*
 * sonicspy CLI — the link for programs.
 *
 * A process has no microphone and no speaker, so the CLI works in files: it
 * encodes a message or a file into a WAV, and decodes a WAV back into messages
 * and files. That is enough for one agent to hand data to another agent, or to
 * a person who plays the WAV out loud.
 *
 *   sonicspy-cli.mjs encode --text "hello" --out hello.wav
 *   sonicspy-cli.mjs encode --file ./report.json --out report.wav --profile turbo
 *   sonicspy-cli.mjs decode --in recording.wav --out-dir ./received
 *   sonicspy-cli.mjs selftest --profile fast
 *   sonicspy-cli.mjs profiles
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  PROFILES,
  modulateFrames,
  demodulateAll,
  bitsPerSymbol,
  PREAMBLE_SYMBOLS,
} from '../web/src/modem.js';
import {
  framesForText,
  framesForBinary,
  Reassembler,
  toHex,
  fromHex,
  FLAG_BINARY,
  FLAG_GZIP,
} from '../web/src/protocol.js';
import {
  packFileContainer,
  parseFileContainer,
  maybeCompress,
  maybeDecompress,
  estimateTransfer,
  formatDuration,
  formatBytes,
  payloadBytesPerSecond,
} from '../web/src/transfer.js';
import { toWav, fromWav } from '../web/src/audio.js';

const FS = 48000;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function resolveProfile(name) {
  const key = name || 'robust';
  const profile = PROFILES[key];
  if (!profile) {
    throw new Error(`unknown profile "${key}" — try: ${Object.keys(PROFILES).join(', ')}`);
  }
  return profile;
}

function expectedFrameBytes(prefix, len) {
  return 17 + len + 2;
}

async function encode(args) {
  const profile = resolveProfile(args.profile);
  const repeats = Math.max(1, Math.min(20, Number(args.repeats || profile.repeats)));
  const fs = Number(args.fs || FS);
  const out = args.out || 'sonicspy.wav';
  const chunkBytes = profile.chunkBytes;

  let frames;
  let summary;
  let id = (Math.random() * 0xffffffff) >>> 0;

  if (args.text) {
    const text = String(args.text);
    ({ frames } = framesForText(text, { chunkBytes, id }));
    summary = `${text.length} characters of text`;
  } else if (args.hex) {
    const bytes = fromHex(String(args.hex));
    const packed = packFileContainer({ name: 'payload.bin', mime: 'application/octet-stream', data: bytes });
    ({ frames } = framesForBinary(packed, { chunkBytes, id }));
    summary = `${bytes.length} raw bytes`;
  } else if (args.file) {
    const raw = new Uint8Array(await readFile(String(args.file)));
    const { data, gzipped } = await maybeCompress(raw, args.compress !== false);
    const packed = packFileContainer({
      name: basename(String(args.file)),
      mime: 'application/octet-stream',
      data,
    });
    ({ frames } = framesForBinary(packed, { chunkBytes, id, flags: gzipped ? FLAG_GZIP : 0 }));
    summary = `${basename(String(args.file))} (${formatBytes(raw.length)}${gzipped ? ` → ${formatBytes(data.length)} compressed` : ''})`;
  } else {
    throw new Error('encode needs one of --text, --file or --hex');
  }

  const repeated = [];
  for (let r = 0; r < repeats; r++) repeated.push(...frames);
  const samples = modulateFrames(repeated, { fs, profile });
  await writeFile(out, toWav(samples, fs));

  const symbolsPerFrame = PREAMBLE_SYMBOLS + Math.ceil(((17 + chunkBytes + 2) * 8) / bitsPerSymbol(profile));
  const seconds = repeated.length * symbolsPerFrame * profile.symbolSeconds;

  console.log(`profile   ${profile.label} (${profile.m} tones, ${(payloadBytesPerSecond(profile)).toFixed(0)} B/s)`);
  console.log(`payload   ${summary}`);
  console.log(`frames    ${frames.length} × ${repeats} repeats`);
  console.log(`on air    ${formatDuration(seconds)}`);
  console.log(`wrote     ${out} (${formatBytes(samples.length * 2 + 44)} of audio)`);
}

async function decode(args) {
  const source = args.in;
  if (!source) throw new Error('decode needs --in <recording.wav>');
  const buffer = await readFile(source);
  const raw = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const { samples, sampleRate } = fromWav(raw);

  const candidates = args.profile ? [args.profile] : Object.keys(PROFILES);
  const results = [];

  for (const name of candidates) {
    const profile = resolveProfile(name);
    const messages = [];
    const reassembler = new Reassembler({ onComplete: (m) => messages.push(m) });
    const { frames: decoded, stats } = demodulateAll(samples, {
      fs: sampleRate,
      profile,
      squelch: Number(args.squelch || 0.08),
      expectedFrameBytes,
    });
    for (const frame of decoded) reassembler.accept(frame);
    results.push({ name, profile, messages, frames: decoded.length, stats });
    if (messages.length > 0 && !args.profile) break;
  }

  const winner = results.find((r) => r.messages.length > 0) || results[0];
  if (!winner.messages.length) {
    console.error(`no messages decoded from ${source}`);
    for (const r of results) {
      console.error(`  tried ${r.name}: ${r.frames} frames, ${r.stats.crcFailures} CRC failures`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`profile   ${winner.profile.label} (detected "${winner.name}")`);
  console.log(`decoded   ${winner.messages.length} message(s) from ${winner.frames} frame(s)`);

  const outDir = args['out-dir'];
  if (outDir) await mkdir(outDir, { recursive: true });

  for (const message of winner.messages) {
    const binary = (message.flags & FLAG_BINARY) !== 0;
    if (!binary) {
      console.log('---');
      console.log(message.text);
      if (outDir) {
        const target = join(outDir, `message-${message.id.toString(16)}.txt`);
        await writeFile(target, message.text, 'utf8');
        console.log(`wrote ${target}`);
      }
      continue;
    }

    console.log('---');
    console.log(`binary message ${message.id.toString(16)} · ${formatBytes(message.binary.length)}`);

    const container = parseFileContainer(message.binary);
    if (container) {
      const data = await maybeDecompress(container.data, (message.flags & FLAG_GZIP) !== 0);
      console.log(`file      ${container.name} (${container.mime || 'application/octet-stream'}) · ${formatBytes(data.length)}`);
      if (outDir) {
        const target = join(outDir, basename(container.name));
        await writeFile(target, data);
        console.log(`wrote ${target}`);
      }
    } else {
      console.log(`hex       ${toHex(message.binary.slice(0, 64))}${message.binary.length > 64 ? ' …' : ''}`);
      if (outDir) {
        const target = join(outDir, `payload-${message.id.toString(16)}.bin`);
        await writeFile(target, message.binary);
        console.log(`wrote ${target}`);
      }
    }
  }
}

function selftest(args) {
  const profile = resolveProfile(args.profile);
  const text = args.text ? String(args.text) : 'sonicspy link check';
  const started = Date.now();

  const { frames } = framesForText(text, { chunkBytes: profile.chunkBytes });
  const clean = modulateFrames(frames, { fs: FS, profile });

  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const check = (samples, label) => {
    const messages = [];
    const rx = new Reassembler({ onComplete: (m) => messages.push(m) });
    const { frames: decoded, stats } = demodulateAll(samples, {
      fs: FS,
      profile,
      squelch: 0.1,
      expectedFrameBytes,
    });
    for (const f of decoded) rx.accept(f);
    const ok = messages.length === 1 && messages[0].text === text;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} — ${decoded.length} frames, ${stats.crcFailures} CRC failures`);
    return ok;
  };

  const results = [check(clean, 'clean channel')];

  for (const snr of [12, 6]) {
    const signalRms = Math.sqrt(clean.reduce((s, v) => s + v * v, 0) / clean.length) || 1;
    const noiseRms = signalRms / Math.pow(10, snr / 20);
    const noisy = Float32Array.from(clean);
    for (let i = 0; i < noisy.length; i++) {
      const u1 = Math.max(rand(), 1e-9);
      const u2 = rand();
      noisy[i] += Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * noiseRms;
    }
    results.push(check(noisy, `${snr} dB signal to noise`));
  }

  console.log(`profile   "${args.profile || 'robust'}" · ${profile.m} tones · ${formatDuration((Date.now() - started) / 1000)} elapsed`);
  if (results.some((r) => !r)) process.exitCode = 1;
}

function profiles() {
  for (const [name, profile] of Object.entries(PROFILES)) {
    const rate = payloadBytesPerSecond(profile);
    const { seconds } = estimateTransfer({ bytes: 1024, profile });
    console.log(
      `${name.padEnd(8)} ${profile.m} tones  ${bitsPerSymbol(profile)} bits/symbol  ` +
        `${rate.toFixed(0)} B/s  1 KB ≈ ${formatDuration(seconds)}`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  switch (command) {
    case 'encode':
      await encode(args);
      break;
    case 'decode':
      await decode(args);
      break;
    case 'selftest':
      selftest(args);
      break;
    case 'profiles':
      profiles();
      break;
    default:
      console.log(
        [
          'sonicspy — data over sound',
          '',
          'usage:',
          '  encode --text "hello" --out hello.wav [--profile robust|fast|turbo] [--repeats 2]',
          '  encode --file ./report.json --out report.wav [--profile turbo]',
          '  encode --hex a5c35a --out payload.wav',
          '  decode --in recording.wav [--out-dir ./received] [--profile fast]',
          '  selftest [--profile fast] [--text "custom payload"]',
          '  profiles',
        ].join('\n')
      );
      if (command) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
