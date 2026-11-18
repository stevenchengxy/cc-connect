import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker/index.js';

export function database(t) {
  const sql = new DatabaseSync(':memory:');
  const dir = new URL('../drizzle/', import.meta.url);
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(file,dir),'utf8'));
  t.after(() => sql.close());
  const statement = (text, values = []) => ({
    bind(...args) { return statement(text, args.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v)); },
    first() { return sql.prepare(text).get(...values) || null; },
    all() { return { results: sql.prepare(text).all(...values) }; },
    run() { return { meta: sql.prepare(text).run(...values) }; }
  });
  return { handle: sql, DB: { prepare: statement, batch(stmts) {
    sql.exec('BEGIN');
    try { const rows = stmts.map(s => s.run()); sql.exec('COMMIT'); return rows; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } } };
}
export const token = () => randomBytes(32).toString('base64url');
export const sha = s => createHash('sha256').update(s).digest('hex');
export function approvedSession(db) {
  const id = crypto.randomUUID(), session = token(), now = Date.now();
  db.handle.prepare("INSERT INTO accounts(id,username,role,status,salt,password_hash,password_scheme,created) VALUES(?,?,'member','approved','unused','unused','test',?)")
    .run(id,'u-'+id,now);
  db.handle.prepare('INSERT INTO account_sessions(digest,account,expires) VALUES(?,?,?)').run(sha(session),id,now+86_400_000);
  return {id,session};
}

export function fixture(db,members={host:approvedSession(db),viewer:approvedSession(db)}) {
  const id = token(), proof = token(), hostToken = token(), viewerToken = token();
  const send = (role, method, seq, bearer = role === 'host' ? hostToken : viewerToken, body = null, enrollment = role === 'host' ? sha(proof) : proof, session=members[role].session) => worker.fetch(new Request(
    `https://example.test/v1/rooms/${id}/${role}` + (seq ? `/messages/${seq}` : ''),
    {method, headers: {authorization:`Bearer ${bearer}`,'x-cc-session':session,'x-viewer-proof':enrollment,'content-type':'application/octet-stream'}, body}
  ), db);
  return { id, send, hostToken, viewerToken, proof, members };
}
