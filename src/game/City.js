import * as THREE from 'three';

/* ==========================================================================
 *  절차적 도시 생성 — 격자 위에 건물/가로수를 배치한다.
 *
 *  건물과 가로수는 두 가지 역할을 동시에 한다.
 *    1) collisionBoxes — 플레이어가 통과할 수 없는 장애물 (XZ 평면 AABB)
 *    2) occluders       — 태양 광선을 가리는 그늘의 원천 (raycast 대상 메시)
 * ========================================================================== */

export const CITY = {
  gridSize: 12,
  cellSize: 16,
  buildingChance: 0.6,
  minHeight: 6,
  maxHeight: 46,
  treeChance: 0.16,
};

const PALETTE = [0x3a4356, 0x424c62, 0x37415a, 0x4a5570, 0x2f3648, 0x4e5a78];

const WINDOW_TEX_SIZE = 128;
const WINDOW_LIGHT_COLOR = 0xffd9a0;
const WINDOW_PATTERN_COUNT = 4;

/** 창문 배치를 흑백 캔버스로 절차 생성한다 — emissiveMap으로 사용해 밤에 불이 켜진 것처럼 보이게 한다 */
function makeWindowTexture(rand) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = WINDOW_TEX_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, WINDOW_TEX_SIZE, WINDOW_TEX_SIZE);

  const cols = 8;
  const rows = 8;
  const cellW = WINDOW_TEX_SIZE / cols;
  const cellH = WINDOW_TEX_SIZE / rows;
  const pad = cellW * 0.22;
  const windowSlot = 0.55 + rand() * 0.25; // 건물마다 창문칸 밀도가 조금씩 다르다
  const litChance = 0.4 + rand() * 0.3;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (rand() > windowSlot || rand() > litChance) continue;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(c * cellW + pad, r * cellH + pad * 1.4, cellW - pad * 2, cellH - pad * 2.4);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** footprint/height에 맞춰 창문 텍스처를 복제하고 반복 횟수를 지정한다 */
function fitWindowTexture(pattern, footprint, height) {
  const tex = pattern.clone();
  tex.needsUpdate = true;
  tex.repeat.set(Math.max(1, Math.round(footprint / 4)), Math.max(1, Math.round(height / 4)));
  return tex;
}

