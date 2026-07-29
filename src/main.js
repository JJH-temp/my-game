import Phaser from 'phaser';

/* ==========================================================================
 * 1v1 조준 격투 — Phaser 3 (단일 파일)
 *
 *  조작
 *    우클릭           그 지점으로 이동 (누른 채 끌면 목적지가 따라옴)
 *    방향키           보조 이동 — 누르면 이동 명령이 취소됨
 *    Q W E R         스킬 장전 (같은 키를 다시 누르면 취소)
 *    마우스           조준 — 장전 중에는 사거리와 적중 범위가 표시됨
 *    좌클릭           발사
 *    ESC              장전 취소
 *    1 2 3           AI 난이도
 *    SPACE           재시작
 *
 *  AI도 플레이어와 완전히 같은 스킬과 쿨다운을 쓰고, 시전 전에
 *  같은 방식으로 예고선을 그립니다. 예고를 보고 피하는 것이 핵심입니다.
 * ========================================================================== */

const VIEW = { W: 960, H: 600 };

/* ── 팔레트 ─────────────────────────────────────────────────────────── */
const C = {
  void:   0x0e111a,
  floor:  0x161b27,
  grid:   0x1f2637,
  rim:    0x39445e,
  bone:   0xe8e3d9,
  dim:    0x7d8598,
  player: 0x4ecb8f,  // 옥색
  enemy:  0xe0574a,  // 주색
  gold:   0xd9a441,
};

/* ── 스킬 정의 ───────────────────────────────────────────────────────
 * 여기 숫자만 바꾸면 밸런스가 전부 조정됩니다.
 * ------------------------------------------------------------------ */
const SKILLS = {
  Q: {
    name: '탄환', kind: 'bolt', cd: 700, dmg: 10,
    speed: 640, size: 8, range: 760, hue: 0xffb347,
    desc: '직선 투사체',
  },
  W: {
    name: '질주', kind: 'dash', cd: 2400, dmg: 0,
    speed: 980, dur: 170, range: 220, hue: 0x8ad7ff,
    desc: '무적 돌진',
  },
  E: {
    name: '파쇄', kind: 'cone', cd: 2000, dmg: 20,
    range: 165, arc: 62, knock: 420, hue: 0xff7ab0,
    desc: '근거리 부채꼴 · 밀쳐냄',
  },
  R: {
    name: '낙성', kind: 'meteor', cd: 7500, dmg: 32,
    range: 430, size: 88, delay: 800, hue: 0xba7cff,
    desc: '지연 폭발 · 광역',
  },
};

const DIFFICULTY = {
  1: { label: '연습', react: 520, jitter: 0.24, dodge: 0.25, aggro: 0.50, lead: 0.55 },
  2: { label: '호각', react: 330, jitter: 0.12, dodge: 0.60, aggro: 0.78, lead: 0.85 },
  3: { label: '사투', react: 210, jitter: 0.05, dodge: 0.88, aggro: 1.00, lead: 1.00 },
};

const KEY_ORDER = ['Q', 'W', 'E', 'R'];
const FONT = '"Pretendard", "Noto Sans KR", system-ui, sans-serif';

/* ========================================================================== */
/*  전투 유닛                                                                  */
/* ========================================================================== */
class Fighter {
  constructor(scene, x, y, color, label) {
    this.scene = scene;
    this.label = label;
    this.color = color;

    this.maxHp = 100;
    this.hp = 100;
    this.radius = 17;
    this.speed = 245;
    this.alive = true;

    this.go = scene.add.circle(x, y, this.radius, color);
    this.go.setStrokeStyle(2, C.void, 0.85);
    this.go.setDepth(10);
    scene.physics.add.existing(this.go);

    this.body = this.go.body;
    this.body.setCircle(this.radius);
    this.body.setCollideWorldBounds(true);

    this.cd = { Q: 0, W: 0, E: 0, R: 0 };
    this.invulnUntil = 0;
    this.lockUntil = 0;   // 돌진·경직 중 이동 입력 무시
    this.facing = 0;
    this.moveTarget = null;   // { x, y } — 우클릭 이동 목적지
  }

  get x() { return this.go.x; }
  get y() { return this.go.y; }

  ready(key, t) { return this.alive && t >= this.cd[key]; }
  cdLeft(key, t) { return Math.max(0, this.cd[key] - t); }

