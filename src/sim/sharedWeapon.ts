import * as THREE from 'three';
import { CollisionWorld, getRoadElevationAt, getTerrainHeight } from './mapData';
import { FpsRayTarget } from './fpsBridge';
import { worldEventBus } from './worldEventBus';

/**
 * Shared Weapon Module (Standing Law: one definition — model, behavior, stats —
 * drawn from by both the player and armed enemies).
 */
export type SharedWeaponId = 'service_carbine' | 'full_auto_carbine' | 'pump_shotgun';

export const SHARED_WEAPON_IDS: readonly SharedWeaponId[] = [
  'service_carbine',
  'full_auto_carbine',
  'pump_shotgun',
] as const;

export interface SharedWeaponSpec {
  id: SharedWeaponId;
  label: string;
  damage: number;
  pellets: number;
  fireRateHz: number;
  burstCount: number;
  burstCooldownSec: number;
  sustainedFire: boolean;
  pumpCycleSec: number;
  rangeM: number;
  falloffStartM: number;
  falloffMinScale: number;
  playerSpreadRad: number;
  npcSpreadRad: number;
  magazineSize: number;
  reloadSec: number;
  loudRadiusM: number;
}

export const SHARED_WEAPON_SPECS: Record<SharedWeaponId, SharedWeaponSpec> = {
  service_carbine: {
    id: 'service_carbine',
    label: 'Service Carbine',
    damage: 18,
    pellets: 1,
    fireRateHz: 8.2,
    burstCount: 3,
    burstCooldownSec: 1.05,
    sustainedFire: false,
    pumpCycleSec: 0,
    rangeM: 78,
    falloffStartM: 0,
    falloffMinScale: 1.0,
    playerSpreadRad: 0.012,
    npcSpreadRad: 0.052,
    magazineSize: 30,
    reloadSec: 1.75,
    loudRadiusM: 54,
  },
  full_auto_carbine: {
    id: 'full_auto_carbine',
    label: 'Full-Auto Carbine',
    damage: 14,
    pellets: 1,
    fireRateHz: 11.0,
    burstCount: 40,
    burstCooldownSec: 0,
    sustainedFire: true,
    pumpCycleSec: 0,
    rangeM: 72,
    falloffStartM: 0,
    falloffMinScale: 1.0,
    playerSpreadRad: 0.024,
    npcSpreadRad: 0.075,
    magazineSize: 40,
    reloadSec: 2.1,
    loudRadiusM: 58,
  },
  pump_shotgun: {
    id: 'pump_shotgun',
    label: 'Pump Shotgun',
    damage: 9,
    pellets: 8,
    fireRateHz: 0.9,
    burstCount: 1,
    burstCooldownSec: 0,
    sustainedFire: false,
    pumpCycleSec: 1 / 0.9,
    rangeM: 48,
    falloffStartM: 25,
    falloffMinScale: 0.25,
    playerSpreadRad: 0.09,
    npcSpreadRad: 0.09,
    magazineSize: 6,
    reloadSec: 3.2,
    loudRadiusM: 68,
  },
};

/** Backwards-compatible canonical Service Carbine spec */
export const SHARED_WEAPON_SPEC: SharedWeaponSpec = SHARED_WEAPON_SPECS.service_carbine;

export function getSharedWeaponSpec(weaponId: SharedWeaponId = 'service_carbine'): SharedWeaponSpec {
  return SHARED_WEAPON_SPECS[weaponId] ?? SHARED_WEAPON_SPECS.service_carbine;
}

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

