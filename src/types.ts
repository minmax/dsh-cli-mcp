// Shared types for the dsh-cli-mcp server.

/** Public MCP tool description / schema shape. */
export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

/** Wire types — everything that crosses a process boundary. */

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Result of one dsh subprocess run. */
export interface DshRunResult {
  /** Process exit code, or -1 if it died before exit. */
  code: number;
  /** Captured stdout, capped to MAX_CAPTURE chars. */
  stdout: string;
  /** Captured stderr (last MAX_STDERR chars). */
  stderr: string;
  /** Wall-clock time the run took, in milliseconds. */
  wallMs: number;
  /** True when the process did not exit on its own. */
  timedOut?: boolean;
  /** Command + argv we actually spawned (for diagnostics). */
  command: string;
  args: string[];
}
