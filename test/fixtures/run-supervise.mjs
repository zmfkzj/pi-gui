// Runs bin/pi-gui-snap-chromium.mjs's supervise() in its own process (so tests can signal or kill the supervisor).
// Options come as JSON in SUPERVISE_OPTIONS (RegExp fields as strings); log lines go to stdout, the exit code is its own.
import { supervise } from "../../bin/pi-gui-snap-chromium.mjs";

const options = JSON.parse(process.env.SUPERVISE_OPTIONS);
if (options.browserProgram) options.browserProgram = new RegExp(options.browserProgram);
const code = await supervise({ ...options, log: line => console.log(line) });
process.exit(code);
