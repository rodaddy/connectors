/**
 * Terminal output for the catalog scripts. They are command-line tools, not
 * library code, so they write lines to stdout and stderr directly.
 *
 * @module
 */

/** Write one line to stdout. */
export function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Write one line to stderr. */
export function warn(line: string): void {
  process.stderr.write(`${line}\n`);
}
