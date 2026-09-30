// Browser-side transport for the one continuous, server-owned battle.
// Only frames received from the room may advance the replica.
const ROOM_ID = 'flocking-main';
const MAX_QUEUED_FRAMES = 120;
const INPUT_INTERVAL = 1 / 20;
const NEUTRAL_INPUT = Object.freeze({ dx: 0, dy: 0, boost: false, gather: false });

const defaultSdk = () => import('/vendor/colyseus-sdk.mjs');
const defaultProtocol = () => import('./fleet-room-protocol.mjs');

function endpointFromConfig(config, origin) {
  const url = new URL(config?.endpoint || origin, origin);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('멀티플레이 서버 주소가 올바르지 않습니다.');
  return url.href.replace(/\/$/, '');
}

async function configuredEndpoint(fetchConfig, origin) {
  const response = await fetchConfig('/multiplayer-config.json', { cache: 'no-store' });
  // A local server can omit the config; its own origin is the endpoint.
  if (response?.status === 404) return endpointFromConfig(null, origin);
  if (!response?.ok) throw new Error('서버 설정을 읽을 수 없습니다.');
  return endpointFromConfig(await response.json(), origin);
}

function connectionError(error) {
  const message = String(error?.message || error || '');
  if (/full|capacity|429|409|30명|정원/i.test(message)) return { code: 'full', message: '방이 가득 찼습니다. 잠시 후 다시 시도해 주세요.' };
  return { code: 'unavailable', message: '서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.' };
}

// Presentation objects have their own player flags. The replica and its codec
// reference player are never modified by rendering or ownership changes.
export class FleetPresentation {
  constructor() { this.entities = new Map(); this.lastOwn = null; this.view = null; }

  update(replica, entityId) {
    if (!replica?.game || !Number.isSafeInteger(entityId)) return null;
    const canonical = replica.game;
    const live = new Set();
    const entities = canonical.entities.map(entity => {
      live.add(entity.id);
      let drawn = this.entities.get(entity.id);
      if (!drawn) { drawn = {}; this.entities.set(entity.id, drawn); }
      Object.assign(drawn, entity);
      drawn.player = entity.id === entityId && entity.alive;
      return drawn;
    });
    for (const id of this.entities.keys()) if (!live.has(id) && id !== entityId) this.entities.delete(id);
    const own = live.has(entityId) ? this.entities.get(entityId) : null;
    if (own) this.lastOwn = own;
    if (!this.lastOwn || this.lastOwn.id !== entityId) return null;
    if (!own) { this.lastOwn.alive = false; this.lastOwn.player = false; }
    // Every mutable field on the view belongs to this presentation object.
    // Gameplay always uses replica.game directly through the protocol helpers.
    const view = Object.create(canonical);
    view.player = this.lastOwn;
    view.entities = entities;
    this.view = view;
    return view;
  }

  reset() { this.entities.clear(); this.lastOwn = null; this.view = null; }
}

export class FleetNetworkSession {
  constructor({
    origin = globalThis.location?.origin,
    fetchConfig = (...args) => fetch(...args),
    loadSdk = defaultSdk,
    loadProtocol = defaultProtocol,
    onEvent = () => {},
    onState = () => {},
    onReplica = () => {},
    onWelcome = () => {},
    onResult = () => {},
    onCounts = () => {},
  } = {}) {
    this.origin = origin;
    this.fetchConfig = fetchConfig;
    this.loadSdk = loadSdk;
    this.loadProtocol = loadProtocol;
    this.onEvent = onEvent;
    this.onState = onState;
    this.onReplica = onReplica;
    this.onWelcome = onWelcome;
    this.onResult = onResult;
    this.onCounts = onCounts;
    this.status = 'idle';
    this.entityId = null;
    this.replica = null;
    this.controls = new Map();
    this.filler = new Set();
    this.counts = null;
    this.presentation = new FleetPresentation();
    this.frames = [];
    this.room = null;
    this.protocol = null;
    this.epoch = 0;
    this.sequence = 0;
    this.inputClock = 0;
    this.frameClock = 0;
    this.hidden = false;
    this.awaitingSnapshot = false;
    this.awaitingRespawn = false;
    this.joinPromise = null;
    this.startedAt = null;
    this.lastResult = null;
    this.joinTimer = null;
    this.snapshotTimer = null;
    this.respawnTimer = null;
    this.snapshotAttempts = 0;
    this.focused = true;
  }

