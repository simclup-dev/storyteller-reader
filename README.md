# Storyteller Reader

A synchronized audiobook reader: the text highlights **word by word, karaoke-style, in sync with the narration**. Built as an installable PWA (~9,600 lines of vanilla JavaScript across 20 modules) on top of a self-hosted [Storyteller](https://gitlab.com/storyteller-platform/storyteller) backend, which provides the audio-text alignment data.

![Reader with karaoke highlighting](docs/screenshot.png)

## Features

- **Karaoke mode** — word-level highlighting synchronized with audiobook narration
- **Walk mode** — hands-free listening with the screen readable at a glance
- **One-tap translation** — tap any word or phrase while reading
- **Offline-first PWA** — service worker caching; installable on phone and desktop
- **Gesture controls** — swipe navigation, tap zones for play/pause and paging
- **Encrypted credential storage** — the LLM API key and session token are AES-GCM encrypted at rest (WebCrypto, non-extractable master key in IndexedDB), never stored as plaintext
- **Sleep timer**, per-book progress sync, configurable themes and typography
- **Exact-arithmetic pagination** — column layout computed analytically instead of via `getClientRects()`, which returns per-word rects and breaks column measurement (hard-won lesson)

## Architecture

20 focused modules instead of a framework — `state.js` (single store), `reader.js` (pagination & rendering), `audio.js` (playback & sync), `epub.js` (content parsing), `gestures.js`, `translate.js`, `sleep.js`, `auth.js`, `storage.js`, and friends. No build step: open it, it runs.

```
Storyteller backend (self-hosted) ──> REST API: books, positions, alignment data
        │
nginx ──> reader.html + js/ + css/  (this repo, static PWA)
        └──> sw.js (offline cache)
```

## Setup

Point `nginx.conf` (or any static server) at this directory and at your Storyteller instance's `/api`. Log in with your Storyteller credentials — books, audio, and sync positions come from there.

## Stack

Vanilla JavaScript (ES modules) · PWA / Service Worker · Nginx · Storyteller platform API