function buildCarbineFamilyMesh(fullAuto: boolean): THREE.Group {
  const { gunMetal, polymer, steel } = getSharedWeaponMaterials();
  const gun = new THREE.Group();
  gun.name = fullAuto ? 'SharedFullAutoCarbine' : 'SharedServiceCarbine';

  // Upper & lower receiver (same receiver family for Service & Full-Auto carbines)
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

  // Curved box magazine (extended 40-round mag on Full-Auto variation)
  const mag = new THREE.Mesh(
    new THREE.BoxGeometry(fullAuto ? 0.032 : 0.03, fullAuto ? 0.215 : 0.145, fullAuto ? 0.058 : 0.056),
    polymer
  );
  mag.name = 'MagazineMesh';
  mag.position.set(0, fullAuto ? -0.095 : -0.062, fullAuto ? 0.112 : 0.105);
  mag.rotation.x = fullAuto ? -0.2 : -0.14;
  gun.add(mag);

  if (fullAuto) {
    // Extended magazine baseplate lip for clear silhouette readability
    const magFoot = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.018, 0.064), gunMetal);
    magFoot.position.set(0, -0.106, 0.002);
    mag.add(magFoot);
  }

  // Folding stock
  const stockBar = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.036, 0.22), polymer);
  stockBar.position.set(0, 0.028, -0.17);
  gun.add(stockBar);
  const buttPad = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.098, 0.03), polymer);
  buttPad.position.set(0, 0.012, -0.275);
  gun.add(buttPad);

  // Handguard + vented shroud (slightly heavier heat shroud on full-auto variation)
  const handguard = new THREE.Mesh(
    new THREE.BoxGeometry(fullAuto ? 0.05 : 0.044, fullAuto ? 0.064 : 0.058, fullAuto ? 0.24 : 0.22),
    polymer
  );
  handguard.position.set(0, 0.034, fullAuto ? 0.30 : 0.29);
  gun.add(handguard);

  if (fullAuto) {
    // Upper cooling shroud rib on sustained-fire barrel
    const shroud = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.014, 0.20), steel);
    shroud.position.set(0, 0.069, 0.30);
    gun.add(shroud);
  }

  // Barrel + flash suppressor / compensator
  const barrelLen = fullAuto ? 0.24 : 0.22;
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(fullAuto ? 0.013 : 0.011, fullAuto ? 0.014 : 0.012, barrelLen, 8),
    steel
  );
  barrel.rotation.x = Math.PI * 0.5;
  barrel.position.set(0, 0.042, fullAuto ? 0.50 : 0.48);
  gun.add(barrel);

  const muzzleBrake = new THREE.Mesh(
    new THREE.CylinderGeometry(fullAuto ? 0.018 : 0.015, fullAuto ? 0.016 : 0.014, fullAuto ? 0.056 : 0.046, 8),
    gunMetal
  );
  muzzleBrake.rotation.x = Math.PI * 0.5;
  muzzleBrake.position.set(0, 0.042, fullAuto ? 0.625 : 0.595);
  gun.add(muzzleBrake);

  // Front sight post
  const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.024, 0.016), steel);
  frontSight.position.set(0, 0.068, fullAuto ? 0.44 : 0.42);
  gun.add(frontSight);

  // Muzzle anchor node for flash & tracer alignment
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.name = 'MuzzleAnchor';
  muzzleAnchor.position.set(0, 0.042, fullAuto ? 0.658 : 0.625);
  gun.add(muzzleAnchor);

  return gun;
}

function buildPumpShotgunMesh(): THREE.Group {
  const { gunMetal, polymer, steel } = getSharedWeaponMaterials();
  const gun = new THREE.Group();
  gun.name = 'SharedPumpShotgun';

  // Heavy tactical shotgun receiver (same low-poly procedural build style)
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.08, 0.27), gunMetal);
  receiver.position.set(0, 0.032, 0.055);
  gun.add(receiver);

  // Top ghost-ring rail + rear sight
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.012, 0.21), steel);
  rail.position.set(0, 0.077, 0.058);
  gun.add(rail);

  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.022, 0.036), polymer);
  sight.position.set(0, 0.09, 0.008);
  gun.add(sight);

  // Ejection port recess accent on receiver right side
  const port = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.026, 0.078), steel);
  port.position.set(0.025, 0.042, 0.072);
  gun.add(port);

  // Combat grip anchored at (0, 0, 0) + sloped buttstock
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.096, 0.046), polymer);
  grip.position.set(0, -0.036, -0.016);
  grip.rotation.x = 0.28;
  gun.add(grip);

  const stockNeck = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.056, 0.22), polymer);
  stockNeck.position.set(0, 0.012, -0.17);
  stockNeck.rotation.x = 0.14;
  gun.add(stockNeck);

  const buttPad = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.114, 0.034), polymer);
  buttPad.position.set(0, -0.008, -0.28);
  gun.add(buttPad);

  // Heavy smoothbore 12ga barrel
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0155, 0.0165, 0.44, 8), steel);
  barrel.rotation.x = Math.PI * 0.5;
  barrel.position.set(0, 0.052, 0.405);
  gun.add(barrel);

  // Under-barrel 6-shell tubular magazine
  const magTube = new THREE.Mesh(new THREE.CylinderGeometry(0.0135, 0.0135, 0.39, 8), gunMetal);
  magTube.rotation.x = Math.PI * 0.5;
  magTube.position.set(0, 0.021, 0.38);
  gun.add(magTube);

  // Front barrel-to-tube clamp + front bead sight
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.056, 0.024), gunMetal);
  clamp.position.set(0, 0.036, 0.54);
  gun.add(clamp);

  const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.02, 0.014), steel);
  frontSight.position.set(0, 0.072, 0.59);
  gun.add(frontSight);

  // Sliding ribbed pump forend (animated back & forward along Z coupled to 0.9 Hz shot cycle)
  const pumpForend = new THREE.Group();
  pumpForend.name = 'PumpForend';
  pumpForend.position.set(0, 0.018, 0.31);
  const forendBody = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.052, 0.175), polymer);
  pumpForend.add(forendBody);
  for (let r = -2; r <= 2; r++) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.044, 0.012), gunMetal);
    rib.position.set(0, -0.002, r * 0.028);
    pumpForend.add(rib);
  }
  gun.add(pumpForend);

  // Muzzle anchor node for flash & pellet tracers
  const muzzleAnchor = new THREE.Object3D();
  muzzleAnchor.name = 'MuzzleAnchor';
  muzzleAnchor.position.set(0, 0.052, 0.635);
  gun.add(muzzleAnchor);

  return gun;
}

