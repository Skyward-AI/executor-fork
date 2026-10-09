import { Effect } from "effect";

import { discoverToolsFromInput } from "@executor-js/plugin-mcp";
import {
  makeHostedHttpClientLayer,
  type HostedInternalHosts,
} from "@executor-js/sdk/host-internal";

import type { ListTools } from "./reconcile";

/** Lists tools with the MCP plugin's discovery, routed like the plugin's own calls. */
export const makeInternalListTools = (internalHosts: HostedInternalHosts): ListTools => {
  const httpClientLayer = makeHostedHttpClientLayer({ internalHosts });
  return (endpoint) =>
    discoverToolsFromInput({
      transport: "remote",
      endpoint,
      remoteTransport: "streamable-http",
      httpClientLayer,
    }).pipe(Effect.map(({ manifest }) => manifest.tools));
};
