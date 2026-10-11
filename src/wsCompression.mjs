// wsCompression.mjs — bounded, opt-in WebSocket transport compression (permessage-deflate).
//
// Zero dependencies, framework-agnostic. Extracted from Stronghold Protocol's `server/wsCompression.js`,
// where the numbers below were measured on a live server; only the game-specific whitelist stays configurable.
//
// Three modes, one word each:
//
//   off    no compression (the default — do not pay for what a fat link does not need)
//   on     the shipped set: context takeover, zlib's default 15-bit window, 64-byte threshold
//   safe   the fallback: context takeover off, window still negotiated
//
// ============================================================================================
// WHY `on` DECLARES ALMOST NOTHING
// ============================================================================================
// Both omissions are load-bearing, and they point the same way — leaving them out is BOTH the better
// compression AND the safer negotiation.
//
// 1. CONTEXT TAKEOVER. With no context takeover every frame is deflated from scratch, so content that
//    repeats ACROSS frames pays its compressed size again in every frame. Hot frames are almost
//    entirely repetition. Measured with the real library over one seat's whole session (byte-exact
//    round trip): `m.private` 4.07x -> 43.55x, the delta-mode `m.public` 2.69x -> 12.68x, and a stream
//    interleaved at real per-type rates (so the window is shared as it is in production) 3.76x ->
//    26.59x. It is also FASTER (52 ms vs 84 ms for that flow): less to deflate, less to push.
//
//    `ws` already defaults to context takeover — Stronghold had explicitly turned it off. Setting the
//    option to `false` would be WRONG, not merely redundant: in ws's negotiation a literal `false`
//    means "REQUIRE context takeover" and silently rejects any client that asks for
//    `server_no_context_takeover` (lib/permessage-deflate.js `acceptAsServer`).
//
// 2. THE WINDOW. Left unset, ws deflates with `zlib.Z_DEFAULT_WINDOWBITS` (15) — see `_compress`.
//    Declaring a number is what risks rejection: `acceptAsServer` rejects the offer when the server's
//    window exceeds the one the CLIENT offered.
//
// ⚠️ NEITHER FAILURE IS A DEGRADED CONNECTION — IT IS NO CONNECTION. `ws` turns a rejected offer into
// `abortHandshake(... 400 ...)` (lib/websocket-server.js), so a client that would have worked fine
// without compression cannot connect at all. That is why `safe` also leaves the window undeclared.
//
// 3. THE THRESHOLD IS A HARD SWITCH, NOT A HINT. `ws` sends a frame below `threshold` with rsv1 clear
//    — not deflated at all, just ~2 bytes of extra framing (lib/sender.js: `rsv1 = byteLength >=
//    _threshold`). 64 rather than the 512 this shipped with: frame-shrinking steps had pushed the hot
//    frame's median under 512, so 61% of them had quietly stopped being compressed. Not 0 either,
//    because the very smallest frames do grow when deflated.

/** The part of the option set that does not depend on who is compressing what. */
const SHARED = Object.freeze({
  threshold: 64,
  clientNoContextTakeover: true,
  concurrencyLimit: 8,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 5 }),
});

/** The shipped set: `SHARED`, with context takeover and zlib's default window left undeclared on purpose. */
const OPTIONS = SHARED;

/** The fallback: context takeover off (the only part that carries risk), window still negotiated. */
const SAFE_OPTIONS = Object.freeze({ ...SHARED, serverNoContextTakeover: true });

const MODES = Object.freeze({ off: false, on: OPTIONS, safe: SAFE_OPTIONS });

/**
 * The `perMessageDeflate` value for a mode string — what you hand to `new WebSocketServer({ ... })`.
 *
 * Anything unrecognised is REFUSED rather than silently defaulted: a typo in the environment variable
 * must not quietly change what goes on the wire.
 * @param {string} [mode] `off` (default) | `on` | `safe`
 * @returns {false | object}
 */
export function resolveWsCompression(mode = 'off') {
  if (Object.prototype.hasOwnProperty.call(MODES, mode)) return MODES[mode];
  throw new TypeError(`WS compression mode must be one of ${Object.keys(MODES).join(', ')} (got ${JSON.stringify(mode)})`);
}

/** Every accepted mode name, in the order they should be offered to an operator. */
export const WS_COMPRESSION_MODES = Object.freeze(Object.keys(MODES));

/**
 * The message types worth compressing for Stronghold Protocol: the repetitive, high-volume traffic.
 * `m.public` is the match's public state broadcast; `m.private` is the per-player view (shop / hand /
 * board). Both are highly repetitive ACROSS frames, which is what context takeover is for.
 *
 * Pass your own set to `createCompressFilter` — this list is game-specific, the mechanism is not.
 */
export const STRONGHOLD_COMPRESSIBLE_TYPES = Object.freeze([
  'b.snap', 'b.ev', 'm.field', 'm.public', 'm.private', 'm.result',
]);

/**
 * A whitelist predicate over message type names. Only what is listed gets compressed; everything else
 * — credentials, handshake, control and request/response traffic — goes out untouched, which also keeps
 * small frames from growing.
 *
 * ⚠️ A type that carries a LARGE payload and is NOT listed is the expensive kind of mistake: it pays
 * full price in every frame and is invisible in a smoke test. Stronghold's `b.start` (the battle spec
 * the client replays, ~4.2 KB) sat outside the list until it was measured at 72.5 B/s — 69% of the
 * whole uplink. Re-measure the type table whenever a new frame type joins the protocol.
 * @param {Iterable<string>} [types] defaults to the Stronghold set
 * @returns {(type: unknown) => boolean}
 */
export function createCompressFilter(types = STRONGHOLD_COMPRESSIBLE_TYPES) {
  const set = new Set(types);
  return (type) => set.has(type);
}

/**
 * A one-line, human-readable description of a mode — for logs and the read-only status route.
 * Reports what will actually be on the wire, including the two undeclared options, because "on" alone
 * does not tell an operator whether the window is pinned.
 * @param {string} mode
 */
export function describeWsCompression(mode) {
  const options = resolveWsCompression(mode);
  if (options === false) return { mode, enabled: false, summary: 'off — frames go out as-is' };
  const takeover = options.serverNoContextTakeover === true ? 'off (declared)' : 'on (negotiated)';
  const windowBits = typeof options.serverMaxWindowBits === 'number'
    ? `${options.serverMaxWindowBits} (pinned)`
    : '15 (zlib default, negotiated)';
  return {
    mode,
    enabled: true,
    threshold: options.threshold,
    contextTakeover: takeover,
    windowBits,
    concurrencyLimit: options.concurrencyLimit,
    summary: `deflate level ${options.zlibDeflateOptions.level}, threshold ${options.threshold} B, context takeover ${takeover}, window ${windowBits}`,
  };
}
