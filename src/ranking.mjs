import { normalizeNickname, validNickname, validId, validToken } from './identity.mjs';

const PROFILE_KEY = 'murmur-player-v1', PENDING_PREFIX = 'murmur-pending-v1:';
export class RankingClient {
  constructor({ storage, request = (...args) => fetch(...args), random = crypto } = {}) {
    try { this.storage = storage ?? localStorage; } catch { this.storage = null; }
    this.request = request; this.random = random; this.pending = new Map(); this.results = new Map(); this.flushing = null;
    let saved;
    try { saved = JSON.parse(this.storage?.getItem(PROFILE_KEY)); } catch { /* Recover a damaged profile. */ }
    if (saved && validId(saved.playerId) && validToken(saved.token)) this.profile = { ...saved, nickname: normalizeNickname(saved.nickname) };
    else {
      const playerId = random.randomUUID();
      const token = Array.from(random.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
      this.profile = { playerId, token, nickname: '', tag: playerId.slice(0, 8).toUpperCase() };
    }
    this.persistent = this.save(PROFILE_KEY, this.profile);
    try {
      for (let i = 0; i < (this.storage?.length || 0); i++) {
        const key = this.storage.key(i);
        if (!key?.startsWith(PENDING_PREFIX)) continue;
        const score = JSON.parse(this.storage.getItem(key));
        if (score?.playerId === this.profile.playerId && validId(score.runId)) this.pending.set(score.runId, score);
      }
    } catch { /* Storage can be unavailable; in-memory submissions still work. */ }
  }
  save(key, value) { try { if (!this.storage) return false; this.storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
  setNickname(value) {
    const nickname = normalizeNickname(value);
    if (!validNickname(nickname)) throw new Error('닉네임을 1~16자로 입력해주세요.');
    this.profile.nickname = nickname;
    this.persistent = this.save(PROFILE_KEY, this.profile);
    return nickname;
  }
  get label() { return `${this.profile.nickname || '플레이어'}#${this.profile.tag}`; }
  async api(path, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await this.request(path, { signal: controller.signal, cache: 'no-store', ...(body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.profile.token}` }, body: JSON.stringify(body),
      } : {}) });
      let result;
      try { result = await response.json(); } catch { throw new Error('랭킹 서버에 연결할 수 없어요.'); }
      if (!response.ok) throw new Error(result.error || '랭킹 연결을 다시 시도해주세요.');
      return result;
    } finally { clearTimeout(timer); }
  }
  async register() {
    const { profile } = await this.api('/api/players', { playerId: this.profile.playerId, nickname: this.profile.nickname });
    this.profile.tag = profile.tag;
    this.persistent = this.save(PROFILE_KEY, this.profile);
    return profile;
  }
  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      if (!this.pending.size) return;
      await this.register();
      while (this.pending.size) {
        const [runId, score] = this.pending.entries().next().value;
        const result = await this.api('/api/scores', score);
        this.results.set(runId, result);
        if (this.results.size > 20) this.results.delete(this.results.keys().next().value);
        this.pending.delete(runId);
        try { this.storage?.removeItem(PENDING_PREFIX + runId); } catch { /* Duplicate retries are idempotent. */ }
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async submit(score) {
    const body = { ...score, playerId: this.profile.playerId };
    this.pending.set(body.runId, body); this.save(PENDING_PREFIX + body.runId, body);
    await this.flush();
    if (this.pending.has(body.runId)) await this.flush();
    return this.results.get(body.runId);
  }
  list(mode) { return this.api(`/api/leaderboard?mode=${encodeURIComponent(mode)}&playerId=${encodeURIComponent(this.profile.playerId)}`); }
}