  /** 방향 벡터로 이동. 돌진·경직 중에는 무시된다. */
  drive(dx, dy, t) {
    if (!this.alive) { this.body.setVelocity(0, 0); return; }
    if (t < this.lockUntil) return;

    if (dx === 0 && dy === 0) { this.body.setVelocity(0, 0); return; }
    const len = Math.hypot(dx, dy);
    this.body.setVelocity((dx / len) * this.speed, (dy / len) * this.speed);
  }

  /** 이동 목적지 지정. 아레나 밖은 안쪽으로 당겨서 벽에 끼는 것을 막는다. */
  setMoveTarget(x, y) {
    if (!this.alive) return;
    const pad = this.radius + 2;
    this.moveTarget = {
      x: Phaser.Math.Clamp(x, pad, VIEW.W - pad),
      y: Phaser.Math.Clamp(y, pad, VIEW.H - pad),
    };
  }

  /** 목적지를 향해 일정 속도로 이동. 도착하면 멈춘다. */
  seek(t) {
    if (!this.alive) { this.body.setVelocity(0, 0); return; }
    if (t < this.lockUntil) return;          // 돌진·경직 중에는 관성 유지
    if (!this.moveTarget) { this.body.setVelocity(0, 0); return; }

    const dx = this.moveTarget.x - this.x;
    const dy = this.moveTarget.y - this.y;
    const d = Math.hypot(dx, dy);

    if (d < 8) {                              // 도착
      this.moveTarget = null;
      this.body.setVelocity(0, 0);
      return;
    }
    this.body.setVelocity((dx / d) * this.speed, (dy / d) * this.speed);
  }

  /** 피격. 실제로 들어갔으면 true */
  takeHit(dmg, t, src = null, knock = 0) {
    if (!this.alive || t < this.invulnUntil) return false;

    this.hp = Math.max(0, this.hp - dmg);
    this.scene.popText(this.x, this.y - 26, `-${dmg}`, this.color);

    // 피격 섬광
    this.go.setFillStyle(C.bone);
    this.scene.time.delayedCall(70, () => {
      if (this.go.active) this.go.setFillStyle(this.color);
    });

    if (src && knock > 0) {
      const a = Phaser.Math.Angle.Between(src.x, src.y, this.x, this.y);
      this.body.setVelocity(Math.cos(a) * knock, Math.sin(a) * knock);
      this.lockUntil = t + 200;
    }

    if (this.hp <= 0) this.die();
    return true;
  }

  die() {
    this.alive = false;
    this.moveTarget = null;
    this.body.setVelocity(0, 0);
    this.go.setFillStyle(C.dim);
    this.scene.burst(this.x, this.y, this.color, 26);
  }
}

/* ========================================================================== */
/*  AI 조종기                                                                  */
/*  - 선호 거리를 유지하며 스트레이핑                                            */
/*  - 날아오는 투사체의 최근접 시점을 계산해 회피                                 */
/*  - 시전 전 예고 시간을 반드시 갖는다 (플레이어와 동일 규칙)                     */
/* ========================================================================== */
class AI {
  constructor(scene, self, foe, level = 2) {
    this.scene = scene;
    this.self = self;
    this.foe = foe;
    this.setLevel(level);

    this.nextDecision = 0;
    this.strafeDir = 1;
    this.nextStrafeFlip = 0;
    this.desiredRange = 300;
    this.cast = null;      // { key, fireAt, aim:{x,y} }
    this.evadeUntil = 0;
    this.evadeVec = { x: 0, y: 0 };
  }

  setLevel(level) {
    this.level = level;
    this.p = DIFFICULTY[level];
  }

  update(t) {
    const me = this.self, foe = this.foe;
    if (!me.alive || !foe.alive) { me.drive(0, 0, t); return; }

    const dist = Phaser.Math.Distance.Between(me.x, me.y, foe.x, foe.y);

    this.evaluateThreats(t);

    // ── 시전 예고가 끝났으면 발사 ──
    if (this.cast && t >= this.cast.fireAt) {
      this.scene.cast(me, this.cast.key, this.cast.aim.x, this.cast.aim.y);
      this.cast = null;
      this.nextDecision = t + this.p.react;
    }

    // ── 새 행동 결정 ──
    if (!this.cast && t >= this.nextDecision) {
      this.decide(t, dist);
      this.nextDecision = t + this.p.react;
    }

    this.moveStep(t, dist);
  }

