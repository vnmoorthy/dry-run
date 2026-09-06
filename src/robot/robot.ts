/**
 * The robot: a wheeled mobile manipulator that follows grid paths, reaches with
 * a two-link arm, and carries items in its gripper.
 *
 * Body options:
 *  - ProceduralBody: built from primitives (always available).
 *  - GltfBody      : a rigged, animated GLB (e.g. Tripo auto-rig + retarget)
 *                    listed in the asset manifest; idle/walk clips are crossfaded.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { AssetManifest, RobotState, Vec3 } from '../sim/types';

export interface RobotBody {
  root: THREE.Object3D;
  /** Anchor the carried item is parented to. */
  gripper: THREE.Object3D;
  update(dt: number, speed: number, moving: boolean): void;
  /** Animate the arm toward a point in the robot's local frame; resolves when done. */
  reach(localTarget: THREE.Vector3, duration: number): Promise<void>;
  retract(duration: number): Promise<void>;
  setState(state: RobotState): void;
  readonly heightUnits: number;
}

export interface RobotConfig {
  /** Total height in world units (used to scale bodies). */
  height: number;
  moveSpeed: number;
  turnSpeed: number;
  /** Arm reach in world units. */
  reach: number;
}

export const DEFAULT_ROBOT_CONFIG: RobotConfig = { height: 2.4, moveSpeed: 3.2, turnSpeed: 4.5, reach: 2.2 };

const STATE_COLORS: Record<RobotState, number> = { idle: 0x4da3ff, moving: 0x3ddc97, working: 0xffb340, failed: 0xff3b30 };

export class Robot {
  readonly group = new THREE.Group();
  state: RobotState = 'idle';
  private path: Vec3[] = [];
  private pathIndex = 0;
  private faceTarget: Vec3 | null = null;
  private speed = 0;
  distanceTravelled = 0;

  constructor(readonly body: RobotBody, readonly cfg: RobotConfig = DEFAULT_ROBOT_CONFIG) {
    this.group.name = 'Robot';
    this.group.add(body.root);
  }

  get pos(): Vec3 {
    const p = this.group.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  get yaw(): number {
    return this.group.rotation.y;
  }

  setPose(pos: Vec3, yaw: number): void {
    this.group.position.set(pos.x, pos.y, pos.z);
    this.group.rotation.y = yaw;
  }

  setState(s: RobotState): void {
    this.state = s;
    this.body.setState(s);
  }

  setPath(points: Vec3[]): void {
    this.path = points;
    this.pathIndex = 0;
    this.faceTarget = null;
  }

  hasPath(): boolean {
    return this.pathIndex < this.path.length;
  }

  get turning(): boolean {
    return this.faceTarget !== null;
  }

  stop(): void {
    this.path = [];
    this.pathIndex = 0;
    this.faceTarget = null;
  }

  /** Turn in place toward a world point (used before manipulating). */
  faceToward(target: Vec3): void {
    this.faceTarget = target;
    this.path = [];
    this.pathIndex = 0;
  }

  isFacing(target: Vec3, tolRad = 0.12): boolean {
    const want = Math.atan2(target.x - this.group.position.x, target.z - this.group.position.z);
    return Math.abs(angleDelta(this.group.rotation.y, want)) < tolRad;
  }

  /** Advance movement. Returns true when the current path is finished this frame. */
  update(dt: number, floorYAt: (x: number, z: number) => number): boolean {
    let arrived = false;
    let moving = false;
    if (this.faceTarget) {
      const want = Math.atan2(this.faceTarget.x - this.group.position.x, this.faceTarget.z - this.group.position.z);
      this.group.rotation.y = lerpAngle(this.group.rotation.y, want, 1 - Math.exp(-this.cfg.turnSpeed * dt));
      if (Math.abs(angleDelta(this.group.rotation.y, want)) < 0.05) {
        this.group.rotation.y = want;
        this.faceTarget = null;
      }
    } else if (this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      const dx = wp.x - this.group.position.x;
      const dz = wp.z - this.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.08) {
        this.pathIndex += 1;
        if (this.pathIndex >= this.path.length) arrived = true;
      } else {
        const want = Math.atan2(dx, dz);
        const delta = angleDelta(this.group.rotation.y, want);
        this.group.rotation.y = lerpAngle(this.group.rotation.y, want, 1 - Math.exp(-this.cfg.turnSpeed * dt));
        // Slow down while turning sharply so the motion reads as a real vehicle.
        const turnFactor = THREE.MathUtils.clamp(1 - Math.abs(delta) / Math.PI, 0.15, 1);
        const step = Math.min(dist, this.cfg.moveSpeed * turnFactor * dt);
        this.group.position.x += (dx / dist) * step;
        this.group.position.z += (dz / dist) * step;
        this.distanceTravelled += step;
        this.speed = step / Math.max(dt, 1e-4);
        moving = true;
      }
    }
    if (!moving) this.speed = THREE.MathUtils.lerp(this.speed, 0, 1 - Math.exp(-8 * dt));
    this.group.position.y = floorYAt(this.group.position.x, this.group.position.z);
    this.body.update(dt, this.speed, moving);
    return arrived;
  }

