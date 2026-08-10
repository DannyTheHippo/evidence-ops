// Side-effect module: pins the process timezone to UTC.
//
// It exists as its own module because ES import declarations are hoisted — a bare
// `process.env.TZ = 'UTC'` statement at the top of an entrypoint still runs *after* every
// imported module's body. Importing this first guarantees the assignment happens before any
// other fixture module is evaluated.
//
// Why it matters: zip entries store DOS timestamps that jszip encodes from a Date's local
// calendar fields, while pdfkit and docProps render UTC. Only under a pinned zone do the two
// agree, and only then does the committed corpus match a regeneration on another machine.
process.env.TZ = 'UTC';
