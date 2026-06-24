// Minimal ambient declarations for Fastly Compute built-in modules.
// These are not SDK dependencies — they only exist in the Compute runtime.
// Imported dynamically and marked external in tsup, so they never get bundled.

declare module "fastly:logger" {
  export class Logger {
    constructor(endpoint: string);
    log(message: string): void;
  }
}
