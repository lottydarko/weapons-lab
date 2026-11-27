import * as THREE from 'three';
import {
  CollisionWorld,
  getDistrictAt,
  getRoadElevationAt,
  getTerrainHeight,
} from './mapData';
import { FpsRayTarget } from './fpsBridge';
import {
  createSharedWeaponMesh,
  fireSharedWeapon,
  SHARED_WEAPON_SPEC,
  SharedWeaponFxPool,
} from './sharedWeapon';
import { worldEventBus } from './worldEventBus';
import { ArmoredTruckState } from './trafficSystem';

export type CrimeEventKind =
  | 'bother'
  | 'kill'
  | 'armored_truck_robbery'
  | 'mass_shooting'
  | 'gang_heist';

export type CrimeActorRole =
  | 'botherer'
  | 'killer'
  | 'truck_robber'
  | 'mass_shooter'
  | 'heist_gang';

export interface CrimeActor {
  id: string;
  role: CrimeActorRole;
  tier: 1 | 2 | 3;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  armed: boolean;
  hasArmorKit: boolean;
  burstCooldown: number;
  burstShotsLeft: number;
  burstShotTimer: number;
  ttl: number;
  root: THREE.Group;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
  walkPhase: number;
}

export interface CrimeTargetPed {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface CrimePlayerContext {
  pos: THREE.Vector3;
  inVehicle: boolean;
  speedKmh: number;
  onPlayerHit?: (damage: number) => void;
  onGunshotSound?: (distM: number) => void;
}

export interface CrimeDirectorHandles {
  root: THREE.Group;
  actors: CrimeActor[];
  update: (
    dt: number,
    elapsed: number,
    armoredTrucks: ArmoredTruckState[],
    pedTargets: CrimeTargetPed[],
    onHitPed: (pedId: string, damage: number, fromPos: THREE.Vector3) => void,
    playerCtx?: CrimePlayerContext
  ) => void;
  getRayTargets: (origin: THREE.Vector3, radiusM: number) => FpsRayTarget[];
  applyDamage: (agentKey: string, damage: number, shooterPos?: THREE.Vector3) => boolean;
  getSummary: () => {
    activeEvent: CrimeEventKind | null;
    activeActors: number;
    globalIntenseCooldown: number;
    armoredTruckCount: number;
    countsByKind: Record<CrimeEventKind, number>;
  };
  dispose: () => void;
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleY(x: number, z: number): number {
  const th = getTerrainHeight(x, z);
  const rh = getRoadElevationAt(x, z);
  return Math.max(0.02, th, rh > 0.05 ? rh : 0.02);
}

/**
 * Coordinates the Ambient Crime Layer (Tier 1 botherers, Tier 2 killers, Tier 3 kitted mass shooters),
 * occasional Armored Truck robberies, and rarest Russian gang heists strictly obeying Intensity Spread.
 */
export function buildCrimeDirector(
  collisionWorld: CollisionWorld,
  fxPool: SharedWeaponFxPool,
  seed = 94112
): CrimeDirectorHandles {
  const rng = makeRng(seed);
  const root = new THREE.Group();
  root.name = 'CrimeDirector';

  const actors: CrimeActor[] = [];
  let actorSeq = 0;

  // Shared materials & geometries for ambient crime actors
  const bodyGeo = new THREE.BoxGeometry(0.42, 0.58, 0.24);
  const headGeo = new THREE.SphereGeometry(0.145, 10, 8);
  const limbGeo = new THREE.BoxGeometry(0.14, 0.54, 0.14);
  const armorPlateGeo = new THREE.BoxGeometry(0.47, 0.44, 0.30);
  const helmetGeo = new THREE.SphereGeometry(0.17, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.62);

  const skinMat = new THREE.MeshStandardMaterial({ color: '#d2aa8e', roughness: 0.72 });
  const armorMat = new THREE.MeshStandardMaterial({ color: '#1b2028', roughness: 0.56, metalness: 0.32 });

  const roleColors: Record<CrimeActorRole, string> = {
    botherer: '#5b4b43',
    killer: '#2d3138',
    truck_robber: '#262b34',
    mass_shooter: '#171b22',
    heist_gang: '#1b2026', // 2059 Russian dark tactical coat
  };

  function buildActorMesh(role: CrimeActorRole, armed: boolean, hasArmorKit: boolean) {
    const g = new THREE.Group();
    const coatMat = new THREE.MeshStandardMaterial({
      color: roleColors[role],
      roughness: 0.76,
      metalness: 0.08,
    });
    const trouserMat = new THREE.MeshStandardMaterial({ color: '#15181e', roughness: 0.82 });

    const torso = new THREE.Mesh(bodyGeo, coatMat);
    torso.position.y = 1.06;
    g.add(torso);

    if (hasArmorKit) {
      const vest = new THREE.Mesh(armorPlateGeo, armorMat);
      vest.position.y = 1.08;
      g.add(vest);
    }

    const head = new THREE.Mesh(headGeo, role === 'truck_robber' || role === 'heist_gang' ? armorMat : skinMat);
    head.position.y = 1.54;
    g.add(head);

    if (hasArmorKit) {
      const helmet = new THREE.Mesh(helmetGeo, armorMat);
      helmet.position.y = 1.57;
      g.add(helmet);
    }

    const leftLeg = new THREE.Mesh(limbGeo, trouserMat);
    leftLeg.position.set(0.11, 0.45, 0);
    g.add(leftLeg);

    const rightLeg = new THREE.Mesh(limbGeo, trouserMat);
    rightLeg.position.set(-0.11, 0.45, 0);
    g.add(rightLeg);

    const leftArm = new THREE.Mesh(limbGeo, coatMat);
    leftArm.position.set(0.28, 1.04, 0);
    g.add(leftArm);

    const rightArm = new THREE.Mesh(limbGeo, coatMat);
    rightArm.position.set(-0.28, 1.04, armed ? 0.14 : 0);
    if (armed) rightArm.rotation.x = -Math.PI * 0.42;
    g.add(rightArm);

    if (armed) {
      const weapon = createSharedWeaponMesh(0.95);
      weapon.position.set(-0.22, 1.12, 0.24);
      g.add(weapon);
    }

    return { g, leftArm, rightArm, leftLeg, rightLeg };
  }

  function spawnCrimeActor(
    role: CrimeActorRole,
    tier: 1 | 2 | 3,
    x: number,
    z: number,
    armed: boolean,
    hasArmorKit: boolean,
    ttl: number
  ): CrimeActor {
    const resolved = collisionWorld.resolveCircle(x, z, 0.65);
    const sx = resolved.hit ? resolved.x + resolved.nx * 0.8 : x;
    const sz = resolved.hit ? resolved.z + resolved.nz * 0.8 : z;
    const sy = sampleY(sx, sz);

    const built = buildActorMesh(role, armed, hasArmorKit);
    built.g.position.set(sx, sy, sz);
    root.add(built.g);

    const maxHp = hasArmorKit ? 175 : tier === 3 ? 140 : tier === 2 ? 90 : 55;
    const act: CrimeActor = {
      id: `crime_${actorSeq++}`,
      role,
      tier,
      x: sx,
      y: sy,
      z: sz,
      yaw: rng() * Math.PI * 2,
      hp: maxHp,
      maxHp,
      alive: true,
      armed,
      hasArmorKit,
      burstCooldown: 0.4 + rng() * 0.8,
      burstShotsLeft: 0,
      burstShotTimer: 0,
      ttl,
      root: built.g,
      leftArm: built.leftArm,
      rightArm: built.rightArm,
      leftLeg: built.leftLeg,
      rightLeg: built.rightLeg,
      walkPhase: rng() * Math.PI * 2,
    };
    actors.push(act);
    return act;
  }

  // Intensity Spread timers (more intense => rarer, never back-to-back)
  let nextBotherAt = 18;
  let nextKillAt = 58;
  let nextTruckRobberyAt = 128;
  let nextMassShooterAt = 210;
  let nextHeistAt = 265;
  let globalIntenseCooldownUntil = 30;
  let activeEvent: CrimeEventKind | null = null;
  let activeEventEndsAt = 0;

  const countsByKind: Record<CrimeEventKind, number> = {
    bother: 0,
    kill: 0,
    armored_truck_robbery: 0,
    mass_shooting: 0,
    gang_heist: 0,
  };

  // High-value city vault / bank heist anchors (D1 Casino/Financial, D8 Quay, D10 Harbor Vault)
  const heistAnchors = [
    { x: -165, z: -140, districtId: 'D1' },
    { x: -320, z: -175, districtId: 'D1' },
    { x: 1620, z: 438, districtId: 'D8' },
    { x: 2040, z: 295, districtId: 'D10' },
  ];

  const _muzzle = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _hitFrom = new THREE.Vector3();

  function pickNearbyPed(pedTargets: CrimeTargetPed[], px: number, pz: number, maxR = 110): CrimeTargetPed | null {
    let chosen: CrimeTargetPed | null = null;
    for (let i = 0; i < pedTargets.length; i++) {
      const p = pedTargets[i];
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d > 14 && d < maxR) {
        chosen = p;
        if (rng() < 0.35) break;
      }
    }
    return chosen;
  }

