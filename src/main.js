import Phaser from 'phaser';

class MainScene extends Phaser.Scene {
  create() {
    this.player = this.add.rectangle(400, 300, 40, 40, 0x4ade80);
    this.physics.add.existing(this.player);
    this.player.body.setCollideWorldBounds(true).setBounce(0.8);

    this.cursors = this.input.keyboard.createCursorKeys();

    this.add.text(16, 16, '방향키로 이동', {
      fontSize: '18px',
      color: '#ffffff',
    });
  }

  update() {
    const speed = 300;
    const body = this.player.body;

    body.setVelocityX(0);
    if (this.cursors.left.isDown) body.setVelocityX(-speed);
    if (this.cursors.right.isDown) body.setVelocityX(speed);
    if (this.cursors.up.isDown && body.blocked.down) body.setVelocityY(-500);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: 'game',
  backgroundColor: '#16213e',
  physics: {
    default: 'arcade',
    arcade: { gravity: { y: 800 }, debug: false },
  },
  scene: MainScene,
});