  /** 날아오는 적 투사체 중 곧 맞을 것이 있는지 검사 */
  evaluateThreats(t) {
    if (t < this.evadeUntil) return;
    const me = this.self;

    for (const p of this.scene.bolts) {
      if (p.owner === me) continue;

      const rx = p.go.x - me.x, ry = p.go.y - me.y;
      const vx = p.go.body.velocity.x, vy = p.go.body.velocity.y;
      const vv = vx * vx + vy * vy;
      if (vv < 1) continue;

      const tc = -(rx * vx + ry * vy) / vv;          // 최근접까지 걸리는 시간(초)
      if (tc < 0 || tc > 0.55) continue;

      const mx = rx + vx * tc, my = ry + vy * tc;    // 최근접 시 거리 벡터
      const miss = Math.hypot(mx, my);
      if (miss > me.radius + p.size + 10) continue;

      if (Math.random() > this.p.dodge) continue;

      // 진행 방향의 수직으로 회피
      const nx = -vy / Math.sqrt(vv), ny = vx / Math.sqrt(vv);
      const side = (rx * ny - ry * nx) > 0 ? 1 : -1;
      this.evadeVec = { x: nx * side, y: ny * side };
      this.evadeUntil = t + 320;

      // 여유가 있으면 질주로 회피
      if (me.ready('W', t) && Math.random() < this.p.dodge * 0.55) {
        const ax = me.x + this.evadeVec.x * 200;
        const ay = me.y + this.evadeVec.y * 200;
        this.scene.cast(me, 'W', ax, ay);
      }
      return;
    }
  }

  decide(t, dist) {
    const me = this.self, foe = this.foe;
    if (Math.random() > this.p.aggro) return;

    // 상황에 맞는 스킬 우선순위
    const wants = [];
    if (dist < SKILLS.E.range * 0.85 && me.ready('E', t)) wants.push('E');
    if (dist > 140 && dist < SKILLS.Q.range && me.ready('Q', t)) wants.push('Q');
    if (dist < SKILLS.R.range && me.ready('R', t)) wants.push('R');
    if (dist > 340 && me.ready('W', t) && Math.random() < 0.35) wants.push('W');

    if (wants.length === 0) {
      // 아무것도 못 쓰면 거리 조절만
      this.desiredRange = dist < 150 ? 300 : Phaser.Math.Between(200, 360);
      return;
    }

    const key = Phaser.Utils.Array.GetRandom(wants);
    const sk = SKILLS[key];

    let aim = this.aimAt(key, sk);

    // 예고 시간 — 난이도가 낮을수록 길게 (반응할 여유를 준다)
    const windup = key === 'R' ? 420 : key === 'E' ? 260 : 300;
    this.cast = { key, fireAt: t + windup * (this.level === 3 ? 0.75 : 1), aim };

    this.desiredRange =
      key === 'E' ? 110 :
      key === 'Q' ? 300 :
      key === 'R' ? 260 : 240;
  }

  /** 예측 조준 + 난이도별 흔들림 */
  aimAt(key, sk) {
    const me = this.self, foe = this.foe;
    let tx = foe.x, ty = foe.y;

    if (sk.kind === 'bolt' || sk.kind === 'meteor') {
      const travel = sk.kind === 'bolt'
        ? Phaser.Math.Distance.Between(me.x, me.y, foe.x, foe.y) / sk.speed
        : sk.delay / 1000;
      tx += foe.body.velocity.x * travel * this.p.lead;
      ty += foe.body.velocity.y * travel * this.p.lead;
    }

    const a = Phaser.Math.Angle.Between(me.x, me.y, tx, ty)
            + Phaser.Math.FloatBetween(-this.p.jitter, this.p.jitter);
    const d = Phaser.Math.Distance.Between(me.x, me.y, tx, ty);

    return { x: me.x + Math.cos(a) * d, y: me.y + Math.sin(a) * d };
  }

