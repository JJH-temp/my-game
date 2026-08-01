import Phaser from 'phaser';

/* ==========================================================================
 * 1D 근접 격투 — Phaser 3
 *
 *  조작
 *    Q / R          좌 / 우 이동
 *    SPACE          점프
 *    W              참격 — 즉시 발동 · 날아오는 단검을 쳐낼 수 있다
 *    E              단검 장전 → 마우스 조준 → 좌클릭 투척 (소지 3개)
 *    ESC            장전 취소
 *    1 2 3          AI 난이도
 *    ENTER          재시작
 *
 *  단검은 유한 자원이다. 빗나가거나 명중한 단검은 땅에 떨어지고,
 *  그 위를 지나가면 주울 수 있다. 화면 밖으로 나간 단검은 사라진다.
 * ========================================================================== */

const VIEW = { W: 960, H: 540 };
const GROUND_Y = 452;

const PHYS = {
  gravity: 1500,
  moveSpeed: 235,
  airControl: 0.72,
  jumpV: -600,
};

const MAX_AMMO = 3;

/* 히트스톱 — 타격 순간 물리를 멈추는 시간(ms) */
const FREEZE = {
  knife: 45,
  slash: 90,
  deflect: 70,
  clash: 170,
};

const C = {
  sky:    0x141824,
  far:    0x1b2130,
  near:   0x232b3d,
  ground: 0x2c3446,
  line:   0x3d4760,
  bone:   0xe8e3d9,
  dim:    0x7d8598,
  player: 0x4ecb8f,
  enemy:  0xe0574a,
  steel:  0xc9d4e6,
  gold:   0xd9a441,
};

const SKILLS = {
  W: {
    name: '참격', kind: 'slash', aimed: false,
    cd: 750, dmg: 18, startup: 110, active: 100,
    reach: 84, arc: 105, knock: 340, hue: 0xc9d4e6,
    hint: '근접 · 단검 쳐냄',
  },
  E: {
    name: '단검', kind: 'knife', aimed: true,
    cd: 620, dmg: 11, startup: 90,
    speed: 720, range: 780, len: 16, hue: 0xffd280,
    hint: '조준 투척 · 회수 가능',
  },
};
const SKILL_KEYS = ['W', 'E'];

const DIFFICULTY = {
  1: { label: '연습', react: 540, jitter: 0.20, dodge: 0.30, aggro: 0.55, lead: 0.5,  windup: 1.25, parry: 0.10 },
  2: { label: '호각', react: 340, jitter: 0.10, dodge: 0.65, aggro: 0.80, lead: 0.85, windup: 1.0,  parry: 0.35 },
  3: { label: '사투', react: 215, jitter: 0.04, dodge: 0.90, aggro: 1.00, lead: 1.0,  windup: 0.75, parry: 0.65 },
};

const FONT = '"Pretendard", "Noto Sans KR", system-ui, sans-serif';

/* ========================================================================== */
/*  전투 유닛                                                                  */
/* ========================================================================== */
class Fighter {
  constructor(scene, x, color, label) {
    this.scene = scene;
    this.label = label;
    this.color = color;

    this.maxHp = 100;
    this.hp = 100;
    this.alive = true;
    this.ammo = MAX_AMMO;

    this.w = 26;
    this.h = 52;
    this.facing = 1;

    // 물리 본체는 보이지 않는다. 눈에 보이는 몸은 따로 그려서 자유롭게 변형한다.
    this.go = scene.add.rectangle(x, GROUND_Y - this.h / 2, this.w, this.h, color);
    this.go.setVisible(false);
    scene.physics.add.existing(this.go);
    this.body = this.go.body;
    this.body.setCollideWorldBounds(true);
    this.body.setDragX(1800);

    // 발밑을 기준점으로 삼아야 눌리고 늘어나는 변형이 자연스럽다
    this.torso = scene.add.rectangle(x, GROUND_Y, this.w, this.h, color).setDepth(10);
    this.torso.setOrigin(0.5, 1);
    this.head = scene.add.circle(x, 0, 11, color).setDepth(10);
    this.head.setStrokeStyle(2, C.sky, 0.8);

    // 스쿼시 상태 — 1이 기본, 트윈으로 되돌아온다
    this.sq = { x: 1, y: 1, lean: 0 };
    this.sqTween = null;

    this.cd = { W: 0, E: 0 };
    this.action = null;
    this.invulnUntil = 0;
    this.lockUntil = 0;
    this.wasAir = false;
  }

