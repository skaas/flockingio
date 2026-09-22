export function normalizeNickname(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}
export function validNickname(value) {
  return value.length > 0 && value.length <= 16 && !/[\p{C}<>]/u.test(value);
}
export const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const validToken = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const rankMode = (duration, practice) => practice ? null : duration === Infinity ? 'challenge' : duration === 1800 ? 'classic' : 'quick';
export const modeNames = { challenge: '기록 도전', classic: '긴 생존', quick: '빠른 플레이' };
