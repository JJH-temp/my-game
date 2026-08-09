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
const BASE = import.meta.env.BASE_URL;
const CHARACTER_URL = `${BASE}models/ReadyPlayerMe.glb`; // 평범한 옷차림의 사람 아바타 — 애니메이션은 없음
// ReadyPlayerMe 아바타 자체엔 애니메이션이 없어, 같은 Mixamo 골격 구조(뼈 이름이
// "mixamorig:" 접두사만 다름)를 쓰는 Xbot.glb의 idle/walk 클립을 이름만 바꿔 이 모델에 재적용(리타겟)한다.
const ANIMATION_URL = `${BASE}models/Xbot.glb`;
// GLTFLoader가 트랙 이름을 만들 때 노드 이름의 콜론(:)을 제거하므로 "mixamorig:"가 아닌
// "mixamorig"만 남는다 (실측 확인됨: "mixamorig:Hips.position" → "mixamorigHips.position").
const ANIMATION_BONE_PREFIX = 'mixamorig';
const ANIMATION_POSITION_SCALE = 0.01; // Xbot 원본 골격(Armature.scale=0.01)만큼 위치 트랙도 같이 보정
const ANIMATION_CLIP_NAMES = ['idle', 'walk'];

const MODEL_FACING_OFFSET = Math.PI; // 모델의 정면축이 반대일 경우 여기서 180도 보정

/** Xbot 클립의 본 이름 접두사를 떼어 ReadyPlayerMe 골격에 맞춘다.
 *  위치(translation) 트랙(엉덩이 루트 모션)은 원본 골격 스케일만큼 다시 보정하지 않으면
 *  100배 과장된 움직임이 된다 — 회전(quaternion) 트랙은 스케일과 무관해 그대로 둔다. */
function retargetClip(clip) {
  const tracks = clip.tracks.map((track) => {
    const retargeted = track.clone();
    retargeted.name = track.name.replace(ANIMATION_BONE_PREFIX, '');
    if (retargeted.name.endsWith('.position')) {
      for (let i = 0; i < retargeted.values.length; i++) retargeted.values[i] *= ANIMATION_POSITION_SCALE;
    }
    return retargeted;
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/** 캐릭터 모델(~1.8MB)과 애니메이션 소스(~2.9MB)는 세션당 한 번만 받고 캐싱해 재사용한다 */
let assetsPromise = null;
function loadAssets() {
  if (!assetsPromise) {
    const loader = new GLTFLoader();
    assetsPromise = Promise.all([
      loader.loadAsync(CHARACTER_URL),
      loader.loadAsync(ANIMATION_URL),
    ]).then(([character, animSource]) => {
      const clips = {};
      for (const clip of animSource.animations) {
        if (ANIMATION_CLIP_NAMES.includes(clip.name)) clips[clip.name] = retargetClip(clip);
      }
      return { scene: character.scene, clips };
    });
  }
  return assetsPromise;
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

    this.ready = loadAssets().then(({ scene, clips }) => this.onAssetsLoaded(scene, clips));
  }

  /** 캐싱된 GLTF 씬은 여러 Player 인스턴스(재시작 등)가 공유할 수 있으므로 매번 복제해 사용한다 */
  onAssetsLoaded(sourceScene, clips) {
    // 일반 Object3D.clone(true)은 스켈레톤의 본 참조를 복제된 계층과 다시 연결해주지 않아
    // (원본의 고아 본을 그대로 참조) 스키닝이 깨진다 — 리깅된 모델은 SkeletonUtils로 복제해야 한다
    const model = cloneSkinned(sourceScene);
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
    for (const name of ['idle', 'walk']) {
      if (clips[name]) this.actions[name] = this.mixer.clipAction(clips[name]);
    }
    this.currentAction = this.actions.idle;
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

  /** 이동 여부에 따라 idle/walk 애니메이션을 크로스페이드로 전환한다 */
  updateAnimation(moving, dt) {
    if (!this.mixer) return;
    const next = moving ? this.actions.walk : this.actions.idle;
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
