// The client protocol: what a spacehub CLI and the hub it talks to must agree
// on. The CLI asks for it (the client_protocol procedure) whenever it
// connects, and stops with an "update it" message on a mismatch instead of
// failing on a table it cannot read.
//
// Bump PROTOCOL when a change breaks clients built before it: a table, column,
// reducer or procedure they use is renamed, removed or changes type, or a
// table gains a column. Adding a table, reducer or procedure breaks no one.
// OLDEST_PROTOCOL is the oldest client protocol this hub still serves; raise
// it with PROTOCOL unless the hub keeps the old names working.
export const PROTOCOL = 1;
export const OLDEST_PROTOCOL = 1;

// The generated client bindings this protocol was decided for. The CLI tests
// fail when the bindings change (npm run generate) and this does not, so each
// schema change decides on a bump: then set this to the hash the test prints.
export const BINDINGS_HASH = 'e3c87160d50f6cee';
