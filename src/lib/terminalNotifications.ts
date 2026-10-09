import type { NotificationTarget, TerminalNotificationList } from "../../shared/terminal-notifications.ts";
const base = "/api/terminal-notifications";
async function request<T>(path: string, signal: AbortSignal, method = "GET"): Promise<T> {
  const response = await fetch(`${base}${path}`, { method, cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}
export const listTerminalNotifications = (signal: AbortSignal) => request<TerminalNotificationList>("", signal);
export const resolveTerminalNotification = (id: number, signal: AbortSignal) => request<NotificationTarget>(`/${id}/target`, signal);
export const readTerminalNotification = (id: number, signal: AbortSignal) => request<{ ok: true }>(`/${id}/read`, signal, "POST");
export const clearTerminalNotifications = (signal: AbortSignal) => request<{ ok: true }>("/clear", signal, "POST");
