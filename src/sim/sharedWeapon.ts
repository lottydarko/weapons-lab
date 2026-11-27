import * as THREE from 'three';
import { CollisionWorld, getRoadElevationAt, getTerrainHeight } from './mapData';
import { FpsRayTarget } from './fpsBridge';
import { worldEventBus } from './worldEventBus';

/**
 * Shared Weapon Module (Standing Law: one definition — model, behavior, stats —
 * drawn from by both the player and armed enemies).
 */
export interface SharedWeaponSpec {
  id: string;
  label: string;
  damage: number;
  fireRateHz: number;
  burstCount: number;
  burstCooldownSec: number;
  rangeM: number;
  playerSpreadRad: number;
  npcSpreadRad: number;
  magazineSize: number;
  reloadSec: number;
  loudRadiusM: number;
}

export const SHARED_WEAPON_SPEC: SharedWeaponSpec = {
  id: 'service_carbine',
  label: 'Service Carbine',
  damage: 18,
  fireRateHz: 8.2,
  burstCount: 3,
  burstCooldownSec: 1.05,
  rangeM: 78,
  playerSpreadRad: 0.012,
  npcSpreadRad: 0.052,
  magazineSize: 30,
  reloadSec: 1.75,
  loudRadiusM: 54,
};

let _gunMetalMat: THREE.MeshStandardMaterial | null = null;
let _polymerMat: THREE.MeshStandardMaterial | null = null;
let _steelBarrelMat: THREE.MeshStandardMaterial | null = null;

function getSharedWeaponMaterials() {
  if (!_gunMetalMat) {
    _gunMetalMat = new THREE.MeshStandardMaterial({
      color: '#222831',
      roughness: 0.42,
      metalness: 0.78,
    });
    _polymerMat = new THREE.MeshStandardMaterial({
      color: '#13161b',
      roughness: 0.72,
      metalness: 0.16,
    });
    _steelBarrelMat = new THREE.MeshStandardMaterial({
      color: '#39414d',
      roughness: 0.34,
      metalness: 0.88,
    });
  }
  return {
    gunMetal: _gunMetalMat,
    polymer: _polymerMat!,
    steel: _steelBarrelMat!,
  };
}

/**
 * Builds the canonical shared carbine mesh (oriented along +Z forward, grip near origin).
 * Used identically by both the player FPS viewmodel and armed NPCs (gangs, shooters, heists).
 */
export function createSharedWeaponMesh(scale = 1.0): THREE.Group {
  const { gunMetal, polymer, steel } = getSharedWeaponMaterials();
  const gun = new THREE.Group();
  gun.name = 'SharedServiceCarbine';

  // Upper & lower receiver
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.078, 0.28), gunMetal);
  receiver.position.set(0, 0.032, 0.06);
  gun.add(receiver);

  // Top accessory rail
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.014, 0.24), steel);
  rail.position.set(0, 0.076, 0.07);
  gun.add(rail);

  // Rear iron / reflex sight housing
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.024, 0.044), polymer);
  sight.position.set(0, 0.092, 0.01);
  gun.add(sight);

  // Pistol grip anchored at (0, 0, 0)
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.098, 0.044), polymer);
  grip.position.set(0, -0.038, -0.016);
  grip.rotation.x = 0.24;
  gun.add(grip);

  // Curved box magazine
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.145, 0.056), polymer);
  mag.position.set(0, -0.062, 0.105);
  mag.rotation.x = -0.14;
  gun.add(mag);

  // Folding stock
  const stockBar = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.036, 0.22), polymer);
  stockBar.position.set(0, 0.028, -0.17);
  gun.add(stockBar);
  const buttPad = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.098, 0.03), polymer);
  buttPad.position.set(0, 0.012, -0.275);
  gun.add(buttPad);

  // Handguard + vented shroud
  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.058, 0.22), polymer);
  handguard.position.set(0, 0.034, 0.29);
  gun.add(handguard);

  // Barrel + flash suppressor
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.012, 0.22, 8), steel);
  barrel.rotation.x = Math.PI * 0.5;
  barrel.position.set(0, 0.042, 0.48);
  gun.add(barrel);

  const muzzleBrake = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.014, 0.046, 8), gunMetal);
  muzzleBrake.rotation.x = Math.PI * 0.5;
  muzzleBrake.position.set(0, 0.042, 0.595);
  gun.add(muzzleBrake);

  // Front sight post
  const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.024, 0.016), steel);
  frontSight.position.set(0, 0.068, 0.42);
  gun.add(frontSight);

  // Muzzle anchor node for flash & tracer alignment
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.name = 'MuzzleAnchor';
  muzzleAnchor.position.set(0, 0.042, 0.625);
  gun.add(muzzleAnchor);

  if (scale !== 1.0) {
    gun.scale.setScalar(scale);
  }
  return gun;
}

