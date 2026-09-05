/**
 * Seed a fresh room with a believable chore setup: a few household items on
 * the floor, two named zones and one articulated drawer unit, all placed on
 * cells the robot can actually reach. Used on first load and by Reset.
 */

import { cellToWorld, reachableSet, worldToCell, type Cell, type Grid } from '../sim/grid';
import type { Entity, Fixture, Item, RobotPose, Vec3, Zone } from '../sim/types';
import { newId } from '../sim/types';

export function seedRoom(grid: Grid, robotStart: Vec3): { entities: Entity[]; robot: RobotPose } {
  const start = worldToCell(grid, robotStart.x, robotStart.z);
  const reach = reachableSet(grid, start);
  const cells = [...reach].map((k) => ({ c: k % grid.cols, r: Math.floor(k / grid.cols) }));
  const pickAt = (dist: number, angle: number, used: Cell[]): Cell | null => {
    // Nearest reachable cell to the ideal spot at (dist, angle) from the robot, not too close to used ones.
    const ideal = { x: robotStart.x + Math.sin(angle) * dist, z: robotStart.z + Math.cos(angle) * dist };
    let best: Cell | null = null;
    let bestD = Infinity;
    for (const c of cells) {
      const w = cellToWorld(grid, c);
      if (used.some((u) => Math.hypot(cellToWorld(grid, u).x - w.x, cellToWorld(grid, u).z - w.z) < 1.6)) continue;
      if (Math.hypot(w.x - robotStart.x, w.z - robotStart.z) < 1.8) continue;
      const d = Math.hypot(w.x - ideal.x, w.z - ideal.z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  };
  const used: Cell[] = [];
  const spot = (dist: number, angle: number): Vec3 => {
    const c = pickAt(dist, angle, used) ?? start;
    used.push(c);
    return cellToWorld(grid, c);
  };
  const now = Date.now();
  const items: Item[] = [
    { id: newId('i'), kind: 'item', name: 'red mug', tags: ['cup', 'coffee', 'mug'], pos: spot(4.5, 0.4), yaw: 0.3, createdAt: now, shape: 'mug', color: '#e63946', size: 0.55, state: 'idle' },
    { id: newId('i'), kind: 'item', name: 'blue bottle', tags: ['water', 'bottle'], pos: spot(5.5, -1.0), yaw: 0, createdAt: now, shape: 'bottle', color: '#3a86ff', size: 0.85, state: 'idle' },
    { id: newId('i'), kind: 'item', name: 'green book', tags: ['book', 'novel'], pos: spot(6.5, 1.6), yaw: 0.9, createdAt: now, shape: 'book', color: '#2a9d8f', size: 0.5, state: 'idle' },
  ];
  const shelfPos = spot(8, -0.3);
  const tablePos = spot(7.5, 2.4);
  const zones: Zone[] = [
    { id: newId('z'), kind: 'zone', name: 'shelf', tags: ['storage', 'shelf', 'rack'], pos: shelfPos, yaw: 0, createdAt: now, radius: 0.95, normal: { x: 0, y: 1, z: 0 } },
    { id: newId('z'), kind: 'zone', name: 'table', tags: ['desk', 'table'], pos: tablePos, yaw: 0, createdAt: now, radius: 0.95, normal: { x: 0, y: 1, z: 0 } },
  ];
  const drawerPos = spot(6.5, -2.2);
  const toward = Math.atan2(robotStart.x - drawerPos.x, robotStart.z - drawerPos.z);
  const drawer: Fixture = {
    id: newId('f'),
    kind: 'fixture',
    name: 'top drawer',
    tags: ['drawer', 'cabinet'],
    pos: { x: drawerPos.x, y: drawerPos.y + 0.55, z: drawerPos.z },
    yaw: toward,
    createdAt: now,
    fixtureType: 'drawer',
    normal: { x: Math.sin(toward), y: 0, z: Math.cos(toward) },
    openness: 0,
    width: 1.2,
    height: 0.5,
    depth: 1.0,
    travel: 0.7,
  };
  const robot: RobotPose = { pos: robotStart, yaw: 0, state: 'idle', carrying: null, updatedAt: now };
  return { entities: [...items, ...zones, drawer], robot };
}
