import Phaser from 'phaser';

/* ==========================================================================
 * 1D 근접 격투 — Phaser 3 (단일 파일)
 *
 *  조작
 *    Q / R          좌 / 우 이동
 *    SPACE          점프
 *    W              칼 휘두르기 — 누르는 즉시 발동 (근접, 밀쳐냄)
 *    E              단검 장전 → 마우스로 조준 → 좌클릭으로 투척
 *    ESC            장전 취소
 *    1 2 3          AI 난이도
 *    ENTER          재시작
 *
 *  캐릭터는 항상 상대를 바라보므로 칼은 조준이 필요 없습니다.
 *  단검만 마우스 각도를 씁니다. AI도 같은 규칙과 예고 동작을 따릅니다.
 * ========================================================================== */

const VIEW = { W: 960, H: 540 };
const GROUND_Y = 452;          // 발이 닿는 높이 (물리 월드의 아래쪽 경계)

const PHYS = {
  gravity: 1500,
  moveSpeed: 235,
  airControl: 0.72,            // 공중에서의 이동 제어력
  jumpV: -600,
};

/* ── 팔레트 ─────────────────────────────────────────────────────────── */
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

/* ── 스킬 ────────────────────────────────────────────────────────────
 *  W 참격 : 즉시 발동. 시전 후 startup 만큼 뒤에 판정이 생긴다.
 *  E 단검 : 장전 → 조준 → 클릭. 직선으로 날아간다.
 * ------------------------------------------------------------------ */
const SKILLS = {
  W: {
    name: '참격', kind: 'slash', aimed: false,
    cd: 750, dmg: 18, startup: 110, active: 90,
    reach: 82, arc: 105, knock: 340, hue: 0xc9d4e6,
    hint: '근접 · 밀쳐냄',
  },
  E: {
    name: '단검', kind: 'knife', aimed: true,
    cd: 900, dmg: 11, startup: 90,
    speed: 720, range: 900, len: 16, hue: 0xffd280,
    hint: '조준 투척',
  },
};
const SKILL_KEYS = ['W', 'E'];

const DIFFICULTY = {
  1: { label: '연습', react: 540, jitter: 0.20, dodge: 0.30, aggro: 0.55, lead: 0.5,  windup: 1.25 },
  2: { label: '호각', react: 340, jitter: 0.10, dodge: 0.65, aggro: 0.80, lead: 0.85, windup: 1.0 },
  3: { label: '사투', react: 215, jitter: 0.04, dodge: 0.90, aggro: 1.00, lead: 1.0,  windup: 0.75 },
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

    this.w = 26;
    this.h = 52;
    this.facing = 1;              // 1 = 오른쪽, -1 = 왼쪽

    // 몸통이 물리 본체, 머리는 매 프레임 따라다니는 장식
    this.go = scene.add.rectangle(x, GROUND_Y - this.h / 2, this.w, this.h, color);
    this.go.setDepth(10);
    scene.physics.add.existing(this.go);
    this.body = this.go.body;
    this.body.setCollideWorldBounds(true);
    this.body.setDragX(1800);

    this.head = scene.add.circle(x, 0, 11, color).setDepth(10);
    this.head.setStrokeStyle(2, C.sky, 0.8);

    this.cd = { W: 0, E: 0 };
    this.action = null;           // { key, hitAt, endAt, facing, aim }
    this.invulnUntil = 0;
    this.lockUntil = 0;           // 경직 — 이동 입력 무시
  }

  get x() { return this.go.x; }
  get y() { return this.go.y; }
  get onGround() { return this.body.blocked.down || this.body.touching.down; }

  ready(key, t) { return this.alive && !this.action && t >= this.cd[key]; }
  cdLeft(key, t) { return Math.max(0, this.cd[key] - t); }

  /** dir: -1, 0, 1 */
  walk(dir, t) {
    if (!this.alive) { this.body.setVelocityX(0); return; }
    if (t < this.lockUntil) return;

    // 시전 중에는 발이 묶인다 (지상에서만)
    const cast = this.action ? (this.onGround ? 0 : 0.5) : 1;
    const ctrl = (this.onGround ? 1 : PHYS.airControl) * cast;

    if (dir === 0) {
      if (this.onGround) this.body.setVelocityX(0);
      return;
    }
    this.body.setVelocityX(dir * PHYS.moveSpeed * ctrl);
  }

  jump(t) {
    if (!this.alive || !this.onGround) return false;
    if (t < this.lockUntil) return false;
    this.body.setVelocityY(PHYS.jumpV);
    return true;
  }

  faceToward(other) {
    if (this.action) return;                    // 시전 중에는 방향 고정
    this.facing = other.x >= this.x ? 1 : -1;
  }

  takeHit(dmg, t, srcX, knock) {
    if (!this.alive || t < this.invulnUntil) return false;

    this.hp = Math.max(0, this.hp - dmg);
    this.scene.popText(this.x, this.y - 46, `-${dmg}`, this.color);

    this.go.setFillStyle(C.bone);
    this.head.setFillStyle(C.bone);
    this.scene.time.delayedCall(70, () => {
      if (this.go.active) { this.go.setFillStyle(this.color); this.head.setFillStyle(this.color); }
    });

    if (knock > 0) {
      const dir = this.x >= srcX ? 1 : -1;
      this.body.setVelocityX(dir * knock);
      this.body.setVelocityY(-190);
      this.lockUntil = t + 220;
      this.action = null;                        // 시전 중이었다면 취소
    }

    if (this.hp <= 0) this.die();
    return true;
  }

  die() {
    this.alive = false;
    this.action = null;
    this.body.setVelocityX(0);
    this.go.setFillStyle(C.dim);
    this.head.setFillStyle(C.dim);
    this.scene.burst(this.x, this.y, this.color, 24);
  }

  syncVisual() {
    this.head.setPosition(this.x + this.facing * 3, this.y - this.h / 2 - 9);
  }
}

