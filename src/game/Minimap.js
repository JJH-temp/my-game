/* ==========================================================================
 *  미니맵 — 도시 전체를 위에서 내려다본 2D 캔버스.
 *  3인칭 시점만으로는 도시 전체의 그늘 패턴을 파악하기 어려우므로,
 *  건물 배치와 플레이어/목적지 위치를 한눈에 보여준다.
 * ========================================================================== */
export class Minimap {
  constructor(canvas, city) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.city = city;
    this.size = canvas.width;
    this.scale = this.size / city.extent;
  }

  worldToMap(x, z) {
    return {
      x: this.size / 2 + x * this.scale,
      y: this.size / 2 + z * this.scale,
    };
  }

  draw(player) {
    const ctx = this.ctx;
    const s = this.size;
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(20,24,36,0.9)';
    ctx.fillRect(0, 0, s, s);

    ctx.fillStyle = '#3a4356';
    for (const b of this.city.buildingMeta) {
      const p = this.worldToMap(b.x - b.halfW, b.z - b.halfD);
      const w = b.halfW * 2 * this.scale;
      const h = b.halfD * 2 * this.scale;
      ctx.globalAlpha = 0.4 + Math.min(0.5, b.height / 60);
      ctx.fillRect(p.x, p.y, w, h);
    }
    ctx.globalAlpha = 1;

    // 목적지
    const g = this.worldToMap(this.city.goal.x, this.city.goal.z);
    ctx.fillStyle = '#d9a441';
    ctx.beginPath();
    ctx.arc(g.x, g.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(217,164,65,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(g.x, g.y, 9, 0, Math.PI * 2);
    ctx.stroke();

    // 플레이어
    const p = this.worldToMap(player.position.x, player.position.z);
    ctx.save();
    ctx.translate(p.x, p.y);
    // world의 (x,z)를 그대로 canvas의 (x,y)로 매핑하면 Three.js의 우수법계 Y축 회전과
    // canvas 2D 회전의 방향이 서로 거울상이 된다 — 각도를 반전(-facing)하고 삼각형 꼭짓점을
    // 아래로 뒤집어야 실제로 바라보는 방향과 일치한다.
    ctx.rotate(-player.facing);
    ctx.fillStyle = player.burning ? '#ff5a3c' : '#4ecb8f';
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.lineTo(4, -5);
    ctx.lineTo(-4, -5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(232,227,217,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, s - 1, s - 1);
  }
}
