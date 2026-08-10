import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const BASE_SPEED = 6.6;
const TURN_SPEED = 14;
const RADIUS = 0.4;

const JUMP_SPEED = 7.2;
const GRAVITY = 20;

const BURN_RATE = 15; // 태양 아래에서 초당 감소하는 체력
const REGEN_RATE = 9; // 그늘/밤에서 초당 회복하는 체력

const COLOR_BURN = 0xff5a3c;

// 캐릭터 색상 — 단색 화이트의 아이콘 같은 미니멀 룩
const COLOR_MAIN = 0xffffff;

// 몸통(둥근 모서리 직육면체) 치수
const TORSO_WIDTH = 0.56;
const TORSO_HEIGHT = 0.82;
const TORSO_DEPTH = 0.36;
const TORSO_CORNER_RADIUS = 0.14;

const HEAD_RADIUS = 0.24;
const HEAD_TORSO_GAP = 0.02; // 머리 밑면과 몸통 윗면 사이 간격

// 팔/다리 치수 — [반지름, 길이(캡슐 원통 구간)]
const ARM_RADIUS = 0.1;
const ARM_LENGTH = 0.38;
const LEG_RADIUS = 0.15;
const LEG_LENGTH = 0.48;
const LEG_TORSO_OVERLAP = 0.06; // 다리 피벗을 몸통 안쪽으로 밀어넣어 이음매를 좁힌다

// 머리 위 체력바 — 항상 카메라를 향하는 3D 빌보드
const HEALTHBAR_WIDTH = 0.6;
const HEALTHBAR_HEIGHT = 0.08;
const HEALTHBAR_MARGIN = 0.14; // 머리 꼭대기에서 바까지의 여백
const HEALTHBAR_BG = 0x1c2230;
const HEALTHBAR_FILL = 0x4ecb8f;
const HEALTHBAR_FILL_LOW = 0xe0574a;
const HEALTHBAR_LOW_THRESHOLD = 0.3;

