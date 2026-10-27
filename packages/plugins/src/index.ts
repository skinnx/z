import type { ZPlugin } from "@z/core";
import channels from "./channels/index.ts";
import clock from "./clock/index.ts";
import github from "./github/index.ts";
import rss from "./rss/index.ts";
import web from "./web/index.ts";

/** Every plugin shipped with z. Third-party plugins are loaded from Z_PLUGINS. */
export const builtinPlugins: ZPlugin[] = [web, rss, github, clock, channels];