  get x() { return this.go.x; }
  get y() { return this.go.y; }
  get footY() { return this.go.y + this.h / 2; }
  get onGround() { return this.body.blocked.down || this.body.touching.down; }

  ready(key, t) {
    if (!this.alive || this.action || t < this.cd[key]) return false;
    if (key === 'E' && this.ammo <= 0) return false;
    return true;
  }
  cdLeft(key, t) { return Math.max(0, this.cd[key] - t); }

  /** 참격 판정이 살아있는 구간인가 */
  slashActive(t) {
    const a = this.action;
    return !!(a && a.key === 'W' && a.done && t < a.endAt);
  }

  walk(dir, t) {
    if (!this.alive) { this.body.setVelocityX(0); return; }
    if (t < this.lockUntil) return;

    const cast = this.action ? (this.onGround ? 0 : 0.5) : 1;
    const ctrl = (this.onGround ? 1 : PHYS.airControl) * cast;

    if (dir === 0) {
      if (this.onGround) this.body.setVelocityX(0);
      return;
    }
    this.body.setVelocityX(dir * PHYS.moveSpeed * ctrl);
  }

  jump(t) {
    if (!this.alive || !this.onGround || t < this.lockUntil) return false;
    this.body.setVelocityY(PHYS.jumpV);
    this.squash(0.82, 1.24, 0, 240);      // 도약 — 위로 늘어남
    return true;
  }

  faceToward(other) {
    if (this.action) return;
    this.facing = other.x >= this.x ? 1 : -1;
  }

  /** 스쿼시/스트레치 + 기울임. 목표값을 찍고 기본 자세로 되돌린다. */
  squash(sx, sy, lean = 0, dur = 260, ease = 'Back.easeOut') {
    if (this.sqTween) this.sqTween.stop();
    this.sq.x = sx; this.sq.y = sy; this.sq.lean = lean;
    this.sqTween = this.scene.tweens.add({
      targets: this.sq, x: 1, y: 1, lean: 0, duration: dur, ease,
    });
  }

  takeHit(dmg, t, srcX, knock) {
    if (!this.alive || t < this.invulnUntil) return false;

    this.hp = Math.max(0, this.hp - dmg);
    this.scene.popText(this.x, this.y - 46, `-${dmg}`, this.color);

    const dir = this.x >= srcX ? 1 : -1;
    this.squash(1.28, 0.76, dir * 0.22, 320);

    this.torso.setFillStyle(C.bone);
    this.head.setFillStyle(C.bone);
    this.scene.time.delayedCall(80, () => {
      if (this.torso.active) { this.torso.setFillStyle(this.color); this.head.setFillStyle(this.color); }
    });

    if (knock > 0) {
      this.body.setVelocityX(dir * knock);
      this.body.setVelocityY(-190);
      this.lockUntil = t + 220;
      this.action = null;
    }

    if (this.hp <= 0) this.die();
    return true;
  }

  die() {
    this.alive = false;
    this.action = null;
    this.body.setVelocityX(0);
    this.torso.setFillStyle(C.dim);
    this.head.setFillStyle(C.dim);
    this.squash(1.5, 0.5, 0, 500);
    this.scene.burst(this.x, this.y, this.color, 26);
  }

  /** 착지 감지 + 시각 동기화 */
  syncVisual(t) {
    const air = !this.onGround;
    if (this.wasAir && !air && this.alive) {
      const impact = Phaser.Math.Clamp(Math.abs(this.body.prevVelocity.y) / 700, 0.25, 1);
      this.squash(1 + 0.34 * impact, 1 - 0.3 * impact, 0, 300);   // 착지 — 눌림
    }
    this.wasAir = air;

    const fy = this.footY;
    this.torso.setPosition(this.x, fy);
    this.torso.setScale(this.sq.x, this.sq.y);
    this.torso.setRotation(this.sq.lean);

    // 머리는 변형된 몸 높이를 따라간다
    const hx = this.x + Math.sin(this.sq.lean) * this.h * this.sq.y;
    const hy = fy - this.h * this.sq.y * Math.cos(this.sq.lean) - 9;
    this.head.setPosition(hx + this.facing * 3, hy);
    this.head.setScale(this.sq.x * 0.5 + 0.5, this.sq.y * 0.5 + 0.5);
  }
}

/* ========================================================================== */
/*  AI                                                                         */
/* ========================================================================== */
class AI {
  constructor(scene, self, foe, level = 2) {
    this.scene = scene;
    this.self = self;
    this.foe = foe;
    this.setLevel(level);

    this.nextDecision = 0;
    this.plan = null;
    this.desiredGap = 300;
    this.evadeUntil = 0;
    this.evadeDir = 1;
    this.recovering = null;     // 주우러 가는 단검
  }

