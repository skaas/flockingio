import { normalizeNickname, validNickname, validId, validToken } from './identity.mjs';
import { validReplay, savePendingReplay, loadPendingReplay, deletePendingReplay } from './replay.mjs';

const PROFILE_KEY = 'murmur-player-v1', PENDING_PREFIX = 'murmur-pending-v1:';
export class RankingClient {
  constructor({ storage, request = (...args) => fetch(...args), random = crypto,
    replayStore = { save: savePendingReplay, load: loadPendingReplay, delete: deletePendingReplay } } = {}) {
    try { this.storage = storage ?? localStorage; } catch { this.storage = null; }
    this.request = request; this.random = random; this.replayStore = replayStore;
    this.pending = new Map(); this.pendingReplays = new Map(); this.results = new Map(); this.flushing = null;
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
    if (!validNickname(nickname)) throw new Error('이름을 1~16자로 입력하세요.');
    this.profile.nickname = nickname;
    this.persistent = this.save(PROFILE_KEY, this.profile);
    return nickname;
  }
  get label() { return `${this.profile.nickname || '플레이어'}#${this.profile.tag}`; }
  async api(path, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), body?.replay || path.startsWith('/api/replay') ? 20000 : 4500);
    try {
      const response = await this.request(path, { signal: controller.signal, cache: 'no-store', ...(body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.profile.token}` }, body: JSON.stringify(body),
      } : {}) });
      let result;
      try { result = await response.json(); } catch { throw new Error('전장의 영웅들에 연결할 수 없습니다.'); }
      if (!response.ok) throw new Error(result.error || '전장의 영웅들 연결을 다시 시도하세요.');
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
        const replay = this.pendingReplays.get(runId) ?? await this.replayStore.load(runId).catch(() => null);
        const includeReplay = replay && JSON.stringify(replay).length <= 1_900_000;
        let result;
        try { result = await this.api('/api/scores', includeReplay ? { ...score, replay } : score); }
        catch (error) {
          if (!includeReplay || !/마지막 출격|출격 재생|리플레이|요청이 너무 커요/.test(error.message)) throw error;
          result = await this.api('/api/scores', score);
        }
        this.results.set(runId, result);
        if (this.results.size > 20) this.results.delete(this.results.keys().next().value);
        this.pending.delete(runId);
        this.pendingReplays.delete(runId);
        try { this.storage?.removeItem(PENDING_PREFIX + runId); } catch { /* Duplicate retries are idempotent. */ }
        this.replayStore.delete(runId).catch(() => {});
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async submit(score, replay = null) {
    const body = { ...score, playerId: this.profile.playerId };
    if (replay && validReplay(replay)) {
      this.pendingReplays.set(body.runId, replay);
      await this.replayStore.save(body.runId, replay).catch(() => {});
    }
    this.pending.set(body.runId, body); this.save(PENDING_PREFIX + body.runId, body);
    await this.flush();
    if (this.pending.has(body.runId)) await this.flush();
    return this.results.get(body.runId);
  }
  list(mode) { return this.api(`/api/leaderboard?mode=${encodeURIComponent(mode)}&playerId=${encodeURIComponent(this.profile.playerId)}`); }
  replay(playerId, mode) { return this.api(`/api/replay?playerId=${encodeURIComponent(playerId)}&mode=${encodeURIComponent(mode)}`); }
}