/**
 * Builds a canonical shared weapon mesh (oriented along +Z forward, grip near origin).
 * Used identically by both the player FPS viewmodel and armed NPCs (cloned to matte black for enemies).
 */
export function createSharedWeaponMesh(
  scale = 1.0,
  weaponId: SharedWeaponId = 'service_carbine'
): THREE.Group {
  let gun: THREE.Group;
  if (weaponId === 'full_auto_carbine') {
    gun = buildCarbineFamilyMesh(true);
  } else if (weaponId === 'pump_shotgun') {
    gun = buildPumpShotgunMesh();
  } else {
    gun = buildCarbineFamilyMesh(false);
  }

  if (scale !== 1.0) {
    gun.scale.setScalar(scale);
  }
  return gun;
}

export interface WeaponPelletHit {
  kind: 'world' | 'npc' | 'player';
  agentId?: string;
  point: THREE.Vector3;
  distance: number;
  damage: number;
}

export interface WeaponHitResult {
  hit: boolean;
  kind: 'none' | 'world' | 'npc' | 'player';
  agentId?: string;
  point: THREE.Vector3;
  distance: number;
  damage: number;
  /** Aggregated per-target hits (populated for multi-pellet weapons like pump_shotgun) */
  hits?: WeaponPelletHit[];
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

