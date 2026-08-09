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

const PALETTE = [0xc7cbd4, 0xd2d5dc, 0xbcc1cc, 0xdadde2, 0xb3b8c2, 0xcdd0d8]; // 콘크리트/석재 외벽 — 밝은 회색
const GLASS_PALETTE = [0xbdd0dd, 0xc8dae5, 0xb2c8d6, 0xd0e0e9]; // 유리 커튼월 — 하늘을 닮은 밝고 차가운 톤
const GLASS_CHANCE = 0.32;
const BASE_BAND_COLOR = 0x14171c; // 1층 로비/상가 — 본체보다 어둡게 눌러 접지감을 준다
const GROUND_EMBED = 0.06; // 건물 밑면을 바닥 평면과 완전히 겹치지 않게 살짝 파묻어 그림자 이음매 틈을 없앤다

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

/** footprint/height에 맞춰 텍스처를 복제하고 반복 횟수를 지정한다 (창문/범프맵 공용) */
function fitTiledTexture(source, footprint, height) {
  const tex = source.clone();
  tex.needsUpdate = true;
  tex.repeat.set(Math.max(1, Math.round(footprint / 4)), Math.max(1, Math.round(height / 4)));
  return tex;
}

/** 창틀 홈을 표현하는 범프맵 — 벽면이 완전히 매끈한 플라스틱처럼 보이지 않도록
 *  창문 격자 경계를 살짝 파인 것처럼 만든다. 모든 건물이 공유하는 단일 소스 텍스처. */
let panelBumpSource = null;
function getPanelBumpSource() {
  if (panelBumpSource) return panelBumpSource;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 2;
  const cols = 8;
  const rows = 8;
  for (let c = 0; c <= cols; c++) {
    const x = (c / cols) * size;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    const y = (r / rows) * size;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
  }
  panelBumpSource = new THREE.CanvasTexture(canvas);
  panelBumpSource.wrapS = THREE.RepeatWrapping;
  panelBumpSource.wrapT = THREE.RepeatWrapping;
  return panelBumpSource;
}

function makeBuildingMaterial(color, windowTex, bumpTex, isGlass) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: isGlass ? 0.22 : 0.85,
    metalness: isGlass ? 0.35 : 0.05,
    emissive: WINDOW_LIGHT_COLOR,
    emissiveMap: windowTex,
    emissiveIntensity: 0,
    bumpMap: bumpTex,
    bumpScale: isGlass ? 0.015 : 0.05,
  });
}

