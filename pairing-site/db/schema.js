import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, blob, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const invites = sqliteTable('account_invites', {
  digest: text('digest').primaryKey(),
  expires: integer('expires').notNull()
}, t => [index('account_invites_expiry').on(t.expires)]);

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  role: text('role').notNull(),
  status: text('status').notNull(),
  salt: text('salt').notNull(),
  passwordHash: text('password_hash').notNull(),
  passwordScheme: text('password_scheme').notNull(),
  invite: text('invite'),
  created: integer('created').notNull(),
  revision: integer('revision').notNull().default(0)
}, t => [uniqueIndex('accounts_single_invite').on(t.invite)]);

export const adminSetup = sqliteTable('admin_setup', {
  singleton: integer('singleton').primaryKey(),
  admin: text('admin').notNull().references(() => accounts.id),
  created: integer('created').notNull()
});

export const accountSessions = sqliteTable('account_sessions', {
  digest: text('digest').primaryKey(),
  account: text('account').notNull().references(() => accounts.id),
  expires: integer('expires').notNull()
}, t => [index('account_sessions_owner').on(t.account,t.expires), index('account_sessions_expiry').on(t.expires)]);

export const authRate = sqliteTable('auth_rate', {
  bucket: text('bucket').primaryKey(),
  attempts: integer('attempts').notNull(),
  expires: integer('expires').notNull()
}, t => [index('auth_rate_expiry').on(t.expires)]);

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  host: text('host').notNull(),
  hostAccount: text('host_account'),
  hostSession: text('host_session'),
  enrollment: text('enrollment').notNull(),
  viewer: text('viewer'),
  viewerAccount: text('viewer_account'),
  viewerSession: text('viewer_session'),
  source: text('source').notNull(),
  created: integer('created').notNull(),
  expires: integer('expires').notNull(),
  closed: integer('closed').notNull().default(0)
}, t => [index('rooms_expiry').on(t.expires), index('rooms_source').on(t.source,t.created),
  index('rooms_host_account').on(t.hostAccount), index('rooms_viewer_account').on(t.viewerAccount)]);

export const messages = sqliteTable('messages', {
  room: text('room').notNull().references(() => rooms.id, {onDelete:'cascade'}),
  sender: text('sender').notNull(),
  seq: integer('seq').notNull(),
  bytes: blob('bytes').notNull(),
  size: integer('size').notNull(),
  digest: text('digest').notNull(),
  served: integer('served').notNull().default(0)
}, t => [primaryKey({ columns:[t.room,t.sender,t.seq] }),
  index('messages_pending').on(t.room,t.sender,t.seq).where(sql`size > 0`)]);

// Device locators remain reserved when their short-lived room is collected.
// The host encrypts its current invitation before publication.
export const deviceAliases = sqliteTable('device_aliases', {
  alias: text('alias').primaryKey(),
  owner: text('owner').notNull().references(() => accounts.id),
  managerDigest: text('manager_digest').notNull(),
  room: text('room').references(() => rooms.id, {onDelete:'set null'}),
  roomCreated: integer('room_created').notNull().default(0),
  envelope: text('envelope'),
  retired: integer('retired').notNull().default(0)
}, t => [uniqueIndex('device_aliases_room').on(t.room)]);

// One short-lived credential cache entry and one issuance lease per member.
export const turnGrants = sqliteTable('turn_grants', {
  room: text('room').notNull().references(() => rooms.id, {onDelete:'cascade'}),
  role: text('role').notNull(),
  lease: text('lease').notNull(),
  retryAt: integer('retry_at').notNull(),
  expires: integer('expires').notNull().default(0),
  payload: text('payload')
}, t => [primaryKey({ columns:[t.room,t.role] })]);

export const relayQuotas = sqliteTable('relay_quotas', {
  scope: text('scope').primaryKey(),
  mode: text('mode').notNull().default('off'),
  limitBytes: integer('limit_bytes').notNull().default(0),
  maxConcurrent: integer('max_concurrent').notNull().default(0),
  revision: integer('revision').notNull().default(0)
});

export const relayMeters = sqliteTable('relay_meters', {
  scope: text('scope').notNull(),
  periodStart: text('period_start').notNull(),
  checked: integer('checked').notNull(),
  highEgress: integer('high_egress').notNull(),
  everReported: integer('ever_reported').notNull()
}, t => [primaryKey({columns:[t.scope,t.periodStart]})]);

// A room deletion must not discard provider usernames still awaiting revocation.
export const relayLeases = sqliteTable('relay_leases', {
  id: text('id').primaryKey(),
  room: text('room').notNull(),
  role: text('role').notNull(),
  account: text('account').notNull(),
  keyId: text('key_id').notNull(),
  created: integer('created').notNull(),
  expires: integer('expires').notNull(),
  state: text('state').notNull(),
  username: text('username'),
  payload: text('payload')
}, t => [index('relay_leases_room').on(t.room,t.role,t.expires),
  index('relay_leases_owner').on(t.account,t.expires), index('relay_leases_time').on(t.created),
  index('relay_leases_expiry').on(t.expires)]);

export const relayDays = sqliteTable('relay_days', {
  provider: text('provider').notNull(), scope: text('scope').notNull(), day: text('day').notNull(),
  egress: integer('egress').notNull(), ingress: integer('ingress').notNull(),
  reported: integer('reported').notNull(), checked: integer('checked').notNull()
}, t=>[primaryKey({columns:[t.provider,t.scope,t.day]})]);
