// Use the database clock inside permission-sensitive mutations so logout,
// suspension and expiry during an in-flight request take effect atomically.
export const nowMs = "(julianday('now')-2440587.5)*86400000";
export const liveSession = (account,session) => `EXISTS(SELECT 1 FROM account_sessions s
  JOIN accounts a ON a.id=s.account WHERE s.digest=${session} AND s.account=${account}
  AND s.expires>${nowMs} AND a.status='approved')`;
export const membersLive = liveSession('r.host_account','r.host_session') +
  ' AND (r.viewer IS NULL OR '+liveSession('r.viewer_account','r.viewer_session')+')';