  setLevel(level) { this.level = level; this.p = DIFFICULTY[level]; }

  update(t) {
    const me = this.self, foe = this.foe;
    if (!me.alive || !foe.alive) { me.walk(0, t); return; }

    const gap = Math.abs(foe.x - me.x);
    const toFoe = foe.x > me.x ? 1 : -1;

    this.dodgeIncoming(t, gap);

    if (this.plan && t >= this.plan.fireAt) {
      this.scene.cast(me, this.plan.key, this.plan.aim);
      this.plan = null;
      this.nextDecision = t + this.p.react;
    }

    if (!this.plan && t >= this.nextDecision) {
      this.decide(t, gap, toFoe);
      this.nextDecision = t + this.p.react;
    }

    this.step(t, gap, toFoe);
  }

  /** 날아오는 단검 — 참격으로 쳐내거나, 점프로 넘거나, 물러난다 */
  dodgeIncoming(t, gap) {
    if (t < this.evadeUntil || this.plan) return;
    const me = this.self;

    for (const k of this.scene.knives) {
      if (k.owner === me || k.grounded) continue;

      const dx = k.go.x - me.x;
      const vx = k.go.body.velocity.x;
      if (Math.abs(vx) < 1) continue;
      if (Math.sign(dx) === Math.sign(vx)) continue;

      const tc = -dx / vx;
      if (tc < 0 || tc > 0.45) continue;

      const yAt = k.go.y + k.go.body.velocity.y * tc;
      if (Math.abs(yAt - me.y) > me.h / 2 + 12) continue;

      // 쳐내기 — 타이밍이 맞아야 하므로 참격 발동 시간을 역산한다
      const canParry = me.ready('W', t) && tc * 1000 > SKILLS.W.startup - 40;
      if (canParry && Math.random() < this.p.parry) {
        this.plan = { key: 'W', fireAt: t + 40, aim: null };
        return;
      }

      if (Math.random() > this.p.dodge) continue;

      if (me.onGround && me.jump(t)) this.evadeUntil = t + 260;
      else { this.evadeDir = dx > 0 ? -1 : 1; this.evadeUntil = t + 260; }
      return;
    }
  }

  decide(t, gap, toFoe) {
    const me = this.self, foe = this.foe;

    // 탄약이 없으면 회수를 우선한다
    if (me.ammo <= 0) {
      const pick = this.nearestPickup();
      if (pick && gap > 110) { this.recovering = pick; return; }
    } else {
      this.recovering = null;
    }

    if (Math.random() > this.p.aggro) return;

    const level = Math.abs(foe.y - me.y) < 40;
    const opts = [];
    if (gap < SKILLS.W.reach * 0.9 && level && me.ready('W', t)) opts.push('W');
    if (gap > 130 && me.ready('E', t)) opts.push('E');

    if (opts.length === 0) {
      this.desiredGap = gap < 90 ? 260 : Phaser.Math.Between(150, 330);
      if (!level && foe.y < me.y - 50 && me.onGround && Math.random() < 0.4) me.jump(t);
      return;
    }

    const key = Phaser.Utils.Array.GetRandom(opts);
    const sk = SKILLS[key];
    this.plan = { key, fireAt: t + 260 * this.p.windup, aim: sk.aimed ? this.aimKnife(sk) : null };
    this.desiredGap = key === 'W' ? 55 : 300;
  }