  moveStep(t, dist) {
    const me = this.self, foe = this.foe;

    if (t < this.evadeUntil) {
      me.drive(this.evadeVec.x, this.evadeVec.y, t);
      return;
    }

    if (t > this.nextStrafeFlip) {
      this.strafeDir *= -1;
      this.nextStrafeFlip = t + Phaser.Math.Between(700, 1500);
    }

    const toFoe = Phaser.Math.Angle.Between(me.x, me.y, foe.x, foe.y);
    if (!this.cast) me.facing = toFoe;   // 시전 중이 아니면 항상 상대를 본다
    const gap = dist - this.desiredRange;

    // 거리 오차만큼 접근/후퇴 + 항상 약간의 횡이동
    const radial = Phaser.Math.Clamp(gap / 120, -1, 1);
    const rx = Math.cos(toFoe) * radial;
    const ry = Math.sin(toFoe) * radial;
    const sx = Math.cos(toFoe + Math.PI / 2) * this.strafeDir * 0.85;
    const sy = Math.sin(toFoe + Math.PI / 2) * this.strafeDir * 0.85;

    // 시전 예고 중에는 발이 느려진다 (플레이어가 파고들 틈)
    const slow = this.cast ? 0.35 : 1;
    me.drive((rx + sx) * slow, (ry + sy) * slow, t);
  }
}

/* ========================================================================== */
/*  아레나 씬                                                                  */
/* ========================================================================== */
class Arena extends Phaser.Scene {
  constructor() { super('Arena'); }

  create() {
    const { W, H } = VIEW;

    this.difficulty = this.registry.get('difficulty') || 2;
    this.over = false;
    this.armed = null;
    this.bolts = [];
    this.meteors = [];

    this.drawFloor();

    // 레이어 (아래에서 위 순서)
    this.gTelegraph = this.add.graphics().setDepth(5);
    this.gEffect = this.add.graphics().setDepth(20);
    this.gHud = this.add.graphics().setDepth(30);

    this.player = new Fighter(this, 190, H / 2, C.player, '나');
    this.enemy = new Fighter(this, W - 190, H / 2, C.enemy, 'AI');
    this.ai = new AI(this, this.enemy, this.player, this.difficulty);

    this.bindInput();
    this.buildHud();
  }

  /* ── 배경 ─────────────────────────────────────────────────────────── */
  drawFloor() {
    const { W, H } = VIEW;
    const g = this.add.graphics().setDepth(0);

    g.fillStyle(C.floor, 1).fillRect(0, 0, W, H);
    g.lineStyle(1, C.grid, 0.55);
    for (let x = 40; x < W; x += 40) g.lineBetween(x, 0, x, H);
    for (let y = 40; y < H; y += 40) g.lineBetween(0, y, W, y);

    // 중앙 원 — 시선의 기준점
    g.lineStyle(1, C.rim, 0.5).strokeCircle(W / 2, H / 2, 120);
    g.lineStyle(2, C.rim, 0.8).strokeRect(1, 1, W - 2, H - 2);
  }

  /* ── 입력 ─────────────────────────────────────────────────────────── */
  bindInput() {
    this.cursors = this.input.keyboard.createCursorKeys();
    this.input.mouse.disableContextMenu();

    for (const k of ['Q', 'W', 'E', 'R']) {
      this.input.keyboard.on(`keydown-${k}`, () => this.armSkill(k));
    }
    this.input.keyboard.on('keydown-ESC', () => { this.armed = null; });
    this.input.keyboard.on('keydown-SPACE', () => {
      if (this.over) this.scene.restart();
    });
    for (const [key, lv] of [['ONE', 1], ['TWO', 2], ['THREE', 3]]) {
      this.input.keyboard.on(`keydown-${key}`, () => {
        this.difficulty = lv;
        this.registry.set('difficulty', lv);
        this.ai.setLevel(lv);
        this.popText(VIEW.W / 2, 70, `난이도 · ${DIFFICULTY[lv].label}`, C.gold);
      });
    }

    this.input.on('pointerdown', (p) => {
      if (this.over || !this.player.alive) return;

      // 우클릭 — 이동 명령
      if (p.rightButtonDown()) {
        this.player.setMoveTarget(p.worldX, p.worldY);
        this.pingMove(this.player.moveTarget.x, this.player.moveTarget.y);
        return;
      }

      // 좌클릭 — 장전된 스킬 발사
      if (!this.armed) return;
      this.cast(this.player, this.armed, p.worldX, p.worldY);
      this.armed = null;
    });
  }