/* ========================================================================== */
/*  AI — 1차원이라 판단 변수가 거리 하나로 줄어든다.                            */
/*  그래서 난이도 조절은 조준 정확도가 아니라 '판단 실수'로 만든다.               */
/* ========================================================================== */
class AI {
  constructor(scene, self, foe, level = 2) {
    this.scene = scene;
    this.self = self;
    this.foe = foe;
    this.setLevel(level);

    this.nextDecision = 0;
    this.plan = null;             // { key, fireAt, aim }
    this.desiredGap = 300;
    this.evadeUntil = 0;
    this.evadeDir = 1;
  }

  setLevel(level) { this.level = level; this.p = DIFFICULTY[level]; }

  update(t) {
    const me = this.self, foe = this.foe;
    if (!me.alive || !foe.alive) { me.walk(0, t); return; }

    const gap = Math.abs(foe.x - me.x);
    const toFoe = foe.x > me.x ? 1 : -1;

    this.dodgeIncoming(t);

    // 예고가 끝나면 실행
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

  /** 날아오는 단검을 점프로 넘거나 뒤로 뺀다 */
  dodgeIncoming(t) {
    if (t < this.evadeUntil) return;
    const me = this.self;

    for (const k of this.scene.knives) {
      if (k.owner === me) continue;

      const dx = k.go.x - me.x;
      const vx = k.go.body.velocity.x;
      if (Math.abs(vx) < 1) continue;
      if (Math.sign(dx) === Math.sign(vx)) continue;      // 멀어지는 중

      const tc = -dx / vx;                                 // 도달까지 (초)
      if (tc < 0 || tc > 0.45) continue;

      const yAt = k.go.y + k.go.body.velocity.y * tc;
      const hitsTorso = Math.abs(yAt - me.y) < me.h / 2 + 10;
      if (!hitsTorso) continue;
      if (Math.random() > this.p.dodge) continue;

      // 몸통 높이로 오면 점프가 가장 확실하다
      if (me.onGround && me.jump(t)) {
        this.evadeUntil = t + 260;
      } else {
        this.evadeDir = dx > 0 ? -1 : 1;
        this.evadeUntil = t + 260;
      }
      return;
    }
  }

  decide(t, gap, toFoe) {
    const me = this.self, foe = this.foe;
    if (Math.random() > this.p.aggro) return;

    const sameHeight = Math.abs(foe.y - me.y) < 40;
    const options = [];

    if (gap < SKILLS.W.reach * 0.9 && sameHeight && me.ready('W', t)) options.push('W');
    if (gap > 120 && me.ready('E', t)) options.push('E');

    if (options.length === 0) {
      this.desiredGap = gap < 90 ? 260 : Phaser.Math.Between(150, 330);
      // 상대가 공중에 있으면 따라 뛴다
      if (!sameHeight && foe.y < me.y - 50 && me.onGround && Math.random() < 0.4) me.jump(t);
      return;
    }

    const key = Phaser.Utils.Array.GetRandom(options);
    const sk = SKILLS[key];
    const aim = sk.aimed ? this.aimKnife(sk) : null;

    this.plan = { key, fireAt: t + 260 * this.p.windup, aim };
    this.desiredGap = key === 'W' ? 55 : 300;
  }

  /** 단검 예측 조준 */
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

    this.physics.world.setBounds(0, 0, VIEW.W, GROUND_Y);
    this.drawStage();

    this.gAim = this.add.graphics().setDepth(6);
    this.gFx = this.add.graphics().setDepth(18);
    this.gHud = this.add.graphics().setDepth(30);

    this.player = new Fighter(this, 250, C.player, '나');
    this.enemy = new Fighter(this, VIEW.W - 250, C.enemy, 'AI');
    this.ai = new AI(this, this.enemy, this.player, this.difficulty);

    this.bindInput();
    this.buildHud();
  }

