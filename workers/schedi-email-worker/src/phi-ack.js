/**
 * Medical / Healthcare preset acknowledgment.
 * The booking page never reads this. It is stored on the private tenant doc.
 */
export const PHI_ACK_VERSION = 'phi-ack-v1';
export const PHI_ACK_WORDING = 'I confirm this business will not collect health information (protected health information) through Schedi.';

const MEDICAL = new Set(['medical', 'healthcare', 'medical / healthcare', 'medical/healthcare']);

export function isMedicalIndustry(value) {
  return MEDICAL.has(String(value || '').trim().toLowerCase());
}

export function phiAckValid(ack) {
  if (!ack || typeof ack !== 'object') return false;
  return ack.version === PHI_ACK_VERSION && String(ack.who || '').trim() !== '' && String(ack.at || '').trim() !== '';
}

export function phiAckStamp(who, now) {
  return {
    who: String(who || '').trim(),
    at: new Date(now || Date.now()).toISOString(),
    version: PHI_ACK_VERSION,
  };
}

/**
 * Medical saves need a checked acknowledgment. A later save that does not send
 * the checkbox keeps a stored acknowledgment of the current wording version.
 * An explicit decline (phiAckAccepted: false) is refused.
 * Returns { ok, phiAcknowledgment }.
 */
export function resolvePhiAcknowledgment({ industry, accepted, explicit, existing, who, now }) {
  if (!isMedicalIndustry(industry)) {
    return { ok: true, required: false, phiAcknowledgment: phiAckValid(existing) ? existing : undefined };
  }
  if (explicit && accepted !== true) return { ok: false, error: 'phi_ack_required' };
  if (accepted === true) {
    const actor = String(who || '').trim();
    if (!actor) return { ok: false, error: 'phi_ack_required' };
    return { ok: true, required: true, phiAcknowledgment: phiAckStamp(actor, now) };
  }
  if (phiAckValid(existing)) return { ok: true, required: true, phiAcknowledgment: existing };
  return { ok: false, error: 'phi_ack_required' };
}