  gripperWorldPos(): Vec3 {
    const p = new THREE.Vector3();
    this.body.gripper.getWorldPosition(p);
    return { x: p.x, y: p.y, z: p.z };
  }

  async reachTo(worldPoint: Vec3, duration = 0.8): Promise<void> {
    const local = new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z);
    this.group.worldToLocal(local);
    await this.body.reach(local, duration);
  }

  retract(duration = 0.5): Promise<void> {
    return this.body.retract(duration);
  }

  attach(obj: THREE.Object3D): void {
    this.body.gripper.attach(obj);
    // Snap to the gripper so it looks held, not floating where it was.
    obj.position.set(0, -0.05, 0.05);
    obj.rotation.set(0, 0, 0);
  }

  detach(obj: THREE.Object3D, worldPos: Vec3, parent: THREE.Object3D, yaw = 0): void {
    parent.attach(obj);
    obj.position.set(worldPos.x, worldPos.y, worldPos.z);
    obj.rotation.set(0, yaw, 0);
  }

  static async fromManifest(manifest: AssetManifest | null, cfg: RobotConfig = DEFAULT_ROBOT_CONFIG): Promise<Robot> {
    if (manifest?.robot?.glbUrl) {
      try {
        const body = await GltfBody.load(manifest.robot.glbUrl, manifest.robot.clips ?? {}, manifest.robot.heightUnits ?? cfg.height);
        return new Robot(body, cfg);
      } catch (e) {
        console.warn('Robot GLB failed to load; using the procedural body', e);
      }
    }
    return new Robot(new ProceduralBody(cfg.height), cfg);
  }
}

function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function lerpAngle(from: number, to: number, t: number): number {
  return from + angleDelta(from, to) * t;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function m(color: number | string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15, ...extra });
}

function sh(mesh: THREE.Mesh): THREE.Mesh {
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}

/** Wheeled base + mast + two-link arm + two-finger gripper + LED ring. */
export class ProceduralBody implements RobotBody {
  root = new THREE.Group();
  gripper = new THREE.Group();
  readonly heightUnits: number;
  private wheels: THREE.Mesh[] = [];
  private shoulder = new THREE.Group();
  private elbow = new THREE.Group();
  private wrist = new THREE.Group();
  private fingerL: THREE.Mesh;
  private fingerR: THREE.Mesh;
  private led: THREE.MeshStandardMaterial;
  private eye: THREE.MeshStandardMaterial;
  private L1: number;
  private L2: number;
  private restPose = { shoulder: -0.55, elbow: 1.35, wrist: -0.8, yaw: 0 };
  private anim: { from: ArmPose; to: ArmPose; t: number; dur: number; resolve: () => void } | null = null;
  private bob = 0;

