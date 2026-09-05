/**
 * RoomView reconciles store state -> three.js objects (items, fixtures, zones,
 * clutter, failure heat). The executor manipulates objects directly while a
 * step is in flight; everything else follows the store.
 */

import * as THREE from 'three';
import { PropFactory, type FixtureView } from '../world/props';
import type { Entity, Fixture, Item, RoomState, Vec3, Zone } from '../sim/types';

interface FixtureAnim {
  from: number;
  to: number;
  t: number;
  dur: number;
  resolve: () => void;
}

export class RoomView {
  readonly group = new THREE.Group();
  readonly heatGroup = new THREE.Group();
  readonly items = new Map<string, THREE.Object3D>();
  readonly fixtures = new Map<string, FixtureView>();
  readonly zones = new Map<string, THREE.Object3D>();
  private pendingItems = new Set<string>();
  private fixtureAnims = new Map<string, FixtureAnim>();
  private lastHeatKey = '';
  private entityById = new Map<string, Entity>();
  /** Items currently under executor control (skip position sync). */
  readonly locked = new Set<string>();

  constructor(scene: THREE.Scene, private factory: PropFactory) {
    this.group.name = 'Room';
    this.heatGroup.name = 'Heat';
    scene.add(this.group, this.heatGroup);
  }

  entity(id: string): Entity | undefined {
    return this.entityById.get(id);
  }

  sync(state: RoomState): void {
    const seen = new Set<string>();
    this.entityById = new Map(state.entities.map((e) => [e.id, e] as const));
    for (const e of state.entities) {
      seen.add(e.id);
      if (e.kind === 'item') this.syncItem(e);
      else if (e.kind === 'fixture') this.syncFixture(e);
      else this.syncZone(e);
    }
    for (const [id, obj] of this.items) {
      if (seen.has(id)) continue;
      obj.removeFromParent();
      disposeObject(obj);
      this.items.delete(id);
    }
    for (const [id, view] of this.fixtures) {
      if (seen.has(id)) continue;
      view.group.removeFromParent();
      disposeObject(view.group);
      this.fixtures.delete(id);
      this.fixtureAnims.delete(id);
    }
    for (const [id, obj] of this.zones) {
      if (seen.has(id)) continue;
      obj.removeFromParent();
      disposeObject(obj);
      this.zones.delete(id);
    }
    this.syncHeat(state.heat);
  }

  private syncItem(item: Item): void {
    const existing = this.items.get(item.id);
    if (!existing) {
      if (this.pendingItems.has(item.id)) return;
      this.pendingItems.add(item.id);
      this.factory
        .makeItem(item)
        .then((obj) => {
          this.pendingItems.delete(item.id);
          if (!this.entityById.has(item.id)) return; // removed while loading
          obj.position.set(item.pos.x, item.pos.y, item.pos.z);
          obj.rotation.y = item.yaw;
          this.group.add(obj);
          this.items.set(item.id, obj);
        })
        .catch((e) => {
          this.pendingItems.delete(item.id);
          console.warn('item load failed', e);
        });
      return;
    }
    if (item.state === 'held' || this.locked.has(item.id)) return;
    existing.position.set(item.pos.x, item.pos.y, item.pos.z);
    existing.rotation.y = item.yaw;
  }

  private syncFixture(f: Fixture): void {
    let view = this.fixtures.get(f.id);
    if (!view) {
      view = this.factory.makeFixture(f);
      this.group.add(view.group);
      this.fixtures.set(f.id, view);
      return;
    }
    view.group.position.set(f.pos.x, f.pos.y, f.pos.z);
    if (!this.fixtureAnims.has(f.id)) view.setOpenness(f.openness);
  }

  private syncZone(z: Zone): void {
    let obj = this.zones.get(z.id);
    if (!obj) {
      obj = this.factory.makeZone(z);
      this.group.add(obj);
      this.zones.set(z.id, obj);
      return;
    }
    obj.position.set(z.pos.x, z.pos.y + 0.02, z.pos.z);
  }

  private syncHeat(points: Vec3[]): void {
    const key = points.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join('|');
    if (key === this.lastHeatKey) return;
    this.lastHeatKey = key;
    for (const c of [...this.heatGroup.children]) {
      c.removeFromParent();
      disposeObject(c);
    }
    // Merge nearby points into weighted discs.
    const merged: { p: Vec3; w: number }[] = [];
    for (const p of points) {
      const near = merged.find((m) => Math.hypot(m.p.x - p.x, m.p.z - p.z) < 0.9);
      if (near) near.w += 1;
      else merged.push({ p, w: 1 });
    }
    for (const m of merged) this.heatGroup.add(this.factory.makeHeatDisc(m.p, m.w));
  }

  animateFixture(id: string, to: number, dur = 0.9): Promise<void> {
    const view = this.fixtures.get(id);
    if (!view) return Promise.resolve();
    const f = this.entityById.get(id) as Fixture | undefined;
    const from = this.fixtureAnims.get(id)?.to ?? f?.openness ?? 0;
    return new Promise((resolve) => {
      this.fixtureAnims.set(id, { from, to, t: 0, dur, resolve });
    });
  }

  tick(dt: number): void {
    for (const [id, a] of this.fixtureAnims) {
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.fixtures.get(id)?.setOpenness(THREE.MathUtils.lerp(a.from, a.to, e));
      if (k >= 1) {
        this.fixtureAnims.delete(id);
        a.resolve();
      }
    }
  }

  /** Objects that can be clicked to select an entity. */
  pickables(): THREE.Object3D[] {
    return [...this.items.values(), ...[...this.fixtures.values()].map((f) => f.group), ...this.zones.values()];
  }

  entityIdOf(obj: THREE.Object3D | null): string | null {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      const id = cur.userData.itemId ?? cur.userData.fixtureId ?? cur.userData.zoneId;
      if (id) return id as string;
      cur = cur.parent;
    }
    return null;
  }

  setHighlight(id: string | null): void {
    for (const [fid, view] of this.fixtures) view.setHighlight(fid === id);
    for (const [iid, obj] of this.items) setEmissive(obj, iid === id ? 0.35 : 0);
    for (const [zid, obj] of this.zones) obj.scale.setScalar(zid === id ? 1.12 : 1);
  }
}

function setEmissive(obj: THREE.Object3D, intensity: number): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mt of mats) {
      if (mt instanceof THREE.MeshStandardMaterial) {
        mt.emissive.set(0x3ddc97);
        mt.emissiveIntensity = intensity;
      }
    }
  });
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const mt of mats) {
      const anyMat = mt as THREE.Material & { map?: THREE.Texture | null };
      anyMat.map?.dispose();
      mt.dispose();
    }
  });
}