  armSkill(key) {
    if (this.over || !this.player.alive) return;
    if (!this.player.ready(key, this.time.now)) {
      this.popText(this.player.x, this.player.y - 34, '쿨다운', C.dim);
      return;
    }
    this.armed = this.armed === key ? null : key;
  }

  /* ── 시전 ─────────────────────────────────────────────────────────── */
  cast(who, key, aimX, aimY) {
    const t = this.time.now;
    if (!who.ready(key, t)) return;

    const sk = SKILLS[key];
    who.cd[key] = t + sk.cd;
    const angle = Phaser.Math.Angle.Between(who.x, who.y, aimX, aimY);
    who.facing = angle;

    if (sk.kind === 'bolt') this.fireBolt(who, sk, angle);
    else if (sk.kind === 'dash') this.fireDash(who, sk, angle, t);
    else if (sk.kind === 'cone') this.fireCone(who, sk, angle, t);
    else if (sk.kind === 'meteor') this.fireMeteor(who, sk, aimX, aimY, t);
  }

  fireBolt(who, sk, angle) {
    const ox = who.x + Math.cos(angle) * (who.radius + sk.size + 2);
    const oy = who.y + Math.sin(angle) * (who.radius + sk.size + 2);

    const go = this.add.circle(ox, oy, sk.size, sk.hue).setDepth(15);
    go.setStrokeStyle(2, who.color, 0.9);
    this.physics.add.existing(go);
    go.body.setCircle(sk.size);
    this.physics.velocityFromRotation(angle, sk.speed, go.body.velocity);

    this.bolts.push({
      go, owner: who, dmg: sk.dmg, size: sk.size,
      dieAt: this.time.now + (sk.range / sk.speed) * 1000,
    });
  }

  fireDash(who, sk, angle, t) {
    who.moveTarget = null;   // 돌진 후 옛 목적지로 되돌아가지 않도록
    who.body.setVelocity(Math.cos(angle) * sk.speed, Math.sin(angle) * sk.speed);
    who.lockUntil = t + sk.dur;
    who.invulnUntil = t + sk.dur + 60;

    // 잔상
    for (let i = 0; i < 5; i++) {
      this.time.delayedCall(i * 28, () => {
        if (!who.go.active) return;
        const gh = this.add.circle(who.x, who.y, who.radius * 0.9, who.color, 0.28).setDepth(9);
        this.tweens.add({ targets: gh, alpha: 0, scale: 0.6, duration: 260, onComplete: () => gh.destroy() });
      });
    }
  }

  fireCone(who, sk, angle, t) {
    const foe = who === this.player ? this.enemy : this.player;
    const half = Phaser.Math.DegToRad(sk.arc) / 2;

    // 시각 효과
    const g = this.add.graphics().setDepth(18);
    g.fillStyle(sk.hue, 0.42);
    g.beginPath();
    g.slice(who.x, who.y, sk.range, angle - half, angle + half, false);
    g.fillPath();
    this.tweens.add({ targets: g, alpha: 0, duration: 260, onComplete: () => g.destroy() });
    this.cameras.main.shake(90, 0.004);

    // 판정
    const d = Phaser.Math.Distance.Between(who.x, who.y, foe.x, foe.y);
    if (d > sk.range + foe.radius) return;
    const toFoe = Phaser.Math.Angle.Between(who.x, who.y, foe.x, foe.y);
    if (Math.abs(Phaser.Math.Angle.Wrap(toFoe - angle)) > half) return;

    foe.takeHit(sk.dmg, t, who, sk.knock);
  }

  fireMeteor(who, sk, aimX, aimY, t) {
    // 사거리 밖이면 최대 사거리 지점으로 당김
    const a = Phaser.Math.Angle.Between(who.x, who.y, aimX, aimY);
    const d = Math.min(Phaser.Math.Distance.Between(who.x, who.y, aimX, aimY), sk.range);
    const tx = who.x + Math.cos(a) * d;
    const ty = who.y + Math.sin(a) * d;

    this.meteors.push({
      x: tx, y: ty, owner: who, sk,
      landAt: t + sk.delay, startAt: t,
    });
  }