  constructor(height: number) {
    this.heightUnits = height;
    const s = height / 2.4; // designed at 2.4 units tall
    const baseW = 1.3 * s;
    const baseH = 0.5 * s;
    const baseD = 1.0 * s;
    const wheelR = 0.22 * s;
    const body = sh(new THREE.Mesh(new THREE.BoxGeometry(baseW, baseH, baseD, 1, 1, 1), m('#e8e6e1')));
    body.position.y = wheelR + baseH / 2;
    const bumper = sh(new THREE.Mesh(new THREE.BoxGeometry(baseW * 1.04, baseH * 0.35, baseD * 1.04), m('#ff7a1a')));
    bumper.position.y = wheelR + baseH * 0.2;
    this.root.add(body, bumper);
    const wheelGeo = new THREE.CylinderGeometry(wheelR, wheelR, 0.16 * s, 20);
    for (const [x, z] of [
      [-baseW / 2 - 0.02 * s, baseD * 0.32],
      [baseW / 2 + 0.02 * s, baseD * 0.32],
      [-baseW / 2 - 0.02 * s, -baseD * 0.32],
      [baseW / 2 + 0.02 * s, -baseD * 0.32],
    ]) {
      const w = sh(new THREE.Mesh(wheelGeo, m('#2a2a2e', { roughness: 0.8 })));
      w.rotation.z = Math.PI / 2;
      w.position.set(x, wheelR, z);
      this.root.add(w);
      this.wheels.push(w);
    }
    // Mast + head with lidar puck
    const mastH = 0.9 * s;
    const mast = sh(new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.11 * s, mastH, 16), m('#d0cdc6')));
    mast.position.set(-baseW * 0.22, wheelR + baseH + mastH / 2, -baseD * 0.1);
    const head = sh(new THREE.Mesh(new THREE.BoxGeometry(0.42 * s, 0.3 * s, 0.34 * s), m('#e8e6e1')));
    head.position.set(-baseW * 0.22, wheelR + baseH + mastH + 0.15 * s, -baseD * 0.1);
    this.eye = m('#4da3ff', { emissive: '#4da3ff', emissiveIntensity: 1.2 });
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.3 * s, 0.08 * s, 0.02 * s), this.eye);
    eye.position.set(-baseW * 0.22, wheelH(wheelR, baseH, mastH, s) + 0.02 * s, -baseD * 0.1 + 0.18 * s);
    const puck = sh(new THREE.Mesh(new THREE.CylinderGeometry(0.12 * s, 0.12 * s, 0.08 * s, 20), m('#2a2a2e')));
    puck.position.set(-baseW * 0.22, wheelR + baseH + mastH + 0.34 * s, -baseD * 0.1);
    this.led = m('#4da3ff', { emissive: '#4da3ff', emissiveIntensity: 1.5 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13 * s, 0.02 * s, 8, 32), this.led);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(puck.position);
    this.root.add(mast, head, eye, puck, ring);

    // Arm: shoulder at the front-top of the base, +Z is forward.
    this.L1 = 0.7 * s;
    this.L2 = 0.62 * s;
    this.shoulder.position.set(baseW * 0.15, wheelR + baseH + 0.08 * s, baseD * 0.2);
    // Yaw first, then pitch in the yawed plane — otherwise elevation scales with cos(yaw).
    this.shoulder.rotation.order = 'YXZ';
    const shoulderJoint = sh(new THREE.Mesh(new THREE.SphereGeometry(0.11 * s, 16, 12), m('#ff7a1a')));
    const upper = sh(new THREE.Mesh(new THREE.BoxGeometry(0.12 * s, 0.12 * s, this.L1), m('#d0cdc6')));
    upper.position.z = this.L1 / 2;
    this.shoulder.add(shoulderJoint, upper);
    this.elbow.position.z = this.L1;
    const elbowJoint = sh(new THREE.Mesh(new THREE.SphereGeometry(0.09 * s, 16, 12), m('#ff7a1a')));
    const fore = sh(new THREE.Mesh(new THREE.BoxGeometry(0.1 * s, 0.1 * s, this.L2), m('#d0cdc6')));
    fore.position.z = this.L2 / 2;
    this.elbow.add(elbowJoint, fore);
    this.shoulder.add(this.elbow);
    this.wrist.position.z = this.L2;
    const palm = sh(new THREE.Mesh(new THREE.BoxGeometry(0.2 * s, 0.1 * s, 0.1 * s), m('#2a2a2e')));
    this.fingerL = sh(new THREE.Mesh(new THREE.BoxGeometry(0.03 * s, 0.06 * s, 0.18 * s), m('#2a2a2e')));
    this.fingerR = this.fingerL.clone();
    this.fingerL.position.set(-0.07 * s, 0, 0.12 * s);
    this.fingerR.position.set(0.07 * s, 0, 0.12 * s);
    this.gripper.position.set(0, -0.02 * s, 0.16 * s);
    this.wrist.add(palm, this.fingerL, this.fingerR, this.gripper);
    this.elbow.add(this.wrist);
    this.root.add(this.shoulder);
    this.applyPose(this.restPose);
  }

  private applyPose(p: ArmPose): void {
    this.shoulder.rotation.set(p.shoulder, p.yaw, 0);
    this.elbow.rotation.x = p.elbow;
    this.wrist.rotation.x = p.wrist;
  }

  private currentPose(): ArmPose {
    return { shoulder: this.shoulder.rotation.x, elbow: this.elbow.rotation.x, wrist: this.wrist.rotation.x, yaw: this.shoulder.rotation.y };
  }

  /** Analytic 2-link IK in the vertical plane that contains the target. */
  private solve(local: THREE.Vector3): ArmPose {
    const rel = local.clone().sub(this.shoulder.position);
    const yaw = Math.atan2(rel.x, rel.z);
    const horiz = Math.hypot(rel.x, rel.z);
    const vert = rel.y;
    const L1 = this.L1;
    const L2 = this.L2 + 0.16 * (this.heightUnits / 2.4);
    let d = Math.hypot(horiz, vert);
    d = THREE.MathUtils.clamp(d, Math.abs(L1 - L2) + 0.02, L1 + L2 - 0.02);
    const cosElbow = (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2);
    const elbowInner = Math.acos(THREE.MathUtils.clamp(cosElbow, -1, 1));
    const elbow = Math.PI - elbowInner; // bend downward/inward
    const a1 = Math.atan2(vert, horiz);
    const a2 = Math.acos(THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    // Rotation about X: positive tilts the +Z arm downward in three.js (right-handed), so negate elevation.
    const shoulder = -(a1 + a2);
    const wrist = -(shoulder + elbow) * 0.6;
    return { shoulder, elbow, wrist, yaw };
  }

  reach(localTarget: THREE.Vector3, duration: number): Promise<void> {
    return this.animateTo(this.solve(localTarget), duration);
  }

  retract(duration: number): Promise<void> {
    return this.animateTo(this.restPose, duration);
  }

  private animateTo(to: ArmPose, dur: number): Promise<void> {
    if (this.anim) this.anim.resolve();
    return new Promise((resolve) => {
      this.anim = { from: this.currentPose(), to, t: 0, dur: Math.max(0.05, dur), resolve };
    });
  }

  setState(state: RobotState): void {
    const c = new THREE.Color(STATE_COLORS[state]);
    this.led.color.copy(c);
    this.led.emissive.copy(c);
    this.eye.color.copy(c);
    this.eye.emissive.copy(c);
  }

  update(dt: number, speed: number, moving: boolean): void {
    const s = this.heightUnits / 2.4;
    const wheelR = 0.22 * s;
    const spin = (speed * dt) / wheelR;
    for (const w of this.wheels) w.rotation.x += spin;
    this.bob += dt * (moving ? 6 : 1.5);
    this.root.position.y = Math.sin(this.bob) * (moving ? 0.008 : 0.004) * s;
    if (this.anim) {
      this.anim.t += dt;
      const k = easeInOut(Math.min(1, this.anim.t / this.anim.dur));
      const { from, to } = this.anim;
      this.applyPose({
        shoulder: THREE.MathUtils.lerp(from.shoulder, to.shoulder, k),
        elbow: THREE.MathUtils.lerp(from.elbow, to.elbow, k),
        wrist: THREE.MathUtils.lerp(from.wrist, to.wrist, k),
        yaw: lerpAngle(from.yaw, to.yaw, k),
      });
      if (k >= 1) {
        const r = this.anim.resolve;
        this.anim = null;
        r();
      }
    }
    // Fingers close when something is held.
    const holding = this.gripper.children.length > 0;
    const gap = holding ? 0.035 * s : 0.07 * s;
    this.fingerL.position.x = THREE.MathUtils.lerp(this.fingerL.position.x, -gap, 1 - Math.exp(-10 * dt));
    this.fingerR.position.x = THREE.MathUtils.lerp(this.fingerR.position.x, gap, 1 - Math.exp(-10 * dt));
  }
}

