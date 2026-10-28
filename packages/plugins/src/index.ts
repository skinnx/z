import type { ZPlugin } from "@z/core";
import browser from "./browser/index.ts";
import channels from "./channels/index.ts";
import clock from "./clock/index.ts";
import github from "./github/index.ts";
import rss from "./rss/index.ts";
import web from "./web/index.ts";

/** Every plugin shipped with z. Third-party plugins are loaded from Z_PLUGINS. */
export const builtinPlugins: ZPlugin[] = [web, browser, rss, github, clock, channels];

/** The SSRF guard, reused by the server for MCP connector URLs. */
export { isPrivateAddress, resolvePublicHost } from "./util.ts";
