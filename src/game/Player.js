import * as THREE from 'three';

const BASE_SPEED = 6.6;
const TURN_SPEED = 14;
const RADIUS = 0.4;

const JUMP_SPEED = 7.2;
const GRAVITY = 20;

const BURN_RATE = 15; // 태양 아래에서 초당 감소하는 체력
const REGEN_RATE = 9; // 그늘/밤에서 초당 회복하는 체력

const COLOR = 0x4ecb8f;
const COLOR_BURN = 0xff5a3c;

const RIM_VERTEX_SHADER = `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;
const RIM_FRAGMENT_SHADER = `
  uniform vec3 color;
  uniform float intensity;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vec3 viewDir = normalize(vViewPosition);
    float fresnel = pow(1.0 - max(dot(normalize(vNormal), viewDir), 0.0), 2.4);
    gl_FragColor = vec4(color, fresnel * intensity);
  }
`;

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

    const bodyMat = new THREE.MeshStandardMaterial({ color: COLOR, roughness: 0.55, metalness: 0.1 });
    this.bodyMat = bodyMat;

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(RADIUS, 0.85, 6, 12), bodyMat);
    body.position.y = RADIUS + 0.425;
    body.castShadow = true;
    body.receiveShadow = true;
    this.root.add(body);

    // 실루엣을 강조하는 fresnel 림 라이트 — 몸체보다 살짝 큰 쉘에 가장자리만 빛나는 셰이더를 입힌다
    this.rimMat = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(COLOR) },
        intensity: { value: 0.9 },
      },
      vertexShader: RIM_VERTEX_SHADER,
      fragmentShader: RIM_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
    });
    const rim = new THREE.Mesh(new THREE.CapsuleGeometry(RADIUS * 1.12, 0.85, 6, 12), this.rimMat);
    rim.position.y = RADIUS + 0.425;
    this.root.add(rim);

    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.14),
      new THREE.MeshStandardMaterial({ color: 0xe8e3d9, roughness: 0.4 }),
    );
    visor.position.set(0, RADIUS + 0.85, RADIUS + 0.04);
    visor.castShadow = true;
    this.root.add(visor);

    // 화상 파티클을 위한 포인트라이트 — 태양에 노출되면 붉게 빛난다
    this.burnLight = new THREE.PointLight(COLOR_BURN, 0, 4, 2);
    this.burnLight.position.y = 1.1;
    this.root.add(this.burnLight);
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
    this.bodyMat.emissive.set(this.burning ? COLOR_BURN : 0x000000);
    this.bodyMat.emissiveIntensity = this.burning ? 0.55 : 0;

    const rimTargetIntensity = this.burning ? 1.6 : (status === 'night' ? 1.1 : 0.7);
    const rimTargetColor = this.burning ? COLOR_BURN : COLOR;
    this.rimMat.uniforms.color.value.lerp(new THREE.Color(rimTargetColor), Math.min(1, dt * 8));
    this.rimMat.uniforms.intensity.value = THREE.MathUtils.lerp(
      this.rimMat.uniforms.intensity.value, rimTargetIntensity, Math.min(1, dt * 8),
    );

    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
  }
}
