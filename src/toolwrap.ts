import { z } from "zod";
import { PanelError } from "./panel.js";

/**
 * Shared `confirm_live` argument for every mutating tool. The wording is the whole safety model: the
 * caller may only pass it when the user asked, in the current conversation, to write to that live box.
 */
export const confirmLiveArg = z
  .boolean()
  .optional()
  .describe(
    "Required (true) to write to a LIVE server. Pass it ONLY when the user explicitly asked, in this conversation, " +
      "to write to this specific live server. Never inferred from urgency, a dev approval, or an earlier session."
  );

export interface TextContentResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Wraps a plain string as an MCP tool text result. */
export function ok(text: string): TextContentResult {
  return { content: [{ type: "text", text }] };
}

/** Pretty-prints a JSON-serializable value as an MCP tool text result. */
export function jsonBlock(data: unknown): TextContentResult {
  return ok(JSON.stringify(data, null, 2));
}

/**
 * Wraps a tool handler so that thrown PanelError/Error instances become a well-formed
 * MCP error result instead of an uncaught exception.
 */
export function wrap(
  handler: (args: any) => Promise<any>
): (args: any) => Promise<any> {
  return async (args: any) => {
    try {
      return await handler(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

/**
 * Guards a destructive operation behind an explicit confirm flag. Throws a PanelError
 * instructing the caller to retry with confirm: true unless confirm === true.
 */
export function requireConfirm(confirm: boolean | undefined, what: string): void {
  if (confirm !== true) {
    throw new PanelError(`This will ${what}. Call again with confirm: true`);
  }
}
