# LanPair

Real-time pair editing for Antigravity / Code OSS over the local network.
Two people on the same LAN edit the same files simultaneously and see each
other's cursors. Built on Yjs (CRDT); no cloud server, no accounts, no internet.

Status: Phase 0 (scaffold). See `PROMPT-claude-code-lanpair.md` for the roadmap.

## Development

```sh
npm install
npm run build     # bundle to dist/extension.js
npm test          # vitest
npm run package   # produce lanpair.vsix
```

Install in Antigravity: Extensions → ⋯ → Install from VSIX… → `lanpair.vsix`.