export interface WeaponHitResult {
  hit: boolean;
  kind: 'none' | 'world' | 'npc' | 'player';
  agentId?: string;
  point: THREE.Vector3;
  distance: number;
  damage: number;
}

interface TracerEntry {
  mesh: THREE.Mesh;
  flash: THREE.Mesh;
  life: number;
  maxLife: number;
}

/**
 * Pooled tracer & muzzle flash FX manager shared across player and NPC shooters.
 */
export class SharedWeaponFxPool {
  public readonly root = new THREE.Group();
  private pool: TracerEntry[] = [];
  private cursor = 0;

  constructor(poolSize = 24) {
    const tracerGeo = new THREE.CylinderGeometry(0.014, 0.014, 1.0, 5);
    tracerGeo.rotateX(Math.PI * 0.5);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: '#fde68a',
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
    });
    const flashGeo = new THREE.SphereGeometry(0.09, 6, 6);
    const flashMat = new THREE.MeshBasicMaterial({
      color: '#fbbf24',
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });

    for (let i = 0; i < poolSize; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false;
      const flash = new THREE.Mesh(flashGeo, flashMat);
      flash.visible = false;
      this.root.add(mesh, flash);
      this.pool.push({ mesh, flash, life: 0, maxLife: 0.09 });
    }
  }

  public spawnShot(start: THREE.Vector3, end: THREE.Vector3): void {
    const entry = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const len = Math.max(0.25, Math.hypot(dx, dy, dz));

    entry.mesh.position.set((start.x + end.x) * 0.5, (start.y + end.y) * 0.5, (start.z + end.z) * 0.5);
    entry.mesh.lookAt(end);
    entry.mesh.scale.set(1, 1, Math.min(len, 18));
    entry.mesh.visible = true;

    entry.flash.position.copy(start);
    entry.flash.scale.setScalar(0.75 + Math.random() * 0.5);
    entry.flash.visible = true;

    entry.life = 0.075;
    entry.maxLife = 0.075;
  }

  public update(dt: number): void {
    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[i];
      if (e.life <= 0) continue;
      e.life -= dt;
      if (e.life <= 0) {
        e.mesh.visible = false;
        e.flash.visible = false;
      } else if (e.life < e.maxLife * 0.5) {
        e.flash.visible = false;
      }
    }
  }
}

const _ray = new THREE.Ray();
const _hitPt = new THREE.Vector3();
const _tmpDir = new THREE.Vector3();

/**
 * Shared raycast & event emission for any shot fired from the shared carbine.
 */
