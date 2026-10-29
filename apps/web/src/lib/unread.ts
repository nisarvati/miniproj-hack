import type { UserNotification } from "./api";
import { readStorage, writeStorage } from "./storage";

const key = (email: string) => `medlink:seen:${email}`;

/** The id of the newest notification this device has shown the user. Ids only grow, so "newer than that" is unread. */
export function loadLastSeen(email: string): number {
  const n = Number(readStorage(key(email)));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export const saveLastSeen = (email: string, id: number) => writeStorage(key(email), String(id));

export function countUnread(notifications: UserNotification[], lastSeen: number): number {
  return notifications.filter((n) => n.id > lastSeen).length;
}

export const newestId = (notifications: UserNotification[]): number => notifications.reduce((max, n) => Math.max(max, n.id), 0);