  nearestPickup() {
    const me = this.self;
    let best = null, bd = Infinity;
    for (const k of this.scene.knives) {
      if (!k.grounded) continue;
      const d = Math.abs(k.go.x - me.x);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  aimKnife(sk) {
    const me = this.self, foe = this.foe;
    const flight = Math.abs(foe.x - me.x) / sk.speed;
    const tx = foe.x + foe.body.velocity.x * flight * this.p.lead;
    const ty = foe.y + foe.body.velocity.y * flight * this.p.lead * 0.6;

    const a = Phaser.Math.Angle.Between(me.x, me.y, tx, ty)
            + Phaser.Math.FloatBetween(-this.p.jitter, this.p.jitter);
    const d = Phaser.Math.Distance.Between(me.x, me.y, tx, ty) || 200;
    return { x: me.x + Math.cos(a) * d, y: me.y + Math.sin(a) * d };
  }

  step(t, gap, toFoe) {
    const me = this.self;

    if (t < this.evadeUntil) { me.walk(this.evadeDir, t); return; }

    // 단검 회수 중
    if (this.recovering) {
      if (!this.recovering.grounded || me.ammo >= MAX_AMMO) { this.recovering = null; }
      else {
        const dx = this.recovering.go.x - me.x;
        me.walk(Math.abs(dx) < 12 ? 0 : Math.sign(dx), t);
        return;
      }
    }

    const err = gap - this.desiredGap;
    if (Math.abs(err) < 26) { me.walk(0, t); return; }
    me.walk(err > 0 ? toFoe : -toFoe, t);
  }
}

/* ========================================================================== */
/*  씬                                                                         */
/* ========================================================================== */
class Duel extends Phaser.Scene {
  constructor() { super('Duel'); }

  create() {
    this.difficulty = this.registry.get('difficulty') || 2;
    this.over = false;
    this.armed = null;
    this.knives = [];
    this.frozenUntil = 0;

    this.physics.world.setBounds(0, 0, VIEW.W, GROUND_Y);
    this.drawStage();

    this.gAim = this.add.graphics().setDepth(6);
    this.gHud = this.add.graphics().setDepth(30);

    this.player = new Fighter(this, 250, C.player, '나');
    this.enemy = new Fighter(this, VIEW.W - 250, C.enemy, 'AI');
    this.ai = new AI(this, this.enemy, this.player, this.difficulty);

    this.bindInput();
    this.buildHud();
  }

  drawStage() {
    const { W, H } = VIEW;
    const g = this.add.graphics().setDepth(0);

    g.fillStyle(C.sky, 1).fillRect(0, 0, W, H);
    g.fillStyle(C.far, 1);
    for (let i = 0; i < 7; i++) {
      g.fillRect(i * 150 - 40, GROUND_Y - (120 + (i % 4) * 60), 90 + (i % 3) * 40, 120 + (i % 4) * 60);
    }
    g.fillStyle(C.near, 1);
    for (let i = 0; i < 5; i++) {
      g.fillRect(i * 210 + 60, GROUND_Y - (70 + (i % 3) * 40), 130, 70 + (i % 3) * 40);
    }
    g.fillStyle(C.ground, 1).fillRect(0, GROUND_Y, W, H - GROUND_Y);
    g.lineStyle(2, C.line, 1).lineBetween(0, GROUND_Y, W, GROUND_Y);
    g.lineStyle(1, C.line, 0.4);
    for (let x = 0; x < W; x += 48) g.lineBetween(x, GROUND_Y, x - 20, H);
  }

  /* ── 히트스톱 ─────────────────────────────────────────────────────── */
  freeze(ms) {
    this.frozenUntil = Math.max(this.frozenUntil, this.time.now + ms);
    this.physics.world.pause();
    this.time.delayedCall(ms, () => {
      if (this.time.now >= this.frozenUntil - 8) this.physics.world.resume();
    });
  }
  get frozen() { return this.time.now < this.frozenUntil; }

  /* ── 입력 ─────────────────────────────────────────────────────────── */
  bindInput() {
    this.keys = this.input.keyboard.addKeys({
      left: Phaser.Input.Keyboard.KeyCodes.Q,
      right: Phaser.Input.Keyboard.KeyCodes.R,
      jump: Phaser.Input.Keyboard.KeyCodes.SPACE,
    });

    this.input.keyboard.on('keydown-W', () => {
      if (this.over || !this.player.ready('W', this.time.now)) return;
      this.armed = null;
      this.cast(this.player, 'W', null);
    });

    this.input.keyboard.on('keydown-E', () => {
      if (this.over || !this.player.alive) return;
      const t = this.time.now;
      if (this.player.ammo <= 0) {
        this.popText(this.player.x, this.player.y - 56, '단검 없음', C.dim);
        return;
      }
      if (!this.player.ready('E', t)) {
        this.popText(this.player.x, this.player.y - 56, '쿨다운', C.dim);
        return;
      }
      this.armed = this.armed === 'E' ? null : 'E';
    });

    this.input.keyboard.on('keydown-ESC', () => { this.armed = null; });
    this.input.keyboard.on('keydown-ENTER', () => { if (this.over) this.scene.restart(); });

    for (const [k, lv] of [['ONE', 1], ['TWO', 2], ['THREE', 3]]) {
      this.input.keyboard.on(`keydown-${k}`, () => {
        this.difficulty = lv;
        this.registry.set('difficulty', lv);
        this.ai.setLevel(lv);
        this.popText(VIEW.W / 2, 90, `난이도 · ${DIFFICULTY[lv].label}`, C.gold);
      });
    }

    this.input.mouse.disableContextMenu();
    this.input.on('pointerdown', (p) => {
      if (this.over || !this.armed || !p.leftButtonDown()) return;
      this.cast(this.player, this.armed, { x: p.worldX, y: p.worldY });
      this.armed = null;
    });
  }

  /* ── 시전 ─────────────────────────────────────────────────────────── */
  cast(who, key, aim) {
    const t = this.time.now;
    if (!who.ready(key, t)) return;

    const sk = SKILLS[key];
    who.cd[key] = t + sk.cd;
    who.action = {
      key, aim, done: false,
      hitAt: t + sk.startup,
      endAt: t + sk.startup + (sk.active || 60),
      facing: who.facing,
    };
    // 예비 동작 — 뒤로 젖힘
    if (key === 'W') who.squash(0.92, 1.06, -who.facing * 0.16, sk.startup, 'Sine.easeOut');
  }

  resolveAction(who, t) {
    const a = who.action;
    if (!a) return;

    if (!a.done && t >= a.hitAt) {
      a.done = true;
      if (a.key === 'W') this.doSlash(who, a, t);
      else this.doKnife(who, a);
    }
    if (a && t >= a.endAt) who.action = null;
  }

  /* ── 참격 ─────────────────────────────────────────────────────────── */
  doSlash(who, a, t) {
    const sk = SKILLS.W;
    const foe = who === this.player ? this.enemy : this.player;
    const base = a.facing > 0 ? 0 : Math.PI;
    const half = Phaser.Math.DegToRad(sk.arc) / 2;

    who.squash(1.14, 0.9, a.facing * 0.24, 240);     // 휘두름 — 앞으로 기울임
    this.slashTrail(who.x, who.y, base, half, sk.reach, sk.hue);
    this.cameras.main.shake(70, 0.003);

    // ① 참격 대 참격 — 서로의 칼이 같은 순간 부딪히면 격돌
    const fa = foe.action;
    const facingEach = a.facing !== foe.facing;
    const gap = Math.abs(foe.x - who.x);
    if (fa && fa.key === 'W' && Math.abs(fa.hitAt - t) < 120 &&
        gap < sk.reach * 1.5 && facingEach) {
      this.clash(who, foe, t);
      return;
    }

    // ② 몸통 판정
    if (foe.alive) {
      const d = Phaser.Math.Distance.Between(who.x, who.y, foe.x, foe.y);
      const ang = Phaser.Math.Angle.Between(who.x, who.y, foe.x, foe.y);
      if (d <= sk.reach + foe.w / 2 && Math.abs(Phaser.Math.Angle.Wrap(ang - base)) <= half) {
        if (foe.takeHit(sk.dmg, t, who.x, sk.knock)) {
          this.burst((who.x + foe.x) / 2, (who.y + foe.y) / 2, sk.hue, 14);
          this.freeze(FREEZE.slash);
        }
      }
    }
  }

  /** 참격 판정이 살아있는 동안 매 프레임 호출 — 단검 쳐내기 */
  deflectCheck(who, t) {
    const sk = SKILLS.W;
    const base = who.action.facing > 0 ? 0 : Math.PI;
    const half = Phaser.Math.DegToRad(sk.arc) / 2;

    for (const k of this.knives) {
      if (k.owner === who || k.grounded || k.deflectedAt > t - 200) continue;

      const d = Phaser.Math.Distance.Between(who.x, who.y, k.go.x, k.go.y);
      if (d > sk.reach + 10) continue;
      const ang = Phaser.Math.Angle.Between(who.x, who.y, k.go.x, k.go.y);
      if (Math.abs(Phaser.Math.Angle.Wrap(ang - base)) > half) continue;

      // 되받아친다 — 소유권이 넘어가므로 던진 쪽이 맞을 수 있다
      const v = k.go.body.velocity;
      k.go.body.setVelocity(-v.x * 0.92, -v.y * 0.92 - 40);
      k.go.setRotation(Math.atan2(-v.y, -v.x));
      k.go.setFillStyle(C.steel);
      k.owner = who;
      k.deflectedAt = t;
      k.dieAt = t + 1400;

      this.burst(k.go.x, k.go.y, C.steel, 10);
      this.popText(k.go.x, k.go.y - 24, '쳐냄', C.steel);
      this.freeze(FREEZE.deflect);
      this.cameras.main.shake(90, 0.005);
    }
  }

  clash(a, b, t) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;

    a.action = null; b.action = null;
    for (const f of [a, b]) {
      const dir = f.x >= mx ? 1 : -1;
      f.body.setVelocity(dir * 300, -230);
      f.lockUntil = t + 240;
      f.cd.W = t + 420;                       // 곧바로 다시 붙을 수 있게
      f.squash(0.82, 1.2, -dir * 0.3, 380);
    }

    this.burst(mx, my, C.bone, 30);
    this.popText(mx, my - 40, '격돌', C.gold);
    this.cameras.main.shake(220, 0.014);
    this.freeze(FREEZE.clash);

    const ring = this.add.circle(mx, my, 12).setDepth(25);
    ring.setStrokeStyle(3, C.bone, 1);
    ring.setFillStyle();
    this.tweens.add({ targets: ring, scale: 5, alpha: 0, duration: 420, onComplete: () => ring.destroy() });
  }

  slashTrail(x, y, base, half, reach, hue) {
    const g = this.add.graphics().setDepth(19);
    g.fillStyle(hue, 0.35);
    g.beginPath(); g.slice(x, y, reach, base - half, base + half, false); g.fillPath();
    g.lineStyle(2, C.bone, 0.85);
    g.beginPath(); g.slice(x, y, reach, base - half, base + half, false); g.strokePath();
    this.tweens.add({ targets: g, alpha: 0, duration: 220, onComplete: () => g.destroy() });
  }

  /* ── 단검 ─────────────────────────────────────────────────────────── */
  doKnife(who, a) {
    const sk = SKILLS.E;
    who.ammo--;
    who.squash(1.1, 0.94, who.facing * 0.14, 220);

    const angle = Phaser.Math.Angle.Between(who.x, who.y, a.aim.x, a.aim.y);
    const go = this.add.rectangle(
      who.x + Math.cos(angle) * 26, who.y + Math.sin(angle) * 26,
      sk.len, 4, sk.hue,
    ).setDepth(15);
    go.setRotation(angle);
    this.physics.add.existing(go);
    go.body.setAllowGravity(false);
    this.physics.velocityFromRotation(angle, sk.speed, go.body.velocity);

    this.knives.push({
      go, owner: who, dmg: sk.dmg,
      dieAt: this.time.now + (sk.range / sk.speed) * 1000,
      grounded: false, deflectedAt: -9999,
    });
  }

  /** 날던 단검을 땅에 꽂는다 */
  planted(k, x) {
    k.grounded = true;
    k.go.body.setVelocity(0, 0);
    k.go.body.setAllowGravity(false);
    k.go.setPosition(Phaser.Math.Clamp(x, 16, VIEW.W - 16), GROUND_Y - 8);
    k.go.setRotation(-Math.PI / 2.6);
    k.go.setFillStyle(C.gold);
    k.go.setDepth(4);
    this.tweens.add({ targets: k.go, alpha: 0.55, duration: 700, yoyo: true, repeat: -1 });
  }

  stepKnives(t) {
    for (let i = this.knives.length - 1; i >= 0; i--) {
      const k = this.knives[i];

      if (k.grounded) {
        // 회수 — 지나가면 주워진다
        for (const f of [this.player, this.enemy]) {
          if (!f.alive || f.ammo >= MAX_AMMO) continue;
          if (Math.abs(f.x - k.go.x) < 24 && Math.abs(f.footY - GROUND_Y) < 40) {
            f.ammo++;
            this.popText(f.x, f.y - 56, '＋단검', C.gold);
            k.go.destroy();
            this.knives.splice(i, 1);
            break;
          }
        }
        continue;
      }

      const foe = k.owner === this.player ? this.enemy : this.player;

      // 명중 — 단검은 발밑에 떨어진다
      if (foe.alive &&
          Math.abs(k.go.x - foe.x) < foe.w / 2 + 8 &&
          Math.abs(k.go.y - foe.y) < foe.h / 2 + 4) {
        if (foe.takeHit(k.dmg, t, k.go.x, 120)) {
          this.burst(k.go.x, k.go.y, SKILLS.E.hue, 8);
          this.freeze(FREEZE.knife);
        }
        this.planted(k, foe.x);
        continue;
      }

      // 사거리 끝 — 중력을 받아 떨어진다
      if (t > k.dieAt && !k.falling) {
        k.falling = true;
        k.go.body.setAllowGravity(true);
        k.go.body.setVelocity(k.go.body.velocity.x * 0.35, 40);
      }
      if (k.go.y >= GROUND_Y - 10) { this.planted(k, k.go.x); continue; }

      // 화면 밖 — 영영 잃는다
      if (k.go.x < -40 || k.go.x > VIEW.W + 40 || k.go.y < -200) {
        k.go.destroy();
        this.knives.splice(i, 1);
      }
    }
  }

  /* ── 루프 ─────────────────────────────────────────────────────────── */
  update(t) {
    if (!this.over && !this.frozen) {
      this.stepPlayer(t);
      this.ai.update(t);

      for (const f of [this.player, this.enemy]) {
        this.resolveAction(f, t);
        if (f.slashActive(t)) this.deflectCheck(f, t);
      }
      this.player.faceToward(this.enemy);
      this.enemy.faceToward(this.player);

      this.stepKnives(t);
      this.checkEnd();
    }

    // 정지 중에도 그림은 갱신한다
    this.player.syncVisual(t);
    this.enemy.syncVisual(t);
    this.drawAimLayer(t);
    this.drawHud(t);
  }

  stepPlayer(t) {
    const p = this.player;
    if (!p.alive) return;

    let dir = 0;
    if (this.keys.left.isDown) dir -= 1;
    if (this.keys.right.isDown) dir += 1;
    p.walk(dir, t);

    if (Phaser.Input.Keyboard.JustDown(this.keys.jump)) p.jump(t);
    if (this.armed && !p.ready(this.armed, t)) this.armed = null;
  }

  /* ── 조준·예고 ────────────────────────────────────────────────────── */
  drawAimLayer(t) {
    const g = this.gAim;
    g.clear();

    if (this.armed === 'E' && this.player.alive) {
      const ptr = this.input.activePointer;
      this.drawKnifeAim(g, this.player, ptr.worldX, ptr.worldY, C.player, 0.55);
    }

    if (this.ai.plan) {
      const pl = this.ai.plan;
      const urg = Phaser.Math.Clamp(1 - Math.max(0, pl.fireAt - t) / 300, 0.3, 1);
      if (pl.key === 'E' && pl.aim) {
        this.drawKnifeAim(g, this.enemy, pl.aim.x, pl.aim.y, C.enemy, 0.3 + urg * 0.55);
      } else {
        const e = this.enemy;
        const base = e.facing > 0 ? 0 : Math.PI;
        const half = Phaser.Math.DegToRad(SKILLS.W.arc) / 2;
        g.fillStyle(C.enemy, 0.12 + urg * 0.24);
        g.beginPath(); g.slice(e.x, e.y, SKILLS.W.reach, base - half, base + half, false); g.fillPath();
      }
    }

    for (const f of [this.player, this.enemy]) {
      if (!f.alive) continue;
      g.lineStyle(3, C.steel, f.action ? 1 : 0.5);
      const len = f.action && f.action.key === 'W' ? 32 : 20;
      g.lineBetween(f.x, f.y - 6, f.x + f.facing * len, f.y - 12);
    }
  }

  drawKnifeAim(g, who, ax, ay, color, alpha) {
    const sk = SKILLS.E;
    const a = Phaser.Math.Angle.Between(who.x, who.y, ax, ay);
    g.lineStyle(2, color, alpha);
    g.lineBetween(who.x, who.y, who.x + Math.cos(a) * sk.range, who.y + Math.sin(a) * sk.range);
    g.fillStyle(sk.hue, alpha * 0.9);
    g.fillCircle(who.x + Math.cos(a) * 46, who.y + Math.sin(a) * 46, 4);
  }

  /* ── HUD ──────────────────────────────────────────────────────────── */
  buildHud() {
    const mk = (x, y, txt, size, color, ox = 0) =>
      this.add.text(x, y, txt, {
        fontFamily: FONT, fontSize: `${size}px`,
        color: Phaser.Display.Color.IntegerToColor(color).rgba,
      }).setOrigin(ox, 0).setDepth(31);

    mk(28, 22, '나', 13, C.player);
    mk(VIEW.W - 28, 22, 'AI', 13, C.enemy, 1);
    this.txtHint = mk(VIEW.W / 2, 22, '', 12, C.dim, 0.5);

    this.slots = {};
    const bx = VIEW.W / 2 - (SKILL_KEYS.length * 132) / 2;
    SKILL_KEYS.forEach((k, i) => {
      const x = bx + i * 132;
      this.slots[k] = {
        key: mk(x + 12, VIEW.H - 62, k, 16, C.bone),
        name: mk(x + 36, VIEW.H - 62, SKILLS[k].name, 13, C.bone),
        hint: mk(x + 36, VIEW.H - 45, SKILLS[k].hint, 10, C.dim),
        cd: mk(x + 112, VIEW.H - 62, '', 11, C.gold, 1),
      };
    });

    this.txtEnd = this.add.text(VIEW.W / 2, 200, '', {
      fontFamily: FONT, fontSize: '38px', color: '#e8e3d9', align: 'center',
    }).setOrigin(0.5).setDepth(40);
  }

  drawHud(t) {
    const g = this.gHud;
    g.clear();

    this.hpBar(g, 28, 42, 320, this.player, false);
    this.hpBar(g, VIEW.W - 28, 42, 320, this.enemy, true);
    this.ammoDots(g, 28, 64, this.player, false);
    this.ammoDots(g, VIEW.W - 28, 64, this.enemy, true);

    const bx = VIEW.W / 2 - (SKILL_KEYS.length * 132) / 2;
    SKILL_KEYS.forEach((k, i) => {
      const x = bx + i * 132, y = VIEW.H - 68, w = 124, h = 46;
      const left = this.player.cdLeft(k, t);
      const ratio = left / SKILLS[k].cd;
      const on = this.armed === k;
      const dry = k === 'E' && this.player.ammo <= 0;

      g.fillStyle(C.sky, 0.6).fillRect(x, y, w, h);
      if (ratio > 0) g.fillStyle(C.dim, 0.22).fillRect(x, y, w, h * ratio);
      g.lineStyle(on ? 2 : 1, on ? C.gold : (dry ? C.enemy : C.line), on ? 1 : 0.8);
      g.strokeRect(x, y, w, h);

      const s = this.slots[k];
      const txt = dry ? '없음' : (left > 0 ? (left / 1000).toFixed(1) : '준비');
      s.cd.setText(txt);
      s.cd.setColor(dry ? '#e0574a' : (left > 0 ? '#7d8598' : '#d9a441'));
    });

    this.txtHint.setText(
      this.armed === 'E'
        ? '단검 조준 중 — 좌클릭 투척 · ESC 취소'
        : `Q R 이동 · SPACE 점프 · W 참격 · E 단검    |    ${DIFFICULTY[this.difficulty].label} (1 2 3)`
    );
  }

  hpBar(g, x, y, w, f, flip) {
    const h = 14, x0 = flip ? x - w : x;
    const fw = w * (f.hp / f.maxHp);
    g.fillStyle(C.sky, 0.65).fillRect(x0, y, w, h);
    g.fillStyle(f.color, 0.92).fillRect(flip ? x - fw : x0, y, fw, h);
    g.lineStyle(1, C.line, 0.9).strokeRect(x0, y, w, h);
  }

  ammoDots(g, x, y, f, flip) {
    for (let i = 0; i < MAX_AMMO; i++) {
      const cx = flip ? x - 6 - i * 16 : x + 6 + i * 16;
      if (i < f.ammo) g.fillStyle(C.gold, 0.95).fillCircle(cx, y + 6, 4);
      else { g.lineStyle(1, C.dim, 0.7); g.strokeCircle(cx, y + 6, 4); }
    }
  }

  /* ── 소품 ─────────────────────────────────────────────────────────── */
  popText(x, y, msg, color) {
    const o = this.add.text(x, y, msg, {
      fontFamily: FONT, fontSize: '15px',
      color: Phaser.Display.Color.IntegerToColor(color).rgba,
    }).setOrigin(0.5).setDepth(35);
    this.tweens.add({ targets: o, y: y - 28, alpha: 0, duration: 620, onComplete: () => o.destroy() });
  }

  burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 12 + Math.random() * 44;
      const p = this.add.circle(x, y, 2 + Math.random() * 2, color).setDepth(22);
      this.tweens.add({
        targets: p, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
        alpha: 0, duration: 280 + Math.random() * 300,
        onComplete: () => p.destroy(),
      });
    }
  }

  checkEnd() {
    if (this.over || (this.player.alive && this.enemy.alive)) return;
    this.over = true;
    this.armed = null;
    this.physics.world.resume();
    const win = this.enemy.hp <= 0 && this.player.hp > 0;
    this.txtEnd.setText(`${win ? '승리' : '패배'}\n\nENTER 로 다시`);
    this.txtEnd.setColor(win ? '#4ecb8f' : '#e0574a');
  }
}

/* ========================================================================== */
new Phaser.Game({
  type: Phaser.AUTO,
  width: VIEW.W,
  height: VIEW.H,
  parent: 'game',
  backgroundColor: '#141824',
  physics: { default: 'arcade', arcade: { gravity: { y: PHYS.gravity }, debug: false } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: Duel,
});