// 걷기/숨쉬기 절차적 애니메이션 파라미터
const WALK_CYCLE_SPEED = 9;
const LIMB_SWING_AMPLITUDE = 0.75; // rad
const WALK_BOB_AMPLITUDE = 0.045;
const IDLE_BOB_SPEED = 1.6;
const IDLE_BOB_AMPLITUDE = 0.02;
const ANIM_BLEND_SPEED = 8;

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

    this.bodyMats = [];
    this.walkT = 0; // 걷기 사이클 진행도
    this.idleT = 0; // 대기 상태 숨쉬기 진행도
    this.moveBlend = 0; // 0(정지)~1(이동) 크로스페이드

    this.buildModel();
    this.buildHealthBar(scene);

    // 화상 파티클을 위한 포인트라이트 — 태양에 노출되면 붉게 빛난다
    this.burnLight = new THREE.PointLight(COLOR_BURN, 0, 4, 2);
    this.burnLight.position.y = 1.1;
    this.root.add(this.burnLight);

    this.ready = Promise.resolve();
  }

  /** 머리 위에 항상 카메라를 향하는 체력바(배경 + 채움)를 만든다. 회전은 매 프레임 카메라 쿼터니언을 그대로 복사해 구현한다(빌보드) */
  buildHealthBar(scene) {
    this.healthBar = new THREE.Group();
    scene.add(this.healthBar);

    const bgGeo = new THREE.PlaneGeometry(HEALTHBAR_WIDTH + 0.03, HEALTHBAR_HEIGHT + 0.03);
    const bgMat = new THREE.MeshBasicMaterial({ color: HEALTHBAR_BG, transparent: true, opacity: 0.75, depthWrite: false });
    this.healthBar.add(new THREE.Mesh(bgGeo, bgMat));

    // 왼쪽 끝을 기준점으로 두어 scale.x만으로 왼쪽 정렬된 채움 애니메이션을 만든다
    const fillGeo = new THREE.PlaneGeometry(HEALTHBAR_WIDTH, HEALTHBAR_HEIGHT);
    fillGeo.translate(HEALTHBAR_WIDTH / 2, 0, 0);
    this.healthBarFillMat = new THREE.MeshBasicMaterial({ color: HEALTHBAR_FILL, depthWrite: false });
    this.healthBarFill = new THREE.Mesh(fillGeo, this.healthBarFillMat);
    this.healthBarFill.position.set(-HEALTHBAR_WIDTH / 2, 0, 0.001);
    this.healthBar.add(this.healthBarFill);

    this._headWorldPos = new THREE.Vector3();
  }

  /** 머리 위치를 따라가며 카메라를 향하도록(빌보드) 매 프레임 호출 */
  updateHealthBar(camera) {
    this.head.getWorldPosition(this._headWorldPos);
    this.healthBar.position.copy(this._headWorldPos);
    this.healthBar.position.y += HEAD_RADIUS + HEALTHBAR_MARGIN;
    this.healthBar.quaternion.copy(camera.quaternion);

    const pct = THREE.MathUtils.clamp(this.hp / this.maxHp, 0, 1);
    this.healthBarFill.scale.x = pct;
    this.healthBarFillMat.color.set(pct <= HEALTHBAR_LOW_THRESHOLD ? HEALTHBAR_FILL_LOW : HEALTHBAR_FILL);
  }

  /** 화이트 단색의 둥근 프리미티브만으로 아이콘 같은 사람을 조립한다 */
  buildModel() {
    const mainMat = new THREE.MeshStandardMaterial({ color: COLOR_MAIN, roughness: 0.55 });
    this.bodyMats.push(mainMat);

    const body = new THREE.Group();
    this.root.add(body);
    this.bodyGroup = body;

    // 몸통 — 모서리가 둥근 직육면체
    // HIP_Y는 다리 피벗(HIP_Y + LEG_TORSO_OVERLAP)에서 다리 전체 길이(LEG_LENGTH + 2*LEG_RADIUS)를
    // 뺀 값이 0이 되도록 잡아야 발이 정확히 지면(y=0)에 닿는다.
    const HIP_Y = LEG_LENGTH + 2 * LEG_RADIUS - LEG_TORSO_OVERLAP;
    const torso = new THREE.Mesh(
      new RoundedBoxGeometry(TORSO_WIDTH, TORSO_HEIGHT, TORSO_DEPTH, 4, TORSO_CORNER_RADIUS),
      mainMat,
    );
    torso.position.y = HIP_Y + TORSO_HEIGHT / 2;
    torso.castShadow = true;
    torso.receiveShadow = true;
    body.add(torso);

    // 머리 — 몸통 위에 살짝 간격을 두고 얹은 매끈한 구
    const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 24, 16), mainMat);
    head.position.y = HIP_Y + TORSO_HEIGHT + HEAD_RADIUS + HEAD_TORSO_GAP;
    head.castShadow = true;
    head.receiveShadow = true;
    body.add(head);
    this.head = head;

    // 팔/다리 — 어깨·엉덩이에 피벗을 두고 캡슐(끝이 둥근 원통)을 매달아 회전만으로 스윙
    const SHOULDER_Y = HIP_Y + TORSO_HEIGHT - 0.1;
    const LEG_PIVOT_Y = HIP_Y + LEG_TORSO_OVERLAP;
    this.leftArm = this.buildLimb(body, mainMat, ARM_RADIUS, ARM_LENGTH, [-0.36, SHOULDER_Y, 0]);
    this.rightArm = this.buildLimb(body, mainMat, ARM_RADIUS, ARM_LENGTH, [0.36, SHOULDER_Y, 0]);
    this.leftLeg = this.buildLimb(body, mainMat, LEG_RADIUS, LEG_LENGTH, [-0.15, LEG_PIVOT_Y, 0]);
    this.rightLeg = this.buildLimb(body, mainMat, LEG_RADIUS, LEG_LENGTH, [0.15, LEG_PIVOT_Y, 0]);

    this.model = body;
  }

  /** 피벗 그룹 + 아래로 매달린 캡슐(끝이 둥근 원통) 메시. 피벗을 회전시키면 팔다리가 스윙한다 */
  buildLimb(parent, material, radius, length, [x, y, z]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    parent.add(pivot);

    const totalLength = length + radius * 2;
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 10), material);
    mesh.position.y = -totalLength / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pivot.add(mesh);

    return pivot;
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

  /** 이동 여부에 따라 걷기(팔다리 스윙)와 대기(숨쉬기) 자세를 크로스페이드로 섞는다 */
  updateAnimation(moving, dt) {
    this.moveBlend = THREE.MathUtils.lerp(this.moveBlend, moving ? 1 : 0, Math.min(1, ANIM_BLEND_SPEED * dt));
    this.walkT += dt * WALK_CYCLE_SPEED;
    this.idleT += dt * IDLE_BOB_SPEED;

    const swing = Math.sin(this.walkT) * LIMB_SWING_AMPLITUDE * this.moveBlend;
    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;
    this.leftArm.rotation.x = -swing * 0.85;
    this.rightArm.rotation.x = swing * 0.85;

    const walkBob = Math.abs(Math.sin(this.walkT)) * WALK_BOB_AMPLITUDE * this.moveBlend;
    const idleBob = Math.sin(this.idleT) * IDLE_BOB_AMPLITUDE * (1 - this.moveBlend);
    this.bodyGroup.position.y = walkBob + idleBob;
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
    }
  }
}
