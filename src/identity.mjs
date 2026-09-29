export function normalizeNickname(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}
export function validNickname(value) {
  return value.length > 0 && value.length <= 16 && !/[\p{C}<>]/u.test(value);
}
export function suggestNickname(current = '', random = Math.random) {
  const skies = ['새벽', '노을', '은빛', '푸른', '고요한', '빛나는', '구름', '바람', '별빛', '번개', '안개', '황금'];
  const wings = ['매', '솔개', '날개', '제비', '독수리', '비행사', '편대', '수리'];
  const names = skies.flatMap(sky => wings.map(wing => `${sky} ${wing}`)).filter(name => name !== current);
  return names[Math.floor(random() * names.length)];
}
export const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const validToken = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const rankMode = (duration, practice) => practice ? null : duration === Infinity ? 'challenge' : duration === 1800 ? 'classic' : 'quick';
export const modeNames = { challenge: '출격', classic: '30분 출격', quick: '3분 출격' };