  detonate(m) {
    const t = this.time.now;
    const foe = m.owner === this.player ? this.enemy : this.player;

    const g = this.add.graphics().setDepth(19);
    g.fillStyle(m.sk.hue, 0.5).fillCircle(m.x, m.y, m.sk.size);
    g.lineStyle(3, C.bone, 0.9).strokeCircle(m.x, m.y, m.sk.size);
    this.tweens.add({ targets: g, alpha: 0, duration: 340, onComplete: () => g.destroy() });

    this.burst(m.x, m.y, m.sk.hue, 18);
    this.cameras.main.shake(180, 0.011);

    if (Phaser.Math.Distance.Between(m.x, m.y, foe.x, foe.y) < m.sk.size + foe.radius) {
      foe.takeHit(m.sk.dmg, t, { x: m.x, y: m.y }, 260);
    }
  }

  /* ── 루프 ─────────────────────────────────────────────────────────── */
  update(t) {
    if (this.over) return;

    this.stepPlayer(t);
    this.ai.update(t);
    this.stepBolts(t);
    this.stepMeteors(t);

    this.drawTelegraphs(t);
    this.drawHud(t);
    this.checkEnd();
  }

  stepPlayer(t) {
    const p = this.player;
    if (!p.alive) return;

    const ptr = this.input.activePointer;

    // 우클릭을 누른 채 끌면 목적지가 커서를 따라온다
    if (ptr.rightButtonDown()) p.setMoveTarget(ptr.worldX, ptr.worldY);

    // 방향키는 보조 수단 — 누르는 순간 이동 명령을 덮어쓴다
    let dx = 0, dy = 0;
    if (this.cursors.left.isDown) dx -= 1;
    if (this.cursors.right.isDown) dx += 1;
    if (this.cursors.up.isDown) dy -= 1;
    if (this.cursors.down.isDown) dy += 1;

    if (dx !== 0 || dy !== 0) {
      p.moveTarget = null;
      p.drive(dx, dy, t);
    } else {
      p.seek(t);
    }

    // 시선은 항상 커서를 향한다 (이동 방향과 분리)
    p.facing = Phaser.Math.Angle.Between(p.x, p.y, ptr.worldX, ptr.worldY);

    if (this.armed && !p.ready(this.armed, t)) this.armed = null;
  }

  stepBolts(t) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const foe = b.owner === this.player ? this.enemy : this.player;

      const out = b.go.x < -30 || b.go.x > VIEW.W + 30 || b.go.y < -30 || b.go.y > VIEW.H + 30;
      const hit = foe.alive &&
        Phaser.Math.Distance.Between(b.go.x, b.go.y, foe.x, foe.y) < b.size + foe.radius;