  get connected() { return this.status === 'connected'; }
  get queuedFrames() { return this.frames.length; }
  get ownEntity() { return this.replica?.game?.entities.find(entity => entity.id === this.entityId && entity.alive) ?? null; }
  get canControl() { return this.connected && this.focused && !this.hidden && !this.awaitingSnapshot && !this.awaitingRespawn && !this.lastResult && Boolean(this.ownEntity); }
  get view() { return this.presentation.update(this.replica, this.entityId); }
  get survivalSeconds() {
    if (this.lastResult) return this.lastResult.elapsed;
    return this.replica && Number.isSafeInteger(this.startedAt)
      ? Math.max(0, (this.replica.tick - this.startedAt) / 60) : 0;
  }

  setState(status, detail = null) { this.status = status; this.onState(status, detail); }

  async join(nickname) {
    if (this.joinPromise || this.room) return this.joinPromise ?? false;
    const epoch = ++this.epoch;
    this.setState('connecting');
    this.joinTimer = setTimeout(() => this.lost(epoch, { code: 'timeout', message: '연결 시간이 초과됐습니다. 다시 시도해 주세요.' }), 15000);
    this.joinPromise = (async () => {
      let room;
      try {
        const [endpoint, sdk, protocol] = await Promise.all([
          configuredEndpoint(this.fetchConfig, this.origin), this.loadSdk(), this.loadProtocol(),
        ]);
        if (epoch !== this.epoch) return false;
        if (typeof sdk.Client !== 'function' || typeof protocol.restorePublicSnapshot !== 'function' ||
            typeof protocol.stepPublicFrame !== 'function' || protocol.ROOM_PROTOCOL_VERSION !== 1) {
          throw new Error('멀티플레이 버전이 맞지 않습니다.');
        }
        this.protocol = protocol;
        const joining = new sdk.Client(endpoint).joinById(ROOM_ID, { nickname, protocol: protocol.ROOM_PROTOCOL_VERSION });
        joining.then(lateRoom => {
          if (epoch !== this.epoch && (!lateRoom.connection || lateRoom.connection.isOpen === true)) {
            Promise.resolve().then(() => lateRoom.leave()).catch(() => {});
          }
        }).catch(() => {});
        room = await joining;
        if (epoch !== this.epoch) return false;
        clearTimeout(this.joinTimer); this.joinTimer = null;
        // SDK 0.18 reconnects automatically unless explicitly disabled. A lost
        // connection must return to the entry screen, never reclaim this fleet.
        if (room.reconnection) room.reconnection.enabled = false;
        this.room = room;
        // Register synchronously before requesting the initial snapshot.
        room.onMessage('welcome', data => this.receive(epoch, 'welcome', data));
        room.onMessage('snapshot', data => this.receive(epoch, 'snapshot', data));
        room.onMessage('frames', data => this.receive(epoch, 'frames', data));
        room.onMessage('result', data => this.receive(epoch, 'result', data));
        room.onMessage('room-error', data => this.receive(epoch, 'room-error', data));
        room.onMessage('counts', data => this.receive(epoch, 'counts', data));
        room.onLeave?.(() => this.lost(epoch));
        room.onDrop?.(() => this.lost(epoch));
        room.onError?.((code, message) => this.lost(epoch, { code, message }));
        this.setState('connected');
        this.requestSnapshot();
        return true;
      } catch (error) {
        if (epoch !== this.epoch) return false;
        clearTimeout(this.joinTimer); this.joinTimer = null;
    if (room && (!room.connection || room.connection.isOpen === true)) {
      Promise.resolve().then(() => {
        if (!room.connection || room.connection.isOpen === true) return room.leave();
      }).catch(() => {});
    }
        this.room = null;
        this.setState('error', connectionError(error));
        return false;
      } finally {
        if (epoch === this.epoch) this.joinPromise = null;
      }
    })();
    return this.joinPromise;
  }

