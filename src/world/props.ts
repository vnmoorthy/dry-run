/**
 * Visual props for entities: items (procedural or GLB from the asset manifest),
 * articulated fixtures (drawers slide, doors swing), zones and floor labels.
 *
 * Procedural props are the guaranteed path; when `public/assets/manifest.json`
 * lists a Tripo or Mint GLB for a shape key, that GLB is used instead.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { AssetManifest, Fixture, Item, Vec3, Zone } from '../sim/types';

export interface FixtureView {
  group: THREE.Group;
  setOpenness(v: number): void;
  /** World position of the handle (where the gripper goes). */
  handleWorldPos(): Vec3;
  /** World position inside the fixture (where an item is placed). */
  interiorWorldPos(): Vec3;
  setHighlight(on: boolean): void;
}

const gltfLoader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
gltfLoader.setDRACOLoader(draco);

export class PropFactory {
  private glbCache = new Map<string, Promise<THREE.Group>>();
  constructor(private manifest: AssetManifest | null) {}

  /** GLB key for an item shape, if the manifest provides one. */
  private glbFor(item: Item): { url: string; heightUnits?: number } | null {
    const props = this.manifest?.props ?? [];
    const key = item.shape.toLowerCase();
    const hit = props.find((p) => p.key.toLowerCase() === key || (p.tags ?? []).map((t) => t.toLowerCase()).includes(key));
    return hit ? { url: hit.glbUrl, heightUnits: hit.heightUnits } : null;
  }

  async makeItem(item: Item): Promise<THREE.Object3D> {
    const glb = this.glbFor(item);
    if (glb) {
      try {
        const scene = await this.loadGlb(glb.url);
        const clone = scene.clone(true);
        fitHeight(clone, glb.heightUnits ?? item.size);
        clone.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = false;
          }
        });
        clone.userData.itemId = item.id;
        return clone;
      } catch (e) {
        console.warn('Falling back to procedural prop for', item.shape, e);
      }
    }
    const obj = proceduralItem(item.shape, item.color, item.size);
    obj.userData.itemId = item.id;
    return obj;
  }

  private loadGlb(url: string): Promise<THREE.Group> {
    let p = this.glbCache.get(url);
    if (!p) {
      p = gltfLoader.loadAsync(url).then((g) => g.scene);
      this.glbCache.set(url, p);
    }
    return p;
  }

  makeFixture(f: Fixture): FixtureView {
    return f.fixtureType === 'drawer' ? makeDrawer(f) : makeDoor(f);
  }

  makeZone(z: Zone): THREE.Object3D {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(z.radius * 0.82, z.radius, 40),
      new THREE.MeshBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
    );
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(z.radius * 0.82, 40),
      new THREE.MeshBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    disc.rotation.x = -Math.PI / 2;
    ring.renderOrder = 20;
    disc.renderOrder = 19;
    g.add(ring, disc);
    const label = makeLabel(z.name, '#3ddc97');
    label.position.set(0, 0.9, 0);
    g.add(label);
    g.position.set(z.pos.x, z.pos.y + 0.02, z.pos.z);
    g.userData.zoneId = z.id;
    return g;
  }

  makeHeatDisc(p: Vec3, weight = 1): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(0.7 + 0.15 * weight, 32),
      new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: Math.min(0.75, 0.3 + 0.15 * weight), depthWrite: false, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(p.x, p.y + 0.03, p.z);
    m.renderOrder = 18;
    return m;
  }

  makeClutterBox(p: Vec3, size = 0.9): THREE.Object3D {
    const obj = proceduralItem('crate', '#b8874a', size);
    obj.position.set(p.x, p.y, p.z);
    return obj;
  }
}

function fitHeight(obj: THREE.Object3D, height: number): void {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const h = Math.max(box.max.y - box.min.y, 1e-4);
  const s = height / h;
  obj.scale.multiplyScalar(s);
  obj.updateMatrixWorld(true);
  box.setFromObject(obj);
  obj.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
}

function mat(color: string | number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, ...extra });
}

