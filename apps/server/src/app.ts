import type { Briefings } from "./briefings.ts";
import type { Channels } from "./channels.ts";
import type { Connectors } from "./connectors.ts";
import type { Pairing } from "./owner.ts";
import type { Push } from "./push.ts";
import type { Runtime } from "./runtime.ts";
import type { Tasks } from "./tasks.ts";

/** Everything the HTTP routes need. */
export type Services = {
  rt: Runtime;
  tasks: Tasks;
  briefings: Briefings;
  channels: Channels;
  push: Push;
  pairing: Pairing;
  connectors: Connectors;
};
