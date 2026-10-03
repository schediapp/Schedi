import crypto from 'node:crypto';

function latinUpper(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function statementDescriptor(name) {
  let descriptor = latinUpper(name).slice(0, 22).trim();
  if (!/[A-Z]/.test(descriptor) || descriptor.length < 5) {
    descriptor = `${descriptor} PAY`.trim().slice(0, 22).trim();
  }
  if (descriptor.length < 5 || !/[A-Z]/.test(descriptor)) descriptor = 'SCHEDI';
  return descriptor;
}

export function chargeStatement(name) {
  const descriptor = statementDescriptor(name);
  let prefix = descriptor.replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (prefix.length < 2 || !/[A-Z]/.test(prefix)) prefix = 'SCHEDI';
  const compact = descriptor.replace(/[^A-Z0-9]/g, '');
  let suffix = compact.startsWith(prefix) ? compact.slice(prefix.length) : compact;
  const room = Math.max(1, 22 - prefix.length - 2);
  suffix = suffix.slice(0, room);
  if (!suffix) suffix = prefix.slice(0, room);
  return { descriptor, prefix, suffix };
}

export function integrationIdentifier(prefix) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i += 1) suffix += alphabet[bytes[i] % 26];
  return `${prefix}_${suffix}`;
}

export function slugify(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'business';
}