  /* ── 배경 ─────────────────────────────────────────────────────────── */
  drawStage() {
    const { W, H } = VIEW;
    const g = this.add.graphics().setDepth(0);

    g.fillStyle(C.sky, 1).fillRect(0, 0, W, H);

    // 원경 — 시차 없이도 깊이감을 주는 실루엣
    g.fillStyle(C.far, 1);
    for (let i = 0; i < 7; i++) {
      const bx = i * 150 - 40, bw = 90 + (i % 3) * 40, bh = 120 + (i % 4) * 60;
      g.fillRect(bx, GROUND_Y - bh, bw, bh);
    }
    g.fillStyle(C.near, 1);
    for (let i = 0; i < 5; i++) {
      const bx = i * 210 + 60, bw = 130, bh = 70 + (i % 3) * 40;
      g.fillRect(bx, GROUND_Y - bh, bw, bh);
    }

    // 지면
    g.fillStyle(C.ground, 1).fillRect(0, GROUND_Y, W, H - GROUND_Y);
    g.lineStyle(2, C.line, 1).lineBetween(0, GROUND_Y, W, GROUND_Y);
    g.lineStyle(1, C.line, 0.4);
    for (let x = 0; x < W; x += 48) g.lineBetween(x, GROUND_Y, x - 20, H);
  }

