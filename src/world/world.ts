/**
 * World loading: a Marble Gaussian splat (rendered by Spark) plus its collider
 * mesh, from which we derive the floor height and the occupancy grid the robot
 * plans on. The collider is never drawn; it is the physical truth of the room.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { buildGrid, type Grid } from '../sim/grid';
import type { Vec3, WorldInfo } from '../sim/types';

export interface Hit {
  point: Vec3;
  normal: Vec3;
  object: THREE.Object3D;
}

export interface WorldHandles {
  info: WorldInfo;
  group: THREE.Group;
  splat: SplatMesh;
  colliderRoot: THREE.Group;
  colliderMeshes: THREE.Mesh[];
  floorY: number;
  bounds: THREE.Box3;
  grid: Grid;
  /** Cast straight down at (x, z) from `fromY` and return the first collider hit. */
  raycastDown(x: number, z: number, fromY?: number, maxDist?: number): Hit | null;
  /** Cast from a camera through normalized device coordinates. */
  raycastScreen(ndc: THREE.Vector2, camera: THREE.Camera): Hit | null;
  /** Re-rasterize the occupancy grid (after world scale changes). */
  rebuildGrid(): Grid;
  /** Resolve once the splat has finished decoding. */
  splatReady: Promise<void>;
}

export interface WorldOptions {
  /** Robot body height used when sampling for obstacles (world units). */
  robotHeight: number;
  /** Grid cell size (world units). */
  cell: number;
  /** Extra blocked cells around obstacles. */
  inflate: number;
  onProgress?: (fraction: number) => void;
}

const _ray = new THREE.Raycaster();
const _down = new THREE.Vector3(0, -1, 0);
const _origin = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _nm = new THREE.Matrix3();

export async function loadWorld(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  info: WorldInfo,
  opts: WorldOptions,
): Promise<WorldHandles> {
  const group = new THREE.Group();
  group.name = 'World';
  scene.add(group);

  // LoD is opt-in (VITE_SPLAT_LOD=1). The in-browser "Tiny LoD" build takes ~90 s and, on the GitHub Pages origin,
  // finished without ever handing splats to the renderer (black room); the plain path renders the 3.8M-splat world in ~20 s.
  const useLod = (import.meta as unknown as { env?: { VITE_SPLAT_LOD?: string } }).env?.VITE_SPLAT_LOD === '1';
  const spark = new SparkRenderer({ renderer, enableLod: useLod, lodRenderScale: 2 });
  scene.add(spark);

  const splat = new SplatMesh({
    url: info.splatUrl,
    lod: useLod,
    raycastable: false,
    onProgress: (ev: ProgressEvent) => {
      if (opts.onProgress && ev.lengthComputable && ev.total > 0) opts.onProgress(ev.loaded / ev.total);
    },
  });
  splat.scale.setScalar(info.scale);
  group.add(splat);
  const splatReady = splat.initialized.then(() => undefined);

  const colliderRoot = new THREE.Group();
  colliderRoot.name = 'Collider';
  colliderRoot.scale.setScalar(info.scale);
  group.add(colliderRoot);

  const gltf = await new GLTFLoader().loadAsync(info.colliderUrl);
  colliderRoot.add(gltf.scene);
  const colliderMeshes: THREE.Mesh[] = [];
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    // Invisible geometry that still catches shadows, so props and the robot sit "in" the splat.
    const shadowMat = new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.28 });
    shadowMat.transparent = true;
    shadowMat.depthWrite = false;
    m.material = shadowMat;
    m.receiveShadow = true;
    m.castShadow = false;
    m.renderOrder = 1000;
    colliderMeshes.push(m);
  });
  colliderRoot.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(colliderRoot);

  function raycastDown(x: number, z: number, fromY = bounds.max.y + 1, maxDist = bounds.max.y - bounds.min.y + 2): Hit | null {
    _origin.set(x, fromY, z);
    _ray.set(_origin, _down);
    _ray.near = 0;
    _ray.far = maxDist;
    const hits = _ray.intersectObjects(colliderMeshes, false);
    if (hits.length === 0) return null;
    return toHit(hits[0]);
  }

  function raycastScreen(ndc: THREE.Vector2, camera: THREE.Camera): Hit | null {
    _ray.setFromCamera(ndc, camera);
    _ray.near = 0;
    _ray.far = 1000;
    const hits = _ray.intersectObjects(colliderMeshes, false);
    if (hits.length === 0) return null;
    return toHit(hits[0]);
  }

  function toHit(h: THREE.Intersection): Hit {
    _normal.set(0, 1, 0);
    if (h.face) {
      _nm.getNormalMatrix(h.object.matrixWorld);
      _normal.copy(h.face.normal).applyMatrix3(_nm).normalize();
    }
    return {
      point: { x: h.point.x, y: h.point.y, z: h.point.z },
      normal: { x: _normal.x, y: _normal.y, z: _normal.z },
      object: h.object,
    };
  }

  // Floor: the lowest large horizontal surface near the middle of the room.
  const floorY = estimateFloor(raycastDown, bounds);

  let grid: Grid;

  function rasterize(): Grid {
    const sampleTop = floorY + opts.robotHeight;
    grid = buildGrid(
      (x, z) => {
        const h = raycastDown(x, z, sampleTop, opts.robotHeight + 1.5);
        return { hitY: h ? h.point.y : null };
      },
      {
        minX: bounds.min.x,
        maxX: bounds.max.x,
        minZ: bounds.min.z,
        maxZ: bounds.max.z,
        cell: opts.cell,
        floorY,
        floorTolerance: 0.35,
        inflate: opts.inflate,
      },
    );
    return grid;
  }
  rasterize();

  return {
    info,
    group,
    splat,
    colliderRoot,
    colliderMeshes,
    floorY,
    bounds,
    get grid() {
      return grid;
    },
    raycastDown,
    raycastScreen,
    rebuildGrid: rasterize,
    splatReady,
  };
}

/** Sample a coarse grid of downward rays and take the most common low height as the floor. */
function estimateFloor(raycastDown: WorldHandles['raycastDown'], bounds: THREE.Box3): number {
  const buckets = new Map<number, number>();
  const step = Math.max(0.5, Math.min(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 24);
  for (let x = bounds.min.x + step / 2; x < bounds.max.x; x += step) {
    for (let z = bounds.min.z + step / 2; z < bounds.max.z; z += step) {
      const h = raycastDown(x, z);
      if (!h || h.normal.y < 0.8) continue;
      const key = Math.round(h.point.y / 0.25);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }
  let bestKey = 0;
  let bestCount = -1;
  for (const [k, n] of buckets) {
    // Prefer lower surfaces when counts are close (floors beat tables).
    if (n > bestCount * 1.15 || (n > bestCount * 0.6 && k < bestKey)) {
      bestKey = k;
      bestCount = n;
    }
  }
  return bestCount < 0 ? bounds.min.y : bestKey * 0.25;
}
