# TypeScript Port of token-goat → [pi-token-goat](https://github.com/eSaadster/pi-token-goat)

Just a quick heads-up — I made a TypeScript/Node.js port of token-goat!

👉 **https://github.com/eSaadster/pi-token-goat**

**Why?** Two reasons:

1. I use [pi](https://github.com/earendil-works/pi-mono), which is a TypeScript-native coding agent. I wanted token-goat to run in-process instead of forking Python on every hook call, so the whole thing got ported as a native TS extension.

2. I wanted to see if I could take a real, honest-to-goodness tool and move it into a language / framework I'm still learning. I'm a Python/bash person by trade and TypeScript + Node was way outside my comfort zone. It was... humbling. And I loved it.

It is a line-by-line port — all 80+ CLI commands, 130+ bash filters, code/session/skill compaction, image shrinking, read optimization, the whole hook system. ~280 tests so far. Same TOML config, same env vars, same defaults. Just different plumbing: `commander` instead of `typer`, `better-sqlite3` instead of `sqlite3`, native `async/await` instead of `asyncio`, and a pi extension that hooks straight into the agent's event loop instead of routing through a subprocess.

Not trying to replace anything — this is my "learn a new stack" project that accidentally turned into something useful. Figured I'd drop a note in case it ever helps someone else running token-goat in a JS-heavy stack.

— [eSaadster](https://github.com/eSaadster)
