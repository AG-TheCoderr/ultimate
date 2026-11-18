#!/usr/bin/env node
/**
 * M3 implements this. What M0 fixes in place: the entry point, the `bin` name the MCP config examples
 * in README reference, and the rule that makes the whole relay work.
 *
 * CRITICAL (VISION §8): stdout is the MCP protocol channel. Never write logs here — one stray
 * `console.log` desynchronises the stdio framing and the agent sees a corrupt handshake. All logging
 * goes to stderr, and the line below is why this stub exists at M0 rather than M3.
 */
const log = (msg: string): void => {
  process.stderr.write(`[rigpilot-relay] ${msg}\n`);
};

log("relay starts in M3 (MCP stdio server + ws bridge on 127.0.0.1:8765)");
log("until then: use the studio page directly — it is the source of truth for project state");
process.exitCode = 69; // EX_UNAVAILABLE: explicit, and `claude mcp add` will show a clean failure
