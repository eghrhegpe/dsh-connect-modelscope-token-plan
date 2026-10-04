#!/usr/bin/env node
/**
 * The CLI entry for `dsh-connect-modelscope-token-plan`'s doctor: a read-only
 * report over the plugin's own state files under `$DSH_HOME` (or `~/.dsh`).
 * It never touches a platform endpoint, never writes, and never prints a
 * token value (env presence only — see src/host/doctor.ts).
 *
 * Run: `node tools/doctor.mjs` (human lines) or `node tools/doctor.mjs --json`
 * (machine-readable report).
 */
import { main } from "../src/host/doctor.ts";

await main();
