/** Helper to build MCP text content response */
export function ok<T>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data }) }],
  };
}

export function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