function makeBuildingMaterial(color, windowTex) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    metalness: 0.05,
    emissive: WINDOW_LIGHT_COLOR,
    emissiveMap: windowTex,
    emissiveIntensity: 0,
  });
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateCity(scene, seed = Date.now() & 0xffffffff) {
  const rand = mulberry32(seed);
  const { gridSize, cellSize, buildingChance, minHeight, maxHeight, treeChance } = CITY;
  const extent = gridSize * cellSize;
  const half = extent / 2;

  const group = new THREE.Group();
  scene.add(group);

  const occluders = [];
  const collisionBoxes = [];
  const buildingMeta = []; // for minimap
  const windowMats = []; // { mat, target } — 밤에 emissiveIntensity를 올릴 건물 창문 재질

  const windowPatterns = Array.from({ length: WINDOW_PATTERN_COUNT }, () => makeWindowTexture(rand));

  // ── 바닥 ────────────────────────────────────────────────────────────
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(extent * 1.6, extent * 1.6),
    new THREE.MeshStandardMaterial({ color: 0x252c42, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const grid = new THREE.GridHelper(extent, gridSize, 0x4a5570, 0x2a3040);
  grid.position.y = 0.02;
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  group.add(grid);

  // 시작/도착 칸은 항상 비워 둔다 (반경 1칸)
  const spawnCell = { i: 0, j: 0 };
  const goalCell = { i: gridSize - 1, j: gridSize - 1 };
  const isClearCell = (i, j) =>
    (Math.abs(i - spawnCell.i) <= 1 && Math.abs(j - spawnCell.j) <= 1) ||
    (Math.abs(i - goalCell.i) <= 1 && Math.abs(j - goalCell.j) <= 1);

  const cellToWorld = (i, j) => ({
    x: -half + cellSize * (i + 0.5),
    z: -half + cellSize * (j + 0.5),
  });

  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      if (isClearCell(i, j)) continue;
      const { x, z } = cellToWorld(i, j);

      if (rand() < buildingChance) {
        const footprint = cellSize * (0.42 + rand() * 0.34);
        const height = minHeight + rand() * (maxHeight - minHeight);
        const color = PALETTE[Math.floor(rand() * PALETTE.length)];
        const pattern = windowPatterns[Math.floor(rand() * windowPatterns.length)];

        const mat = makeBuildingMaterial(color, fitWindowTexture(pattern, footprint, height));
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(footprint, height, footprint), mat);
        mesh.position.set(x, height / 2, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        occluders.push(mesh);
        windowMats.push({ mat, target: 0.7 + rand() * 0.6 });

        let topY = height;
        let topFootprint = footprint;

        // 키 큰 건물 일부는 위층을 좁혀 단차(setback) 실루엣을 만든다
        if (height > minHeight + (maxHeight - minHeight) * 0.45 && rand() < 0.45) {
          const tierFootprint = footprint * (0.5 + rand() * 0.25);
          const tierHeight = height * (0.2 + rand() * 0.25);
          const tierPattern = windowPatterns[Math.floor(rand() * windowPatterns.length)];

          const tierMat = makeBuildingMaterial(color, fitWindowTexture(tierPattern, tierFootprint, tierHeight));
          const tier = new THREE.Mesh(new THREE.BoxGeometry(tierFootprint, tierHeight, tierFootprint), tierMat);
          tier.position.set(x, height + tierHeight / 2, z);
          tier.castShadow = true;
          tier.receiveShadow = true;
          group.add(tier);
          occluders.push(tier);
          windowMats.push({ mat: tierMat, target: 0.7 + rand() * 0.6 });

          topY = height + tierHeight;
          topFootprint = tierFootprint;
        }

        // 옥상 테두리 — 실루엣을 또렷하게 만드는 얇은 디테일
        const trimGeo = new THREE.BoxGeometry(topFootprint * 1.02, 0.4, topFootprint * 1.02);
        const trim = new THREE.Mesh(trimGeo, new THREE.MeshStandardMaterial({ color: 0x1a1f2c, roughness: 1 }));
        trim.position.set(x, topY + 0.2, z);
        trim.castShadow = true;
        group.add(trim);

        const r = footprint / 2;
        collisionBoxes.push({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r });
        buildingMeta.push({ x, z, halfW: r, halfD: r, height: topY });
      } else if (rand() < treeChance) {
        const tree = makeTree(rand);
        tree.position.set(x + (rand() - 0.5) * cellSize * 0.3, 0, z + (rand() - 0.5) * cellSize * 0.3);
        group.add(tree);
        tree.traverse((o) => { if (o.isMesh) { o.castShadow = true; occluders.push(o); } });

        const r = 0.9;
        collisionBoxes.push({ minX: tree.position.x - r, maxX: tree.position.x + r, minZ: tree.position.z - r, maxZ: tree.position.z + r });
      }
    }
  }

  const spawn = new THREE.Vector3(cellToWorld(spawnCell.i, spawnCell.j).x, 0, cellToWorld(spawnCell.i, spawnCell.j).z);
  const goal = new THREE.Vector3(cellToWorld(goalCell.i, goalCell.j).x, 0, cellToWorld(goalCell.i, goalCell.j).z);

  return { group, extent, half, occluders, collisionBoxes, buildingMeta, windowMats, spawn, goal };
}

function makeTree(rand) {
  const group = new THREE.Group();
  const trunkH = 1.6 + rand() * 0.8;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.22, trunkH, 6),
    new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1 }),
  );
  trunk.position.y = trunkH / 2;
  group.add(trunk);

  const foliageR = 1.3 + rand() * 0.7;
  const foliage = new THREE.Mesh(
    new THREE.ConeGeometry(foliageR, foliageR * 1.7, 7),
    new THREE.MeshStandardMaterial({ color: 0x2f6b47, roughness: 0.9 }),
  );
  foliage.position.y = trunkH + foliageR * 0.75;
  group.add(foliage);

  return group;
}
