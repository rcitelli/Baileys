/**
 * Single import surface for the Baileys library.
 *
 * The server consumes the parent package's *built* output (`../../lib`) rather than
 * re-installing `baileys` as a nested dependency. This avoids rebuilding Baileys'
 * native dependencies (libsignal, whatsapp-rust-bridge) a second time: their runtime
 * modules resolve by Node's node_modules walk-up to the repository root install.
 *
 * Build the parent once (`yarn build` at the repo root) before starting the server.
 * The Dockerfile does this automatically.
 */
export * from '../../lib/index.js'
export { default, default as makeWASocket } from '../../lib/index.js'
