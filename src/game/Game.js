import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { generateCity } from './City.js';
import { Sun } from './Sun.js';
import { Player } from './Player.js';
import { Minimap } from './Minimap.js';

const GOAL_RADIUS = 3;
const UP = new THREE.Vector3(0, 1, 0);

/* 해의 위치 HUD — 일출~일몰을 그리는 타원 아치 (index.html의 #sunArc viewBox와 일치해야 함) */
const SUN_ARC = { cx: 86, cy: 46, rx: 76, ry: 38 };

/* 마우스 시점 — Pointer Lock으로 커서를 가두고, 마인크래프트처럼 이동량만큼 그대로 시점을 돌린다 */
const YAW_SENSITIVITY = 0.0022;   // rad / px
const PITCH_SENSITIVITY = 0.0022; // rad / px
const PITCH_MIN = -1.5;
const PITCH_MAX = 1.5;
const DIST_MIN = 4;
const DIST_MAX = 20;
const ZOOM_SPEED = 0.0016;

/* ==========================================================================
 *  그림자 도시 — 태양을 피해 그늘만 밟고 목적지에 도달하는 3D 생존 게임.
 * ========================================================================== */
export class Game {
  constructor() {
    this.dom = {
      container: document.getElementById('game'),
      loading: document.getElementById('loading'),
      burnVignette: document.getElementById('burnVignette'),
      hpFill: document.getElementById('hpFill'),
      hpNum: document.getElementById('hpNum'),
      statusTag: document.getElementById('statusTag'),
      sunDot: document.getElementById('sunDot'),
      sunArcFill: document.getElementById('sunArcFill'),
      dayTime: document.getElementById('dayTime'),
      goalDist: document.getElementById('goalDist'),
      minimapCanvas: document.getElementById('minimap'),
      pointerLockOverlay: document.getElementById('pointerLockOverlay'),
      endScreen: document.getElementById('endScreen'),
      endTitle: document.getElementById('endTitle'),
      endSub: document.getElementById('endSub'),
      restartBtn: document.getElementById('restartBtn'),
    };

    this.state = 'playing'; // 'playing' | 'won' | 'lost'
    this.keys = new Set();
    this.jumpQueued = false;
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();

    this.initScene();
    this.initCity();
    this.initCamera();
    this.initPostFX();
    this.initInput();

    if (import.meta.env.DEV) window.__game = this;
    // 캐릭터 모델(비동기 로딩) 준비가 끝난 뒤에야 로딩 화면을 내리고 루프를 시작한다
    this.player.ready.then(() => {
      this.dom.loading.style.display = 'none';
      requestAnimationFrame(() => this.loop());
    });
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.fog = new THREE.Fog(0x141824, 40, 210);
    this.scene.fog = this.fog;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.dom.container.appendChild(this.renderer.domElement);

    window.addEventListener('resize', () => this.onResize());
  }

  initCity() {
    this.city = generateCity(this.scene);
    this.fog.far = this.city.extent * 1.1;
    this.sun = new Sun(this.scene, this.city.extent);
    this.player = new Player(this.scene, this.city.spawn);
    this.buildGoalBeacon();
    this.minimap = new Minimap(this.dom.minimapCanvas, this.city);
  }

