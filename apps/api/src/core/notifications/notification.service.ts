import type { ClientSession, Types } from 'mongoose';
import { Notification } from './notification.model';

export interface NotifyInput {
  recipientIds: (string | Types.ObjectId)[];
  type: string;
  title: string;
  body?: string;
  link?: string;
  entityType?: string;
  entityId?: string | Types.ObjectId;
  severity?: 'info' | 'success' | 'warning' | 'danger';
}

/**
 * Creates in-app notifications. Email/SMS/WhatsApp fan-out, templates, preferences and retries are
 * completed in Phase 9 (NOT-04…NOT-07); this function remains the single entry point.
 */
export async function notify(input: NotifyInput, session?: ClientSession) {
  const unique = [...new Set(input.recipientIds.map(String))];
  if (!unique.length) return;
  await Notification.insertMany(
    unique.map((recipientId) => ({
      recipientId,
      channel: 'IN_APP',
      type: input.type,
      title: input.title,
      body: input.body ?? '',
      link: input.link,
      entityType: input.entityType,
      entityId: input.entityId,
      severity: input.severity ?? 'info',
      status: 'SENT',
      sentAt: new Date(),
    })),
    { session },
  );
}
