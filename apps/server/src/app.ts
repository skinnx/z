import type { Briefings } from "./briefings.ts";
import type { Channels } from "./channels.ts";
import type { Runtime } from "./runtime.ts";
import type { Tasks } from "./tasks.ts";

/** Everything the HTTP routes need. */
export type Services = { rt: Runtime; tasks: Tasks; briefings: Briefings; channels: Channels };
