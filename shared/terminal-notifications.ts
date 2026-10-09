/** Text-only terminal announcements. These are application claims, not execution evidence. */
export type TerminalAnnouncement = { protocol: "9" | "99" | "777"; title: string; body: string };
export type NotificationTarget = { terminalId: string; paneId: string; workspaceId: string; paneNumber: number };
export type TerminalNotification = TerminalAnnouncement & { id: number; terminalId: string; createdAt: number; read: boolean; target: NotificationTarget | null };
export type TerminalNotificationList = { items: TerminalNotification[]; unread: number; checkedAt: number; collection: "attached-live-output" | "native-live-output"; sourceStatus?: "available" | "unavailable" };
