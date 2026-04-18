// Preloaded via `node -r` before any ESM imports resolve.
// Next's `async-local-storage` module reads `globalThis.AsyncLocalStorage`
// (normally planted by `next start` / Edge runtime bootstrap). With our
// custom server that's not set up, so do it here.
globalThis.AsyncLocalStorage ??= require("async_hooks").AsyncLocalStorage;