  /* ── 입력 ─────────────────────────────────────────────────────────── */
  bindInput() {
    this.keys = this.input.keyboard.addKeys({
      left: Phaser.Input.Keyboard.KeyCodes.Q,
      right: Phaser.Input.Keyboard.KeyCodes.R,
      jump: Phaser.Input.Keyboard.KeyCodes.SPACE,
    });

    // 참격 — 즉시 발동
    this.input.keyboard.on('keydown-W', () => {
      if (this.over || !this.player.ready('W', this.time.now)) return;
      this.armed = null;
      this.cast(this.player, 'W', null);
    });

    // 단검 — 장전 후 클릭
    this.input.keyboard.on('keydown-E', () => {
      if (this.over || !this.player.alive) return;
      if (!this.player.ready('E', this.time.now)) {
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
      key,
      hitAt: t + sk.startup,
      endAt: t + sk.startup + (sk.active || 60),
      facing: who.facing,
      aim,
      done: false,
    };
  }

  /** startup 이 지난 시점에 실제 판정/발사가 일어난다 */
  resolveAction(who, t) {
    const a = who.action;
    if (!a) return;

    if (!a.done && t >= a.hitAt) {
      a.done = true;
      if (a.key === 'W') this.doSlash(who, a);
      else if (a.key === 'E') this.doKnife(who, a);
    }
    if (t >= a.endAt) who.action = null;
  }

  doSlash(who, a) {
    const sk = SKILLS.W;
    const t = this.time.now;
    const foe = who === this.player ? this.enemy : this.player;
    const cx = who.x, cy = who.y;
    const base = a.facing > 0 ? 0 : Math.PI;
    const half = Phaser.Math.DegToRad(sk.arc) / 2;

    // 궤적
    const g = this.add.graphics().setDepth(19);
    g.fillStyle(sk.hue, 0.35);
    g.beginPath();
    g.slice(cx, cy, sk.reach, base - half, base + half, false);
    g.fillPath();
    g.lineStyle(2, C.bone, 0.8);
    g.beginPath();
    g.slice(cx, cy, sk.reach, base - half, base + half, false);
    g.strokePath();
    this.tweens.add({ targets: g, alpha: 0, duration: 220, onComplete: () => g.destroy() });
    this.cameras.main.shake(70, 0.003);

    // 판정 — 부채꼴 안에 상대 몸통이 걸치는지
    if (!foe.alive) return;
    const d = Phaser.Math.Distance.Between(cx, cy, foe.x, foe.y);
    if (d > sk.reach + foe.w / 2) return;
    const ang = Phaser.Math.Angle.Between(cx, cy, foe.x, foe.y);
    if (Math.abs(Phaser.Math.Angle.Wrap(ang - base)) > half) return;

    foe.takeHit(sk.dmg, t, cx, sk.knock);
    this.burst((cx + foe.x) / 2, (cy + foe.y) / 2, sk.hue, 12);
  }

  doKnife(who, a) {
    const sk = SKILLS.E;
    const angle = Phaser.Math.Angle.Between(who.x, who.y, a.aim.x, a.aim.y);
    const ox = who.x + Math.cos(angle) * 26;
    const oy = who.y + Math.sin(angle) * 26;

    const go = this.add.rectangle(ox, oy, sk.len, 4, sk.hue).setDepth(15);
    go.setRotation(angle);
    this.physics.add.existing(go);
    go.body.setAllowGravity(false);
    this.physics.velocityFromRotation(angle, sk.speed, go.body.velocity);

    this.knives.push({
      go, owner: who, dmg: sk.dmg,
      dieAt: this.time.now + (sk.range / sk.speed) * 1000,
    });
  }

  /* ── 루프 ─────────────────────────────────────────────────────────── */
  update(t) {
    if (this.over) return;

    this.stepPlayer(t);
    this.ai.update(t);

    for (const f of [this.player, this.enemy]) {
      this.resolveAction(f, t);
      f.syncVisual();
    }
    this.player.faceToward(this.enemy);
    this.enemy.faceToward(this.player);

    this.stepKnives(t);
    this.drawAimLayer(t);
    this.drawHud(t);
    this.checkEnd();
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

  stepKnives(t) {
    for (let i = this.knives.length - 1; i >= 0; i--) {
      const k = this.knives[i];
      const foe = k.owner === this.player ? this.enemy : this.player;

      const out = k.go.x < -40 || k.go.x > VIEW.W + 40 || k.go.y < -40 || k.go.y > VIEW.H + 40;
      let hit = false;

      if (foe.alive) {
        hit = Math.abs(k.go.x - foe.x) < foe.w / 2 + 8 &&
              Math.abs(k.go.y - foe.y) < foe.h / 2 + 4;
        if (hit && foe.takeHit(k.dmg, t, k.go.x, 120)) {
          this.burst(k.go.x, k.go.y, SKILLS.E.hue, 8);
        }
      }

      if (hit || out || t > k.dieAt) {
        k.go.destroy();
        this.knives.splice(i, 1);
      }
    }
  }

  /* ── 조준·예고 ────────────────────────────────────────────────────── */
  drawAimLayer(t) {
    const g = this.gAim;
    g.clear();

    // 플레이어 단검 조준선
    if (this.armed === 'E' && this.player.alive) {
      const ptr = this.input.activePointer;
      this.drawKnifeAim(g, this.player, ptr.worldX, ptr.worldY, C.player, 0.55);
    }

    // AI 예고 — 남은 시간이 짧을수록 진해진다
    if (this.ai.plan) {
      const pl = this.ai.plan;
      const left = Math.max(0, pl.fireAt - t);
      const urg = Phaser.Math.Clamp(1 - left / 300, 0.3, 1);

      if (pl.key === 'E') {
        this.drawKnifeAim(g, this.enemy, pl.aim.x, pl.aim.y, C.enemy, 0.3 + urg * 0.55);
      } else {
        const e = this.enemy;
        const base = e.facing > 0 ? 0 : Math.PI;
        const half = Phaser.Math.DegToRad(SKILLS.W.arc) / 2;
        g.fillStyle(C.enemy, 0.12 + urg * 0.22);
        g.beginPath();
        g.slice(e.x, e.y, SKILLS.W.reach, base - half, base + half, false);
        g.fillPath();
      }
    }

    // 시전 중 무기 방향 표시
    for (const f of [this.player, this.enemy]) {
      if (!f.alive) continue;
      g.lineStyle(3, C.steel, f.action ? 1 : 0.5);
      const len = f.action && f.action.key === 'W' ? 30 : 20;
      g.lineBetween(f.x, f.y - 6, f.x + f.facing * len, f.y - 12);
    }
  }

  drawKnifeAim(g, who, ax, ay, color, alpha) {
    const sk = SKILLS.E;
    const a = Phaser.Math.Angle.Between(who.x, who.y, ax, ay);
    const ex = who.x + Math.cos(a) * sk.range;
    const ey = who.y + Math.sin(a) * sk.range;

    g.lineStyle(2, color, alpha);
    g.lineBetween(who.x, who.y, ex, ey);
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
    const bx = VIEW.W / 2 - (SKILL_KEYS.length * 116) / 2;
    SKILL_KEYS.forEach((k, i) => {
      const x = bx + i * 116;
      this.slots[k] = {
        key: mk(x + 12, VIEW.H - 62, k, 16, C.bone),
        name: mk(x + 36, VIEW.H - 62, SKILLS[k].name, 13, C.bone),
        hint: mk(x + 36, VIEW.H - 45, SKILLS[k].hint, 10, C.dim),
        cd: mk(x + 96, VIEW.H - 62, '', 11, C.gold, 1),
      };
    });

    this.txtEnd = this.add.text(VIEW.W / 2, 210, '', {
      fontFamily: FONT, fontSize: '38px', color: '#e8e3d9', align: 'center',
    }).setOrigin(0.5).setDepth(40);
  }

  drawHud(t) {
    const g = this.gHud;
    g.clear();

    this.hpBar(g, 28, 42, 320, this.player, false);
    this.hpBar(g, VIEW.W - 28, 42, 320, this.enemy, true);

    const bx = VIEW.W / 2 - (SKILL_KEYS.length * 116) / 2;
    SKILL_KEYS.forEach((k, i) => {
      const x = bx + i * 116, y = VIEW.H - 68, w = 108, h = 46;
      const left = this.player.cdLeft(k, t);
      const ratio = left / SKILLS[k].cd;
      const on = this.armed === k;

      g.fillStyle(C.sky, 0.6).fillRect(x, y, w, h);
      if (ratio > 0) g.fillStyle(C.dim, 0.22).fillRect(x, y, w, h * ratio);
      g.lineStyle(on ? 2 : 1, on ? C.gold : C.line, on ? 1 : 0.8);
      g.strokeRect(x, y, w, h);

      const s = this.slots[k];
      s.cd.setText(left > 0 ? (left / 1000).toFixed(1) : '준비');
      s.cd.setColor(left > 0 ? '#7d8598' : '#d9a441');
    });

    this.txtHint.setText(
      this.armed === 'E'
        ? '단검 조준 중 — 좌클릭 투척 · ESC 취소'
        : `Q R 이동 · SPACE 점프 · W 참격 · E 단검    |    ${DIFFICULTY[this.difficulty].label} (1 2 3)`
    );
  }

  hpBar(g, x, y, w, f, flip) {
    const h = 14;
    const x0 = flip ? x - w : x;
    const fw = w * (f.hp / f.maxHp);
    g.fillStyle(C.sky, 0.65).fillRect(x0, y, w, h);
    g.fillStyle(f.color, 0.92).fillRect(flip ? x - fw : x0, y, fw, h);
    g.lineStyle(1, C.line, 0.9).strokeRect(x0, y, w, h);
  }

  /* ── 소품 ─────────────────────────────────────────────────────────── */
  popText(x, y, msg, color) {
    const o = this.add.text(x, y, msg, {
      fontFamily: FONT, fontSize: '15px',
      color: Phaser.Display.Color.IntegerToColor(color).rgba,
    }).setOrigin(0.5).setDepth(35);
    this.tweens.add({ targets: o, y: y - 28, alpha: 0, duration: 600, onComplete: () => o.destroy() });
  }

  burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 12 + Math.random() * 40;
      const p = this.add.circle(x, y, 2 + Math.random() * 2, color).setDepth(22);
      this.tweens.add({
        targets: p, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
        alpha: 0, duration: 280 + Math.random() * 280,
        onComplete: () => p.destroy(),
      });
    }
  }

  checkEnd() {
    if (this.over || (this.player.alive && this.enemy.alive)) return;
    this.over = true;
    this.armed = null;
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