import Phaser from 'phaser';

/**
 * The scene's grid backdrop + centred title.
 *
 * Drawn ONCE and never redrawn, a backdrop keeps whatever size the window had
 * when the scene started: enlarge the window and the grid stops partway across
 * with the title off-centre. This redraws on every scale change instead, and
 * detaches itself when the scene shuts down.
 */
export function attachBackdrop(scene: Phaser.Scene, title: string) {
  let grid: Phaser.GameObjects.Graphics | null = null;
  let label: Phaser.GameObjects.Text | null = null;

  const draw = () => {
    const { width, height } = scene.scale;
    grid?.destroy();
    label?.destroy();
    grid = scene.add.graphics().setDepth(-100);
    grid.lineStyle(1, 0x0a1e2c, 1);
    for (let x = 0; x < width; x += 32) grid.lineBetween(x, 0, x, height);
    for (let y = 0; y < height; y += 32) grid.lineBetween(0, y, width, y);
    grid.setAlpha(0.6);
    label = scene.add
      .text(width / 2, 70, title, {
        fontFamily: '"Orbitron", sans-serif',
        fontSize: '15px',
        color: '#12475c',
      })
      .setOrigin(0.5)
      .setDepth(-99);
  };

  draw();
  scene.scale.on(Phaser.Scale.Events.RESIZE, draw);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    scene.scale.off(Phaser.Scale.Events.RESIZE, draw);
  });
}