  buildGoalBeacon() {
    const g = this.city.goal;
    const group = new THREE.Group();
    group.position.set(g.x, 0, g.z);

    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0xd9a441, emissive: 0xd9a441, emissiveIntensity: 0.8, roughness: 0.4 }),
    );
    pillar.position.y = 3;
    group.add(pillar);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.4, 0.08, 8, 32),
      new THREE.MeshStandardMaterial({ color: 0xffd280, emissive: 0xffd280, emissiveIntensity: 1 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.4;
    group.add(ring);
    this.goalRing = ring;

    const light = new THREE.PointLight(0xffcf6b, 2.2, 18, 2);
    light.position.y = 3;
    group.add(light);

    this.scene.add(group);
  }

  initCamera() {
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 400);
    const s = this.city.spawn;

    // 스폰 지점에서 도시 중심(목적지 방향)을 바라보도록 초기 시점을 잡는다
    const intoCity = new THREE.Vector3(-s.x, 0, -s.z).normalize();
    this.camYaw = Math.atan2(intoCity.x, intoCity.z);
    this.camPitch = 0.58;
    this.camDist = 12;
    this.camTarget = new THREE.Vector3(s.x, 1.2, s.z);

    this.updateCameraTransform();
  }

  /** 태양/골 비콘/창문 같은 밝은 지점에 은은한 블룸 발광을 더한다 */
  initPostFX() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.55, // strength
      0.45, // radius
      0.82, // threshold
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  initInput() {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
      if (e.key.toLowerCase() === 'r' && this.state !== 'playing') this.restart();
      if (e.code === 'Space') {
        e.preventDefault(); // 스페이스바의 기본 페이지 스크롤 동작 방지
        if (!e.repeat) this.jumpQueued = true;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    this.dom.restartBtn.addEventListener('click', () => this.restart());

    // 마우스 시점 — 클릭해서 포인터를 잠그면, 이후 마우스 이동량만큼 시점이 그대로 회전한다 (마인크래프트 방식)
    const canvas = this.renderer.domElement;
    this.pointerLocked = false;

    const requestLock = () => {
      if (this.state === 'playing') canvas.requestPointerLock();
    };
    canvas.addEventListener('click', requestLock);
    this.dom.pointerLockOverlay.addEventListener('click', requestLock);

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      this.dom.pointerLockOverlay.classList.toggle('show', !this.pointerLocked && this.state === 'playing');
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.camYaw -= e.movementX * YAW_SENSITIVITY;
      this.camPitch = THREE.MathUtils.clamp(
        this.camPitch + e.movementY * PITCH_SENSITIVITY,
        PITCH_MIN, PITCH_MAX,
      );
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camDist = THREE.MathUtils.clamp(this.camDist + e.deltaY * ZOOM_SPEED * this.camDist, DIST_MIN, DIST_MAX);
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.dom.pointerLockOverlay.classList.add('show');
  }

  updateCameraTransform() {
    const horiz = this.camDist * Math.cos(this.camPitch);
    const height = this.camDist * Math.sin(this.camPitch);
    this.camera.position.set(
      this.camTarget.x - Math.sin(this.camYaw) * horiz,
      this.camTarget.y + height,
      this.camTarget.z - Math.cos(this.camYaw) * horiz,
    );
    this.camera.lookAt(this.camTarget);
  }

  restart() { window.location.reload(); }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  /** 카메라 시점 기준 WASD 이동 벡터 (XZ 평면) */
  computeMoveDir() {
    const forward = new THREE.Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    const right = new THREE.Vector3().crossVectors(forward, UP).normalize();

    const dir = new THREE.Vector3();
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) dir.add(forward);
    if (k.has('s') || k.has('arrowdown')) dir.sub(forward);
    if (k.has('d') || k.has('arrowright')) dir.add(right);
    if (k.has('a') || k.has('arrowleft')) dir.sub(right);
    if (dir.lengthSq() > 1e-6) dir.normalize();
    return dir;
  }

  /** 플레이어가 태양을 향해 가려진 것 없이 노출돼 있는지 검사 */
  computeShadeStatus() {
    if (!this.sun.isDaytime) return 'night';
    const origin = new THREE.Vector3(this.player.position.x, 1.0, this.player.position.z);
    this.raycaster.set(origin, this.sun.direction);
    this.raycaster.far = this.city.extent * 1.5;
    const hits = this.raycaster.intersectObjects(this.city.occluders, false);
    return hits.length > 0 ? 'shade' : 'sun';
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(this.clock.getDelta(), 0.1);

    if (this.state === 'playing') {
      this.sun.update(dt, this.scene, this.fog);
      this.updateBuildingWindows(dt);

      const moveDir = this.computeMoveDir();
      const jumpPressed = this.jumpQueued;
      this.jumpQueued = false;
      this.player.update(moveDir, dt, this.city.collisionBoxes, this.city.half, jumpPressed);

      const status = this.computeShadeStatus();
      this.player.applyEnvironment(status, dt);

      this.goalRing.rotation.z += dt * 0.6;

      this.camTarget.set(this.player.position.x, 1.2, this.player.position.z);

      this.checkOutcome();
    }

    this.updateCameraTransform();
    this.composer.render();
    this.updateHud();
  }

  /** 해가 지면서 건물 창문이 서서히 켜지도록 emissiveIntensity를 보간한다 */
  updateBuildingWindows(dt) {
    const glow = this.sun.windowGlow;
    for (const w of this.city.windowMats) {
      const target = w.target * glow;
      w.mat.emissiveIntensity = THREE.MathUtils.lerp(w.mat.emissiveIntensity, target, Math.min(1, dt * 2));
    }
  }

  checkOutcome() {
    if (!this.player.alive) {
      this.finish('lost', '타 버렸습니다', '그늘을 더 자주 이용해 체력을 지키세요.');
      return;
    }
    const dx = this.player.position.x - this.city.goal.x;
    const dz = this.player.position.z - this.city.goal.z;
    if (Math.hypot(dx, dz) < GOAL_RADIUS) {
      this.finish('won', '목적지 도착', '그림자만 밟고 무사히 도착했습니다.');
      return;
    }
    if (!this.sun.isDaytime) {
      this.finish('lost', '밤이 되었습니다', '해가 지기 전에 목적지에 도착하지 못했습니다.');
    }
  }

  finish(state, title, sub) {
    this.state = state;
    if (document.pointerLockElement) document.exitPointerLock();
    this.dom.pointerLockOverlay.classList.remove('show');
    this.dom.endScreen.classList.add('show');
    this.dom.endTitle.textContent = title;
    this.dom.endTitle.className = state === 'won' ? 'win' : 'lose';
    this.dom.endSub.textContent = sub;
  }

  updateHud() {
    const p = this.player;
    const hpPct = Math.round((p.hp / p.maxHp) * 100);
    this.dom.hpFill.style.width = `${hpPct}%`;
    this.dom.hpFill.classList.toggle('low', hpPct <= 30);
    this.dom.hpNum.textContent = Math.round(p.hp);

    const tag = this.dom.statusTag;
    const labels = { sun: '☀ 태양 노출 — 화상 중', shade: '⛅ 그늘 — 안전', night: '🌙 밤 — 안전' };
    tag.textContent = labels[p.status];
    tag.className = p.status;

    this.dom.burnVignette.classList.toggle('on', p.burning);

    const t = this.sun.progress;
    // f: 일출(0)~일몰(1) 진행률. 밤에는 1을 넘어가는데, 같은 공식이 그대로
    // 해를 지평선 아래·아치 뷰박스 밖으로 내려보내 자연스럽게 사라지게 한다.
    const f = t / 0.5;
    const angle = Math.PI * (1 - f);
    this.dom.sunDot.setAttribute('cx', SUN_ARC.cx + SUN_ARC.rx * Math.cos(angle));
    this.dom.sunDot.setAttribute('cy', SUN_ARC.cy - SUN_ARC.ry * Math.sin(angle));
    this.dom.sunArcFill.style.strokeDashoffset = `${100 - THREE.MathUtils.clamp(f, 0, 1) * 100}`;
    // t=0 일출(06:00), t=0.25 정오(12:00), t=0.5 일몰(18:00), t=0.75 자정(00:00)
    const clock = (t + 0.25) % 1;
    const hours = Math.floor(clock * 24);
    const mins = Math.floor((clock * 24 * 60) % 60);
    this.dom.dayTime.textContent = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;

    const dist = Math.hypot(p.position.x - this.city.goal.x, p.position.z - this.city.goal.z);
    this.dom.goalDist.textContent = `${Math.max(0, Math.round(dist))}m`;

    this.minimap.draw(p, this.sun.direction, this.sun.isDaytime);
  }
}