function shadowed(m: THREE.Mesh): THREE.Mesh {
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Procedural props keyed by shape; origin at the base, +Y up. */
export function proceduralItem(shape: string, color: string, size: number): THREE.Object3D {
  const g = new THREE.Group();
  const s = size;
  switch (shape) {
    case 'mug':
    case 'cup': {
      const body = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(s * 0.34, s * 0.3, s, 24, 1, false), mat(color)));
      body.position.y = s / 2;
      const inner = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.29, s * 0.25, s * 0.95, 24, 1, true), mat('#f3efe6', { side: THREE.BackSide }));
      inner.position.y = s * 0.55;
      const handle = shadowed(new THREE.Mesh(new THREE.TorusGeometry(s * 0.28, s * 0.06, 12, 24, Math.PI), mat(color)));
      handle.rotation.set(0, 0, -Math.PI / 2);
      handle.rotation.y = Math.PI / 2;
      handle.position.set(s * 0.36, s * 0.5, 0);
      g.add(body, inner, handle);
      break;
    }
    case 'bottle': {
      const body = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(s * 0.2, s * 0.22, s * 0.7, 24), mat(color, { roughness: 0.25 })));
      body.position.y = s * 0.35;
      const neck = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(s * 0.09, s * 0.16, s * 0.25, 24), mat(color, { roughness: 0.25 })));
      neck.position.y = s * 0.82;
      const cap = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(s * 0.1, s * 0.1, s * 0.08, 24), mat('#2b2b2b')));
      cap.position.y = s * 0.98;
      g.add(body, neck, cap);
      break;
    }
    case 'book': {
      const b = shadowed(new THREE.Mesh(new THREE.BoxGeometry(s * 1.4, s * 0.22, s), mat(color)));
      b.position.y = s * 0.11;
      const pages = new THREE.Mesh(new THREE.BoxGeometry(s * 1.36, s * 0.18, s * 0.96), mat('#f5f1e8'));
      pages.position.set(s * 0.03, s * 0.11, 0);
      g.add(b, pages);
      break;
    }
    case 'plant': {
      const pot = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(s * 0.3, s * 0.22, s * 0.45, 20), mat('#b5651d')));
      pot.position.y = s * 0.225;
      const leaves = shadowed(new THREE.Mesh(new THREE.IcosahedronGeometry(s * 0.38, 1), mat(color, { flatShading: true })));
      leaves.position.y = s * 0.75;
      g.add(pot, leaves);
      break;
    }
    case 'ball': {
      const b = shadowed(new THREE.Mesh(new THREE.SphereGeometry(s * 0.5, 24, 18), mat(color, { roughness: 0.35 })));
      b.position.y = s * 0.5;
      g.add(b);
      break;
    }
    case 'can': {
      const c = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(s * 0.28, s * 0.28, s, 24), mat(color, { metalness: 0.6, roughness: 0.3 })));
      c.position.y = s / 2;
      g.add(c);
      break;
    }
    case 'crate': {
      const b = shadowed(new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.8, s), mat(color)));
      b.position.y = s * 0.4;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(b.geometry), new THREE.LineBasicMaterial({ color: 0x5a3d1a }));
      edges.position.copy(b.position);
      g.add(b, edges);
      break;
    }
    case 'box':
    default: {
      const b = shadowed(new THREE.Mesh(new THREE.BoxGeometry(s * 0.8, s * 0.6, s * 0.6), mat(color)));
      b.position.y = s * 0.3;
      g.add(b);
    }
  }
  return g;
}

function yawFromNormal(n: Vec3): number {
  return Math.atan2(n.x, n.z);
}

