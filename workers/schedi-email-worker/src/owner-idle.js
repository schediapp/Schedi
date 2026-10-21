/**
 * Owner portal auto log-off.
 * Chosen values are 0 (Off), 15, 30, and 60 minutes. New owners start at 30.
 * A one-time migration moves Off or a missing value to 30 and sets
 * ownerIdleDefaultApplied. A later Off is left alone.
 */
export const OWNER_IDLE_DEFAULT_MIN = 30;
export const OWNER_IDLE_CHOICES = [0, 15, 30, 60];

export function canonicalOwnerIdleMinutes(value) {
  if (value === 0 || value === false) return 0;
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (text === '' || text === 'null' || text === 'undefined') return null;
  if (text === '0' || text === 'off') return 0;
  const n = parseInt(text, 10);
  if (n === 15 || n === 30 || n === 60) return n;
  if (n === 0) return 0;
  return null;
}

export function planOwnerIdleDefault(tenant) {
  const row = tenant || {};
  if (row.ownerIdleDefaultApplied === true) {
    const minutes = canonicalOwnerIdleMinutes(row.ownerIdleTimeoutMin);
    return { action: 'skip', reason: 'already-applied', minutes: minutes == null ? OWNER_IDLE_DEFAULT_MIN : minutes, patch: null };
  }
  const has = Object.prototype.hasOwnProperty.call(row, 'ownerIdleTimeoutMin')
    && row.ownerIdleTimeoutMin !== ''
    && row.ownerIdleTimeoutMin != null;
  const minutes = canonicalOwnerIdleMinutes(has ? row.ownerIdleTimeoutMin : null);
  if (minutes === 15 || minutes === 30 || minutes === 60) {
    return {
      action: 'keep',
      reason: 'chosen',
      minutes,
      patch: { ownerIdleDefaultApplied: true },
    };
  }
  return {
    action: 'set-default',
    reason: has ? 'off' : 'missing',
    minutes: OWNER_IDLE_DEFAULT_MIN,
    patch: { ownerIdleTimeoutMin: OWNER_IDLE_DEFAULT_MIN, ownerIdleDefaultApplied: true },
  };
}

export function summarizeOwnerIdlePlans(plans) {
  const list = plans || [];
  return {
    setTo30: list.filter((p) => p && p.action === 'set-default').length,
    leftChosen: list.filter((p) => p && p.action === 'keep').length,
    alreadyApplied: list.filter((p) => p && p.action === 'skip').length,
  };
}

/**
 * First browser visit after this change. Off or a missing local value becomes
 * 30. 15, 30, and 60 stay. Once applied, a later Off stays Off.
 */
export function planLocalIdleDefault(raw, applied) {
  if (applied === true) {
    const minutes = canonicalOwnerIdleMinutes(raw);
    return { migrated: false, keptChoice: false, minutes: minutes == null ? OWNER_IDLE_DEFAULT_MIN : minutes };
  }
  const minutes = canonicalOwnerIdleMinutes(raw);
  if (minutes === 15 || minutes === 30 || minutes === 60) {
    return { migrated: true, keptChoice: true, minutes };
  }
  return { migrated: true, keptChoice: false, minutes: OWNER_IDLE_DEFAULT_MIN };
}