      if (hit) {
        if (foe.takeHit(b.dmg, t, b.owner, 90)) this.burst(b.go.x, b.go.y, b.go.fillColor, 8);
      }
      if (hit || out || t > b.dieAt) {
        b.go.destroy();
        this.bolts.splice(i, 1);
      }
    }
  }

  stepMeteors(t) {
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      if (t >= this.meteors[i].landAt) {
        this.detonate(this.meteors[i]);
        this.meteors.splice(i, 1);
      }
    }
  }

  /* ── 조준·예고 표시 ────────────────────────────────────────────────── */
  drawTelegraphs(t) {
    const g = this.gTelegraph;
    g.clear();

    // 플레이어 장전 미리보기
    if (this.armed && this.player.alive) {
      const ptr = this.input.activePointer;
      this.drawAim(g, this.player, this.armed, ptr.worldX, ptr.worldY, C.player, 0.5);
    }

    // AI 시전 예고 — 남은 시간에 따라 선이 진해진다
    if (this.ai.cast) {
      const c = this.ai.cast;
      const left = Math.max(0, c.fireAt - t);
      const urgency = Phaser.Math.Clamp(1 - left / 400, 0.25, 1);
      this.enemy.facing = Phaser.Math.Angle.Between(this.enemy.x, this.enemy.y, c.aim.x, c.aim.y);
      this.drawAim(g, this.enemy, c.key, c.aim.x, c.aim.y, C.enemy, 0.35 + urgency * 0.5);
    }

    // 낙성 착탄 예고 — 원이 차오른다
    for (const m of this.meteors) {
      const prog = Phaser.Math.Clamp((t - m.startAt) / (m.landAt - m.startAt), 0, 1);
      const col = m.owner === this.player ? C.player : C.enemy;
      g.lineStyle(2, col, 0.8);
      g.strokeCircle(m.x, m.y, m.sk.size);
      g.fillStyle(m.sk.hue, 0.14 + prog * 0.3);
      g.fillCircle(m.x, m.y, m.sk.size * prog);
    }

    // 이동 목적지 표시
    const mt = this.player.moveTarget;
    if (mt) {
      g.lineStyle(1.5, C.player, 0.55);
      g.strokeCircle(mt.x, mt.y, 9);
      g.lineStyle(1, C.player, 0.25);
      g.lineBetween(this.player.x, this.player.y, mt.x, mt.y);
    }

    // 유닛 시선 표시
    for (const f of [this.player, this.enemy]) {
      if (!f.alive) continue;
      g.lineStyle(3, f.color, 0.9);
      g.lineBetween(
        f.x + Math.cos(f.facing) * (f.radius - 2),
        f.y + Math.sin(f.facing) * (f.radius - 2),
        f.x + Math.cos(f.facing) * (f.radius + 11),
        f.y + Math.sin(f.facing) * (f.radius + 11),
      );
    }
  }

  /** 스킬 종류별 조준 도형 */
  drawAim(g, who, key, ax, ay, color, alpha) {
    const sk = SKILLS[key];
    const angle = Phaser.Math.Angle.Between(who.x, who.y, ax, ay);

    if (sk.kind === 'bolt') {
      const ex = who.x + Math.cos(angle) * sk.range;
      const ey = who.y + Math.sin(angle) * sk.range;
      g.lineStyle(2, color, alpha);
      g.lineBetween(who.x, who.y, ex, ey);
      g.fillStyle(sk.hue, alpha * 0.9);
      g.fillCircle(ex, ey, 5);

    } else if (sk.kind === 'dash') {
      const d = Math.min(Phaser.Math.Distance.Between(who.x, who.y, ax, ay), sk.range);
      const ex = who.x + Math.cos(angle) * d;
      const ey = who.y + Math.sin(angle) * d;
      g.lineStyle(6, color, alpha * 0.45);
      g.lineBetween(who.x, who.y, ex, ey);
      g.lineStyle(2, color, alpha);
      g.strokeCircle(ex, ey, who.radius);

    } else if (sk.kind === 'cone') {
      const half = Phaser.Math.DegToRad(sk.arc) / 2;
      g.fillStyle(sk.hue, alpha * 0.32);
      g.beginPath();
      g.slice(who.x, who.y, sk.range, angle - half, angle + half, false);
      g.fillPath();
      g.lineStyle(1.5, color, alpha * 0.9);
      g.beginPath();
      g.slice(who.x, who.y, sk.range, angle - half, angle + half, false);
      g.strokePath();

    } else if (sk.kind === 'meteor') {
      const d = Math.min(Phaser.Math.Distance.Between(who.x, who.y, ax, ay), sk.range);
      const ex = who.x + Math.cos(angle) * d;
      const ey = who.y + Math.sin(angle) * d;
      g.lineStyle(1, color, alpha * 0.5);
      g.strokeCircle(who.x, who.y, sk.range);
      g.lineStyle(2, color, alpha);
      g.strokeCircle(ex, ey, sk.size);
      g.lineBetween(ex - 12, ey, ex + 12, ey);
      g.lineBetween(ex, ey - 12, ex, ey + 12);
    }
  }

  /* ── HUD ──────────────────────────────────────────────────────────── */
  buildHud() {
    const mk = (x, y, txt, size, color, origin = 0) =>
      this.add.text(x, y, txt, {
        fontFamily: FONT, fontSize: `${size}px`,
        color: Phaser.Display.Color.IntegerToColor(color).rgba,
      }).setOrigin(origin, 0).setDepth(31);

    mk(28, 22, '나', 13, C.player);
    mk(VIEW.W - 28, 22, 'AI', 13, C.enemy, 1);

    this.txtHint = mk(VIEW.W / 2, 22, '', 12, C.dim, 0.5);

    this.slotTexts = {};
    const bx = VIEW.W / 2 - (4 * 96) / 2;
    KEY_ORDER.forEach((k, i) => {
      const x = bx + i * 96;
      this.slotTexts[k] = {
        key: mk(x + 12, VIEW.H - 62, k, 16, C.bone),
        name: mk(x + 34, VIEW.H - 60, SKILLS[k].name, 13, C.dim),
        cd: mk(x + 34, VIEW.H - 43, '', 11, C.gold),
      };
    });

    this.txtEnd = this.add.text(VIEW.W / 2, VIEW.H / 2, '', {
      fontFamily: FONT, fontSize: '38px', color: '#e8e3d9', align: 'center',
    }).setOrigin(0.5).setDepth(40);
  }

  drawHud(t) {
    const g = this.gHud;
    g.clear();

    // 체력 막대
    this.hpBar(g, 28, 42, 300, this.player, false);
    this.hpBar(g, VIEW.W - 28, 42, 300, this.enemy, true);

    // 스킬 슬롯
    const bx = VIEW.W / 2 - (4 * 96) / 2;
    KEY_ORDER.forEach((k, i) => {
      const x = bx + i * 96, y = VIEW.H - 68, w = 88, h = 44;
      const left = this.player.cdLeft(k, t);
      const ratio = left / SKILLS[k].cd;
      const isArmed = this.armed === k;

      g.fillStyle(C.void, 0.55).fillRect(x, y, w, h);
      if (ratio > 0) g.fillStyle(C.dim, 0.22).fillRect(x, y, w, h * ratio);
      g.lineStyle(isArmed ? 2 : 1, isArmed ? C.gold : C.rim, isArmed ? 1 : 0.7);
      g.strokeRect(x, y, w, h);

      const st = this.slotTexts[k];
      st.cd.setText(left > 0 ? (left / 1000).toFixed(1) : '준비');
      st.cd.setColor(left > 0 ? '#7d8598' : '#d9a441');
    });

    this.txtHint.setText(
      this.armed
        ? `${SKILLS[this.armed].name} — 좌클릭 발사 · ESC 취소`
        : `우클릭 이동 · Q W E R 장전 · 좌클릭 발사    |    난이도 ${this.difficulty} · ${DIFFICULTY[this.difficulty].label}  (1 2 3)`
    );
  }

  hpBar(g, x, y, w, f, flip) {
    const h = 14;
    const x0 = flip ? x - w : x;
    const ratio = f.hp / f.maxHp;

    g.fillStyle(C.void, 0.6).fillRect(x0, y, w, h);
    const fw = w * ratio;
    g.fillStyle(f.color, 0.92).fillRect(flip ? x - fw : x0, y, fw, h);
    g.lineStyle(1, C.rim, 0.8).strokeRect(x0, y, w, h);
  }

  /* ── 소품 ─────────────────────────────────────────────────────────── */
  popText(x, y, msg, color) {
    const t = this.add.text(x, y, msg, {
      fontFamily: FONT, fontSize: '15px',
      color: Phaser.Display.Color.IntegerToColor(color).rgba,
    }).setOrigin(0.5).setDepth(35);
    this.tweens.add({ targets: t, y: y - 26, alpha: 0, duration: 620, onComplete: () => t.destroy() });
  }

  /** 우클릭 지점에 퍼지는 링 */
  pingMove(x, y) {
    const r = this.add.circle(x, y, 6).setDepth(6);
    r.setStrokeStyle(2, C.player, 0.9);
    r.setFillStyle();
    this.tweens.add({
      targets: r, scale: 2.6, alpha: 0,
      duration: 340, ease: 'Cubic.easeOut',
      onComplete: () => r.destroy(),
    });
  }

  burst(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 14 + Math.random() * 46;
      const p = this.add.circle(x, y, 2 + Math.random() * 2, color).setDepth(22);
      this.tweens.add({
        targets: p,
        x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
        alpha: 0, duration: 300 + Math.random() * 300,
        onComplete: () => p.destroy(),
      });
    }
  }

  checkEnd() {
    if (this.over) return;
    if (this.player.alive && this.enemy.alive) return;

    this.over = true;
    this.armed = null;
    const win = this.enemy.hp <= 0 && this.player.hp > 0;
    this.txtEnd.setText(`${win ? '승리' : '패배'}\n\nSPACE 로 다시`);
    this.txtEnd.setColor(win ? '#4ecb8f' : '#e0574a');
  }
}

/* ========================================================================== */
new Phaser.Game({
  type: Phaser.AUTO,
  width: VIEW.W,
  height: VIEW.H,
  parent: 'game',
  backgroundColor: '#0e111a',
  physics: { default: 'arcade', arcade: { gravity: { y: 0 }, debug: false } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: Arena,
});