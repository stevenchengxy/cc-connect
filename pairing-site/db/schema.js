import { sqliteTable, text, integer, blob, index, primaryKey } from 'drizzle-orm/sqlite-core';

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  host: text('host').notNull(),
  enrollment: text('enrollment').notNull(),
  viewer: text('viewer'),
  source: text('source').notNull(),
  created: integer('created').notNull(),
  expires: integer('expires').notNull(),
  closed: integer('closed').notNull().default(0)
}, t => [index('rooms_expiry').on(t.expires), index('rooms_source').on(t.source,t.created)]);

export const messages = sqliteTable('messages', {
  room: text('room').notNull().references(() => rooms.id, {onDelete:'cascade'}),
  sender: text('sender').notNull(),
  seq: integer('seq').notNull(),
  bytes: blob('bytes').notNull(),
  size: integer('size').notNull(),
  digest: text('digest').notNull()
}, t => [primaryKey({ columns:[t.room,t.sender,t.seq] })]);
