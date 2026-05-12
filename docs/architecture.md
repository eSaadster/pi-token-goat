# Architecture

See implementation plan at `C:\Users\zelys\.claude\plans\would-any-kind-of-cozy-hippo.md` (local).

## Overview

**8 pillars:**
- Image shrinking (local + GDrive intercept)
- Session-context cache (avoid re-reading touched files)
- Read replacement (symbol index + semantic search)
- Repo map (PageRank-based layout)
- Symbol index (tree-sitter)
- Light indexers (Liquid, Markdown, HTML, JSON)
- Semantic search (fastembed + sqlite-vec)
- Hook auto-wiring (pre/post-read, session-start, etc.)

**Two-tier DB:**
- Global: symbol definitions, embeddings, cached images, session records
- Per-project: fast local lookups, dep graphs

**Python entrypoint hooks** register at install time; Windows Scheduled Task wakes worker daemon on reboot + idle.

**fastembed** for embeddings; **sqlite-vec** for vector similarity; **tree-sitter** for parsing.