function makeDrawer(f: Fixture): FixtureView {
  const group = new THREE.Group();
  const w = f.width;
  const h = f.height;
  const d = f.depth;
  const bodyMat = mat('#e9e4da');
  const frontMat = mat('#d9d2c5');
  // Body sits behind the tapped surface (local -Z), front flush with the surface.
  const body = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat));
  body.position.set(0, 0, -d / 2);
  const cavity = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, h * 0.86, d * 0.98), mat('#3b3630', { side: THREE.BackSide }));
  cavity.position.set(0, 0, -d / 2 + 0.01);
  const drawer = new THREE.Group();
  const front = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, h * 1.02, 0.06), frontMat));
  front.position.z = 0.03;
  const tray = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w * 0.88, h * 0.3, d * 0.9), mat('#f2eee6')));
  tray.position.set(0, -h * 0.3, -d * 0.45);
  const handle = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, w * 0.35, 12), mat('#8a8a8a', { metalness: 0.8, roughness: 0.3 })));
  handle.rotation.z = Math.PI / 2;
  handle.position.set(0, 0, 0.09);
  drawer.add(front, tray, handle);
  group.add(body, cavity, drawer);
  const glow = new THREE.Mesh(new THREE.BoxGeometry(w * 1.08, h * 1.08, 0.02), new THREE.MeshBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0 }));
  glow.position.z = 0.07;
  group.add(glow);
  const label = makeLabel(f.name, '#ffd166');
  label.position.set(0, h / 2 + 0.35, 0.1);
  group.add(label);
  group.position.set(f.pos.x, f.pos.y, f.pos.z);
  group.rotation.y = yawFromNormal(f.normal);
  group.userData.fixtureId = f.id;
  let openness = f.openness;
  const view: FixtureView = {
    group,
    setOpenness(v) {
      openness = THREE.MathUtils.clamp(v, 0, 1);
      drawer.position.z = openness * f.travel;
    },
    handleWorldPos() {
      const p = new THREE.Vector3(0, 0, openness * f.travel + 0.12);
      group.localToWorld(p);
      return { x: p.x, y: p.y, z: p.z };
    },
    interiorWorldPos() {
      const p = new THREE.Vector3(0, -h * 0.15, openness * f.travel - d * 0.45);
      group.localToWorld(p);
      return { x: p.x, y: p.y, z: p.z };
    },
    setHighlight(on) {
      (glow.material as THREE.MeshBasicMaterial).opacity = on ? 0.35 : 0;
    },
  };
  view.setOpenness(f.openness);
  return view;
}

function makeDoor(f: Fixture): FixtureView {
  const group = new THREE.Group();
  const w = f.width;
  const h = f.height;
  const d = f.depth;
  const body = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat('#e9e4da')));
  body.position.set(0, 0, -d / 2);
  const cavity = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, h * 0.92, d * 0.98), mat('#3b3630', { side: THREE.BackSide }));
  cavity.position.set(0, 0, -d / 2 + 0.01);
  const shelf = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.05, d * 0.9), mat('#f2eee6')));
  shelf.position.set(0, -h * 0.05, -d / 2);
  // Hinge on the left edge (local -X).
  const hinge = new THREE.Group();
  hinge.position.set(-w / 2, 0, 0.03);
  const panel = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, h * 1.02, 0.06), mat('#d9d2c5')));
  panel.position.set(w / 2, 0, 0);
  const handle = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, h * 0.25, 12), mat('#8a8a8a', { metalness: 0.8, roughness: 0.3 })));
  handle.position.set(w * 0.86, 0, 0.06);
  hinge.add(panel, handle);
  group.add(body, cavity, shelf, hinge);
  const glow = new THREE.Mesh(new THREE.BoxGeometry(w * 1.08, h * 1.08, 0.02), new THREE.MeshBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0 }));
  glow.position.z = 0.07;
  group.add(glow);
  const label = makeLabel(f.name, '#ffd166');
  label.position.set(0, h / 2 + 0.35, 0.1);
  group.add(label);
  group.position.set(f.pos.x, f.pos.y, f.pos.z);
  group.rotation.y = yawFromNormal(f.normal);
  group.userData.fixtureId = f.id;
  let openness = f.openness;
  const view: FixtureView = {
    group,
    setOpenness(v) {
      openness = THREE.MathUtils.clamp(v, 0, 1);
      hinge.rotation.y = -openness * f.travel;
    },
    handleWorldPos() {
      const p = new THREE.Vector3(w * 0.86, 0, 0.12);
      hinge.localToWorld(p);
      return { x: p.x, y: p.y, z: p.z };
    },
    interiorWorldPos() {
      const p = new THREE.Vector3(0, 0, -d * 0.45);
      group.localToWorld(p);
      return { x: p.x, y: p.y, z: p.z };
    },
    setHighlight(on) {
      (glow.material as THREE.MeshBasicMaterial).opacity = on ? 0.35 : 0;
    },
  };
  view.setOpenness(f.openness);
  return view;
}

/** Canvas-texture text sprite that always faces the camera. */
export function makeLabel(text: string, color = '#ffffff'): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '600 42px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.font = font;
  const padX = 28;
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const h = 72;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.fillStyle = 'rgba(12, 14, 20, 0.78)';
  roundRect(ctx, 0, 0, w, h, 22);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  roundRect(ctx, 1.5, 1.5, w - 3, h - 3, 20);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padX, h / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  const scale = 0.0075;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.renderOrder = 50;
  return sprite;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
