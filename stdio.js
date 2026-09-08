import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

if (!process.env.ICLOSED_API_KEY) {
  console.error("ICLOSED_API_KEY env var required");
  process.exit(1);
}

const server = new McpServer({ name: "iclosed", version: "2.0.0" });
registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