interface ArmPose {
  shoulder: number;
  elbow: number;
  wrist: number;
  yaw: number;
}

function wheelH(wheelR: number, baseH: number, mastH: number, s: number): number {
  return wheelR + baseH + mastH + 0.15 * s;
}

/** A rigged GLB (e.g. Tripo auto-rig + retarget) with idle/walk clips. */
export class GltfBody implements RobotBody {
  root = new THREE.Group();
  gripper = new THREE.Group();
  readonly heightUnits: number;
  private mixer: THREE.AnimationMixer | null = null;
  private idle: THREE.AnimationAction | null = null;
  private walk: THREE.AnimationAction | null = null;
  private playing: 'idle' | 'walk' = 'idle';
  private tint: THREE.MeshStandardMaterial[] = [];
  private reachOffset = 0;

  private constructor(model: THREE.Object3D, clips: THREE.AnimationClip[], names: { idle?: string; walk?: string }, height: number) {
    this.heightUnits = height;
    fitToHeight(model, height);
    this.root.add(model);
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mt of mats) if (mt instanceof THREE.MeshStandardMaterial) this.tint.push(mt);
    });
    // Hand anchor: in front of the chest.
    this.gripper.position.set(0, height * 0.45, height * 0.25);
    this.root.add(this.gripper);
    if (clips.length) {
      this.mixer = new THREE.AnimationMixer(model);
      const find = (name: string | undefined, re: RegExp) =>
        (name && clips.find((c) => c.name === name)) || clips.find((c) => re.test(c.name)) || null;
      const idleClip = find(names.idle, /idle|breath|stand/i) ?? clips[0];
      const walkClip = find(names.walk, /walk|run|move/i) ?? clips[Math.min(1, clips.length - 1)];
      this.idle = this.mixer.clipAction(idleClip);
      this.walk = this.mixer.clipAction(walkClip);
      this.idle.play();
      this.walk.play();
      this.walk.setEffectiveWeight(0);
    }
  }

  static async load(url: string, clips: { idle?: string; walk?: string }, height: number): Promise<GltfBody> {
    const gltf = await new GLTFLoader().loadAsync(url);
    console.info('[robot] clips in', url, gltf.animations.map((a) => a.name));
    return new GltfBody(gltf.scene, gltf.animations, clips, height);
  }

  update(dt: number, _speed: number, moving: boolean): void {
    if (this.mixer) {
      const want: 'idle' | 'walk' = moving ? 'walk' : 'idle';
      if (want !== this.playing && this.idle && this.walk) {
        const from = this.playing === 'idle' ? this.idle : this.walk;
        const to = want === 'idle' ? this.idle : this.walk;
        to.reset().setEffectiveWeight(1).play();
        from.crossFadeTo(to, 0.25, false);
        this.playing = want;
      }
      this.mixer.update(dt);
    }
    // Lean forward a little while "reaching".
    this.root.rotation.x = THREE.MathUtils.lerp(this.root.rotation.x, this.reachOffset, 1 - Math.exp(-6 * dt));
  }

  async reach(localTarget: THREE.Vector3, duration: number): Promise<void> {
    this.gripper.position.set(localTarget.x * 0.6, Math.max(0.2, localTarget.y), Math.max(0.3, localTarget.z * 0.6));
    this.reachOffset = 0.12;
    await sleep(duration);
  }

  async retract(duration: number): Promise<void> {
    this.reachOffset = 0;
    this.gripper.position.set(0, this.heightUnits * 0.45, this.heightUnits * 0.25);
    await sleep(duration);
  }

  setState(state: RobotState): void {
    const c = new THREE.Color(STATE_COLORS[state]);
    for (const mt of this.tint) {
      mt.emissive.copy(c);
      mt.emissiveIntensity = state === 'idle' ? 0.05 : 0.18;
    }
  }
}

function fitToHeight(model: THREE.Object3D, height: number): void {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const h = Math.max(box.max.y - box.min.y, 1e-4);
  model.scale.multiplyScalar(height / h);
  model.updateMatrixWorld(true);
  box.setFromObject(model);
  model.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
}

function sleep(s: number): Promise<void> {
  return new Promise((r) => setTimeout(r, s * 1000));
}
