import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const BASE_SPEED = 6.6;
const TURN_SPEED = 14;
const RADIUS = 0.4;

const JUMP_SPEED = 7.2;
const GRAVITY = 20;

const BURN_RATE = 15; // 태양 아래에서 초당 감소하는 체력
const REGEN_RATE = 9; // 그늘/밤에서 초당 회복하는 체력

const COLOR_BURN = 0xff5a3c;

// import.meta.env.BASE_URL: 배포 시 '/my-game/' 하위 경로로 서빙되므로 절대 경로 대신 이걸 사용한다
const MODEL_URL = `${import.meta.env.BASE_URL}models/Soldier.glb`;
// Soldier.glb는 루트 노드(Character)에 실제 사람 키(약 1.8m)로 맞춘 scale=0.01과
// Z-up→Y-up 회전 보정이 이미 내장돼 있다. 여기서 또 축소하면 각인이 겹쳐 눈에 안 보이는
// 크기(약 2cm)가 되므로 추가 스케일은 주지 않는다.
const MODEL_FACING_OFFSET = Math.PI; // 모델의 정면축이 반대일 경우 여기서 180도 보정

/** Soldier.glb는 용량이 있어(약 2MB) 세션당 한 번만 받고 캐싱해 재사용한다 */
let modelPromise = null;
function loadModel() {
  if (!modelPromise) modelPromise = new GLTFLoader().loadAsync(MODEL_URL);
  return modelPromise;
}

export class Player {
  constructor(scene, spawnPos) {
    this.radius = RADIUS;
    this.maxHp = 100;
    this.hp = 100;
    this.alive = true;
    this.burning = false;
    this.status = 'shade'; // 'sun' | 'shade' | 'night'

    this.position = spawnPos.clone();
    this.facing = 0; // Y축 회전(라디안)
    this.velocityXZ = new THREE.Vector2();

    this.height = 0;
    this.velocityY = 0;
    this.grounded = true;

    this.root = new THREE.Group();
    this.root.position.copy(this.position);
    scene.add(this.root);

    this.model = null;
    this.mixer = null;
    this.actions = {};
    this.currentAction = null;
    this.bodyMats = [];

    // 화상 파티클을 위한 포인트라이트 — 태양에 노출되면 붉게 빛난다
    this.burnLight = new THREE.PointLight(COLOR_BURN, 0, 4, 2);
    this.burnLight.position.y = 1.1;
    this.root.add(this.burnLight);

    this.ready = loadModel().then((gltf) => this.onModelLoaded(gltf));
  }

  /** 캐싱된 GLTF는 여러 Player 인스턴스(재시작 등)가 공유할 수 있으므로 매번 복제해 사용한다 */
  onModelLoaded(gltf) {
    // 일반 Object3D.clone(true)은 스켈레톤의 본 참조를 복제된 계층과 다시 연결해주지 않아
    // (원본의 고아 본을 그대로 참조) 스키닝이 깨진다 — 리깅된 모델은 SkeletonUtils로 복제해야 한다
    const model = cloneSkinned(gltf.scene);
    model.rotation.y = MODEL_FACING_OFFSET;
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        this.bodyMats.push(o.material);
      }
    });
    this.root.add(model);
    this.model = model;

    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      if (clip.name === 'Idle' || clip.name === 'Walk') {
        this.actions[clip.name] = this.mixer.clipAction(clip);
      }
    }
    this.currentAction = this.actions.Idle;
    this.currentAction.play();
  }

  /**
   * @param {THREE.Vector3} moveDir 정규화된 XZ 이동 방향 (월드 좌표계)
   * @param {boolean} jumpPressed 이번 프레임에 점프가 요청되었는지
   */
  update(moveDir, dt, collisionBoxes, worldHalf, jumpPressed) {
    if (!this.alive) return;

    const moving = moveDir.lengthSq() > 0.0001;
    if (moving) {
      this.position.x += moveDir.x * BASE_SPEED * dt;
      this.position.z += moveDir.z * BASE_SPEED * dt;

      const targetFacing = Math.atan2(moveDir.x, moveDir.z);
      let delta = targetFacing - this.facing;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.facing += delta * Math.min(1, TURN_SPEED * dt);
    }

    this.resolveCollisions(collisionBoxes);

    const bound = worldHalf - this.radius - 0.2;
    this.position.x = THREE.MathUtils.clamp(this.position.x, -bound, bound);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -bound, bound);

    if (jumpPressed && this.grounded) {
      this.velocityY = JUMP_SPEED;
      this.grounded = false;
    }
    this.velocityY -= GRAVITY * dt;
    this.height += this.velocityY * dt;
    if (this.height <= 0) {
      this.height = 0;
      this.velocityY = 0;
      this.grounded = true;
    }

    this.root.position.set(this.position.x, this.height, this.position.z);
    this.root.rotation.y = this.facing;

    this.updateAnimation(moving, dt);
  }

  /** 이동 여부에 따라 Idle/Walk 애니메이션을 크로스페이드로 전환한다 */
  updateAnimation(moving, dt) {
    if (!this.mixer) return;
    const next = moving ? this.actions.Walk : this.actions.Idle;
    if (next && next !== this.currentAction) {
      next.reset().play();
      next.crossFadeFrom(this.currentAction, 0.25, false);
      this.currentAction = next;
    }
    this.mixer.update(dt);
  }

  resolveCollisions(collisionBoxes) {
    for (let pass = 0; pass < 2; pass++) {
      for (const box of collisionBoxes) {
        const cx = THREE.MathUtils.clamp(this.position.x, box.minX, box.maxX);
        const cz = THREE.MathUtils.clamp(this.position.z, box.minZ, box.maxZ);
        const dx = this.position.x - cx;
        const dz = this.position.z - cz;
        const distSq = dx * dx + dz * dz;
        if (distSq >= this.radius * this.radius || distSq < 1e-9) continue;
        const dist = Math.sqrt(distSq);
        const push = (this.radius - dist) / dist;
        this.position.x += dx * push;
        this.position.z += dz * push;
      }
    }
  }

  /** @param {'sun'|'shade'|'night'} status */
  applyEnvironment(status, dt) {
    if (!this.alive) return;
    this.status = status;
    this.burning = status === 'sun';

    if (this.burning) {
      this.hp -= BURN_RATE * dt;
    } else {
      this.hp = Math.min(this.maxHp, this.hp + REGEN_RATE * dt);
    }
    this.hp = THREE.MathUtils.clamp(this.hp, 0, this.maxHp);

    this.burnLight.intensity = THREE.MathUtils.lerp(this.burnLight.intensity, this.burning ? 2.4 : 0, Math.min(1, dt * 8));

    for (const mat of this.bodyMats) {
      mat.emissive.set(this.burning ? COLOR_BURN : 0x000000);
      mat.emissiveIntensity = THREE.MathUtils.lerp(mat.emissiveIntensity, this.burning ? 0.55 : 0, Math.min(1, dt * 8));
    }

    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      if (this.currentAction) this.currentAction.paused = true;
    }
  }
}