  constructor(poolSize = 36) {
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

  public spawnShot(start: THREE.Vector3, end: THREE.Vector3, withFlash = true): void {
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

    if (withFlash) {
      entry.flash.position.copy(start);
      entry.flash.scale.setScalar(0.75 + Math.random() * 0.5);
      entry.flash.visible = true;
    } else {
      entry.flash.visible = false;
    }

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
const _pelletPt = new THREE.Vector3();

function computeFalloffDamage(spec: SharedWeaponSpec, distanceM: number): number {
  if (spec.falloffStartM <= 0 || distanceM <= spec.falloffStartM) {
    return spec.damage;
  }
  const span = Math.max(1, spec.rangeM - spec.falloffStartM);
  const t = THREE.MathUtils.clamp((distanceM - spec.falloffStartM) / span, 0, 1);
  const scale = THREE.MathUtils.lerp(1.0, spec.falloffMinScale, t);
  return Math.max(1, Math.round(spec.damage * scale));
}

/**
 * Shared raycast & event emission for any shot fired from the shared arsenal
 * (Service Carbine, Full-Auto Carbine, or 8-pellet Pump Shotgun with falloff past 25m).
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
  weaponId?: SharedWeaponId;
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
    weaponId = 'service_carbine',
  } = params;

  const spec = getSharedWeaponSpec(weaponId);
  const pelletCount = Math.max(1, spec.pellets);
  const effectiveSpread = spreadRad > 0 ? spreadRad : spec.playerSpreadRad;

  let primaryKind: WeaponHitResult['kind'] = 'none';
  let primaryAgentId: string | undefined;
  let primaryDist = spec.rangeM;
  let primaryDamage = 0;
  const primaryPoint = new THREE.Vector3().copy(origin).addScaledVector(dir, spec.rangeM);

  const hitMap = pelletCount > 1 ? new Map<string, WeaponPelletHit>() : null;

  for (let p = 0; p < pelletCount; p++) {
    _tmpDir.copy(dir).normalize();
    if (effectiveSpread > 0) {
      // Uniform disk-like cone scatter for pellets and rifle spread
      const rx = (Math.random() - 0.5) * 2 * effectiveSpread;
      const ry = (Math.random() - 0.5) * 2 * effectiveSpread * (pelletCount > 1 ? 0.9 : 0.7);
      const rz = (Math.random() - 0.5) * 2 * effectiveSpread;
      _tmpDir.x += rx;
      _tmpDir.y += ry;
      _tmpDir.z += rz;
      _tmpDir.normalize();
    }

    _ray.origin.copy(origin);
    _ray.direction.copy(_tmpDir);

    let bestDist = spec.rangeM;
    let bestKind: WeaponHitResult['kind'] = 'none';
    let bestAgentId: string | undefined;
    _pelletPt.copy(origin).addScaledVector(_tmpDir, spec.rangeM);

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
        _pelletPt.copy(res);
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
          _pelletPt.copy(res);
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
        _pelletPt.copy(origin).addScaledVector(_tmpDir, tGround);
      }
    }

    // 4. Optional coarse static LOS clamp if no world target matched closer
    if (collisionWorld && bestKind === 'none') {
      const blocked = !collisionWorld.hasLineOfSight(origin.x, origin.z, _pelletPt.x, _pelletPt.z);
      if (blocked) {
        bestDist = Math.min(bestDist, 24);
        _pelletPt.copy(origin).addScaledVector(_tmpDir, bestDist);
        bestKind = 'world';
      }
    }

    fxPool?.spawnShot(muzzleWorld, _pelletPt, p === 0);

    const pelletDmg = computeFalloffDamage(spec, bestDist);

    if (hitMap) {
      if (bestKind !== 'none') {
        const key = `${bestKind}:${bestAgentId ?? 'world'}`;
        const existing = hitMap.get(key);
        if (existing) {
          existing.damage += pelletDmg;
          if (bestDist < existing.distance) {
            existing.distance = bestDist;
            existing.point.copy(_pelletPt);
          }
        } else {
          hitMap.set(key, {
            kind: bestKind,
            agentId: bestAgentId,
            point: _pelletPt.clone(),
            distance: bestDist,
            damage: pelletDmg,
          });
        }
      }
    } else {
      primaryKind = bestKind;
      primaryAgentId = bestAgentId;
      primaryDist = bestDist;
      primaryDamage = pelletDmg;
      primaryPoint.copy(_pelletPt);
    }
  }

  let hits: WeaponPelletHit[] | undefined;
  if (hitMap) {
    hits = Array.from(hitMap.values());
    // Prefer entity hits (player/npc) as primary summary result, summing all pellets that landed on it
    let chosen: WeaponPelletHit | null = null;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (
        !chosen ||
        (chosen.kind === 'world' && h.kind !== 'world') ||
        (h.kind === chosen.kind && h.damage > chosen.damage)
      ) {
        chosen = h;
      }
    }
    if (chosen) {
      primaryKind = chosen.kind;
      primaryAgentId = chosen.agentId;
      primaryDist = chosen.distance;
      primaryDamage = chosen.damage;
      primaryPoint.copy(chosen.point);
    } else {
      primaryDamage = spec.damage;
    }
  }

  if (onSound) {
    const d = listenerPos ? listenerPos.distanceTo(origin) : 0;
    if (d < spec.loudRadiusM * 1.4) {
      onSound(d);
    }
  }

  worldEventBus.emit({
    type: 'gunfire',
    x: origin.x,
    y: origin.y,
    z: origin.z,
    shooterKind,
    loudRadius: spec.loudRadiusM,
    districtId,
  });

  return {
    hit: primaryKind !== 'none',
    kind: primaryKind,
    agentId: primaryAgentId,
    point: primaryPoint,
    distance: primaryDist,
    damage: primaryDamage,
    hits,
  };
}