/** 에어컨 실외기·안테나 같은 옥상 설비를 무작위로 얹어 스카이라인 실루엣에 디테일을 더한다 */
function addRooftopClutter(group, x, z, topY, footprint, rand, mat) {
  const count = 1 + Math.floor(rand() * 2);
  for (let k = 0; k < count; k++) {
    const w = footprint * (0.08 + rand() * 0.07);
    const h = 0.6 + rand() * 0.8;
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mat);
    const ox = (rand() - 0.5) * (footprint * 0.55 - w);
    const oz = (rand() - 0.5) * (footprint * 0.55 - w);
    box.position.set(x + ox, topY + h / 2, z + oz);
    box.castShadow = true;
    group.add(box);
  }
  if (rand() < 0.35) {
    const antennaH = 2 + rand() * 2.2;
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, antennaH, 5), mat);
    antenna.position.set(x, topY + antennaH / 2, z);
    antenna.castShadow = true;
    group.add(antenna);
  }
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
  const baseBandMat = new THREE.MeshStandardMaterial({ color: BASE_BAND_COLOR, roughness: 0.3, metalness: 0.2 });
  const clutterMat = new THREE.MeshStandardMaterial({ color: 0x1c2028, roughness: 0.9 });

  // ── 바닥 ────────────────────────────────────────────────────────────
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(extent * 1.6, extent * 1.6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
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
        // 정사각 대신 폭/깊이를 따로 흔들어 스카이라인에 형태 다양성을 준다
        const width = cellSize * (0.4 + rand() * 0.34);
        const depth = cellSize * (0.4 + rand() * 0.34);
        const avgFootprint = (width + depth) / 2;
        const height = minHeight + rand() * (maxHeight - minHeight);
        const isGlass = rand() < GLASS_CHANCE;
        const palette = isGlass ? GLASS_PALETTE : PALETTE;
        const color = palette[Math.floor(rand() * palette.length)];
        const pattern = windowPatterns[Math.floor(rand() * windowPatterns.length)];

        const mat = makeBuildingMaterial(
          color,
          fitTiledTexture(pattern, avgFootprint, height),
          fitTiledTexture(getPanelBumpSource(), avgFootprint, height),
          isGlass,
        );
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
        mesh.position.set(x, height / 2 - GROUND_EMBED, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        occluders.push(mesh);
        windowMats.push({ mat, target: 0.7 + rand() * 0.6 });

        // 1층 로비/상가 — 본체보다 어두운 밑단을 둘러 접지감을 준다
        const baseBandH = Math.min(3, height * 0.16);
        const baseBand = new THREE.Mesh(
          new THREE.BoxGeometry(width * 1.015, baseBandH, depth * 1.015),
          baseBandMat,
        );
        baseBand.position.set(x, baseBandH / 2 - GROUND_EMBED, z);
        baseBand.castShadow = true;
        baseBand.receiveShadow = true;
        group.add(baseBand);

        let topY = height - GROUND_EMBED;
        let topWidth = width;
        let topDepth = depth;

        // 키 큰 건물 일부는 위층을 좁혀 단차(setback) 실루엣을 만든다
        if (height > minHeight + (maxHeight - minHeight) * 0.45 && rand() < 0.45) {
          const tierWidth = width * (0.5 + rand() * 0.25);
          const tierDepth = depth * (0.5 + rand() * 0.25);
          const tierHeight = height * (0.2 + rand() * 0.25);
          const tierAvg = (tierWidth + tierDepth) / 2;
          const tierPattern = windowPatterns[Math.floor(rand() * windowPatterns.length)];

          const tierMat = makeBuildingMaterial(
            color,
            fitTiledTexture(tierPattern, tierAvg, tierHeight),
            fitTiledTexture(getPanelBumpSource(), tierAvg, tierHeight),
            isGlass,
          );
          const tier = new THREE.Mesh(new THREE.BoxGeometry(tierWidth, tierHeight, tierDepth), tierMat);
          tier.position.set(x, topY + tierHeight / 2, z);
          tier.castShadow = true;
          tier.receiveShadow = true;
          group.add(tier);
          occluders.push(tier);
          windowMats.push({ mat: tierMat, target: 0.7 + rand() * 0.6 });

          topY += tierHeight;
          topWidth = tierWidth;
          topDepth = tierDepth;
        }

        // 옥상 테두리 — 실루엣을 또렷하게 만드는 얇은 디테일
        const trimGeo = new THREE.BoxGeometry(topWidth * 1.02, 0.4, topDepth * 1.02);
        const trim = new THREE.Mesh(trimGeo, new THREE.MeshStandardMaterial({ color: 0x1a1f2c, roughness: 1 }));
        trim.position.set(x, topY + 0.2, z);
        trim.castShadow = true;
        group.add(trim);

        // 옥상 설비 — 유리 타워는 깔끔하게 비워두고, 나머지 절반 정도에만 얹는다
        if (!isGlass && rand() < 0.5) {
          addRooftopClutter(group, x, z, topY, Math.min(topWidth, topDepth), rand, clutterMat);
        }

        const rW = width / 2;
        const rD = depth / 2;
        collisionBoxes.push({ minX: x - rW, maxX: x + rW, minZ: z - rD, maxZ: z + rD });
        buildingMeta.push({ x, z, halfW: rW, halfD: rD, height: topY });
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
