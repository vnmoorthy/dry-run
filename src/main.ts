/**
 * Dry Run — projector app.
 *
 * Boot order: renderer → store → world (Marble splat + collider → occupancy
 * grid) → robot → room view → executor → HUD. From then on the store is the
 * single source of truth; this tab is the one that moves the robot.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createStore } from './data/store';
import { loadWorld, type WorldHandles } from './world/world';
import { PropFactory } from './world/props';
import { Robot } from './robot/robot';
import { RoomView } from './app/room';
import { Executor } from './sim/executor';
import { Sfx } from './app/sfx';
import { seedRoom } from './app/seed';
import { Hud, type Tool } from './ui/hud';
import { applyLayout, DEFAULT_TRIAL, makeVariantLayout, runTrial } from './sim/evaluate';
import { cellToWorld, nearestFree, worldToCell } from './sim/grid';
import { DEFAULT_WORLD, assetUrl, newId, type AssetManifest, type Entity, type Fixture, type Gauntlet, type Item, type Vec3, type WorldInfo, type Zone } from './sim/types';

const ROBOT_HEIGHT = 2.4;
const CELL = 0.5;

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  // Splat rendering is fill-rate bound; DPR 1 keeps a projector laptop smooth.
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 400);
  camera.position.set(6, 9, 10);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a2f24, 0.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.02;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -20;
  sc.right = 20;
  sc.top = 20;
  sc.bottom = -20;
  sc.near = 1;
  sc.far = 120;
  scene.add(sun, sun.target);

  const manifest = await loadManifest();
  const store = createStore();
  const ledgerUrl = new URL('ledger.html', location.href);
  ledgerUrl.searchParams.set('room', store.roomSlug);
  const hud = new Hud(app, callbacks(), { mode: store.mode, ledgerUrl: ledgerUrl.toString(), manifest });
  hud.setStatus(store.mode === 'convex' ? 'Connecting to Convex…' : 'Starting offline room…');
  try {
    // Dead venue Wi-Fi must not strand the projector on "Connecting…": fall back to offline mode.
    await Promise.race([store.ready(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Convex unreachable after 8 s')), 8000))]);
  } catch (e) {
    console.error(e);
    if (store.mode === 'convex') {
      hud.setStatus('Convex unreachable — switching to offline mode…');
      const u = new URL(location.href);
      u.searchParams.set('local', '1');
      setTimeout(() => location.replace(u.toString()), 1500);
    } else hud.setStatus(`Store failed: ${(e as Error).message}`);
    return;
  }

  // World authority: a world written by the live World Labs job (or a previous manifest) wins over the
  // starter; the manifest is pushed only while the room still holds the starter world.
  const manifestWorld: WorldInfo | null = manifest?.world
    ? {
        name: manifest.world.name,
        splatUrl: manifest.world.splatUrl,
        colliderUrl: manifest.world.colliderUrl,
        scale: manifest.world.scale ?? DEFAULT_WORLD.scale,
        metersPerUnit: manifest.world.metersPerUnit ?? DEFAULT_WORLD.metersPerUnit,
        provenance: `${manifest.world.provider === 'worldlabs' ? 'World Labs Marble' : manifest.world.provider} · ${manifest.world.model ?? ''} · ${manifest.world.inputs ?? ''} ${manifest.world.note ?? ''}`.trim(),
      }
    : null;
  const storedWorld = store.getState().world;
  const storedIsStarter = storedWorld.splatUrl === DEFAULT_WORLD.splatUrl;
  if (manifestWorld && storedIsStarter && storedWorld.splatUrl !== manifestWorld.splatUrl) await store.setWorld(manifestWorld);
  const worldInfo: WorldInfo = store.getState().world;

  hud.setStatus('Loading collider and rasterizing the room…');
  let world: WorldHandles;
  try {
    world = await loadWorld(scene, renderer, worldInfo, {
      robotHeight: ROBOT_HEIGHT,
      cell: CELL,
      inflate: 1,
      onProgress: (f) => hud.setStatus(`Downloading Marble splat… ${Math.round(f * 100)}%`),
    });
  } catch (e) {
    console.error(e);
    hud.setStatus(`World failed to load: ${(e as Error).message}`);
    return;
  }
  const grid = world.grid;
  const free = grid.cells.filter((c) => c === 0).length;
  const mpu = worldInfo.metersPerUnit;
  hud.setGridInfo(`${grid.cols}×${grid.rows} cells @ ${(CELL * mpu * 100).toFixed(0)} cm · ${(free * CELL * CELL * mpu * mpu).toFixed(1)} m² drivable · floor y=${world.floorY.toFixed(2)}`);
  hud.setStatus('Decoding Marble splat and building its LoD (~30 s on first load)…');
  world.splatReady
    .then(() => {
      hud.setStatus(null);
      hud.toast('Room ready — splat, collider and grid live', 3500);
    })
    .catch((e) => hud.setStatus(`Splat failed to load: ${(e as Error)?.message ?? e} — collider, grid and robot still work.`));

  const trial = { ...DEFAULT_TRIAL, metersPerUnit: mpu };
  const factory = new PropFactory(manifest);
  const room = new RoomView(scene, factory);
  const sfx = new Sfx(manifest);
  const robot = await Robot.fromManifest(manifest, { height: ROBOT_HEIGHT, moveSpeed: 3.2, turnSpeed: 4.5, reach: trial.reach });
  scene.add(robot.group);

  // First run (or an empty room): seed a chore-ready layout on reachable cells.
  if (store.getState().entities.length === 0) {
    const startCell = nearestFree(grid, worldToCell(grid, 0, 0), 20) ?? { c: Math.floor(grid.cols / 2), r: Math.floor(grid.rows / 2) };
    const seed = seedRoom(grid, cellToWorld(grid, startCell));
    await store.reset(seed.entities, seed.robot);
  }
  {
    const r = store.getState().robot;
    robot.setPose({ x: r.pos.x, y: world.floorY, z: r.pos.z }, r.yaw);
    controls.target.set(r.pos.x, world.floorY + 1, r.pos.z);
    camera.position.set(r.pos.x + 7, world.floorY + 8, r.pos.z + 9);
  }

  // Path ribbon on the floor.
  const ribbon = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x3ddc97, transparent: true, opacity: 0.9, depthTest: false }));
  ribbon.renderOrder = 30;
  ribbon.visible = false;
  scene.add(ribbon);

  const executor = new Executor({
    store,
    world,
    robot,
    room,
    sfx,
    trial,
    onPath: (points) => {
      if (!points) {
        ribbon.visible = false;
        return;
      }
      ribbon.geometry.dispose();
      ribbon.geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, world.floorY + 0.06, p.z)));
      ribbon.visible = true;
    },
  });

  let follow = true;
  let selectedId: string | null = null;
  let tool: Tool = 'select';
  let labelsOn = true;
  // Debug handle for the console (and for judges who ask "show me the grid").
  // `dryrun.fastForward(20)` advances the simulation 20 s without waiting for frames — used by the smoke test.
  (window as unknown as { dryrun: unknown }).dryrun = {
    scene,
    world,
    robot,
    store,
    executor,
    room,
    camera,
    renderer,
    fastForward: async (seconds: number) => {
      const step = 1 / 50;
      for (let i = 0; i < seconds / step; i++) {
        executor.tick(step);
        room.tick(step);
        // Yield to microtasks so the executor's awaits can progress between ticks.
        await Promise.resolve();
        await Promise.resolve();
      }
      renderer.render(scene, camera);
    },
  };

  store.subscribe((state) => {
    // The world was swapped elsewhere (World Labs job, another tab): reload onto it.
    if (state.world.splatUrl !== worldInfo.splatUrl) {
      hud.setStatus('New world arrived — reloading…');
      setTimeout(() => location.reload(), 800);
      return;
    }
    room.sync(state);
    hud.update(state);
    // Remote pose (reset, "Robot start" tool, another executor) — only when this tab is not driving.
    if (!executor.isBusy) {
      const r = state.robot;
      if (Math.hypot(r.pos.x - robot.pos.x, r.pos.z - robot.pos.z) > 0.05) robot.setPose({ x: r.pos.x, y: world.floorY, z: r.pos.z }, r.yaw);
    }
    setLabels(labelsOn);
  });

  function setLabels(on: boolean): void {
    labelsOn = on;
    scene.traverse((o) => {
      if ((o as THREE.Sprite).isSprite) o.visible = on;
    });
  }

  /* ---------------- click handling ---------------- */
  const ndc = new THREE.Vector2();
  let downAt: { x: number; y: number } | null = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    downAt = { x: ev.clientX, y: ev.clientY };
  });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!downAt || ev.button !== 0) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    downAt = null;
    if (moved > 6) return; // it was an orbit drag
    ndc.set((ev.clientX / window.innerWidth) * 2 - 1, -(ev.clientY / window.innerHeight) * 2 + 1);
    void handleClick();
  });

  async function handleClick(): Promise<void> {
    if (tool === 'select') {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(room.pickables(), true);
      const id = hits.length ? room.entityIdOf(hits[0].object) : null;
      select(id);
      return;
    }
    const hit = world.raycastScreen(ndc, camera);
    if (!hit) {
      hud.toast('Click on the room geometry (floor, table, wall).');
      return;
    }
    const now = Date.now();
    const up = hit.normal.y > 0.7;
    if (tool === 'item') {
      if (!up) {
        hud.toast('Items need a flat surface.');
        return;
      }
      const d = hud.itemDraft();
      const item: Item = { id: newId('i'), kind: 'item', name: d.name, tags: [d.shape], pos: hit.point, yaw: Math.random() * Math.PI * 2, createdAt: now, shape: d.shape, color: d.color, size: sizeFor(d.shape), state: 'idle', createdBy: 'projector' };
      await store.addEntity(item);
      hud.toast(`Added ${d.name}`);
    } else if (tool === 'zone') {
      if (!up) {
        hud.toast('Zones need a flat surface.');
        return;
      }
      const zone: Zone = { id: newId('z'), kind: 'zone', name: hud.zoneDraft(), tags: [hud.zoneDraft()], pos: hit.point, yaw: 0, createdAt: now, radius: 0.95, normal: hit.normal, createdBy: 'projector' };
      await store.addEntity(zone);
      hud.toast(`Added zone ${zone.name}`);
    } else if (tool === 'drawer' || tool === 'door') {
      const name = hud.fixtureDraft();
      let pos: Vec3;
      let normal: Vec3;
      if (up) {
        // Free-standing unit on the floor, facing the camera.
        const toCam = new THREE.Vector3().subVectors(camera.position, new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z));
        toCam.y = 0;
        toCam.normalize();
        normal = { x: toCam.x, y: 0, z: toCam.z };
        pos = { x: hit.point.x + normal.x * 0.5, y: hit.point.y + 0.55, z: hit.point.z + normal.z * 0.5 };
      } else {
        const n = new THREE.Vector3(hit.normal.x, 0, hit.normal.z).normalize();
        normal = { x: n.x, y: 0, z: n.z };
        pos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
      }
      const fixture: Fixture = {
        id: newId('f'),
        kind: 'fixture',
        name,
        tags: [tool, 'cabinet'],
        pos,
        yaw: Math.atan2(normal.x, normal.z),
        createdAt: now,
        fixtureType: tool,
        normal,
        openness: 0,
        width: tool === 'door' ? 1.0 : 1.2,
        height: tool === 'door' ? 1.1 : 0.5,
        depth: 1.0,
        travel: tool === 'door' ? Math.PI * 0.55 : 0.7,
        createdBy: 'projector',
      };
      await store.addEntity(fixture);
      hud.toast(`Added ${tool} “${name}” (${tool === 'door' ? 'revolute' : 'prismatic'} joint)`);
    } else if (tool === 'robot') {
      if (!up) {
        hud.toast('Put the robot on the floor.');
        return;
      }
      if (executor.isBusy) {
        hud.toast('Robot is busy — stop it first.');
        return;
      }
      const cell = nearestFree(grid, worldToCell(grid, hit.point.x, hit.point.z), 6);
      if (!cell) {
        hud.toast('No drivable floor there.');
        return;
      }
      const p = cellToWorld(grid, cell);
      robot.setPose({ x: p.x, y: world.floorY, z: p.z }, robot.yaw);
      await store.setRobot({ pos: robot.pos, yaw: robot.yaw, state: 'idle', carrying: null, updatedAt: now });
    }
  }

  function select(id: string | null): void {
    selectedId = id;
    room.setHighlight(id);
    hud.setSelected(id);
  }

  /* ---------------- HUD callbacks ---------------- */
  function callbacks() {
    return {
      onSubmitChore: (text: string) => {
        void store.submitTask(text, 'projector');
      },
      onToolChange: (t: Tool) => {
        tool = t;
      },
      onRemoveEntity: (id: string) => {
        if (selectedId === id) select(null);
        void store.removeEntity(id);
      },
      onSelectEntity: (id: string | null) => select(id),
      onRunGauntlet: (count: number) => void runGauntlet(count),
      onReplayVariant: (gid: string, vid: string) => void replayVariant(gid, vid),
      onReset: () => void resetRoom(),
      onAbort: () => executor.abort(),
      onToggleFollow: (on: boolean) => {
        follow = on;
      },
      onToggleLabels: (on: boolean) => setLabels(on),
    };
  }

  async function resetRoom(): Promise<void> {
    await executor.abort();
    const start = store.getState().robot.pos;
    const startCell = nearestFree(grid, worldToCell(grid, start.x, start.z), 20) ?? { c: Math.floor(grid.cols / 2), r: Math.floor(grid.rows / 2) };
    const seed = seedRoom(grid, cellToWorld(grid, startCell));
    await store.reset(seed.entities, seed.robot);
    robot.setPose({ x: seed.robot.pos.x, y: world.floorY, z: seed.robot.pos.z }, 0);
    robot.setState('idle');
    select(null);
    hud.toast('Room reset');
  }

  async function runGauntlet(count: number): Promise<void> {
    const state = store.getState();
    const last = [...state.tasks].sort((a, b) => b.createdAt - a.createdAt).find((t) => t.status !== 'queued');
    const taskText = last?.text ?? 'put the red mug on the shelf';
    // Baseline = where the items were when that chore started, so "as-is" is the real starting layout.
    const before = new Map((last?.layoutBefore ?? []).map((l) => [l.id, l.pos] as const));
    const baseEntities = state.entities
      .filter((e) => !(e.kind === 'item' && e.clutter))
      .map(freshItem)
      .map((e) => (e.kind === 'item' && before.has(e.id) ? { ...e, pos: before.get(e.id)! } : e));
    const robotPose = { ...state.robot, pos: { ...robot.pos }, carrying: null };
    const gauntlet: Gauntlet = {
      id: newId('g'),
      taskText,
      status: 'running',
      createdAt: Date.now(),
      variants: Array.from({ length: count }, (_, i) => ({ id: `v${i + 1}`, seed: 1 + i * 7919, label: i === 0 ? 'as-is' : `variant ${i}`, passed: null, layout: { items: [], clutter: [] } })),
    };
    await store.addGauntlet(gauntlet);
    hud.toast(`Gauntlet: “${taskText}” × ${count}`);
    const variants = [...gauntlet.variants];
    for (let i = 0; i < count; i++) {
      await new Promise((r) => setTimeout(r, 120)); // let the tiles animate in
      const seed = variants[i].seed;
      const layout = i === 0 ? { items: [], clutter: [] } : makeVariantLayout(grid, baseEntities, robotPose, seed, { clutterCount: 2 + (i % 3) });
      const staged = applyLayout(baseEntities, layout);
      const outcome = runTrial(grid, staged, robotPose, taskText, trial);
      variants[i] = { ...variants[i], passed: outcome.passed, reason: outcome.reason, distanceM: outcome.distanceUnits * mpu, layout, stuckAt: outcome.stuckAt };
      await store.updateGauntlet(gauntlet.id, { variants: [...variants] });
    }
    await store.updateGauntlet(gauntlet.id, { status: 'done', variants });
    const heat = variants.filter((v) => v.passed === false && v.stuckAt).map((v) => ({ ...v.stuckAt!, y: world.floorY }));
    if (heat.length) await store.setHeat([...store.getState().heat, ...heat]);
    const passes = variants.filter((v) => v.passed).length;
    hud.toast(`Gauntlet done: ${passes}/${count} layouts pass`);
    if (passes < count) sfx.fail();
    else sfx.pass();
  }

  async function replayVariant(gid: string, vid: string): Promise<void> {
    const g = store.getState().gauntlets.find((x) => x.id === gid);
    const v = g?.variants.find((x) => x.id === vid);
    if (!g || !v) return;
    if (executor.isBusy) {
      hud.toast('Robot is busy — stop it first.');
      return;
    }
    // Remove old clutter, restore the baseline layout, apply this variant's shuffle, then rehearse the same chore for real.
    const state = store.getState();
    for (const e of state.entities) if (e.kind === 'item' && e.clutter) await store.removeEntity(e.id);
    const last = [...state.tasks].sort((a, b) => b.createdAt - a.createdAt).find((t) => t.text === g.taskText && t.layoutBefore);
    for (const l of last?.layoutBefore ?? []) await store.updateEntity(l.id, { pos: l.pos, state: 'idle', zoneId: null, heldBy: null } as Partial<Item>);
    for (const it of v.layout.items) await store.updateEntity(it.id, { pos: it.pos, state: 'idle', zoneId: null, heldBy: null } as Partial<Item>);
    let i = 0;
    for (const c of v.layout.clutter) {
      const box: Item = { id: newId('clutter'), kind: 'item', name: `clutter box ${++i}`, tags: ['clutter', 'box'], pos: { x: c.x, y: world.floorY, z: c.z }, yaw: Math.random() * 0.6, createdAt: Date.now(), shape: 'crate', color: '#b8874a', size: 0.9, state: 'idle', clutter: true };
      await store.addEntity(box);
    }
    hud.toast(`Replaying ${v.label} in 3D`);
    await store.submitTask(g.taskText, `gauntlet ${v.label}`);
  }

  /* ---------------- loop ---------------- */
  const clock = new THREE.Clock();
  const tmpTarget = new THREE.Vector3();
  function frame(): void {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.25);
    executor.tick(dt);
    room.tick(dt);
    if (follow) {
      tmpTarget.set(robot.pos.x, world.floorY + 1.0, robot.pos.z);
      const before = controls.target.clone();
      controls.target.lerp(tmpTarget, 1 - Math.exp(-3 * dt));
      camera.position.add(controls.target.clone().sub(before));
    }
    sun.position.set(robot.pos.x - 12, world.floorY + 40, robot.pos.z + 10);
    sun.target.position.set(robot.pos.x, world.floorY, robot.pos.z);
    controls.update();
    renderer.render(scene, camera);
  }
  frame();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function freshItem(e: Entity): Entity {
  return e.kind === 'item' ? { ...e, state: 'idle', heldBy: null, zoneId: null } : e;
}

function sizeFor(shape: string): number {
  return { mug: 0.55, bottle: 0.85, book: 0.5, plant: 0.9, ball: 0.5, can: 0.5, box: 0.7, crate: 0.9 }[shape] ?? 0.6;
}

async function loadManifest(): Promise<AssetManifest | null> {
  try {
    const res = await fetch(assetUrl('assets/manifest.json'), { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as AssetManifest;
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error(e);
  const el = document.createElement('pre');
  el.className = 'fatal';
  el.textContent = `Dry Run failed to start:\n${(e as Error).stack ?? e}`;
  document.body.appendChild(el);
});