  function update(
    dt: number,
    elapsed: number,
    armoredTrucks: ArmoredTruckState[],
    pedTargets: CrimeTargetPed[],
    onHitPed: (pedId: string, damage: number, fromPos: THREE.Vector3) => void,
    playerCtx?: CrimePlayerContext
  ) {
    const safeDt = Math.min(0.1, Math.max(0.001, dt));
    const px = playerCtx?.pos.x ?? 0;
    const pz = playerCtx?.pos.z ?? 0;

    if (activeEvent && elapsed >= activeEventEndsAt) {
      activeEvent = null;
    }

    // --- Scheduler following strict Intensity Spread ---
    // Rarest Tier 3 / Heist first, never stacked back-to-back with any intense event
    if (elapsed >= globalIntenseCooldownUntil) {
      if (elapsed >= nextHeistAt && actors.length < 10) {
        const anchor = heistAnchors[Math.floor(rng() * heistAnchors.length)];
        for (let k = 0; k < 4; k++) {
          const ang = (k / 4) * Math.PI * 2;
          spawnCrimeActor(
            'heist_gang',
            3,
            anchor.x + Math.cos(ang) * 3.8,
            anchor.z + Math.sin(ang) * 3.8,
            true,
            true,
            58
          );
        }
        activeEvent = 'gang_heist';
        activeEventEndsAt = elapsed + 58;
        countsByKind.gang_heist++;
        nextHeistAt = elapsed + 245 + rng() * 95;
        globalIntenseCooldownUntil = elapsed + 165;
        worldEventBus.emit({
          type: 'crime',
          kind: 'gang_heist',
          x: anchor.x,
          y: sampleY(anchor.x, anchor.z),
          z: anchor.z,
          districtId: anchor.districtId,
          severity: 1.0,
        });
        worldEventBus.emit({
          type: 'chase',
          kind: 'gang',
          x: anchor.x,
          y: sampleY(anchor.x, anchor.z),
          z: anchor.z,
          dirX: 0,
          dirZ: 1,
          radius: 46,
        });
      } else if (elapsed >= nextMassShooterAt && actors.length < 10) {
        const seedPed = pickNearbyPed(pedTargets, px, pz, 140);
        const sx = seedPed ? seedPed.x + 8 : px + 46;
        const sz = seedPed ? seedPed.z + 6 : pz + 34;
        const distId = getDistrictAt(sx, sz).split(' ')[0].trim();
        spawnCrimeActor('mass_shooter', 3, sx, sz, true, true, 50);
        activeEvent = 'mass_shooting';
        activeEventEndsAt = elapsed + 50;
        countsByKind.mass_shooting++;
        nextMassShooterAt = elapsed + 205 + rng() * 85;
        globalIntenseCooldownUntil = elapsed + 145;
        worldEventBus.emit({
          type: 'crime',
          kind: 'mass_shooting',
          x: sx,
          y: sampleY(sx, sz),
          z: sz,
          districtId: distId,
          severity: 0.94,
        });
      } else if (
        elapsed >= nextTruckRobberyAt &&
        armoredTrucks.length > 0 &&
        actors.length < 10
      ) {
        const truck = armoredTrucks[Math.floor(rng() * armoredTrucks.length)];
        const sideX = -Math.cos(truck.heading) * 6.5;
        const sideZ = Math.sin(truck.heading) * 6.5;
        for (let k = 0; k < 2; k++) {
          const sign = k === 0 ? 1 : -1;
          spawnCrimeActor(
            'truck_robber',
            2,
            truck.x + sideX * sign,
            truck.z + sideZ * sign,
            true,
            false,
            42
          );
        }
        activeEvent = 'armored_truck_robbery';
        activeEventEndsAt = elapsed + 42;
        countsByKind.armored_truck_robbery++;
        nextTruckRobberyAt = elapsed + 140 + rng() * 65;
        globalIntenseCooldownUntil = elapsed + 90;
        const distId = getDistrictAt(truck.x, truck.z).split(' ')[0].trim();
        worldEventBus.emit({
          type: 'crime',
          kind: 'armored_truck_robbery',
          x: truck.x,
          y: truck.y,
          z: truck.z,
          districtId: distId,
          severity: 0.78,
        });
        worldEventBus.emit({
          type: 'chase',
          kind: 'police',
          x: truck.x,
          y: truck.y,
          z: truck.z,
          dirX: Math.sin(truck.heading),
          dirZ: Math.cos(truck.heading),
          radius: 40,
        });
      } else if (elapsed >= nextKillAt && actors.length < 12) {
        const seedPed = pickNearbyPed(pedTargets, px, pz, 125);
        if (seedPed) {
          const sx = seedPed.x + 7.5;
          const sz = seedPed.z - 5.5;
          spawnCrimeActor('killer', 2, sx, sz, true, false, 34);
          countsByKind.kill++;
          nextKillAt = elapsed + 75 + rng() * 40;
          globalIntenseCooldownUntil = elapsed + 48;
          const distId = getDistrictAt(sx, sz).split(' ')[0].trim();
          worldEventBus.emit({
            type: 'crime',
            kind: 'kill',
            x: sx,
            y: sampleY(sx, sz),
            z: sz,
            districtId: distId,
            severity: 0.55,
          });
        }
      }
    }

    // Tier 1 Botherers run frequently & independently without tripping intense cooldown
    if (elapsed >= nextBotherAt && actors.length < 14) {
      const seedPed = pickNearbyPed(pedTargets, px, pz, 95);
      if (seedPed) {
        const sx = seedPed.x + 3.2;
        const sz = seedPed.z + 2.6;
        spawnCrimeActor('botherer', 1, sx, sz, false, false, 22);
        countsByKind.bother++;
        nextBotherAt = elapsed + 26 + rng() * 16;
        const distId = getDistrictAt(sx, sz).split(' ')[0].trim();
        worldEventBus.emit({
          type: 'crime',
          kind: 'bother',
          x: sx,
          y: sampleY(sx, sz),
          z: sz,
          districtId: distId,
          severity: 0.22,
        });
      } else {
        nextBotherAt = elapsed + 8;
      }
    }

    // Update active crime actors
    for (let i = actors.length - 1; i >= 0; i--) {
      const a = actors[i];
      a.ttl -= safeDt;
      if (a.ttl <= 0 || (!a.alive && a.ttl < -8)) {
        root.remove(a.root);
        actors.splice(i, 1);
        continue;
      }
      if (!a.alive) {
        a.root.rotation.x = Math.PI * 0.48;
        a.root.position.y = sampleY(a.x, a.z) + 0.14;
        continue;
      }

      // Nearest target (pedestrian or player)
      let targetX = px;
      let targetY = playerCtx?.pos.y ?? 0;
      let targetZ = pz;
      let targetPedId: string | null = null;
      let bestDist = Math.hypot(px - a.x, pz - a.z);
      if (playerCtx?.inVehicle) bestDist += 18; // prioritize exposed pedestrians unless player gets close

      for (let pIdx = 0; pIdx < pedTargets.length; pIdx++) {
        const p = pedTargets[pIdx];
        const d = Math.hypot(p.x - a.x, p.z - a.z);
        if (d < bestDist && d < 36) {
          bestDist = d;
          targetX = p.x;
          targetY = p.y;
          targetZ = p.z;
          targetPedId = p.id;
        }
      }

      const desiredYaw = Math.atan2(targetX - a.x, targetZ - a.z);
      a.yaw = desiredYaw;
      a.root.rotation.y = a.yaw;

      const desiredRange = a.armed ? 14 : 1.6;
      if (bestDist > desiredRange && bestDist < 55) {
        const spd = a.tier >= 2 ? 3.5 : 2.6;
        const nx = a.x + Math.sin(a.yaw) * spd * safeDt;
        const nz = a.z + Math.cos(a.yaw) * spd * safeDt;
        const res = collisionWorld.resolveCircle(nx, nz, 0.45);
        a.x = res.x;
        a.z = res.z;
        a.y = sampleY(a.x, a.z);
        a.walkPhase += safeDt * 8.0;
        const sw = Math.sin(a.walkPhase) * 0.42;
        a.leftLeg.rotation.x = sw;
        a.rightLeg.rotation.x = -sw;
        a.leftArm.rotation.x = -sw * 0.6;
      } else {
        a.leftLeg.rotation.x *= 0.85;
        a.rightLeg.rotation.x *= 0.85;
      }
      a.root.position.set(a.x, a.y, a.z);

      // Armed actors draw strictly from sharedWeapon.ts
      if (a.armed && bestDist < SHARED_WEAPON_SPEC.rangeM * 0.72) {
        if (a.burstShotsLeft <= 0) {
          a.burstCooldown -= safeDt;
          if (a.burstCooldown <= 0) {
            a.burstShotsLeft = a.tier === 3 ? 4 : SHARED_WEAPON_SPEC.burstCount;
            a.burstShotTimer = 0;
            a.burstCooldown = SHARED_WEAPON_SPEC.burstCooldownSec * (a.tier === 3 ? 0.8 : 1.25);
          }
        } else {
          a.burstShotTimer -= safeDt;
          if (a.burstShotTimer <= 0) {
            a.burstShotsLeft--;
            a.burstShotTimer = 1 / SHARED_WEAPON_SPEC.fireRateHz;

            _muzzle.set(a.x, a.y + 1.22, a.z);
            _dir.set(targetX - a.x, targetY + 1.0 - (a.y + 1.22), targetZ - a.z).normalize();

            const targets: FpsRayTarget[] = [];
            if (targetPedId) {
              targets.push({
                id: targetPedId,
                kind: 'npc',
                agentId: targetPedId,
                bounds: new THREE.Box3(
                  new THREE.Vector3(targetX - 0.38, targetY, targetZ - 0.38),
                  new THREE.Vector3(targetX + 0.38, targetY + 1.75, targetZ + 0.38)
                ),
              });
            }

            const shooterKind =
              a.role === 'mass_shooter'
                ? 'shooter'
                : a.role === 'heist_gang' || a.role === 'truck_robber'
                ? 'gang'
                : 'killer';

            const playerHitBox =
              playerCtx && !playerCtx.inVehicle
                ? new THREE.Box3(
                    new THREE.Vector3(playerCtx.pos.x - 0.36, playerCtx.pos.y, playerCtx.pos.z - 0.36),
                    new THREE.Vector3(playerCtx.pos.x + 0.36, playerCtx.pos.y + 1.75, playerCtx.pos.z + 0.36)
                  )
                : null;

            const distId = getDistrictAt(a.x, a.z).split(' ')[0].trim();
            const res = fireSharedWeapon({
              origin: _muzzle,
              muzzleWorld: _muzzle,
              dir: _dir,
              shooterKind,
              shooterId: a.id,
              spreadRad: SHARED_WEAPON_SPEC.npcSpreadRad * (a.tier === 3 ? 0.85 : 1.0),
              rayTargets: targets,
              collisionWorld,
              playerHitBox,
              fxPool,
              districtId: distId,
              listenerPos: playerCtx?.pos,
              onSound: playerCtx?.onGunshotSound,
            });
            if (res.hit && res.kind === 'npc' && res.agentId) {
              _hitFrom.set(a.x, a.y + 1.1, a.z);
              onHitPed(res.agentId, res.damage, _hitFrom);
            } else if (res.hit && res.kind === 'player') {
              playerCtx?.onPlayerHit?.(res.damage);
            }
          }
        }
      }
    }
  }