export function fireSharedWeapon(params: {
  origin: THREE.Vector3;
  muzzleWorld: THREE.Vector3;
  dir: THREE.Vector3;
  shooterKind: 'player' | 'gang' | 'killer' | 'shooter' | 'police';
  shooterId: string;
  spreadRad: number;
  rayTargets: FpsRayTarget[];
  collisionWorld?: CollisionWorld;
  playerHitBox?: THREE.Box3 | null;
  fxPool?: SharedWeaponFxPool;
  districtId?: string;
  onSound?: (distM: number) => void;
  listenerPos?: THREE.Vector3;
}): WeaponHitResult {
  const {
    origin,
    muzzleWorld,
    dir,
    shooterKind,
    shooterId,
    spreadRad,
    rayTargets,
    collisionWorld,
    playerHitBox,
    fxPool,
    districtId,
    onSound,
    listenerPos,
  } = params;

  _tmpDir.copy(dir).normalize();
  if (spreadRad > 0) {
    _tmpDir.x += (Math.random() - 0.5) * 2 * spreadRad;
    _tmpDir.y += (Math.random() - 0.5) * 2 * spreadRad * 0.7;
    _tmpDir.z += (Math.random() - 0.5) * 2 * spreadRad;
    _tmpDir.normalize();
  }

  _ray.origin.copy(origin);
  _ray.direction.copy(_tmpDir);

  let bestDist = SHARED_WEAPON_SPEC.rangeM;
  let bestKind: WeaponHitResult['kind'] = 'none';
  let bestAgentId: string | undefined;
  const bestPoint = new THREE.Vector3()
    .copy(origin)
    .addScaledVector(_tmpDir, SHARED_WEAPON_SPEC.rangeM);

  // 1. Test against provided ray targets (NPCs + world boxes)
  for (let i = 0; i < rayTargets.length; i++) {
    const t = rayTargets[i];
    if (t.id === shooterId || t.agentId === shooterId) continue;
    const res = _ray.intersectBox(t.bounds, _hitPt);
    if (!res) continue;
    const d = origin.distanceTo(res);
    if (d < bestDist && d > 0.25) {
      bestDist = d;
      bestKind = t.kind;
      bestAgentId = t.agentId;
      bestPoint.copy(res);
    }
  }

  // 2. Test against player hitbox if shooter is an NPC
  if (shooterKind !== 'player' && playerHitBox) {
    const res = _ray.intersectBox(playerHitBox, _hitPt);
    if (res) {
      const d = origin.distanceTo(res);
      if (d < bestDist && d > 0.25) {
        bestDist = d;
        bestKind = 'player';
        bestAgentId = 'player';
        bestPoint.copy(res);
      }
    }
  }

  // 3. Test ground plane / terrain height along ray if descending
  if (_tmpDir.y < -0.02) {
    const groundY = Math.max(getTerrainHeight(origin.x, origin.z), getRoadElevationAt(origin.x, origin.z));
    const tGround = (groundY - origin.y) / _tmpDir.y;
    if (tGround > 0.4 && tGround < bestDist) {
      bestDist = tGround;
      bestKind = 'world';
      bestAgentId = undefined;
      bestPoint.copy(origin).addScaledVector(_tmpDir, tGround);
    }
  }

  // 4. Optional coarse static LOS clamp if no world target matched closer
  if (collisionWorld && bestKind === 'none') {
    const blocked = !collisionWorld.hasLineOfSight(origin.x, origin.z, bestPoint.x, bestPoint.z);
    if (blocked) {
      bestDist = Math.min(bestDist, 24);
      bestPoint.copy(origin).addScaledVector(_tmpDir, bestDist);
      bestKind = 'world';
    }
  }

  fxPool?.spawnShot(muzzleWorld, bestPoint);

  if (onSound) {
    const d = listenerPos ? listenerPos.distanceTo(origin) : 0;
    if (d < SHARED_WEAPON_SPEC.loudRadiusM * 1.4) {
      onSound(d);
    }
  }

  worldEventBus.emit({
    type: 'gunfire',
    x: origin.x,
    y: origin.y,
    z: origin.z,
    shooterKind,
    loudRadius: SHARED_WEAPON_SPEC.loudRadiusM,
    districtId,
  });

  return {
    hit: bestKind !== 'none',
    kind: bestKind,
    agentId: bestAgentId,
    point: bestPoint,
    distance: bestDist,
    damage: SHARED_WEAPON_SPEC.damage,
  };
}