  receive(epoch, type, data) {
    if (epoch !== this.epoch || !this.room) return;
    try {
      if (type === 'welcome') {
        if (data?.version !== 1 || !Number.isSafeInteger(data.entityId) || !Number.isSafeInteger(data.startedAt)) throw new Error('환영 메시지 오류');
        const changed = this.entityId !== data.entityId;
        this.entityId = data.entityId;
        if (changed) {
          this.awaitingRespawn = false;
          this.sequence = 0;
          this.presentation.reset();
          this.startedAt = data.startedAt;
          this.lastResult = null;
          clearTimeout(this.respawnTimer); this.respawnTimer = null;
        }
        this.onWelcome(data);
      } else if (type === 'snapshot') {
        if (data?.version !== 1 || !Number.isSafeInteger(data.tick)) throw new Error('스냅샷 오류');
        if (!this.awaitingSnapshot && this.replica && data.tick < this.replica.tick) return;
        const restored = this.protocol.restorePublicSnapshot(data, { onEvent: this.onEvent });
        this.replica = restored;
        this.controls = new Map((data.controls || []).map(control => [control.entityId, control.nickname]));
        this.filler = new Set(data.filler || []);
        this.frames.length = 0;
        this.frameClock = 0;
        this.awaitingSnapshot = false;
        this.snapshotAttempts = 0;
        clearTimeout(this.snapshotTimer); this.snapshotTimer = null;
        this.presentation.update(restored, this.entityId);
        this.onReplica(restored);
      } else if (type === 'frames') {
        if (!Array.isArray(data)) throw new Error('프레임 오류');
        if (this.awaitingSnapshot || this.hidden) return;
        if (data.length + this.frames.length > MAX_QUEUED_FRAMES) return this.resync();
        for (const frame of data) {
          const lastTick = this.frames.at(-1)?.tick ?? this.replica?.tick;
          if (!Number.isSafeInteger(frame?.tick) || frame.tick !== lastTick + 1) return this.resync();
          this.frames.push(frame);
        }
      } else if (type === 'result') {
        if (data?.entityId !== this.entityId) return;
        this.awaitingRespawn = false;
        clearTimeout(this.respawnTimer); this.respawnTimer = null;
        this.lastResult = data;
        this.sendNeutral();
        this.onResult(data);
      } else if (type === 'room-error') {
        const wasRespawning = this.awaitingRespawn;
        this.awaitingRespawn = false;
        clearTimeout(this.respawnTimer); this.respawnTimer = null;
        this.onState(this.status, { ...data, respawn: wasRespawning });
      } else if (type === 'counts') {
        this.counts = data;
        this.onCounts(data);
      }
    } catch {
      this.resync();
    }
  }

  update(dt) {
    if (!this.connected || !this.replica || this.awaitingSnapshot || this.hidden) return 0;
    // Time spent waiting for the next packet cannot become simulation time.
    if (!this.frames.length) { this.frameClock = 0; return 0; }
    this.frameClock = Math.min(this.frameClock + Math.max(0, dt), 1 / 10);
    let advanced = 0;
    // Catch up a bounded number of confirmed frames after a render stall.
    while ((this.frameClock >= 1 / 60 || this.frames.length > 3) && this.frames.length && advanced < 6) {
      const frame = this.frames.shift();
      try {
        if (frame.tick !== this.replica.tick + 1) throw new Error('프레임 누락');
        const verified = this.protocol.stepPublicFrame(this.replica, frame);
        // The protocol helper owns hash verification. Fingerprints are uint32.
        if (verified === false) throw new Error('상태 불일치');
      } catch { this.resync(); break; }
      this.frameClock = Math.max(0, this.frameClock - 1 / 60);
      advanced++;
    }
    if (!this.frames.length) this.frameClock = 0;
    if (advanced) {
      this.presentation.update(this.replica, this.entityId);
      this.onReplica(this.replica);
    }
    return advanced;
  }

  sendInput(input, dt) {
    if (!this.canControl) return false;
    this.inputClock += Math.max(0, dt);
    if (this.inputClock < INPUT_INTERVAL) return false;
    this.inputClock %= INPUT_INTERVAL;
    const safe = {
      dx: Number.isFinite(input?.dx) ? input.dx : 0,
      dy: Number.isFinite(input?.dy) ? input.dy : 0,
      boost: Boolean(input?.boost), gather: Boolean(input?.gather),
      ...(Number.isFinite(input?.targetX) && Number.isFinite(input?.targetY)
        ? { targetX: input.targetX, targetY: input.targetY } : {}),
    };
    this.room.send('input', { sequence: ++this.sequence, input: safe });
    return true;
  }