  function getRayTargets(origin: THREE.Vector3, radiusM: number): FpsRayTarget[] {
    const out: FpsRayTarget[] = [];
    const r2 = radiusM * radiusM;
    for (const a of actors) {
      if (!a.alive) continue;
      const dx = a.x - origin.x;
      const dz = a.z - origin.z;
      if (dx * dx + dz * dz > r2) continue;
      out.push({
        id: a.id,
        kind: 'npc',
        agentId: a.id,
        bounds: new THREE.Box3(
          new THREE.Vector3(a.x - 0.42, a.y, a.z - 0.42),
          new THREE.Vector3(a.x + 0.42, a.y + 1.75, a.z + 0.42)
        ),
      });
    }
    return out;
  }

  function applyDamage(agentKey: string, damage: number): boolean {
    const a = actors.find((x) => x.id === agentKey);
    if (!a || !a.alive) return false;
    a.hp -= damage;
    if (a.hp <= 0) {
      a.hp = 0;
      a.alive = false;
      a.ttl = Math.min(a.ttl, 0); // start 8s corpse settle
    }
    return true;
  }

  return {
    root,
    actors,
    update,
    getRayTargets,
    applyDamage,
    getSummary: () => ({
      activeEvent,
      activeActors: actors.filter((a) => a.alive).length,
      globalIntenseCooldown: Math.max(0, globalIntenseCooldownUntil),
      armoredTruckCount: 2,
      countsByKind: { ...countsByKind },
    }),
    dispose: () => {
      bodyGeo.dispose();
      headGeo.dispose();
      limbGeo.dispose();
      armorPlateGeo.dispose();
      helmetGeo.dispose();
      skinMat.dispose();
      armorMat.dispose();
    },
  };
}
