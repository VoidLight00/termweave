/** Bun supports client headers; lib.dom's constructor overload hides that option. */
export function authenticatedWebSocket(url: string, token: string): WebSocket {
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  return new RuntimeSocket(url, { headers: { authorization: `Bearer ${token}` } });
}
