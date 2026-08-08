import * as THREE from 'three';

/* ==========================================================================
 *  태양 — 시간에 따라 하늘을 가로지르며 위치가 바뀐다.
 *  DirectionalLight의 위치/그림자 카메라를 매 프레임 갱신해
 *  건물이 드리우는 그림자의 모양과 방향이 실시간으로 변하게 한다.
 * ========================================================================== */

const NIGHT_SKY = new THREE.Color(0x0a0d1a);
const DAY_SKY = new THREE.Color(0x8fb8e0);
const DUSK_SKY = new THREE.Color(0x3a2f4a);
const WARM_SUN = new THREE.Color(0xffab66);
const WHITE_SUN = new THREE.Color(0xfff4e0);
const ZENITH_NIGHT = new THREE.Color(0x00010a);
const ZENITH_DAY = new THREE.Color(0x1c5fa8);

const SKY_VERTEX_SHADER = `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAGMENT_SHADER = `
  uniform vec3 topColor;
  uniform vec3 bottomColor;
  varying vec3 vWorldPosition;
  void main() {
    float h = normalize(vWorldPosition).y;
    float t = smoothstep(-0.05, 0.55, h);
    gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
  }
`;

export class Sun {
  /**
   * @param {THREE.Scene} scene
   * @param {number} extent 도시 전체 크기 (그림자 카메라 범위 계산용)
   * @param {number} dayLength 낮/밤 한 주기의 길이(초)
   */
  constructor(scene, extent, dayLength = 150) {
    this.extent = extent;
    this.dayLength = dayLength;
    this.t = 0.12; // 이른 아침에서 시작 — 곧바로 긴 그림자를 볼 수 있게

    this.direction = new THREE.Vector3(0, 1, 0);
    this.isDaytime = true;
    this.elevation = 1;
    this.windowGlow = 0; // 0(대낮) ~ 1(밤) — 건물 창문 emissive 세기에 사용

    this.light = new THREE.DirectionalLight(0xffffff, 1.3);
    this.light.castShadow = true;
    const shadowHalf = extent * 0.62;
    this.light.shadow.camera.left = -shadowHalf;
    this.light.shadow.camera.right = shadowHalf;
    this.light.shadow.camera.top = shadowHalf;
    this.light.shadow.camera.bottom = -shadowHalf;
    this.light.shadow.camera.near = 1;
    this.light.shadow.camera.far = extent * 2.2;
    this.light.shadow.mapSize.set(2048, 2048);
    this.light.shadow.bias = -0.0015;
    scene.add(this.light);
    scene.add(this.light.target);

    this.ambient = new THREE.AmbientLight(0x3a4568, 0.55);
    scene.add(this.ambient);

    this.hemi = new THREE.HemisphereLight(0x8fb8e0, 0x23283a, 0.5);
    scene.add(this.hemi);

    this.dist = extent * 0.85;

    this.skyDome = this.buildSkyDome(extent);
    scene.add(this.skyDome);

    this.stars = this.buildStars(extent);
    scene.add(this.stars);
  }

  /** 하늘을 단색 대신 지평선→천정 그라디언트로 표현하는 대형 구체 */
  buildSkyDome(extent) {
    const radius = extent * 1.9;
    const geo = new THREE.SphereGeometry(radius, 24, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x0a0d1a) },
        bottomColor: { value: new THREE.Color(0x0a0d1a) },
      },
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  /** 밤하늘 상단에만 흩뿌린 별 — 낮에는 투명해진다 */
  buildStars(extent) {
    const radius = extent * 1.85;
    const count = 900;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.48; // 천정(0) ~ 지평선 근처까지, 상반구에만 분포
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      fog: false,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    points.renderOrder = -1;
    points.matrixAutoUpdate = false;
    points.updateMatrix();
    return points;
  }

  update(dt, scene, fog) {
    this.t = (this.t + dt / this.dayLength) % 1;
    const angle = this.t * Math.PI * 2;

    const dir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0.32).normalize();
    this.direction.copy(dir);
    this.elevation = dir.y;
    this.isDaytime = dir.y > 0.02;

    this.light.position.copy(dir).multiplyScalar(this.dist);
    this.light.target.position.set(0, 0, 0);
    this.light.target.updateMatrixWorld();

    const dayFactor = THREE.MathUtils.clamp(dir.y / 0.55, 0, 1);
    this.light.intensity = dayFactor * 2.0;
    this.windowGlow = 1 - THREE.MathUtils.smoothstep(dir.y, -0.05, 0.15);
    this.light.color.copy(WARM_SUN).lerp(WHITE_SUN, THREE.MathUtils.clamp(dir.y / 0.4, 0, 1));

    // 그늘/양지 바닥의 명암 대비를 키우기 위해 채움광(ambient/hemi)은 낮게, 직사광은 강하게 유지한다
    this.ambient.intensity = 0.12 + dayFactor * 0.26;
    this.hemi.intensity = 0.12 + dayFactor * 0.3;

    const nightMix = THREE.MathUtils.smoothstep(dir.y, -0.15, 0.05);
    const duskMix = 1 - THREE.MathUtils.smoothstep(Math.abs(dir.y), 0, 0.28);
    const sky = NIGHT_SKY.clone().lerp(DAY_SKY, nightMix).lerp(DUSK_SKY, duskMix * 0.5);
    scene.background = sky;
    if (fog) { fog.color.copy(sky); }

    const zenith = ZENITH_NIGHT.clone().lerp(ZENITH_DAY, nightMix).lerp(DUSK_SKY, duskMix * 0.35);
    this.skyDome.material.uniforms.bottomColor.value.copy(sky);
    this.skyDome.material.uniforms.topColor.value.copy(zenith);

    this.stars.material.opacity = THREE.MathUtils.clamp(1 - nightMix * 1.15, 0, 1) * 0.85;
  }

  /** 0(자정) ~ 0.25(일출) ~ 0.5(정오) ~ 0.75(일몰) 형태의 하루 진행률 */
  get progress() { return this.t; }
}