  sendNeutral() {
    if (!this.connected || !this.room || !this.ownEntity || this.lastResult) return;
    this.room.send('input', { sequence: ++this.sequence, input: NEUTRAL_INPUT });
    this.inputClock = 0;
  }

  setHidden(hidden) {
    if (this.hidden === Boolean(hidden)) return;
    if (hidden) this.sendNeutral();
    this.hidden = Boolean(hidden);
    this.frames.length = 0;
    this.frameClock = 0;
    if (this.hidden) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
    else this.resync(true);
  }

  setFocused(focused) {
    if (this.focused === Boolean(focused)) return;
    if (!focused) this.sendNeutral();
    this.focused = Boolean(focused);
    if (focused && !this.hidden) this.resync(true);
  }

  requestSnapshot() {
    if (!this.connected || !this.room || this.hidden) return;
    this.awaitingSnapshot = true;
    this.frames.length = 0;
    this.frameClock = 0;
    this.room.send('resync', {});
    clearTimeout(this.snapshotTimer);
    const epoch = this.epoch;
    this.snapshotTimer = setTimeout(() => {
      if (epoch !== this.epoch || !this.awaitingSnapshot || this.hidden) return;
      if (++this.snapshotAttempts >= 4) {
        this.lost(epoch, { code: 'sync-timeout', message: '전장 정보를 받지 못했습니다. 다시 입장해 주세요.' });
      } else this.requestSnapshot();
    }, 1800);
  }

  resync(force = false) {
    if (!this.connected || !this.room || (this.awaitingSnapshot && !force)) return;
    this.sendNeutral();
    this.snapshotAttempts = 0;
    this.requestSnapshot();
  }

  respawn() {
    if (!this.connected || !this.room || this.awaitingRespawn || !this.lastResult) return false;
    this.awaitingRespawn = true;
    this.room.send('respawn', {});
    const epoch = this.epoch;
    clearTimeout(this.respawnTimer);
    this.respawnTimer = setTimeout(() => {
      if (epoch !== this.epoch || !this.awaitingRespawn) return;
      this.awaitingRespawn = false;
      this.onState(this.status, { code: 'respawn-timeout', respawn: true, message: '출격 응답이 늦어지고 있습니다. 다시 시도해 주세요.' });
    }, 5000);
    return true;
  }

  lost(epoch, detail = null) {
    if (epoch !== this.epoch) return;
    ++this.epoch;
    clearTimeout(this.joinTimer); clearTimeout(this.snapshotTimer); clearTimeout(this.respawnTimer);
    this.joinTimer = this.snapshotTimer = this.respawnTimer = null;
    const room = this.room;
    this.room = null;
    this.joinPromise = null;
    this.frames.length = 0;
    this.awaitingSnapshot = false;
    this.awaitingRespawn = false;
    this.entityId = null;
    if (room && (!room.connection || room.connection.isOpen === true)) {
      Promise.resolve().then(() => {
        if (!room.connection || room.connection.isOpen === true) return room.leave();
      }).catch(() => {});
    }
    this.setState('disconnected', detail ?? { message: '연결이 끊겼습니다. 다시 입장하면 새 편대로 시작합니다.' });
  }

  async disconnect() {
    ++this.epoch;
    clearTimeout(this.joinTimer); clearTimeout(this.snapshotTimer); clearTimeout(this.respawnTimer);
    this.joinTimer = this.snapshotTimer = this.respawnTimer = null;
    const room = this.room;
    this.room = null;
    this.joinPromise = null;
    this.entityId = null;
    this.startedAt = null;
    this.lastResult = null;
    this.replica = null;
    this.frames.length = 0;
    this.controls.clear();
    this.filler.clear();
    this.presentation.reset();
    this.awaitingSnapshot = false;
    this.awaitingRespawn = false;
    this.setState('idle');
    if (room && (!room.connection || room.connection.isOpen === true)) {
      try { await room.leave(); } catch { /* Already disconnected. */ }
    }
  }
}
