/**
 * Ambient types for Host-runtime-provided peer modules.
 *
 * DSH ships the private @deepseek-ai/* scope with the runtime itself; the local
 * npm mirror cannot install it (see docs/CONTRIBUTING.md §8 on the registry),
 * so this checkout's node_modules has no copy to resolve types from. These
 * declarations assert only the module's EXISTENCE so that @ts-check can resolve
 * the specifier without pretending to know the real shape — the runtime shape
 * is the authority, exactly as with the peer-only test suites.
 *
 * Dev-only: package.json#files does not include types/, so nothing here ships
 * in the tarball. Keep entries in sync with the peer imports actually in *.js.
 *
 * `@earendil-works/pi-ai` IS public on npm, but it is asserted the same way on
 * purpose: it is a PEER, so the runtime copy is whatever the Host shipped, and
 * a devDep copy's declarations would describe a version this plugin does not
 * control — a confidently-wrong shape is worse here than an honest `any`.
 *
 * `react` is the same story from the browser side: `client.js` ships unbuilt
 * and gets React from the shell's module table (or a stand-in in the Node
 * suites), so there is no installed copy to resolve and no honest shape to
 * declare beyond its existence.
 */
declare module "@deepseek-ai/dsh-tools";
declare module "@deepseek-ai/dsh-llm";
declare module "@deepseek-ai/dsh-llm-pi-ai";
declare module "@earendil-works/pi-ai";
declare module "@earendil-works/pi-ai/api/openai-completions.lazy";
declare module "react";
