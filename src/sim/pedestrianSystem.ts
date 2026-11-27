import * as THREE from 'three';
import {
  BUS_STOPS,
  CollisionWorld,
  GANG_TERRITORIES,
  getDistrictAt,
  getRoadElevationAt,
  getTerrainHeight,
  METRO_DOOR_QUEUE_LANES,
  mulberry32,
  ROADS,
  SIGNALIZED_INTERSECTIONS,
} from './mapData';
import { FpsRayTarget } from './fpsBridge';
import { getIntersectionSignal } from './infrastructureSystem';
import { MetroStationRuntimeInfo } from './metroSystem';
import { TextureLibrary } from './textures';
import {
  applyClothWindShader,
  createEnemyCarbineVisual,
  disposeEnemyCarbineVisual,
  EnemyCarbineVisual,
  EnemyWeaponClass,
  EnemyWeaponState,
  evaluateReloadChoreography,
  getEnemyWeaponClassProfile,
  getEnemyWeaponIdForClass,
  getSharedHumanGeometries,
  MuzzleFlashLightPool,
  setEnemyCarbineMagOffset,
  setEnemyWeaponPumpStroke,
  triggerEnemyCarbineFlash,
  updateEnemyCarbineVisual,
} from './humanCharacter';
import {
  fireSharedWeapon,
  getSharedWeaponSpec,
  SHARED_WEAPON_SPEC,
  SharedWeaponFxPool,
  type SharedWeaponId,
} from './sharedWeapon';
import { worldEventBus } from './worldEventBus';

const PED_CAPSULE_RADIUS = 0.34;
const PED_MIN_SEP = PED_CAPSULE_RADIUS * 2; // 0.68 m hard capsule separation
const PED_MIN_SEP2 = PED_MIN_SEP * PED_MIN_SEP;
const POLITE_PASS_DIST = 1.1;
const POLITE_PASS_DIST2 = POLITE_PASS_DIST * POLITE_PASS_DIST;
const HASH_SIZE = 2048;
const HASH_CELL_SIZE = 2.0;
const INV_CELL_SIZE = 1 / HASH_CELL_SIZE;

const MUTTER_LINES = [
  'Watch it!',
  'Mind the space!',
  'Hey, watch where you walk.',
  'Excuse you.',
  'Easy there!',
];

export type PedPersonality = 'polite' | 'rude';

export interface PedAgent {
  id: string;
  role: PedRole;
  civClass: CivilianClass;
  personality: PedPersonality;
  rudeCooldown: number;
  upsetTimer: number;
  upsetLookYaw: number;
  sidestepYaw: number;
  targetSidestep: number;
  nodTimer: number;
  nodCooldown: number;
  impulseX: number;
  impulseZ: number;
  mutterText: string;
  x: number;
  y: number;
  z: number;
  prevX: number;
  prevZ: number;
  vx: number;
  vz: number;
  baseX: number;
  baseZ: number;
  targetX: number;
  targetZ: number;
  heading: number;
  speed: number;
  stridePhase: number;
  idlePhase: number;
  heightScale: number;
  buildScale: number;
  hasProp: boolean;
  hasScarf: boolean;
  coatLenScale: number;
  hairFlowScale: number;
  usesCap: boolean;
  // Role-specific binding
  segIdx: number;
  segProgress: number;
  segDir: 1 | -1;
  ixIdx: number;
  crossAxis: 'ns' | 'ew'; // 'ns' crosses N-S road (walks E-W); 'ew' crosses E-W road (walks N-S)
  crossState: 'wait' | 'crossing';
  crossStartX: number;
  crossStartZ: number;
  crossEndX: number;
  crossEndZ: number;
  crossU: number;
  busStopIdx: number;
  metroStationIdx: number;
  stationYaw: number;
  // Gang & reaction state
  hp: number;
  alive: boolean;
  respawnTimer: number;
  fleeTimer: number;
  fleeDirX: number;
  fleeDirZ: number;
  crewIdx: number;
  memberSlot: number;
  formOffX: number;
  formOffZ: number;
  suspicion: number; // 0..1
  alertBannerTimer: number;
  burstCooldown: number;
  burstShotsLeft: number;
  burstShotTimer: number;
  aiming: boolean;
  // Enemy weapon interaction & animation state (data-driven via ENEMY_CLASS_WEAPON_TABLE)
  weaponClass: EnemyWeaponClass;
  weaponId: SharedWeaponId;
  weaponState: EnemyWeaponState;
  ammoInMag: number;
  reloadTimer: number;
  drawFrac: number;
  aimBlend: number;
  twoHandBlend: number;
  lowReadyBlend: number;
  reloadBlend: number;
  recoilKick: number;
  aimPitch: number;
  ledTarget: number;
  lastShotElapsed: number;
  hadFireLos: boolean;
}

export interface PedPlayerContext {
  pos: THREE.Vector3;
  inVehicle: boolean;
  speedKmh: number;
  onPlayerHit?: (damage: number) => void;
  onGunshotSound?: (distM: number) => void;
}

export interface GangCrewDebugInfo {
  id: string;
  districtId: string;
  state: 'patrol' | 'alert' | 'search' | 'returning';
  anchorX: number;
  anchorZ: number;
  maxSuspicion: number;
  memberCount: number;
}

export interface PedestrianSystemHandles {
  root: THREE.Group;
  totalCount: number;
  readonly agents: readonly PedAgent[];
  update: (
    dt: number,
    elapsed: number,
    busStopArrivals?: boolean[],
    metroTrainFlags?: boolean[],
    playerPosOrCtx?: THREE.Vector3 | PedPlayerContext
  ) => void;
  reseed: (newSeed?: number) => void;
  getRayTargets: (origin: THREE.Vector3, radiusM: number) => FpsRayTarget[];
  getActiveSubtitle: (x: number, y: number, z: number) => string;
  applyDamageToAgent: (agentId: string, damage: number, attackerPos?: THREE.Vector3) => boolean;
  notifyPlayerGunshot: (x: number, y: number, z: number) => void;
  getHiddenHeat: () => number;
  getGangCrewStates: () => GangCrewDebugInfo[];
}

type CivilianClass =
  | 'executive'
  | 'commuter'
  | 'working_class'
  | 'streetwear_youth'
  | 'elder'
  | 'nightlife_patron'
  | 'student_runner'
  | 'transit_guard'
  | 'gang_member';

type PedRole = 'sidewalk' | 'crosswalk' | 'bus_wait' | 'metro_plat' | 'metro_street' | 'gang';

interface OutfitPalette {
  jacket: string[];
  pants: string[];
  boots: string[];
  hat: string[];
  prop: string[];
  hasPropChance: number;
  heightRange: [number, number];
  buildScale: number;
}

const CLASS_OUTFITS: Record<CivilianClass, OutfitPalette> = {
  executive: {
    jacket: ['#1a202c', '#262b36', '#2b2420', '#1c2a3a'],
    pants: ['#161a22', '#22262e', '#1e2028'],
    boots: ['#111316', '#281a14'],
    hat: ['#181c22', '#2d2622', '#3a2c24'],
    prop: ['#2a1d14', '#181a20', '#402c1e'], // leather briefcase
    hasPropChance: 0.85,
    heightRange: [0.97, 1.07],
    buildScale: 1.02,
  },
  commuter: {
    jacket: ['#3a4856', '#5c4b3b', '#2c3d35', '#463848', '#2a384a'],
    pants: ['#1f252e', '#2d333b', '#26242c'],
    boots: ['#1a1c20', '#302218'],
    hat: ['#242830', '#4a3a2e', '#2a3a44'],
    prop: ['#2c3540', '#543c2c', '#1e2832'], // messenger bag
    hasPropChance: 0.72,
    heightRange: [0.94, 1.05],
    buildScale: 0.98,
  },
  working_class: {
    jacket: ['#7c4a1c', '#3c4a38', '#444b52', '#9e5a18', '#2f3c48'],
    pants: ['#232a34', '#2d312c', '#1e242c'],
    boots: ['#2e2218', '#181a1c'],
    hat: ['#c89a22', '#2b3036', '#4a3626'], // knit beanie or hardhat
    prop: ['#4c483c', '#323840', '#6a4620'], // tool/duffel bag
    hasPropChance: 0.55,
    heightRange: [0.96, 1.08],
    buildScale: 1.08,
  },
  streetwear_youth: {
    jacket: ['#7a1e2e', '#1c5666', '#8a5e1c', '#46265c', '#265c42', '#38465e'],
    pants: ['#1a1e26', '#28303e', '#34302c', '#22262e'],
    boots: ['#cfd6de', '#2a2e36', '#8c2832'],
    hat: ['#181c24', '#7a202c', '#284a5a', '#4a3e32'],
    prop: ['#242a34', '#582230', '#204452'], // backpack
    hasPropChance: 0.68,
    heightRange: [0.91, 1.02],
    buildScale: 0.95,
  },
  elder: {
    jacket: ['#4a423a', '#3d3436', '#36403a', '#52483c'],
    pants: ['#242428', '#2e2a26', '#22282a'],
    boots: ['#1c1a18', '#2a201a'],
    hat: ['#483e36', '#645c54', '#2e2824'], // fur ushanka / wool hat
    prop: ['#5a4c3e', '#3e4a44', '#6a403a'], // shopping tote
    hasPropChance: 0.78,
    heightRange: [0.87, 0.95],
    buildScale: 0.96,
  },
  nightlife_patron: {
    jacket: ['#581834', '#182c42', '#3a1c4a', '#1e1c24', '#68242c'],
    pants: ['#14161c', '#1c1e26', '#261822'],
    boots: ['#141418', '#381822'],
    hat: ['#1a1820', '#5a2038', '#2e221e'],
    prop: ['#2a1824', '#1a1c24'],
    hasPropChance: 0.45,
    heightRange: [0.92, 1.04],
    buildScale: 0.94,
  },
  student_runner: {
    jacket: ['#284b6e', '#2e5c48', '#6e3438', '#4c4266', '#5c5234'],
    pants: ['#1d222b', '#262c36', '#2a2a30'],
    boots: ['#b8c2cc', '#34404e', '#6e2c2c'],
    hat: ['#2a2420', '#483424', '#1c2028', '#5c4632'],
    prop: ['#22384c', '#58282c', '#2a4034'], // backpack
    hasPropChance: 0.88,
    heightRange: [0.92, 1.03],
    buildScale: 0.94,
  },
  transit_guard: {
    jacket: ['#1c2c40', '#203044', '#263444'],
    pants: ['#141e2c', '#182230'],
    boots: ['#101216'],
    hat: ['#182436', '#202c3e'],
    prop: ['#242830', '#3c424c'],
    hasPropChance: 0.5,
    heightRange: [0.99, 1.08],
    buildScale: 1.07,
  },
  // 2059 Russia darker tactical trench & street cyber-coat silhouette
  gang_member: {
    jacket: ['#14171e', '#1e1418', '#171c22', '#21191d'],
    pants: ['#0e1015', '#15141a', '#12161c'],
    boots: ['#090a0d', '#181414'],
    hat: ['#101218', '#2a1218', '#1a1c22'],
    prop: ['#12141a'],
    hasPropChance: 0,
    heightRange: [0.98, 1.08],
    buildScale: 1.08,
  },
};

const SKIN_TONES = ['#e2bea6', '#d2a98e', '#be9174', '#eccab4', '#9e7256', '#d6ae94'];
const HAIR_TONES = ['#1c1816', '#36261c', '#563e2a', '#866b4c', '#68301e', '#7c7e84', '#241e1a'];
const SCARF_TONES = ['#a2343e', '#366e80', '#ba8c44', '#54704e', '#805a76', '#d8cec0'];
const ALL_CLASSES: CivilianClass[] = [
  'executive',
  'commuter',
  'working_class',
  'streetwear_youth',
  'elder',
  'nightlife_patron',
  'student_runner',
  'transit_guard',
];

interface SidewalkSegment {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  len: number;
  dirX: number;
  dirZ: number;
  nextEnd: { segIdx: number; dir: 1 | -1 }[];
  nextStart: { segIdx: number; dir: 1 | -1 }[];
}

function buildSidewalkSegments(): SidewalkSegment[] {
  const segs: SidewalkSegment[] = [];
  for (let r = 0; r < ROADS.length; r++) {
    const road = ROADS[r];
    if (road.kind === 'ramp' || road.kind === 'bridge') continue;
    const pts = road.points;
    if (pts.length < 2) continue;
    // Place sidewalk neatly on the raised concrete sidewalk centerline (road.width * 0.5 + 1.68m)
    const offset = road.width * 0.5 + 1.68;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 16) continue;
      const dirX = dx / len;
      const dirZ = dz / len;
      const nx = -dirZ;
      const nz = dirX;
      // Add both left & right sidewalks (inset 6m from intersections so walkers stay clean)
      const inset = Math.min(6.5, len * 0.18);
      for (const side of [-1, 1]) {
        const sx0 = a.x + dirX * inset + nx * offset * side;
        const sz0 = a.z + dirZ * inset + nz * offset * side;
        const sx1 = b.x - dirX * inset + nx * offset * side;
        const sz1 = b.z - dirZ * inset + nz * offset * side;
        const slen = Math.hypot(sx1 - sx0, sz1 - sz0);
        if (slen > 10) {
          segs.push({
            x0: sx0,
            z0: sz0,
            x1: sx1,
            z1: sz1,
            len: slen,
            dirX,
            dirZ,
            nextEnd: [],
            nextStart: [],
          });
        }
      }
    }
  }

  // Build sidewalk corner & continuing connectivity graph so walkers transition seamlessly across blocks
  const linkRadius = 24;
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    for (let j = 0; j < segs.length; j++) {
      if (i === j) continue;
      const b = segs[j];
      if (Math.hypot(b.x0 - a.x1, b.z0 - a.z1) < linkRadius) a.nextEnd.push({ segIdx: j, dir: 1 });
      if (Math.hypot(b.x1 - a.x1, b.z1 - a.z1) < linkRadius) a.nextEnd.push({ segIdx: j, dir: -1 });
      if (Math.hypot(b.x0 - a.x0, b.z0 - a.z0) < linkRadius) a.nextStart.push({ segIdx: j, dir: 1 });
      if (Math.hypot(b.x1 - a.x0, b.z1 - a.z0) < linkRadius) a.nextStart.push({ segIdx: j, dir: -1 });
    }
  }
  return segs;
}

interface GangCrewRuntime {
  id: string;
  districtId: 'D1' | 'D8';
  anchorX: number;
  anchorZ: number;
  homeAnchorX: number;
  homeAnchorZ: number;
  patrolPoints: { x: number; z: number }[];
  patrolIdx: number;
  patrolHoldTimer: number;
  state: 'patrol' | 'alert' | 'search' | 'returning';
  lastSeenX: number;
  lastSeenZ: number;
  searchTimer: number;
  escapeTimer: number;
  memberIndices: number[];
}

let _qMarkTextures: THREE.CanvasTexture[] | null = null;
let _alertBangTexture: THREE.CanvasTexture | null = null;

function getSuspicionTextures(): {
  questionSteps: THREE.CanvasTexture[];
  alertBang: THREE.CanvasTexture;
} {
  if (_qMarkTextures && _alertBangTexture) {
    return { questionSteps: _qMarkTextures, alertBang: _alertBangTexture };
  }

  const steps: THREE.CanvasTexture[] = [];
  const STEPS = 16;
  for (let s = 0; s <= STEPS; s++) {
    const frac = s / STEPS;
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 96;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, 96, 96);

    // Subtle dark backing pill
    ctx.fillStyle = 'rgba(8, 12, 18, 0.72)';
    ctx.beginPath();
    ctx.arc(48, 48, 36, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = frac > 0.7 ? '#f97316' : '#cbd5e1';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Base un-filled '?'
    ctx.font = 'bold 54px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.32)';
    ctx.fillText('?', 48, 50);

    // Bottom-to-top filling '?'
    if (frac > 0.01) {
      const topY = 80 - frac * 64;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, topY, 96, 96 - topY);
      ctx.clip();
      ctx.fillStyle = frac > 0.75 ? '#ef4444' : frac > 0.4 ? '#f59e0b' : '#fde047';
      ctx.fillText('?', 48, 50);
      ctx.restore();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    steps.push(tex);
  }

  const ac = document.createElement('canvas');
  ac.width = 96;
  ac.height = 96;
  const actx = ac.getContext('2d')!;
  actx.fillStyle = 'rgba(127, 29, 29, 0.9)';
  actx.beginPath();
  actx.arc(48, 48, 36, 0, Math.PI * 2);
  actx.fill();
  actx.strokeStyle = '#fca5a5';
  actx.lineWidth = 4;
  actx.stroke();
  actx.font = 'bold 56px sans-serif';
  actx.textAlign = 'center';
  actx.textBaseline = 'middle';
  actx.fillStyle = '#fef2f2';
  actx.fillText('!', 48, 50);
  const aTex = new THREE.CanvasTexture(ac);
  aTex.colorSpace = THREE.SRGBColorSpace;

  _qMarkTextures = steps;
  _alertBangTexture = aTex;
  return { questionSteps: steps, alertBang: aTex };
}

export function buildPedestrianSystem(
  textures: TextureLibrary,
  metroStations: MetroStationRuntimeInfo[],
  collisionWorld?: CollisionWorld
): PedestrianSystemHandles {
  const root = new THREE.Group();
  const sidewalkSegs = buildSidewalkSegments();
  let seed = (Date.now() ^ 0x4b2a19f3) >>> 0;
  let rng = mulberry32(seed);

  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];

  const agents: PedAgent[] = [];
  const crews: GangCrewRuntime[] = [];
  let hiddenHeat = 0; // 0..100 GTA-style hidden heat (NO HUD element!)

  const weaponFxPool = new SharedWeaponFxPool(24);
  root.add(weaponFxPool.root);
  const muzzleLightPool = new MuzzleFlashLightPool(4);
  root.add(muzzleLightPool.root);
  const { questionSteps, alertBang } = getSuspicionTextures();
  const gangVisuals = new Map<
    number,
    { carbine: EnemyCarbineVisual; suspicionSprite: THREE.Sprite }
  >();

  const spawnAgents = () => {
    agents.length = 0;
    let nextId = 0;

    const makeBaseAgent = (role: PedRole, civClass: CivilianClass): PedAgent => {
      const pal = CLASS_OUTFITS[civClass];
      const [hMin, hMax] = pal.heightRange;
      const isLongCoatClass =
        civClass === 'executive' ||
        civClass === 'elder' ||
        civClass === 'commuter' ||
        civClass === 'transit_guard' ||
        civClass === 'gang_member';
      const isRude = civClass !== 'transit_guard' && civClass !== 'gang_member' && rng() < 0.15;
      return {
        id: `ped_${nextId++}`,
        role,
        civClass,
        personality: isRude ? 'rude' : 'polite',
        rudeCooldown: isRude ? rng() * 6.0 : 0,
        upsetTimer: 0,
        upsetLookYaw: 0,
        sidestepYaw: 0,
        targetSidestep: 0,
        nodTimer: 0,
        nodCooldown: 0,
        impulseX: 0,
        impulseZ: 0,
        mutterText: '',
        x: 0,
        y: 0.08,
        z: 0,
        prevX: 0,
        prevZ: 0,
        vx: 0,
        vz: 0,
        baseX: 0,
        baseZ: 0,
        targetX: 0,
        targetZ: 0,
        heading: rng() * Math.PI * 2,
        speed:
          civClass === 'elder'
            ? 0.92
            : civClass === 'student_runner'
            ? 1.85
            : civClass === 'gang_member'
            ? 1.45 + rng() * 0.25
            : 1.25 + rng() * 0.48,
        stridePhase: rng() * Math.PI * 2,
        idlePhase: rng() * Math.PI * 2,
        heightScale: hMin + rng() * (hMax - hMin),
        buildScale: pal.buildScale * (0.94 + rng() * 0.12),
        hasProp: rng() < pal.hasPropChance,
        hasScarf:
          civClass === 'gang_member'
            ? rng() < 0.72
            : civClass !== 'transit_guard' && rng() < 0.56,
        coatLenScale: isLongCoatClass ? 0.86 + rng() * 0.24 : 0.52 + rng() * 0.24,
        hairFlowScale: 0.85 + rng() * 0.45,
        usesCap:
          civClass === 'transit_guard' ||
          (civClass === 'gang_member' && rng() < 0.62) ||
          (civClass === 'working_class' && rng() < 0.42),
        segIdx: 0,
        segProgress: 0,
        segDir: rng() > 0.5 ? 1 : -1,
        ixIdx: -1,
        crossAxis: 'ns',
        crossState: 'wait',
        crossStartX: 0,
        crossStartZ: 0,
        crossEndX: 0,
        crossEndZ: 0,
        crossU: 0,
        busStopIdx: -1,
        metroStationIdx: -1,
        stationYaw: 0,
        hp: civClass === 'gang_member' ? 100 : 50,
        alive: true,
        respawnTimer: 0,
        fleeTimer: 0,
        fleeDirX: 0,
        fleeDirZ: 0,
        crewIdx: -1,
        memberSlot: 0,
        formOffX: 0,
        formOffZ: 0,
        suspicion: 0,
        alertBannerTimer: 0,
        burstCooldown: 0.35 + rng() * 0.65,
        burstShotsLeft: 0,
        burstShotTimer: 0,
        aiming: false,
        weaponClass: civClass === 'transit_guard' ? 'guard' : 'gang',
        weaponId: 'service_carbine',
        weaponState: 'patrol',
        ammoInMag: SHARED_WEAPON_SPEC.magazineSize,
        reloadTimer: 0,
        drawFrac: 0,
        aimBlend: 0,
        twoHandBlend: 0,
        lowReadyBlend: 0,
        reloadBlend: 0,
        recoilKick: 0,
        aimPitch: 0,
        ledTarget: 0,
        lastShotElapsed: -99,
        hadFireLos: false,
      };
    };

    // 1. SIDEWALK WALKERS (104 civilians + 20 gang crew members = exact 314 existing cap!)
    const sidewalkCount = 104;
    for (let i = 0; i < sidewalkCount; i++) {
      const civClass = ALL_CLASSES[i % ALL_CLASSES.length];
      const ag = makeBaseAgent('sidewalk', civClass);
      const segIdx = Math.floor(rng() * Math.max(1, sidewalkSegs.length));
      const seg = sidewalkSegs[segIdx];
      if (seg) {
        ag.segIdx = segIdx;
        ag.segProgress = rng() * seg.len;
        ag.x = seg.x0 + seg.dirX * ag.segProgress;
        ag.z = seg.z0 + seg.dirZ * ag.segProgress;
        ag.prevX = ag.x;
        ag.prevZ = ag.z;
        ag.heading = Math.atan2(seg.dirX * ag.segDir, seg.dirZ * ag.segDir);
      }
      agents.push(ag);
    }

    // 2. CROSSWALK WAITERS & CROSSERS (72 civilians — 4 per each of the 18 Signalized Intersections)
    for (let ixIdx = 0; ixIdx < SIGNALIZED_INTERSECTIONS.length; ixIdx++) {
      const ix = SIGNALIZED_INTERSECTIONS[ixIdx];
      for (let k = 0; k < 4; k++) {
        const civClass = ALL_CLASSES[(ixIdx * 3 + k) % ALL_CLASSES.length];
        const ag = makeBaseAgent('crosswalk', civClass);
        ag.ixIdx = ixIdx;
        const isNS = k < 2;
        ag.crossAxis = isNS ? 'ns' : 'ew';
        const sideSign = k % 2 === 0 ? 1 : -1;
        const startSign = rng() > 0.5 ? 1 : -1;

        if (isNS) {
          const zLane = ix.z + sideSign * (ix.halfSpanEW + 1.8) + (k % 2 === 0 ? -0.45 : 0.45);
          const xSpan = ix.halfSpanNS + 1.6;
          ag.crossStartX = ix.x + startSign * xSpan;
          ag.crossStartZ = zLane;
          ag.crossEndX = ix.x - startSign * xSpan;
          ag.crossEndZ = zLane;
        } else {
          const xLane = ix.x + sideSign * (ix.halfSpanNS + 1.8) + (k % 2 === 0 ? -0.45 : 0.45);
          const zSpan = ix.halfSpanEW + 1.6;
          ag.crossStartX = xLane;
          ag.crossStartZ = ix.z + startSign * zSpan;
          ag.crossEndX = xLane;
          ag.crossEndZ = ix.z - startSign * zSpan;
        }
        ag.x = ag.crossStartX;
        ag.z = ag.crossStartZ;
        ag.prevX = ag.x;
        ag.prevZ = ag.z;
        ag.heading = Math.atan2(ag.crossEndX - ag.crossStartX, ag.crossEndZ - ag.crossStartZ);
        ag.crossState = 'wait';
        ag.crossU = 0;
        agents.push(ag);
      }
    }

    // 3. BUS STOP WAITERS (54 civilians — 3 per each of the 18 Bus Stops)
    for (let bIdx = 0; bIdx < BUS_STOPS.length; bIdx++) {
      const bs = BUS_STOPS[bIdx];
      const cosR = Math.cos(bs.rotY);
      const sinR = Math.sin(bs.rotY);
      for (let w = 0; w < 3; w++) {
        const civClass = ALL_CLASSES[(bIdx * 2 + w) % ALL_CLASSES.length];
        const ag = makeBaseAgent('bus_wait', civClass);
        ag.busStopIdx = bIdx;
        const lx = -1.6 + w * 1.55 + (rng() - 0.5) * 0.28;
        const lz = 0.25 + (w === 1 ? 0.34 : -0.15);
        ag.baseX = bs.x + lx * cosR + lz * sinR;
        ag.baseZ = bs.z - lx * sinR + lz * cosR;
        ag.x = ag.baseX;
        ag.z = ag.baseZ;
        ag.prevX = ag.x;
        ag.prevZ = ag.z;
        ag.heading = bs.rotY + (rng() - 0.5) * 0.45;
        ag.stationYaw = bs.rotY;
        agents.push(ag);
      }
    }

    // 4. METRO STATION COMMUTERS (aligned cleanly into Spec 5 platform queue lanes flanking train doors!)
    for (let sIdx = 0; sIdx < metroStations.length; sIdx++) {
      const st = metroStations[sIdx];
      const cosY = Math.cos(st.yaw);
      const sinY = Math.sin(st.yaw);
      const centerX = st.platWorldX - -4.8 * cosY; // station spline origin X
      const centerZ = st.platWorldZ + -4.8 * sinY; // station spline origin Z
      for (let p = 0; p < 8; p++) {
        const isElevated = p < 5;
        const civClass =
          p === 0
            ? 'transit_guard'
            : ALL_CLASSES[(sIdx * 3 + p) % ALL_CLASSES.length];
        const ag = makeBaseAgent(isElevated ? 'metro_plat' : 'metro_street', civClass);
        ag.metroStationIdx = sIdx;
        ag.stationYaw = st.yaw;

        if (isElevated) {
          if (p === 0) {
            // Guard stands clear between center doorways (x=-3.2, z=0)
            const acrossX = -3.2;
            const alongZ = 0.0;
            ag.baseX = centerX + acrossX * cosY + alongZ * sinY;
            ag.baseZ = centerZ - acrossX * sinY + alongZ * cosY;
          } else {
            // Queue cleanly inside flanking METRO_DOOR_QUEUE_LANES (leaving central door corridor open!)
            const slotIdx = (sIdx * 4 + (p - 1) * 3) % METRO_DOOR_QUEUE_LANES.length;
            const slot = METRO_DOOR_QUEUE_LANES[slotIdx];
            ag.baseX = centerX + slot.localX * cosY + slot.localZ * sinY;
            ag.baseZ = centerZ - slot.localX * sinY + slot.localZ * cosY;
          }
          ag.y = st.platWorldY;
          ag.heading = st.yaw + Math.PI * 0.5;
        } else {
          const alongZ = -3.8 + (p - 5) * 3.8 + (rng() - 0.5) * 0.8;
          const acrossX = (rng() - 0.5) * 1.4;
          ag.baseX = st.streetX + acrossX * cosY + alongZ * sinY;
          ag.baseZ = st.streetZ - acrossX * sinY + alongZ * cosY;
          ag.y = 0.08;
          ag.heading = st.yaw - Math.PI * 0.5 + (rng() - 0.5) * 0.9;
        }
        ag.x = ag.baseX;
        ag.z = ag.baseZ;
        ag.prevX = ag.x;
        ag.prevZ = ag.z;
        agents.push(ag);
      }
    }

    // 5. 2059 RUSSIA GANG CREWS (Crews of 3-5 in D8 Black Market Quay & D1 Nightlife)
    crews.length = 0;
    gangVisuals.forEach((v) => {
      root.remove(v.carbine.root);
      disposeEnemyCarbineVisual(v.carbine);
      root.remove(v.suspicionSprite);
    });
    gangVisuals.clear();

    for (let cIdx = 0; cIdx < GANG_TERRITORIES.length; cIdx++) {
      const terr = GANG_TERRITORIES[cIdx];
      const memberIndices: number[] = [];
      for (let m = 0; m < terr.crewSize; m++) {
        const ag = makeBaseAgent('gang', 'gang_member');
        const angle = (m / terr.crewSize) * Math.PI * 2 + 0.4;
        const rad = 2.0 + (m % 2) * 1.4;
        ag.crewIdx = cIdx;
        ag.memberSlot = m;
        // Data-driven class assignment via ENEMY_CLASS_WEAPON_TABLE:
        // guards -> Service Carbine, mob enforcers -> Full-Auto Carbine, heavy/brute -> Pump Shotgun
        ag.weaponClass =
          m === 0
            ? 'enforcer'
            : m === 1
            ? 'heavy'
            : m === 2
            ? 'guard'
            : m === 3
            ? 'brute'
            : 'gang';
        ag.weaponId = getEnemyWeaponIdForClass(ag.weaponClass);
        ag.ammoInMag = getSharedWeaponSpec(ag.weaponId).magazineSize;
        ag.formOffX = Math.cos(angle) * rad;
        ag.formOffZ = Math.sin(angle) * rad;
        ag.x = terr.anchorX + ag.formOffX;
        ag.z = terr.anchorZ + ag.formOffZ;
        const groundY = Math.max(0.08, getTerrainHeight(ag.x, ag.z));
        ag.y = terr.districtId === 'D8' && ag.x > 1560 ? Math.max(groundY, 1.52) : groundY;
        ag.baseX = ag.x;
        ag.baseZ = ag.z;
        ag.prevX = ag.x;
        ag.prevZ = ag.z;
        ag.heading = angle + Math.PI * 0.5;
        const idx = agents.length;
        agents.push(ag);
        memberIndices.push(idx);

        // Black cloned enemy variation of the class weapon with red warm-up LED + muzzle flash
        const carbine = createEnemyCarbineVisual(0.95, ag.weaponId);
        root.add(carbine.root);
        const spriteMat = new THREE.SpriteMaterial({
          map: questionSteps[0],
          transparent: true,
          depthTest: false,
          depthWrite: false,
        });
        const suspicionSprite = new THREE.Sprite(spriteMat);
        suspicionSprite.scale.set(0.62, 0.62, 1);
        suspicionSprite.visible = false;
        suspicionSprite.renderOrder = 10;
        root.add(suspicionSprite);
        gangVisuals.set(idx, { carbine, suspicionSprite });
      }
      crews.push({
        id: terr.id,
        districtId: terr.districtId,
        anchorX: terr.anchorX,
        anchorZ: terr.anchorZ,
        homeAnchorX: terr.anchorX,
        homeAnchorZ: terr.anchorZ,
        patrolPoints: terr.patrolPoints,
        patrolIdx: 0,
        patrolHoldTimer: 1.5,
        state: 'patrol',
        lastSeenX: terr.anchorX,
        lastSeenZ: terr.anchorZ,
        searchTimer: 0,
        escapeTimer: 0,
        memberIndices,
      });
    }
  };

  spawnAgents();
  const totalCount = agents.length;

  // Flat zero-GC spatial hash buffers
  const cellHead = new Int32Array(HASH_SIZE);
  const nextAgent = new Int32Array(Math.max(1, totalCount));

  const hashCoord = (gx: number, gz: number): number => {
    const h = (Math.imul(gx, 73856093) ^ Math.imul(gz, 19349663)) & (HASH_SIZE - 1);
    return h;
  };

  // Ensure ~15% rude ratio is guaranteed across small test slices too
  const geos = getSharedHumanGeometries();
  const outdoorWindUniform = { value: 0.88 };

  const clothMat = new THREE.MeshStandardMaterial({
    map: textures.pedClothingMap,
    roughnessMap: textures.pedClothingRoughness,
    bumpMap: textures.pedClothingBump,
    bumpScale: 0.032,
    roughness: 0.9,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  applyClothWindShader(clothMat, outdoorWindUniform, 'cloth-wind-inst-v3');

  const coatSkirtMat = new THREE.MeshStandardMaterial({
    map: textures.pedFabricKnitMap,
    roughnessMap: textures.pedFabricKnitRoughness,
    bumpMap: textures.pedFabricKnitBump,
    bumpScale: 0.042,
    roughness: 0.94,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  applyClothWindShader(coatSkirtMat, outdoorWindUniform, 'cloth-wind-inst-v3');

  const pantsMat = new THREE.MeshStandardMaterial({
    map: textures.pedFabricDenimMap,
    roughnessMap: textures.pedFabricDenimRoughness,
    bumpMap: textures.pedFabricDenimBump,
    bumpScale: 0.034,
    roughness: 0.92,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  applyClothWindShader(pantsMat, outdoorWindUniform, 'cloth-wind-inst-v3');

  const scarfMat = new THREE.MeshStandardMaterial({
    map: textures.pedFabricKnitMap,
    roughnessMap: textures.pedFabricKnitRoughness,
    bumpMap: textures.pedFabricKnitBump,
    bumpScale: 0.044,
    roughness: 0.97,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  applyClothWindShader(scarfMat, outdoorWindUniform, 'cloth-wind-inst-v3');

  const hairMat = new THREE.MeshStandardMaterial({
    map: textures.pedHairMap,
    bumpMap: textures.pedHairBump,
    bumpScale: 0.017,
    roughness: 0.42,
    metalness: 0.06,
    side: THREE.DoubleSide,
  });
  applyClothWindShader(hairMat, outdoorWindUniform, 'cloth-wind-inst-v3');

  const bootMat = new THREE.MeshStandardMaterial({
    map: textures.pedFabricLeatherMap,
    roughnessMap: textures.pedFabricLeatherRoughness,
    bumpMap: textures.pedFabricLeatherBump,
    bumpScale: 0.018,
    roughness: 0.36,
    metalness: 0.16,
  });
  const faceMat = new THREE.MeshStandardMaterial({
    map: textures.pedFaceStreetCloseMap,
    bumpMap: textures.pedFaceBump,
    bumpScale: 0.0092,
    roughness: 0.44,
    metalness: 0.02,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    roughness: 0.56,
    metalness: 0.0,
  });
  const hatMat = new THREE.MeshStandardMaterial({
    roughness: 0.72,
    metalness: 0.06,
  });
  const propMat = new THREE.MeshStandardMaterial({
    bumpMap: textures.pedClothingBump,
    bumpScale: 0.016,
    roughness: 0.64,
    metalness: 0.08,
  });

  const propGeo = geos.backpack;

  const mkInst = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.InstancedMesh(geo, mat, totalCount);
    m.frustumCulled = false;
    root.add(m);
    return m;
  };

  const leftThighInst = mkInst(geos.instThigh, pantsMat);
  const rightThighInst = mkInst(geos.instThigh, pantsMat);
  const leftShinInst = mkInst(geos.instShin, pantsMat);
  const rightShinInst = mkInst(geos.instShin, pantsMat);
  const leftBootInst = mkInst(geos.instShoe, bootMat);
  const rightBootInst = mkInst(geos.instShoe, bootMat);
  const hipsInst = mkInst(geos.instPelvis, pantsMat);
  const coatSkirtInst = mkInst(geos.instCoatSkirt, coatSkirtMat);
  const torsoInst = mkInst(geos.instTorso, clothMat);
  const scarfInst = mkInst(geos.instScarf, scarfMat);
  const leftUpperArmInst = mkInst(geos.instUpperArm, clothMat);
  const rightUpperArmInst = mkInst(geos.instUpperArm, clothMat);
  const leftForearmInst = mkInst(geos.instForearm, clothMat);
  const rightForearmInst = mkInst(geos.instForearm, clothMat);
  const leftHandInst = mkInst(geos.instHandLeft, skinMat);
  const rightHandInst = mkInst(geos.instHandRight, skinMat);
  const headInst = mkInst(geos.instHead, faceMat);
  const flowHairInst = mkInst(geos.instFlowHair, hairMat);
  const hatInst = mkInst(geos.instHairCap, hatMat);
  const propInst = mkInst(propGeo, propMat);
  const briefcaseInst = mkInst(geos.instBriefcase, propMat);

  const tmpCol = new THREE.Color();

  const applyOutfitColors = () => {
    for (let i = 0; i < totalCount; i++) {
      const ag = agents[i];
      const pal = CLASS_OUTFITS[ag.civClass];

      tmpCol.set(pick(pal.jacket));
      torsoInst.setColorAt(i, tmpCol);
      coatSkirtInst.setColorAt(i, tmpCol);
      leftUpperArmInst.setColorAt(i, tmpCol);
      rightUpperArmInst.setColorAt(i, tmpCol);
      leftForearmInst.setColorAt(i, tmpCol);
      rightForearmInst.setColorAt(i, tmpCol);

      tmpCol.set(pick(pal.pants));
      hipsInst.setColorAt(i, tmpCol);
      leftThighInst.setColorAt(i, tmpCol);
      rightThighInst.setColorAt(i, tmpCol);
      leftShinInst.setColorAt(i, tmpCol);
      rightShinInst.setColorAt(i, tmpCol);

      tmpCol.set(pick(SCARF_TONES));
      scarfInst.setColorAt(i, tmpCol);

      tmpCol.set(pick(pal.boots));
      leftBootInst.setColorAt(i, tmpCol);
      rightBootInst.setColorAt(i, tmpCol);

      tmpCol.set(pick(SKIN_TONES));
      headInst.setColorAt(i, tmpCol);
      leftHandInst.setColorAt(i, tmpCol);
      rightHandInst.setColorAt(i, tmpCol);

      tmpCol.set(pick(HAIR_TONES));
      flowHairInst.setColorAt(i, tmpCol);

      tmpCol.set(pick(pal.hat));
      hatInst.setColorAt(i, tmpCol);

      tmpCol.set(pick(pal.prop));
      propInst.setColorAt(i, tmpCol);
      briefcaseInst.setColorAt(i, tmpCol);
    }

    const meshes = [
      leftThighInst,
      rightThighInst,
      leftShinInst,
      rightShinInst,
      leftBootInst,
      rightBootInst,
      hipsInst,
      coatSkirtInst,
      torsoInst,
      scarfInst,
      leftUpperArmInst,
      rightUpperArmInst,
      leftForearmInst,
      rightForearmInst,
      leftHandInst,
      rightHandInst,
      headInst,
      flowHairInst,
      hatInst,
      propInst,
      briefcaseInst,
    ];
    for (let m = 0; m < meshes.length; m++) {
      if (meshes[m].instanceColor) meshes[m].instanceColor!.needsUpdate = true;
    }
  };

  applyOutfitColors();

  // Zero-GC reusable transform & 2-bone arm IK scratch objects
  const dummy = new THREE.Object3D();
  const _ikRel = new THREE.Vector3();
  const _ikDir = new THREE.Vector3();
  const _ikPole = new THREE.Vector3();
  const _ikBend = new THREE.Vector3();
  const _ikElbow = new THREE.Vector3();
  const _ikWrist = new THREE.Vector3();
  const _ikUpperDir = new THREE.Vector3();
  const _ikForeDir = new THREE.Vector3();
  const _ikAxisX = new THREE.Vector3();
  const _ikAxisY = new THREE.Vector3();
  const _ikAxisZ = new THREE.Vector3();
  const _ikMat = new THREE.Matrix4();
  const _ikQuat = new THREE.Quaternion();
  const _ikScale = new THREE.Vector3();
  const _gunEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _gunQuat = new THREE.Quaternion();
  const _gunPos = new THREE.Vector3();
  const _rShPos = new THREE.Vector3();
  const _lShPos = new THREE.Vector3();
  const _rHandTarget = new THREE.Vector3();
  const _lHandTarget = new THREE.Vector3();
  const _lHandBasePos = new THREE.Vector3();
  const _rPoleHint = new THREE.Vector3();
  const _lPoleHint = new THREE.Vector3();
  const _relHandLocal = new THREE.Vector3();
  const _relMagOffset = new THREE.Vector3();
  const _relTilt = { roll: 0, pitch: 0, yaw: 0, impulse: 0, pumpStroke: 0 };
  const _tmpOffset = new THREE.Vector3();

  const setPart = (
    inst: THREE.InstancedMesh,
    idx: number,
    px: number,
    py: number,
    pz: number,
    rx: number,
    ry: number,
    rz: number,
    sx: number,
    sy: number,
    sz: number
  ) => {
    dummy.position.set(px, py, pz);
    dummy.rotation.set(rx, ry, rz, 'YXZ');
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    inst.setMatrixAt(idx, dummy.matrix);
  };

  /** Orient an instanced limb mesh (whose bone runs along local -Y) from startPos along unitDir */
  const setLimbAligned = (
    inst: THREE.InstancedMesh,
    idx: number,
    startPos: THREE.Vector3,
    unitDir: THREE.Vector3,
    fwdHint: THREE.Vector3,
    sx: number,
    sy: number,
    sz: number
  ) => {
    _ikAxisY.copy(unitDir).negate();
    _ikAxisZ.copy(fwdHint).addScaledVector(_ikAxisY, -fwdHint.dot(_ikAxisY));
    if (_ikAxisZ.lengthSq() < 1e-6) {
      _ikAxisZ.set(0, 0, 1);
      _ikAxisZ.addScaledVector(_ikAxisY, -_ikAxisZ.dot(_ikAxisY));
    }
    _ikAxisZ.normalize();
    _ikAxisX.crossVectors(_ikAxisY, _ikAxisZ).normalize();
    _ikAxisZ.crossVectors(_ikAxisX, _ikAxisY).normalize();
    _ikMat.makeBasis(_ikAxisX, _ikAxisY, _ikAxisZ);
    _ikQuat.setFromRotationMatrix(_ikMat);
    _ikScale.set(sx, sy, sz);
    _ikMat.compose(startPos, _ikQuat, _ikScale);
    inst.setMatrixAt(idx, _ikMat);
  };

  /** Zero-GC 3D 2-bone analytical arm IK placing upper arm, forearm & hand onto a world grip target */
  const solveInstancedArmIK = (
    upperInst: THREE.InstancedMesh,
    foreInst: THREE.InstancedMesh,
    handInst: THREE.InstancedMesh,
    idx: number,
    shoulderPos: THREE.Vector3,
    handPalmTarget: THREE.Vector3,
    poleHint: THREE.Vector3,
    uArmLen: number,
    fArmLen: number,
    bScale: number,
    hScale: number
  ) => {
    // Hand geometry palm sits ~0.048*hScale down from wrist along forearm axis
    const effForeLen = fArmLen + 0.048 * hScale;
    _ikRel.copy(handPalmTarget).sub(shoulderPos);
    const rawDist = _ikRel.length();
    const minDist = Math.abs(uArmLen - effForeLen) + 0.04 * hScale;
    const maxDist = uArmLen + effForeLen - 0.008 * hScale;
    const dist = THREE.MathUtils.clamp(rawDist, minDist, maxDist);

    if (rawDist < 1e-4) {
      _ikDir.set(0, -1, 0);
    } else {
      _ikDir.copy(_ikRel).multiplyScalar(1 / rawDist);
    }

    const cosA = THREE.MathUtils.clamp(
      (uArmLen * uArmLen + dist * dist - effForeLen * effForeLen) / (2 * uArmLen * dist),
      -1,
      1
    );
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));

    _ikPole.copy(poleHint).normalize();
    _ikBend.copy(_ikPole).addScaledVector(_ikDir, -_ikPole.dot(_ikDir));
    if (_ikBend.lengthSq() < 1e-5) {
      _ikBend.set(0, -1, 0);
    } else {
      _ikBend.normalize();
    }

    _ikElbow
      .copy(shoulderPos)
      .addScaledVector(_ikDir, uArmLen * cosA)
      .addScaledVector(_ikBend, uArmLen * sinA);

    _ikUpperDir.copy(_ikElbow).sub(shoulderPos).normalize();
    _ikForeDir.copy(shoulderPos).addScaledVector(_ikDir, dist).sub(_ikElbow).normalize();
    _ikWrist.copy(_ikElbow).addScaledVector(_ikForeDir, fArmLen);

    // Orient upper arm, forearm & hand seamlessly along the solved 3D chain
    setLimbAligned(upperInst, idx, shoulderPos, _ikUpperDir, _ikForeDir, bScale, hScale, bScale);
    setLimbAligned(foreInst, idx, _ikElbow, _ikForeDir, _ikBend, bScale, hScale, bScale);
    setLimbAligned(handInst, idx, _ikWrist, _ikForeDir, _ikBend, hScale, hScale, hScale);
  };

  const walkingFlags = new Uint8Array(Math.max(1, totalCount));

  const enforceStaticBounds = (ag: PedAgent) => {
    if (ag.role === 'metro_plat') {
      const st = metroStations[ag.metroStationIdx];
      if (!st) return;
      const cosY = Math.cos(st.yaw);
      const sinY = Math.sin(st.yaw);
      const centerX = st.platWorldX - -4.8 * cosY;
      const centerZ = st.platWorldZ + -4.8 * sinY;
      const dx = ag.x - centerX;
      const dz = ag.z - centerZ;
      // Convert to station local coords
      let lx = dx * cosY - dz * sinY;
      let lz = dx * sinY + dz * cosY;
      // Keep inside platform deck (away from track edge -2.25 and back glass -8.0)
      lx = THREE.MathUtils.clamp(lx, -7.85, -2.52);
      lz = THREE.MathUtils.clamp(lz, -24.8, 24.8);
      // Keep clear of station booth (-6.55, -2.0), half-extents (1.05, 1.7) + 0.34
      if (lx > -7.95 && lx < -5.15 && lz > -4.05 && lz < 0.05) {
        lx = -5.15;
      }
      // Keep clear of fluted columns at x=-7.4, z = -20..20 step 8 (radius 0.34 + 0.34 = 0.68)
      for (let cz = -20; cz <= 20; cz += 8) {
        const cdx = lx - -7.4;
        const cdz = lz - cz;
        const cd2 = cdx * cdx + cdz * cdz;
        if (cd2 < 0.68 * 0.68) {
          const cd = Math.max(0.001, Math.sqrt(cd2));
          lx = -7.4 + (cdx / cd) * 0.68;
          lz = cz + (cdz / cd) * 0.68;
        }
      }
      ag.x = centerX + lx * cosY + lz * sinY;
      ag.z = centerZ - lx * sinY + lz * cosY;
    } else if (collisionWorld) {
      const hit = collisionWorld.resolveCircle(ag.x, ag.z, PED_CAPSULE_RADIUS);
      if (hit.hit) {
        ag.x = hit.x;
        ag.z = hit.z;
      }
    }
  };

  const resolveSeparationAndSocial = (
    dt: number,
    passIdx: number,
    playerPos?: THREE.Vector3
  ) => {
    cellHead.fill(-1);
    for (let i = 0; i < totalCount; i++) {
      const ag = agents[i];
      const gx = Math.floor(ag.x * INV_CELL_SIZE);
      const gz = Math.floor(ag.z * INV_CELL_SIZE);
      const h = hashCoord(gx, gz);
      nextAgent[i] = cellHead[h];
      cellHead[h] = i;
    }

    for (let i = 0; i < totalCount; i++) {
      const a = agents[i];
      if (!a.alive) continue;
      const agx = Math.floor(a.x * INV_CELL_SIZE);
      const agz = Math.floor(a.z * INV_CELL_SIZE);

      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          let j = cellHead[hashCoord(agx + ox, agz + oz)];
          while (j !== -1) {
            if (j > i) {
              const b = agents[j];
              if (b.alive && Math.abs(a.y - b.y) < 1.2) {
                let dx = b.x - a.x;
                let dz = b.z - a.z;
                let d2 = dx * dx + dz * dz;

                if (d2 < POLITE_PASS_DIST2 && d2 > 1e-8) {
                  const d = Math.sqrt(d2);
                  const nx = dx / d;
                  const nz = dz / d;

                  // Social passing check once per frame (passIdx === 0)
                  if (passIdx === 0) {
                    const relSide =
                      nx * Math.cos(a.heading) - nz * Math.sin(a.heading);
                    const passSign = relSide >= 0 ? -1 : 1;

                    // Velocity-projected lateral avoidance when approaching
                    const rvx = b.vx - a.vx;
                    const rvz = b.vz - a.vz;
                    const closingSpeed = -(rvx * nx + rvz * nz);
                    if (closingSpeed > 0.15) {
                      const steerScale = Math.min(0.45, closingSpeed * dt * 0.42);
                      const tx = -nz * passSign;
                      const tz = nx * passSign;
                      a.x -= tx * steerScale;
                      a.z -= tz * steerScale;
                      b.x += tx * steerScale;
                      b.z += tz * steerScale;
                    }

                    // Polite passing vs Rude shoulder-bump
                    const aRudeReady = a.personality === 'rude' && a.rudeCooldown <= 0;
                    const bRudeReady = b.personality === 'rude' && b.rudeCooldown <= 0;

                    if (aRudeReady && !bRudeReady) {
                      a.rudeCooldown = 25.0;
                      a.targetSidestep = 0;
                      const latX = nx * 0.65 - nz * passSign * 0.76;
                      const latZ = nz * 0.65 + nx * passSign * 0.76;
                      b.impulseX += latX * 0.18;
                      b.impulseZ += latZ * 0.18;
                      b.upsetTimer = 2.5;
                      b.upsetLookYaw = Math.atan2(a.x - b.x, a.z - b.z);
                      b.mutterText = MUTTER_LINES[(i + j) % MUTTER_LINES.length];
                    } else if (bRudeReady && !aRudeReady) {
                      b.rudeCooldown = 25.0;
                      b.targetSidestep = 0;
                      const latX = -nx * 0.65 + nz * passSign * 0.76;
                      const latZ = -nz * 0.65 - nx * passSign * 0.76;
                      a.impulseX += latX * 0.18;
                      a.impulseZ += latZ * 0.18;
                      a.upsetTimer = 2.5;
                      a.upsetLookYaw = Math.atan2(b.x - a.x, b.z - a.z);
                      a.mutterText = MUTTER_LINES[(i + j) % MUTTER_LINES.length];
                    } else {
                      if (a.upsetTimer <= 0) {
                        a.targetSidestep = passSign * 0.65;
                        if (a.nodCooldown <= 0) {
                          a.nodTimer = 0.7;
                          a.nodCooldown = 3.6;
                        }
                      }
                      if (b.upsetTimer <= 0) {
                        b.targetSidestep = -passSign * 0.65;
                        if (b.nodCooldown <= 0) {
                          b.nodTimer = 0.7;
                          b.nodCooldown = 3.6;
                        }
                      }
                    }
                  }

                  // Hard capsule separation r = 0.34 m => minDist = 0.68 m
                  dx = b.x - a.x;
                  dz = b.z - a.z;
                  d2 = dx * dx + dz * dz;
                  if (d2 < PED_MIN_SEP2) {
                    const dist = Math.sqrt(Math.max(1e-8, d2));
                    const nxSep = dist > 1e-4 ? dx / dist : Math.cos(i * 1.7);
                    const nzSep = dist > 1e-4 ? dz / dist : Math.sin(i * 1.7);
                    const overlap = (PED_MIN_SEP - dist) * 0.505;
                    a.x -= nxSep * overlap;
                    a.z -= nzSep * overlap;
                    b.x += nxSep * overlap;
                    b.z += nzSep * overlap;
                  }
                } else if (d2 <= 1e-8 && Math.abs(a.y - b.y) < 1.2) {
                  // Deterministic zero-overlap break if two spawns coincided
                  const ang = ((i * 73 + j * 37) % 360) * (Math.PI / 180);
                  a.x -= Math.cos(ang) * 0.35;
                  a.z -= Math.sin(ang) * 0.35;
                  b.x += Math.cos(ang) * 0.35;
                  b.z += Math.sin(ang) * 0.35;
                }
              }
            }
            j = nextAgent[j];
          }
        }
      }

      // Hard capsule separation against on-foot player as well!
      if (playerPos && Math.abs(a.y - playerPos.y) < 1.3) {
        const pdx = a.x - playerPos.x;
        const pdz = a.z - playerPos.z;
        const pd2 = pdx * pdx + pdz * pdz;
        if (pd2 < POLITE_PASS_DIST2 && pd2 > 1e-6) {
          const pd = Math.sqrt(pd2);
          if (passIdx === 0 && a.upsetTimer <= 0) {
            const relSide =
              (pdx / pd) * Math.cos(a.heading) - (pdz / pd) * Math.sin(a.heading);
            a.targetSidestep = (relSide >= 0 ? 1 : -1) * 0.65;
            if (a.nodCooldown <= 0) {
              a.nodTimer = 0.7;
              a.nodCooldown = 3.2;
            }
          }
          if (pd < PED_MIN_SEP) {
            const push = PED_MIN_SEP - pd;
            a.x += (pdx / pd) * push;
            a.z += (pdz / pd) * push;
          }
        }
      }

      enforceStaticBounds(a);
    }
  };

  const _shotOrigin = new THREE.Vector3();
  const _shotMuzzle = new THREE.Vector3();
  const _shotDir = new THREE.Vector3();
  const _playerHitBox = new THREE.Box3();
  const _playerBoxMin = new THREE.Vector3();
  const _playerBoxMax = new THREE.Vector3();
  const _playerPosVec = new THREE.Vector3();

  const alertCrew = (crewIdx: number, px: number, pz: number, propagate: boolean) => {
    const crew = crews[crewIdx];
    if (!crew) return;
    const wasAlert = crew.state === 'alert';
    crew.state = 'alert';
    crew.lastSeenX = px;
    crew.lastSeenZ = pz;
    crew.escapeTimer = 0;
    crew.searchTimer = 0;
    for (let k = 0; k < crew.memberIndices.length; k++) {
      const m = agents[crew.memberIndices[k]];
      m.suspicion = 1;
      if (!wasAlert) m.alertBannerTimer = 2.6;
    }
    if (!wasAlert) {
      hiddenHeat = Math.min(100, hiddenHeat + 12);
      const terr = GANG_TERRITORIES[crewIdx];
      worldEventBus.emit({
        type: 'crime',
        kind: 'gang_firefight',
        x: px,
        y: 1,
        z: pz,
        districtId: terr?.districtId ?? 'D1',
        severity: 0.65,
      });
    }
    if (propagate) {
      const earshotR = 48 + hiddenHeat * 0.45;
      const earshotR2 = earshotR * earshotR;
      for (let j = 0; j < crews.length; j++) {
        if (j === crewIdx) continue;
        const other = crews[j];
        const dx = other.anchorX - crew.anchorX;
        const dz = other.anchorZ - crew.anchorZ;
        if (dx * dx + dz * dz <= earshotR2) {
          alertCrew(j, px, pz, false);
        }
      }
    }
  };

  const applyDamageToAgent = (
    agentId: string,
    damage: number,
    attackerPos?: THREE.Vector3
  ): boolean => {
    for (let i = 0; i < totalCount; i++) {
      const ag = agents[i];
      if (ag.id !== agentId || !ag.alive) continue;
      ag.hp -= damage;
      if (ag.role === 'gang' && attackerPos) {
        alertCrew(ag.crewIdx, attackerPos.x, attackerPos.z, true);
        hiddenHeat = Math.min(100, hiddenHeat + 16);
      } else if (ag.role !== 'gang') {
        hiddenHeat = Math.min(100, hiddenHeat + 20);
        if (attackerPos) {
          const fdx = ag.x - attackerPos.x;
          const fdz = ag.z - attackerPos.z;
          const fl = Math.max(0.01, Math.hypot(fdx, fdz));
          ag.fleeDirX = fdx / fl;
          ag.fleeDirZ = fdz / fl;
          ag.fleeTimer = 8.0;
        }
      }
      if (ag.hp <= 0) {
        ag.hp = 0;
        ag.alive = false;
        ag.respawnTimer = 24.0;
        if (ag.role === 'gang') {
          hiddenHeat = Math.min(100, hiddenHeat + 14);
        } else {
          hiddenHeat = Math.min(100, hiddenHeat + 24);
        }
      }
      return true;
    }
    return false;
  };

  const notifyPlayerGunshot = (x: number, y: number, z: number) => {
    let witnesses = 0;
    for (let i = 0; i < totalCount; i++) {
      const ag = agents[i];
      if (!ag.alive) continue;
      const dx = ag.x - x;
      const dz = ag.z - z;
      const d2 = dx * dx + dz * dz;
      if (ag.role !== 'gang' && d2 < 42 * 42) {
        witnesses++;
      }
      if (ag.role === 'gang' && d2 < 52 * 52) {
        alertCrew(ag.crewIdx, x, z, true);
      }
    }
    hiddenHeat = Math.min(100, hiddenHeat + 4 + Math.min(14, witnesses * 3));
    void y;
  };

  const update = (
    dt: number,
    elapsed: number,
    busStopArrivals?: boolean[],
    metroTrainFlags?: boolean[],
    playerPosOrCtx?: THREE.Vector3 | PedPlayerContext
  ) => {
    const safeDt = Math.min(0.05, Math.max(0.0005, dt));
    weaponFxPool.update(safeDt);
    muzzleLightPool.update(safeDt);

    const playerCtx: PedPlayerContext | undefined =
      playerPosOrCtx instanceof THREE.Vector3
        ? { pos: playerPosOrCtx, inVehicle: false, speedKmh: 0 }
        : playerPosOrCtx;
    const playerPos = playerCtx?.pos;
    if (playerPos) {
      _playerPosVec.copy(playerPos);
      _playerBoxMin.set(playerPos.x - 0.55, playerPos.y, playerPos.z - 0.55);
      _playerBoxMax.set(playerPos.x + 0.55, playerPos.y + 1.75, playerPos.z + 0.55);
      _playerHitBox.set(_playerBoxMin, _playerBoxMax);
    }

    // Drain world event bus -> civilians flee gunfire & scatter from chases (gang members never flee!)
    const events = worldEventBus.drainQueued();
    for (let e = 0; e < events.length; e++) {
      const ev = events[e];
      if (ev.type === 'gunfire') {
        const r2 = ev.loudRadius * ev.loudRadius;
        for (let i = 0; i < totalCount; i++) {
          const ag = agents[i];
          if (!ag.alive || ag.role === 'gang' || ag.role === 'metro_plat') continue;
          const dx = ag.x - ev.x;
          const dz = ag.z - ev.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < r2) {
            const d = Math.max(0.1, Math.sqrt(d2));
            ag.fleeDirX = dx / d;
            ag.fleeDirZ = dz / d;
            ag.fleeTimer = 6.5 + (i % 4) * 0.6;
          }
        }
        if (ev.shooterKind === 'player') {
          notifyPlayerGunshot(ev.x, ev.y, ev.z);
        }
      } else if (ev.type === 'chase') {
        const r2 = ev.radius * ev.radius;
        for (let i = 0; i < totalCount; i++) {
          const ag = agents[i];
          if (!ag.alive || ag.role === 'gang' || ag.role === 'metro_plat') continue;
          const dx = ag.x - ev.x;
          const dz = ag.z - ev.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < r2) {
            const d = Math.max(0.1, Math.sqrt(d2));
            // Scatter perpendicularly / away from chase vector
            const perpX = -ev.dirZ;
            const perpZ = ev.dirX;
            const side = dx * perpX + dz * perpZ >= 0 ? 1 : -1;
            const sx = (dx / d) * 0.5 + perpX * side * 0.85;
            const sz = (dz / d) * 0.5 + perpZ * side * 0.85;
            const sl = Math.max(0.01, Math.hypot(sx, sz));
            ag.fleeDirX = sx / sl;
            ag.fleeDirZ = sz / sl;
            ag.fleeTimer = Math.max(ag.fleeTimer, 3.6);
          }
        }
      }
    }

    // Update Gang Crews (territory patrol, suspicion 0->1 detection, alert/chase, search, return)
    let anyCrewAlert = false;
    for (let c = 0; c < crews.length; c++) {
      const crew = crews[c];
      let aliveCount = 0;
      let anySawPlayer = false;
      let minDistToPlayer = Infinity;

      for (let mIdx = 0; mIdx < crew.memberIndices.length; mIdx++) {
        const ag = agents[crew.memberIndices[mIdx]];
        if (!ag.alive) {
          ag.respawnTimer -= safeDt;
          if (ag.respawnTimer <= 0) {
            ag.alive = true;
            ag.hp = 100;
            ag.x = crew.homeAnchorX + ag.formOffX;
            ag.z = crew.homeAnchorZ + ag.formOffZ;
            ag.suspicion = 0;
            ag.alertBannerTimer = 0;
            ag.ammoInMag = getSharedWeaponSpec(ag.weaponId).magazineSize;
            ag.reloadTimer = 0;
            ag.burstShotsLeft = 0;
            ag.weaponState = 'patrol';
            ag.drawFrac = 0;
            ag.aimBlend = 0;
            ag.twoHandBlend = 0;
            ag.lowReadyBlend = 0;
            ag.reloadBlend = 0;
            ag.recoilKick = 0;
            ag.aimPitch = 0;
            ag.ledTarget = 0;
            ag.hadFireLos = false;
          }
          continue;
        }
        aliveCount++;
        ag.alertBannerTimer = Math.max(0, ag.alertBannerTimer - safeDt);

        if (playerPos) {
          const toPx = playerPos.x - ag.x;
          const toPz = playerPos.z - ag.z;
          const dist = Math.hypot(toPx, toPz);
          if (dist < minDistToPlayer) minDistToPlayer = dist;

          const detectRange = (crew.state === 'alert' ? 38 : 27) + hiddenHeat * 0.16;
          const fwdX = Math.sin(ag.heading);
          const fwdZ = Math.cos(ag.heading);
          const dot = dist > 0.05 ? (toPx * fwdX + toPz * fwdZ) / dist : 1;
          const inCone = dot >= 0.42 || dist < 5.5 || crew.state === 'alert';
          const hasLos =
            dist <= detectRange &&
            inCone &&
            (!collisionWorld || collisionWorld.hasLineOfSight(ag.x, ag.z, playerPos.x, playerPos.z));

          if (hasLos) {
            anySawPlayer = true;
            crew.lastSeenX = playerPos.x;
            crew.lastSeenZ = playerPos.z;
            if (crew.state !== 'alert') {
              const proxFactor = Math.max(0.22, 1.35 - dist / detectRange);
              const heatBoost = 1 + hiddenHeat * 0.012;
              const vehScale = playerCtx?.inVehicle && (playerCtx.speedKmh ?? 0) > 25 ? 0.65 : 1.0;
              ag.suspicion = Math.min(1, ag.suspicion + safeDt * proxFactor * heatBoost * vehScale * 0.95);
              if (ag.suspicion >= 1) {
                alertCrew(c, playerPos.x, playerPos.z, true);
              }
            }
          } else if (crew.state !== 'alert') {
            ag.suspicion = Math.max(0, ag.suspicion - safeDt * 0.28);
          }
        } else if (crew.state !== 'alert') {
          ag.suspicion = Math.max(0, ag.suspicion - safeDt * 0.28);
        }
      }

      if (crew.state === 'patrol') {
        const wp = crew.patrolPoints[crew.patrolIdx];
        const dx = wp.x - crew.anchorX;
        const dz = wp.z - crew.anchorZ;
        const d = Math.hypot(dx, dz);
        if (d < 1.2) {
          crew.patrolHoldTimer -= safeDt;
          if (crew.patrolHoldTimer <= 0) {
            crew.patrolIdx = (crew.patrolIdx + 1) % crew.patrolPoints.length;
            crew.patrolHoldTimer = 2.4;
          }
        } else {
          const step = Math.min(d, 1.35 * safeDt);
          crew.anchorX += (dx / d) * step;
          crew.anchorZ += (dz / d) * step;
        }
      } else if (crew.state === 'alert') {
        anyCrewAlert = true;
        if (playerPos) {
          // Move anchor toward player/lastSeen while chasing
          const tx = anySawPlayer ? playerPos.x : crew.lastSeenX;
          const tz = anySawPlayer ? playerPos.z : crew.lastSeenZ;
          const dx = tx - crew.anchorX;
          const dz = tz - crew.anchorZ;
          const d = Math.hypot(dx, dz);
          if (d > 2.5) {
            const chaseSpd = 5.4 + hiddenHeat * 0.012;
            const step = Math.min(d, chaseSpd * safeDt);
            crew.anchorX += (dx / d) * step;
            crew.anchorZ += (dz / d) * step;
          }
          if (Math.floor(elapsed * 3) !== Math.floor((elapsed - safeDt) * 3) && d > 0.1) {
            worldEventBus.emit({
              type: 'chase',
              x: crew.anchorX,
              y: 1,
              z: crew.anchorZ,
              dirX: dx / Math.max(0.1, d),
              dirZ: dz / Math.max(0.1, d),
              radius: 14,
              kind: 'gang',
            });
          }

          const escapeDist = 42 + hiddenHeat * 0.28;
          const escapeDuration = 4.5 + hiddenHeat * 0.06;
          if (!anySawPlayer && minDistToPlayer > escapeDist) {
            crew.escapeTimer += safeDt;
            if (crew.escapeTimer >= escapeDuration) {
              crew.state = 'search';
              crew.searchTimer = 6.5 + hiddenHeat * 0.05;
              crew.escapeTimer = 0;
            }
          } else {
            crew.escapeTimer = 0;
          }
        } else {
          crew.state = 'search';
          crew.searchTimer = 5.5;
        }
      } else if (crew.state === 'search') {
        const dx = crew.lastSeenX - crew.anchorX;
        const dz = crew.lastSeenZ - crew.anchorZ;
        const d = Math.hypot(dx, dz);
        if (d > 1.5) {
          const step = Math.min(d, 3.2 * safeDt);
          crew.anchorX += (dx / d) * step;
          crew.anchorZ += (dz / d) * step;
        } else {
          crew.searchTimer -= safeDt;
          if (crew.searchTimer <= 0) {
            crew.state = 'returning';
          }
        }
      } else if (crew.state === 'returning') {
        const dx = crew.homeAnchorX - crew.anchorX;
        const dz = crew.homeAnchorZ - crew.anchorZ;
        const d = Math.hypot(dx, dz);
        if (d < 1.5) {
          crew.anchorX = crew.homeAnchorX;
          crew.anchorZ = crew.homeAnchorZ;
          crew.state = 'patrol';
        } else {
          const step = Math.min(d, 2.4 * safeDt);
          crew.anchorX += (dx / d) * step;
          crew.anchorZ += (dz / d) * step;
        }
      }

      if (aliveCount === 0) {
        crew.state = 'returning';
      }
    }

    if (!anyCrewAlert && hiddenHeat > 0) {
      hiddenHeat = Math.max(0, hiddenHeat - safeDt * 2.2);
    }

    for (let i = 0; i < totalCount; i++) {
      const ag = agents[i];
      ag.prevX = ag.x;
      ag.prevZ = ag.z;
      ag.rudeCooldown = Math.max(0, ag.rudeCooldown - safeDt);
      ag.upsetTimer = Math.max(0, ag.upsetTimer - safeDt);
      if (ag.upsetTimer <= 0) ag.mutterText = '';
      ag.nodTimer = Math.max(0, ag.nodTimer - safeDt);
      ag.nodCooldown = Math.max(0, ag.nodCooldown - safeDt);
      ag.targetSidestep = 0;
      ag.aiming = false;

      if (!ag.alive) {
        if (ag.role !== 'gang') {
          ag.respawnTimer -= safeDt;
          if (ag.respawnTimer <= 0) {
            ag.alive = true;
            ag.hp = 50;
          }
        }
        walkingFlags[i] = 0;
        continue;
      }

      // Apply & decay bump impulse smoothly
      if (Math.abs(ag.impulseX) > 0.0005 || Math.abs(ag.impulseZ) > 0.0005) {
        const stepDecay = 1 - Math.exp(-7.5 * safeDt);
        ag.x += ag.impulseX * stepDecay;
        ag.z += ag.impulseZ * stepDecay;
        ag.impulseX *= Math.exp(-7.5 * safeDt);
        ag.impulseZ *= Math.exp(-7.5 * safeDt);
      }

      let isWalking = false;

      // Non-gang civilians flee/scatter when triggered by worldEventBus
      if (ag.fleeTimer > 0 && ag.role !== 'gang') {
        ag.fleeTimer = Math.max(0, ag.fleeTimer - safeDt);
        const fleeSpd = 4.8;
        ag.x += ag.fleeDirX * fleeSpd * safeDt;
        ag.z += ag.fleeDirZ * fleeSpd * safeDt;
        ag.heading = Math.atan2(ag.fleeDirX, ag.fleeDirZ);
        isWalking = true;
      } else if (ag.role === 'gang') {
        const crew = crews[ag.crewIdx];
        if (crew) {
          let targetX = crew.anchorX + ag.formOffX;
          let targetZ = crew.anchorZ + ag.formOffZ;
          let moveSpd = ag.speed;

          if (crew.state === 'alert' && playerPos) {
            // Converge loosely around the player / firing ring (7..14m)
            const ringAng = (ag.memberSlot / Math.max(1, crew.memberIndices.length)) * Math.PI * 2;
            const ringR = 7.5 + (ag.memberSlot % 2) * 3.0;
            targetX = playerPos.x + Math.cos(ringAng) * ringR;
            targetZ = playerPos.z + Math.sin(ringAng) * ringR;
            moveSpd = 5.2 + hiddenHeat * 0.012;
          } else if (crew.state === 'search') {
            targetX = crew.lastSeenX + ag.formOffX * 1.6;
            targetZ = crew.lastSeenZ + ag.formOffZ * 1.6;
            moveSpd = 3.1;
          }

          const dx = targetX - ag.x;
          const dz = targetZ - ag.z;
          const dist = Math.hypot(dx, dz);

          if (dist > 0.45) {
            const step = Math.min(dist, moveSpd * safeDt);
            ag.x += (dx / dist) * step;
            ag.z += (dz / dist) * step;
            ag.heading = Math.atan2(dx, dz);
            isWalking = true;
          }

          const groundY = Math.max(0.08, getTerrainHeight(ag.x, ag.z));
          ag.y = crew.districtId === 'D8' && ag.x > 1560 ? Math.max(groundY, 1.52) : groundY;

          const prof = getEnemyWeaponClassProfile(ag.weaponClass);
          const wSpec = getSharedWeaponSpec(ag.weaponId);
          ag.hadFireLos = false;

          // Tick active magazine/shell reload (duration strictly equals wSpec.reloadSec)
          if (ag.reloadTimer > 0) {
            ag.reloadTimer = Math.max(0, ag.reloadTimer - safeDt);
            if (ag.reloadTimer === 0) {
              ag.ammoInMag = wSpec.magazineSize;
            }
          }

          // Face player & fire shared arsenal during alert chase (armed walk AND run supported!)
          if (crew.state === 'alert' && playerPos) {
            const toPx = playerPos.x - ag.x;
            const toPz = playerPos.z - ag.z;
            const pDist = Math.hypot(toPx, toPz);
            const hasLos =
              pDist < Math.min(34, wSpec.rangeM) &&
              (!collisionWorld || collisionWorld.hasLineOfSight(ag.x, ag.z, playerPos.x, playerPos.z));
            if (hasLos) {
              ag.hadFireLos = true;
              ag.heading = Math.atan2(toPx, toPz);
              const eyeY = ag.y + 1.44 * ag.heightScale;
              const desiredPitch = THREE.MathUtils.clamp(
                Math.atan2(playerPos.y + 1.15 - eyeY, Math.max(0.5, pDist)),
                -0.55,
                0.55
              );
              ag.aimPitch = THREE.MathUtils.damp(ag.aimPitch, desiredPitch, 12.0, safeDt);

              if (ag.reloadTimer <= 0) {
                if (ag.ammoInMag <= 0) {
                  ag.reloadTimer = wSpec.reloadSec;
                  ag.burstShotsLeft = 0;
                } else {
                  ag.aiming = true;

                  // Sustained full-auto fires continuously at 11 Hz with no burst pause until mag empty!
                  if (wSpec.sustainedFire && ag.burstShotsLeft <= 0) {
                    ag.burstShotsLeft = ag.ammoInMag;
                    ag.burstCooldown = 0;
                  }

                  if (ag.burstShotsLeft > 0) {
                    ag.burstShotTimer -= safeDt;
                    if (ag.burstShotTimer <= 0) {
                      ag.burstShotsLeft--;
                      ag.burstShotTimer = 1 / wSpec.fireRateHz;
                      ag.ammoInMag = Math.max(0, ag.ammoInMag - 1);
                      const kickBase =
                        ag.weaponId === 'pump_shotgun'
                          ? 1.15
                          : ag.weaponId === 'full_auto_carbine'
                          ? 0.48
                          : 0.72;
                      ag.recoilKick = Math.min(1.35, ag.recoilKick + kickBase * prof.recoilAmp);
                      ag.lastShotElapsed = elapsed;

                      _shotOrigin.set(ag.x, eyeY, ag.z);
                      const sinH = Math.sin(ag.heading);
                      const cosH = Math.cos(ag.heading);
                      const cosP = Math.cos(ag.aimPitch);
                      const sinP = Math.sin(ag.aimPitch);
                      const gvShot = gangVisuals.get(i);
                      const muzzleZ = (gvShot?.carbine.muzzleLocalPos.z ?? 0.625) * 0.95;
                      // Visual muzzle agrees with ag.y + 1.38*heightScale & live weapon barrel tip
                      _shotMuzzle.set(
                        ag.x + sinH * (0.145 + muzzleZ * cosP) - cosH * 0.175 * ag.buildScale,
                        ag.y + (1.38 + muzzleZ * sinP) * ag.heightScale,
                        ag.z + cosH * (0.145 + muzzleZ * cosP) + sinH * 0.175 * ag.buildScale
                      );
                      if (gvShot) {
                        triggerEnemyCarbineFlash(gvShot.carbine, muzzleLightPool, _shotMuzzle);
                      }

                      _shotDir.set(
                        playerPos.x - ag.x,
                        playerPos.y + 1.15 - eyeY,
                        playerPos.z - ag.z
                      );

                      const hit = fireSharedWeapon({
                        origin: _shotOrigin,
                        muzzleWorld: _shotMuzzle,
                        dir: _shotDir,
                        shooterKind: 'gang',
                        shooterId: ag.id,
                        spreadRad: wSpec.npcSpreadRad,
                        rayTargets: [],
                        collisionWorld,
                        playerHitBox: _playerHitBox,
                        fxPool: weaponFxPool,
                        districtId: crew.districtId,
                        onSound: playerCtx?.onGunshotSound,
                        listenerPos: _playerPosVec,
                        weaponId: ag.weaponId,
                      });
                      if (hit.hit && hit.kind === 'player' && playerCtx?.onPlayerHit) {
                        playerCtx.onPlayerHit(playerCtx.inVehicle ? hit.damage * 0.22 : hit.damage * 0.45);
                      }

                      if (ag.ammoInMag <= 0) {
                        ag.reloadTimer = wSpec.reloadSec;
                        ag.burstShotsLeft = 0;
                      }
                    }
                  } else {
                    ag.burstCooldown -= safeDt;
                    if (ag.burstCooldown <= 0) {
                      ag.burstShotsLeft = Math.max(1, wSpec.burstCount);
                      ag.burstShotTimer = 0;
                      if (wSpec.pumpCycleSec > 0) {
                        // Pump shotgun paces strictly by its ~0.9 Hz pump cycle
                        ag.burstCooldown = wSpec.pumpCycleSec;
                      } else if (wSpec.burstCooldownSec > 0) {
                        ag.burstCooldown =
                          Math.max(0.45, wSpec.burstCooldownSec - hiddenHeat * 0.004) +
                          (ag.memberSlot % 3) * 0.18;
                      } else {
                        ag.burstCooldown = 0;
                      }
                    }
                  }
                }
              }
            } else {
              ag.aimPitch = THREE.MathUtils.damp(ag.aimPitch, 0, 6.0, safeDt);
            }
          } else if (ag.suspicion > 0.12 && playerPos) {
            // Glance toward player while suspicious
            const toPx = playerPos.x - ag.x;
            const toPz = playerPos.z - ag.z;
            const pDist = Math.hypot(toPx, toPz);
            ag.heading = Math.atan2(toPx, toPz);
            const eyeY = ag.y + 1.44 * ag.heightScale;
            const desiredPitch = THREE.MathUtils.clamp(
              Math.atan2(playerPos.y + 1.15 - eyeY, Math.max(0.5, pDist)),
              -0.45,
              0.45
            );
            ag.aimPitch = THREE.MathUtils.damp(ag.aimPitch, desiredPitch, 8.0, safeDt);
            ag.aiming = ag.suspicion > 0.65;
          } else {
            ag.aimPitch = THREE.MathUtils.damp(ag.aimPitch, 0, 6.0, safeDt);
          }

          // Drive enemy weapon state machine & red LED warm-up ramp (patrol -> draw -> aim -> fire -> low_ready -> reload)
          const sinceShot = elapsed - ag.lastShotElapsed;
          const fireHoldSec = wSpec.pumpCycleSec > 0 ? 0.35 : 0.18;
          if (ag.reloadTimer > 0) {
            ag.weaponState = 'reload';
            ag.ledTarget = 0.14;
          } else if (ag.hadFireLos && (ag.burstShotsLeft > 0 || sinceShot < fireHoldSec)) {
            ag.weaponState = 'fire';
            ag.ledTarget = 1.15;
          } else if (ag.hadFireLos && ag.drawFrac >= 0.72) {
            // Break aim briefly to low-ready right after a carbine burst finishes, then re-acquire
            const postBurstBreak =
              !wSpec.sustainedFire &&
              wSpec.burstCooldownSec > 0 &&
              sinceShot >= 0.22 &&
              sinceShot < 1.6 &&
              ag.burstCooldown > 0.52;
            if (postBurstBreak) {
              ag.weaponState = 'low_ready';
              ag.ledTarget = 0.34;
            } else {
              ag.weaponState = 'aim';
              const denom = Math.max(0.2, wSpec.burstCooldownSec || wSpec.pumpCycleSec || 1.0);
              const chargeFrac = 1.0 - THREE.MathUtils.clamp(ag.burstCooldown / denom, 0, 1);
              ag.ledTarget = 0.72 + 0.26 * chargeFrac;
            }
          } else if (ag.aiming && ag.drawFrac >= 0.72) {
            ag.weaponState = 'aim';
            const suspAim = THREE.MathUtils.clamp((ag.suspicion - 0.65) / 0.35, 0, 1);
            ag.ledTarget = 0.60 + 0.32 * suspAim;
          } else if (crew.state === 'alert' || crew.state === 'search') {
            if (ag.drawFrac < 0.72) {
              ag.weaponState = 'draw';
              ag.ledTarget = 0.32 + 0.34 * ag.drawFrac;
            } else {
              // Moving/searching or lost line-of-sight: drop to low-ready and decay red LED
              ag.weaponState = 'low_ready';
              ag.ledTarget = crew.state === 'alert' ? 0.22 : 0.08;
            }
          } else if (ag.suspicion > 0.03) {
            ag.weaponState = ag.suspicion > 0.28 ? 'draw' : 'patrol';
            ag.ledTarget = 0.14 + 0.46 * ag.suspicion;
          } else {
            ag.weaponState = 'patrol';
            ag.ledTarget = 0.0;
          }
        }
      } else if (ag.role === 'sidewalk') {
        const seg = sidewalkSegs[ag.segIdx];
        if (ag.ixIdx >= 0) {
          // Sidewalk walker stepping onto a nearby intersection zebra crosswalk
          const ix = SIGNALIZED_INTERSECTIONS[ag.ixIdx];
          if (ix) {
            const sig = getIntersectionSignal(ix, elapsed);
            const hasWalk = ag.crossAxis === 'ns' ? sig.pedCrossNS : sig.pedCrossEW;
            if (ag.crossState === 'wait') {
              ag.heading = Math.atan2(
                ag.crossEndX - ag.crossStartX,
                ag.crossEndZ - ag.crossStartZ
              );
              if (hasWalk) ag.crossState = 'crossing';
            } else {
              isWalking = true;
              const totalDist = Math.hypot(
                ag.crossEndX - ag.crossStartX,
                ag.crossEndZ - ag.crossStartZ
              );
              const pace = hasWalk ? ag.speed * 1.2 : ag.speed * 1.7;
              ag.crossU += (pace * safeDt) / Math.max(1, totalDist);
              const targetX = ag.crossStartX + (ag.crossEndX - ag.crossStartX) * Math.min(1, ag.crossU);
              const targetZ = ag.crossStartZ + (ag.crossEndZ - ag.crossStartZ) * Math.min(1, ag.crossU);
              ag.x += (targetX - ag.x) * Math.min(1, safeDt * 7.5);
              ag.z += (targetZ - ag.z) * Math.min(1, safeDt * 7.5);
              const roadY = getRoadElevationAt(ag.x, ag.z);
              ag.y = Math.max(0.095, roadY + 0.015);
              ag.heading = Math.atan2(
                ag.crossEndX - ag.crossStartX,
                ag.crossEndZ - ag.crossStartZ
              );
              if (ag.crossU >= 1) {
                ag.crossU = 0;
                ag.crossState = 'wait';
                ag.ixIdx = -1;
                // Latch smoothly onto nearest far-side sidewalk segment
                let bestIdx = ag.segIdx;
                let bestD = Infinity;
                let bestDir: 1 | -1 = 1;
                let bestProg = 0;
                for (let si = 0; si < sidewalkSegs.length; si++) {
                  const cand = sidewalkSegs[si];
                  const d0 = Math.hypot(cand.x0 - ag.x, cand.z0 - ag.z);
                  const d1 = Math.hypot(cand.x1 - ag.x, cand.z1 - ag.z);
                  if (d0 < bestD) {
                    bestD = d0;
                    bestIdx = si;
                    bestDir = 1;
                    bestProg = 0.5;
                  }
                  if (d1 < bestD) {
                    bestD = d1;
                    bestIdx = si;
                    bestDir = -1;
                    bestProg = cand.len - 0.5;
                  }
                }
                ag.segIdx = bestIdx;
                ag.segDir = bestDir;
                ag.segProgress = bestProg;
              }
            }
          } else {
            ag.ixIdx = -1;
          }
        } else if (seg) {
          isWalking = true;
          ag.segProgress += ag.speed * ag.segDir * safeDt;
          const hitEnd = ag.segProgress >= seg.len;
          const hitStart = ag.segProgress <= 0;
          let enteredCrosswalk = false;
          if (hitEnd || hitStart) {
            const endX = hitEnd ? seg.x1 : seg.x0;
            const endZ = hitEnd ? seg.z1 : seg.z0;
            // Check if arriving at a signalized crosswalk corner to cross cleanly!
            for (let ixI = 0; ixI < SIGNALIZED_INTERSECTIONS.length; ixI++) {
              const ix = SIGNALIZED_INTERSECTIONS[ixI];
              if (Math.hypot(endX - ix.x, endZ - ix.z) < Math.max(ix.halfSpanNS, ix.halfSpanEW) + 12) {
                const crossNS = Math.abs(seg.dirX) > Math.abs(seg.dirZ);
                ag.ixIdx = ixI;
                ag.crossAxis = crossNS ? 'ns' : 'ew';
                ag.crossState = 'wait';
                ag.crossU = 0;
                if (crossNS) {
                  const signZ = endZ >= ix.z ? 1 : -1;
                  const startSignX = endX >= ix.x ? 1 : -1;
                  const zLane = ix.z + signZ * (ix.halfSpanEW + 1.8);
                  const xSpan = ix.halfSpanNS + 1.6;
                  ag.crossStartX = ix.x + startSignX * xSpan;
                  ag.crossStartZ = zLane;
                  ag.crossEndX = ix.x - startSignX * xSpan;
                  ag.crossEndZ = zLane;
                } else {
                  const signX = endX >= ix.x ? 1 : -1;
                  const startSignZ = endZ >= ix.z ? 1 : -1;
                  const xLane = ix.x + signX * (ix.halfSpanNS + 1.8);
                  const zSpan = ix.halfSpanEW + 1.6;
                  ag.crossStartX = xLane;
                  ag.crossStartZ = ix.z + startSignZ * zSpan;
                  ag.crossEndX = xLane;
                  ag.crossEndZ = ix.z - startSignZ * zSpan;
                }
                enteredCrosswalk = true;
                break;
              }
            }
            if (!enteredCrosswalk) {
              const links = hitEnd ? seg.nextEnd : seg.nextStart;
              if (links.length > 0) {
                const pick = links[(i + Math.floor(elapsed)) % links.length];
                ag.segIdx = pick.segIdx;
                ag.segDir = pick.dir;
                const nextS = sidewalkSegs[pick.segIdx];
                ag.segProgress = pick.dir === 1 ? 0.5 : Math.max(0, nextS.len - 0.5);
              } else if (hitEnd) {
                ag.segProgress = seg.len;
                ag.segDir = -1;
              } else {
                ag.segProgress = 0;
                ag.segDir = 1;
              }
            }
          }
          if (!enteredCrosswalk) {
            const curSeg = sidewalkSegs[ag.segIdx] ?? seg;
            const clampedP = Math.max(0, Math.min(curSeg.len, ag.segProgress));
            const targetX = curSeg.x0 + curSeg.dirX * clampedP;
            const targetZ = curSeg.z0 + curSeg.dirZ * clampedP;
            ag.x += (targetX - ag.x) * Math.min(1, safeDt * 6.5);
            ag.z += (targetZ - ag.z) * Math.min(1, safeDt * 6.5);
            const roadY = getRoadElevationAt(ag.x, ag.z);
            ag.y = Math.max(0.155, roadY + 0.075);
            ag.heading = Math.atan2(curSeg.dirX * ag.segDir, curSeg.dirZ * ag.segDir);
          } else {
            ag.x = ag.crossStartX;
            ag.z = ag.crossStartZ;
            ag.y = Math.max(0.155, getRoadElevationAt(ag.x, ag.z) + 0.075);
          }
        }
      } else if (ag.role === 'crosswalk') {
        const ix = SIGNALIZED_INTERSECTIONS[ag.ixIdx];
        if (ix) {
          const sig = getIntersectionSignal(ix, elapsed);
          const hasWalk = ag.crossAxis === 'ns' ? sig.pedCrossNS : sig.pedCrossEW;

          if (ag.crossState === 'wait') {
            const roadY = getRoadElevationAt(ag.x, ag.z);
            ag.y = Math.max(0.155, roadY + 0.075);
            if (hasWalk) {
              ag.crossState = 'crossing';
            }
          } else {
            isWalking = true;
            const totalDist = Math.hypot(
              ag.crossEndX - ag.crossStartX,
              ag.crossEndZ - ag.crossStartZ
            );
            const pace = hasWalk ? ag.speed * 1.2 : ag.speed * 1.75;
            ag.crossU += (pace * safeDt) / Math.max(1, totalDist);
            if (ag.crossU >= 1) {
              ag.crossU = 0;
              ag.crossState = 'wait';
              const tmpX = ag.crossStartX;
              const tmpZ = ag.crossStartZ;
              ag.crossStartX = ag.crossEndX;
              ag.crossStartZ = ag.crossEndZ;
              ag.crossEndX = tmpX;
              ag.crossEndZ = tmpZ;
            }
            const targetX = ag.crossStartX + (ag.crossEndX - ag.crossStartX) * ag.crossU;
            const targetZ = ag.crossStartZ + (ag.crossEndZ - ag.crossStartZ) * ag.crossU;
            ag.x += (targetX - ag.x) * Math.min(1, safeDt * 7.5);
            ag.z += (targetZ - ag.z) * Math.min(1, safeDt * 7.5);
            const roadY = getRoadElevationAt(ag.x, ag.z);
            ag.y = Math.max(0.095, roadY + 0.015);
            ag.heading = Math.atan2(
              ag.crossEndX - ag.crossStartX,
              ag.crossEndZ - ag.crossStartZ
            );
          }
        }
      } else if (ag.role === 'bus_wait') {
        const busHere = Boolean(busStopArrivals && busStopArrivals[ag.busStopIdx]);
        const stepFwd = busHere ? 1.05 : 0;
        const tx = ag.baseX + Math.sin(ag.stationYaw) * stepFwd;
        const tz = ag.baseZ + Math.cos(ag.stationYaw) * stepFwd;
        const dx = tx - ag.x;
        const dz = tz - ag.z;
        if (dx * dx + dz * dz > 0.01) {
          ag.x += dx * Math.min(1, safeDt * 3.0);
          ag.z += dz * Math.min(1, safeDt * 3.0);
          isWalking = true;
        }
      } else if (ag.role === 'metro_plat') {
        const trainHere = Boolean(metroTrainFlags && metroTrainFlags[ag.metroStationIdx]);
        const stepTowardTrack = trainHere ? 0.72 : 0;
        const tx = ag.baseX + Math.cos(ag.stationYaw) * stepTowardTrack;
        const tz = ag.baseZ - Math.sin(ag.stationYaw) * stepTowardTrack;
        const dx = tx - ag.x;
        const dz = tz - ag.z;
        if (dx * dx + dz * dz > 0.01) {
          ag.x += dx * Math.min(1, safeDt * 3.2);
          ag.z += dz * Math.min(1, safeDt * 3.2);
          isWalking = true;
        }
      } else if (ag.role === 'metro_street') {
        const paceOff = Math.sin(elapsed * 0.45 + ag.idlePhase) * 1.9;
        const tx = ag.baseX + Math.sin(ag.stationYaw) * paceOff;
        const tz = ag.baseZ + Math.cos(ag.stationYaw) * paceOff;
        const dx = tx - ag.x;
        const dz = tz - ag.z;
        if (Math.abs(dx) + Math.abs(dz) > 0.02) {
          ag.heading = Math.atan2(dx, dz);
          ag.x += dx * Math.min(1, safeDt * 6.0);
          ag.z += dz * Math.min(1, safeDt * 6.0);
          isWalking = true;
        }
      }

      ag.vx = (ag.x - ag.prevX) / safeDt;
      ag.vz = (ag.z - ag.prevZ) / safeDt;
      walkingFlags[i] = isWalking ? 1 : 0;
    }

    // Two fast separation & social-passing passes (zero clipping across all neighbors)
    resolveSeparationAndSocial(safeDt, 0, playerPos);
    resolveSeparationAndSocial(safeDt, 1, playerPos);

    for (let i = 0; i < totalCount; i++) {
      const ag = agents[i];
      if (!ag.alive) {
        // Hide dead NPC parts underground and hide gang weapon/sprite
        setPart(leftThighInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(rightThighInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(leftShinInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(rightShinInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(leftBootInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(rightBootInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(hipsInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(coatSkirtInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(torsoInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(scarfInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(leftUpperArmInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(rightUpperArmInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(leftForearmInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(rightForearmInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(leftHandInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(rightHandInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(headInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(flowHairInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(hatInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(propInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(briefcaseInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        const gv = gangVisuals.get(i);
        if (gv) {
          gv.carbine.root.visible = false;
          gv.carbine.flashGroup.visible = false;
          gv.carbine.ledGlowSprite.visible = false;
          gv.suspicionSprite.visible = false;
        }
        continue;
      }
      ag.sidestepYaw = THREE.MathUtils.damp(ag.sidestepYaw, ag.targetSidestep, 9.5, safeDt);
      const isWalking = walkingFlags[i] === 1;
      const moveSpeed = Math.hypot(ag.vx, ag.vz);

      if (isWalking) {
        // Scale stride cadence with true ground speed so running armed enemies pump legs cleanly (no statue-glide)
        const strideRate = Math.max(ag.speed, Math.min(5.6, moveSpeed));
        ag.stridePhase += safeDt * strideRate * 4.8;
      }

      const h = ag.heightScale;
      const b = ag.buildScale;
      const sinH = Math.sin(ag.heading);
      const cosH = Math.cos(ag.heading);
      const rightX = -cosH;
      const rightZ = sinH;

      const stride = isWalking ? Math.sin(ag.stridePhase) : 0;
      const cosStride = isWalking ? Math.cos(ag.stridePhase) : 0;
      const idleShift = isWalking
        ? 0
        : Math.tanh(Math.sin(elapsed * 0.26 + ag.idlePhase) * 1.9) * 0.85;
      const lIdleRelax = Math.max(0, idleShift);
      const rIdleRelax = Math.max(0, -idleShift);
      const bob = isWalking
        ? Math.abs(stride) * 0.032 * h
        : Math.sin(elapsed * 1.85 + ag.idlePhase) * 0.008 * h - Math.abs(idleShift) * 0.012 * h;

      const windGust =
        (0.55 + 0.45 * Math.sin(elapsed * 1.4 + ag.idlePhase)) *
        (Math.sin(elapsed * 4.5 + ag.idlePhase * 1.7) * 0.65 +
          Math.sin(elapsed * 9.2 + ag.idlePhase * 2.5) * 0.35);

      const lThighX = isWalking ? -stride * 0.50 : -0.02 - lIdleRelax * 0.11;
      const rThighX = isWalking ? stride * 0.50 : -0.02 - rIdleRelax * 0.11;
      const lKneeBend = isWalking
        ? Math.max(0.05, (cosStride * 0.5 + 0.5) * 0.64)
        : 0.04 + lIdleRelax * 0.21;
      const rKneeBend = isWalking
        ? Math.max(0.05, (-cosStride * 0.5 + 0.5) * 0.64)
        : 0.04 + rIdleRelax * 0.21;
      const lShinX = lThighX + lKneeBend;
      const rShinX = rThighX + rKneeBend;

      const upsetFrac = ag.upsetTimer > 0 ? Math.sin(Math.min(1, ag.upsetTimer / 2.5) * Math.PI) : 0;
      const upsetWave = ag.upsetTimer > 0 ? Math.sin(elapsed * 12.5 + ag.idlePhase) * 0.26 * upsetFrac : 0;

      const lArmX =
        ag.upsetTimer > 0
          ? -0.78 * upsetFrac + upsetWave * 0.55
          : isWalking
          ? stride * 0.40
          : -0.04 + Math.sin(elapsed * 1.85 + ag.idlePhase) * 0.025;
      const rArmX = isWalking ? -stride * 0.40 : -0.06 - Math.sin(elapsed * 1.85 + ag.idlePhase) * 0.02;
      const lForearmX =
        ag.upsetTimer > 0
          ? -1.42 * upsetFrac + upsetWave
          : lArmX - 0.22 - Math.max(0, -lArmX) * 0.46;
      const rForearmX = rArmX - 0.24 - Math.max(0, -rArmX) * 0.46;

      const isGang = ag.role === 'gang';
      const wProf = isGang ? getEnemyWeaponClassProfile(ag.weaponClass) : null;
      if (isGang && wProf) {
        const ws = ag.weaponState;
        const targetDraw = ws === 'patrol' ? 0.0 : 1.0;
        const targetAim = ws === 'aim' || ws === 'fire' ? 1.0 : 0.0;
        const targetLowReady = ws === 'low_ready' ? 1.0 : ws === 'draw' ? 0.65 : 0.0;
        const targetTwoHand = ws === 'patrol' ? 0.0 : 1.0;
        const targetReload = ws === 'reload' ? 1.0 : 0.0;

        ag.drawFrac = THREE.MathUtils.damp(
          ag.drawFrac,
          targetDraw,
          ws === 'patrol' ? wProf.blendRate * 0.85 : wProf.blendRate,
          safeDt
        );
        ag.aimBlend = THREE.MathUtils.damp(ag.aimBlend, targetAim, wProf.blendRate, safeDt);
        ag.lowReadyBlend = THREE.MathUtils.damp(ag.lowReadyBlend, targetLowReady, wProf.blendRate * 0.9, safeDt);
        ag.twoHandBlend = THREE.MathUtils.damp(ag.twoHandBlend, targetTwoHand, wProf.blendRate * 1.1, safeDt);
        ag.reloadBlend = THREE.MathUtils.damp(ag.reloadBlend, targetReload, 10.0, safeDt);
        ag.recoilKick = THREE.MathUtils.damp(ag.recoilKick, 0, wProf.recoilDamp, safeDt);
      }

      const gangCombatBlend = isGang
        ? Math.max(ag.aimBlend, ag.lowReadyBlend, ag.reloadBlend)
        : 0;

      // Head glare toward bumper when upset, track combat target when armed, or polite nod on passing
      let headYaw = ag.heading;
      let headPitch = 0;
      if (isGang && gangCombatBlend > 0.04) {
        const patrolLook = Math.tanh(Math.sin(elapsed * 0.42 + ag.idlePhase) * 1.8) * 0.12;
        headYaw = ag.heading + patrolLook * (1 - gangCombatBlend);
        headPitch =
          (-ag.aimPitch * 0.72 + 0.05 * ag.aimBlend - ag.recoilKick * 0.03) * gangCombatBlend;
      } else if (ag.upsetTimer > 0) {
        let glareDelta = ((ag.upsetLookYaw - ag.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
        if (glareDelta < -Math.PI) glareDelta += Math.PI * 2;
        headYaw = ag.heading + THREE.MathUtils.clamp(glareDelta, -1.15, 1.15) * Math.min(1, upsetFrac * 1.4);
        headPitch = -0.08 * upsetFrac; // chin tucked glare
      } else {
        const headLook = isWalking
          ? Math.tanh(Math.sin(elapsed * 0.42 + ag.idlePhase) * 1.8) * 0.10
          : Math.tanh(Math.sin(elapsed * 0.36 + ag.idlePhase) * 2.2) * 0.30;
        headYaw = ag.heading + headLook + ag.sidestepYaw * 0.35;
        if (ag.nodTimer > 0) {
          const nodU = 1 - ag.nodTimer / 0.7;
          headPitch = Math.sin(nodU * Math.PI) * 0.24;
        }
      }

      // Blade torso into tactical stance & counter-stabilize walk twist while aiming/firing on the move
      const walkTwist = -stride * 0.09 * (isGang ? 1 - ag.aimBlend * 0.82 : 1);
      const stanceBlade = isGang && wProf ? -wProf.stanceYaw * gangCombatBlend : 0;
      const torsoYaw = ag.heading + walkTwist + idleShift * 0.03 + ag.sidestepYaw + stanceBlade;

      const baseY = ag.y + bob;
      const hipY = baseY + 0.89 * h;
      const hipShiftX = rightX * (idleShift * 0.024 * b);
      const hipShiftZ = rightZ * (idleShift * 0.024 * b);
      const legOff = 0.098 * b;
      const armOff = 0.198 * b;
      const thighLen = 0.425 * h;
      const shinLen = 0.415 * h;
      const uArmLen = 0.285 * h;

      // Articulated Left & Right Thighs
      setPart(leftThighInst, i, ag.x - rightX * legOff, hipY, ag.z - rightZ * legOff, lThighX, ag.heading, 0, b, h, b);
      setPart(rightThighInst, i, ag.x + rightX * legOff, hipY, ag.z + rightZ * legOff, rThighX, ag.heading, 0, b, h, b);

      // Articulated Left & Right Calves/Shins
      const lKneeFwd = -Math.sin(lThighX) * thighLen;
      const lKneeY = hipY - Math.cos(lThighX) * thighLen;
      const rKneeFwd = -Math.sin(rThighX) * thighLen;
      const rKneeY = hipY - Math.cos(rThighX) * thighLen;

      setPart(
        leftShinInst,
        i,
        ag.x - rightX * legOff + sinH * lKneeFwd,
        lKneeY,
        ag.z - rightZ * legOff + cosH * lKneeFwd,
        lShinX,
        ag.heading,
        0,
        b,
        h,
        b
      );
      setPart(
        rightShinInst,
        i,
        ag.x + rightX * legOff + sinH * rKneeFwd,
        rKneeY,
        ag.z + rightZ * legOff + cosH * rKneeFwd,
        rShinX,
        ag.heading,
        0,
        b,
        h,
        b
      );

      // Shoes
      const lAnkFwd = lKneeFwd - Math.sin(lShinX) * shinLen;
      const lAnkY = Math.max(ag.y, lKneeY - Math.cos(lShinX) * shinLen - 0.04 * h);
      const rAnkFwd = rKneeFwd - Math.sin(rShinX) * shinLen;
      const rAnkY = Math.max(ag.y, rKneeY - Math.cos(rShinX) * shinLen - 0.04 * h);

      setPart(
        leftBootInst,
        i,
        ag.x - rightX * legOff + sinH * lAnkFwd,
        lAnkY,
        ag.z - rightZ * legOff + cosH * lAnkFwd,
        lShinX * 0.28,
        ag.heading,
        0,
        b,
        h,
        b
      );
      setPart(
        rightBootInst,
        i,
        ag.x + rightX * legOff + sinH * rAnkFwd,
        rAnkY,
        ag.z + rightZ * legOff + cosH * rAnkFwd,
        rShinX * 0.28,
        ag.heading,
        0,
        b,
        h,
        b
      );

      const bodyX = ag.x + hipShiftX;
      const bodyZ = ag.z + hipShiftZ;
      setPart(hipsInst, i, bodyX, baseY + 0.92 * h, bodyZ, 0, ag.heading, -idleShift * 0.035, b, h, b);
      setPart(
        coatSkirtInst,
        i,
        bodyX,
        baseY + 1.02 * h,
        bodyZ,
        0.09 + Math.abs(stride) * 0.1 + windGust * 0.14,
        torsoYaw,
        windGust * 0.18 - idleShift * 0.025,
        b * 1.04,
        h * ag.coatLenScale,
        b * 1.04
      );

      const torsoPitch =
        (isWalking ? 0.045 : 0.012) +
        (isGang && wProf
          ? wProf.combatLean * gangCombatBlend -
            ag.aimPitch * 0.18 * ag.aimBlend -
            ag.recoilKick * 0.075
          : 0);

      setPart(
        torsoInst,
        i,
        bodyX,
        baseY + 1.01 * h,
        bodyZ,
        torsoPitch,
        torsoYaw,
        idleShift * 0.028,
        b,
        h,
        b
      );
      if (ag.hasScarf) {
        setPart(
          scarfInst,
          i,
          bodyX,
          baseY + 1.495 * h,
          bodyZ,
          0.02 + Math.abs(windGust) * 0.12,
          torsoYaw,
          windGust * 0.16,
          b * 1.02,
          h,
          b * 1.02
        );
      } else {
        setPart(scarfInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
      }

      const sinT = Math.sin(torsoYaw);
      const cosT = Math.cos(torsoYaw);
      const rightTX = -cosT;
      const rightTZ = sinT;

      const isCarryingBriefcase =
        ag.hasProp &&
        ag.civClass !== 'streetwear_youth' &&
        ag.civClass !== 'student_runner';
      const shoulderY = baseY + 1.43 * h;
      const fArmLen = 0.255 * h;

      // Natural civilian / base arm FK positions (used directly for civilians & blended for patrol left arm)
      const lElbFwd = -Math.sin(lArmX) * uArmLen;
      const lElbY = shoulderY - Math.cos(lArmX) * uArmLen;
      const lHandFwd = lElbFwd - Math.sin(lForearmX) * fArmLen;
      const lHandY = lElbY - Math.cos(lForearmX) * fArmLen;
      const lHandX = bodyX - rightTX * (armOff + 0.016 * b) + sinT * lHandFwd;
      const lHandZ = bodyZ - rightTZ * (armOff + 0.016 * b) + cosT * lHandFwd;

      const rArmFinalX = isCarryingBriefcase ? rArmX * 0.25 + 0.05 : rArmX;
      const rForearmFinalX = isCarryingBriefcase ? rArmFinalX - 0.12 : rForearmX;
      const rElbFwd = -Math.sin(rArmFinalX) * uArmLen;
      const rElbY = shoulderY - Math.cos(rArmFinalX) * uArmLen;
      const rHandFwd = rElbFwd - Math.sin(rForearmFinalX) * fArmLen;
      const rHandY = rElbY - Math.cos(rForearmFinalX) * fArmLen;
      const rHandX = bodyX + rightTX * (armOff + 0.016 * b) + sinT * rHandFwd;
      const rHandZ = bodyZ + rightTZ * (armOff + 0.016 * b) + cosT * rHandFwd;

      if (isGang && wProf) {
        const gv = gangVisuals.get(i);
        const moveNorm = Math.min(1.15, moveSpeed / 4.8);
        const swayX =
          Math.sin(elapsed * 2.1 + ag.idlePhase * 1.7) * 0.008 * wProf.swayAmp +
          Math.sin(ag.stridePhase * 0.5) * 0.006 * moveNorm;
        const swayY =
          Math.cos(elapsed * 1.85 + ag.idlePhase) * 0.006 * wProf.swayAmp -
          Math.abs(stride) * 0.010 * moveNorm;

        // Weapon-specific reload choreography (duration strictly equals wSpec.reloadSec)
        const wSpec = getSharedWeaponSpec(ag.weaponId);
        const relW = ag.reloadBlend;
        if (ag.reloadTimer > 0 && gv) {
          const reloadU = 1.0 - ag.reloadTimer / wSpec.reloadSec;
          evaluateReloadChoreography(reloadU, _relHandLocal, _relMagOffset, _relTilt, ag.weaponId);
          // Mirror X because in pedestrianSystem character-left is +X in weapon space
          setEnemyCarbineMagOffset(
            gv.carbine,
            -_relMagOffset.x,
            _relMagOffset.y,
            _relMagOffset.z,
            _relMagOffset.y * 1.4,
            -_relMagOffset.x * 2.2
          );
          if (ag.weaponId === 'pump_shotgun' && _relTilt.pumpStroke !== undefined) {
            setEnemyWeaponPumpStroke(gv.carbine, _relTilt.pumpStroke);
          }
        } else {
          if (gv) setEnemyCarbineMagOffset(gv.carbine, 0, 0, 0, 0, 0);
          _relTilt.roll = 0;
          _relTilt.pitch = 0;
          _relTilt.yaw = 0;
          _relTilt.impulse = 0;
          _relTilt.pumpStroke = 0;
        }

        // Compute world weapon grip pose blending smoothly: patrol (1-hand low-carry) -> low-ready -> aim/fire
        const drawW = ag.drawFrac;
        const aimW = ag.aimBlend;
        const recoil = ag.recoilKick;

        // Patrol: comfortable one-handed low-carry at right hip/thigh, swaying subtly with right arm
        const patLat = 0.225 * b;
        const patY = baseY + 0.96 * h + Math.abs(stride) * 0.014 * h;
        const patFwd = 0.125 - stride * 0.065;

        // Low-ready: two-handed across upper chest, barrel safely dipped
        const lrLat = 0.135 * b;
        const lrY = baseY + 1.24 * h;
        const lrFwd = 0.205;

        // Shouldered aim/fire: buttpad seated in right shoulder pocket, visual muzzle at ag.y + 1.38*h
        const aimLat = 0.175 * b;
        const aimY = baseY + (1.340 + Math.sin(ag.aimPitch) * 0.045) * h;
        const aimFwd = 0.145 - recoil * 0.044 + _relTilt.impulse * 0.018;

        const gLat = THREE.MathUtils.lerp(THREE.MathUtils.lerp(patLat, lrLat, drawW), aimLat, aimW) + swayX;
        const gY =
          THREE.MathUtils.lerp(THREE.MathUtils.lerp(patY, lrY, drawW), aimY, aimW) +
          swayY +
          recoil * 0.015 -
          relW * 0.036;
        const gFwd =
          THREE.MathUtils.lerp(THREE.MathUtils.lerp(patFwd, lrFwd, drawW), aimFwd, aimW) +
          relW * 0.025;

        _gunPos.set(
          bodyX + rightX * gLat + sinH * gFwd,
          gY,
          bodyZ + rightZ * gLat + cosH * gFwd
        );

        const gPitchPatrol = 0.78 + stride * 0.09;
        const gPitchLowReady = wProf.lowReadyPitch + swayY * 1.4;
        const gPitchAim = -ag.aimPitch - recoil * 0.115 + swayY * 0.8;
        const gPitch =
          THREE.MathUtils.lerp(
            THREE.MathUtils.lerp(gPitchPatrol, gPitchLowReady, drawW),
            gPitchAim,
            aimW
          ) +
          _relTilt.pitch * relW;

        const gYawPatrol = ag.heading - 0.10;
        const gYawLowReady = ag.heading + 0.22;
        const gYawAim = ag.heading + swayX * 1.1;
        const gYaw =
          THREE.MathUtils.lerp(
            THREE.MathUtils.lerp(gYawPatrol, gYawLowReady, drawW),
            gYawAim,
            aimW
          ) -
          _relTilt.yaw * relW;

        const gRollPatrol = -0.14;
        const gRollReady = -wProf.weaponCant + recoil * 0.045;
        const gRoll =
          THREE.MathUtils.lerp(gRollPatrol, gRollReady, drawW) - _relTilt.roll * relW;

        _gunEuler.set(gPitch, gYaw, gRoll, 'YXZ');
        _gunQuat.setFromEuler(_gunEuler);

        // 1. Right arm 3D 2-bone IK locked directly onto the carbine pistol grip (zero floating!)
        _rShPos.set(bodyX + rightTX * armOff, shoulderY, bodyZ + rightTZ * armOff);
        _tmpOffset.set(0, -0.022, -0.012).applyQuaternion(_gunQuat);
        _rHandTarget.copy(_gunPos).add(_tmpOffset);
        _rPoleHint.set(
          rightTX * 0.72 - sinT * 0.36,
          -0.68,
          rightTZ * 0.72 - cosT * 0.36
        );
        solveInstancedArmIK(
          rightUpperArmInst,
          rightForearmInst,
          rightHandInst,
          i,
          _rShPos,
          _rHandTarget,
          _rPoleHint,
          uArmLen,
          fArmLen,
          b,
          h
        );

        // 2. Left (support) arm: natural walk/idle swing in patrol, 3D 2-bone IK onto handguard / reload mag in combat!
        const suppW = ag.twoHandBlend;
        if (suppW > 0.01) {
          _lShPos.set(bodyX - rightTX * armOff, shoulderY, bodyZ - rightTZ * armOff);
          _lHandBasePos.set(lHandX, lHandY, lHandZ);

          const baseHandguardZ =
            ag.weaponId === 'pump_shotgun' && gv
              ? gv.carbine.pumpForendRestZ - gv.carbine.pumpStroke * 0.098
              : 0.265;
          if (relW > 0.02) {
            _tmpOffset.set(
              THREE.MathUtils.lerp(0.0, -_relHandLocal.x, relW),
              THREE.MathUtils.lerp(0.002, _relHandLocal.y, relW),
              THREE.MathUtils.lerp(baseHandguardZ, _relHandLocal.z, relW)
            );
          } else {
            // Anchored directly beneath the carbine handguard or live sliding shotgun pump forend
            _tmpOffset.set(0.0, 0.002, baseHandguardZ);
          }
          _tmpOffset.multiplyScalar(0.95).applyQuaternion(_gunQuat).add(_gunPos);
          _lHandTarget.copy(_lHandBasePos).lerp(_tmpOffset, suppW);

          _lPoleHint.set(
            -rightTX * 0.65 - sinT * 0.24,
            -0.78,
            -rightTZ * 0.65 - cosT * 0.24
          );
          solveInstancedArmIK(
            leftUpperArmInst,
            leftForearmInst,
            leftHandInst,
            i,
            _lShPos,
            _lHandTarget,
            _lPoleHint,
            uArmLen,
            fArmLen,
            b,
            h
          );
        } else {
          // One-handed patrol low-carry: left arm swings completely naturally with gait
          setPart(
            leftUpperArmInst,
            i,
            bodyX - rightTX * armOff,
            shoulderY,
            bodyZ - rightTZ * armOff,
            lArmX,
            torsoYaw,
            0.048,
            b,
            h,
            b
          );
          setPart(
            leftForearmInst,
            i,
            bodyX - rightTX * (armOff + 0.012 * b) + sinT * lElbFwd,
            lElbY,
            bodyZ - rightTZ * (armOff + 0.012 * b) + cosT * lElbFwd,
            lForearmX,
            torsoYaw,
            0.025,
            b,
            h,
            b
          );
          setPart(leftHandInst, i, lHandX, lHandY, lHandZ, lForearmX, torsoYaw, 0.04, h, h, h);
        }

        // Sync black enemy carbine transform, red LED power-up & muzzle flash, plus "?" suspicion sprite
        if (gv) {
          gv.carbine.root.visible = true;
          gv.carbine.root.position.copy(_gunPos);
          gv.carbine.root.quaternion.copy(_gunQuat);
          updateEnemyCarbineVisual(gv.carbine, safeDt, elapsed, ag.ledTarget, ag.idlePhase);

          const crew = crews[ag.crewIdx];
          if (ag.alertBannerTimer > 0 && crew?.state === 'alert') {
            gv.suspicionSprite.visible = true;
            gv.suspicionSprite.position.set(bodyX, baseY + 2.08 * h, bodyZ);
            (gv.suspicionSprite.material as THREE.SpriteMaterial).map = alertBang;
          } else if (ag.suspicion > 0.02 && crew?.state !== 'alert') {
            gv.suspicionSprite.visible = true;
            gv.suspicionSprite.position.set(bodyX, baseY + 2.08 * h, bodyZ);
            const stepIdx = Math.min(
              questionSteps.length - 1,
              Math.max(0, Math.round(ag.suspicion * (questionSteps.length - 1)))
            );
            (gv.suspicionSprite.material as THREE.SpriteMaterial).map = questionSteps[stepIdx];
          } else {
            gv.suspicionSprite.visible = false;
          }
        }
      } else {
        // Non-gang unarmed civilians: original exact FK placement untouched
        setPart(
          leftUpperArmInst,
          i,
          bodyX - rightTX * armOff,
          shoulderY,
          bodyZ - rightTZ * armOff,
          lArmX,
          torsoYaw,
          0.048,
          b,
          h,
          b
        );
        setPart(
          rightUpperArmInst,
          i,
          bodyX + rightTX * armOff,
          shoulderY,
          bodyZ + rightTZ * armOff,
          rArmFinalX,
          torsoYaw,
          -0.048,
          b,
          h,
          b
        );
        setPart(
          leftForearmInst,
          i,
          bodyX - rightTX * (armOff + 0.012 * b) + sinT * lElbFwd,
          lElbY,
          bodyZ - rightTZ * (armOff + 0.012 * b) + cosT * lElbFwd,
          lForearmX,
          torsoYaw,
          0.025,
          b,
          h,
          b
        );
        setPart(
          rightForearmInst,
          i,
          bodyX + rightTX * (armOff + 0.012 * b) + sinT * rElbFwd,
          rElbY,
          bodyZ + rightTZ * (armOff + 0.012 * b) + cosT * rElbFwd,
          rForearmFinalX,
          torsoYaw,
          -0.025,
          b,
          h,
          b
        );
        setPart(leftHandInst, i, lHandX, lHandY, lHandZ, lForearmX, torsoYaw, 0.04, h, h, h);
        setPart(rightHandInst, i, rHandX, rHandY, rHandZ, rForearmFinalX, torsoYaw, -0.04, h, h, h);
      }

      const headY = baseY + 1.59 * h;
      setPart(headInst, i, bodyX, headY, bodyZ, headPitch, headYaw, -idleShift * 0.025, h, h, h);
      if (ag.usesCap) {
        setPart(hatInst, i, bodyX, headY, bodyZ, headPitch, headYaw, -idleShift * 0.025, h * 1.03, h * 1.04, h * 1.03);
        setPart(flowHairInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
      } else {
        setPart(
          flowHairInst,
          i,
          bodyX,
          headY,
          bodyZ,
          headPitch,
          headYaw,
          -idleShift * 0.025,
          h,
          h * ag.hairFlowScale,
          h
        );
        setPart(hatInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
      }

      if (ag.hasProp) {
        if (!isCarryingBriefcase) {
          setPart(
            propInst,
            i,
            bodyX - sinT * 0.148 * b,
            baseY + 1.29 * h,
            bodyZ - cosT * 0.148 * b,
            0.03,
            torsoYaw,
            idleShift * 0.024,
            1.02 * b,
            1.02 * h,
            1.0 * b
          );
          setPart(briefcaseInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        } else {
          const gripDrop = 0.088 * h;
          const bX = rHandX + sinT * (-Math.sin(rForearmFinalX) * gripDrop);
          const bY = rHandY - Math.cos(rForearmFinalX) * gripDrop;
          const bZ = rHandZ + cosT * (-Math.sin(rForearmFinalX) * gripDrop);
          setPart(briefcaseInst, i, bX, bY, bZ, rArmFinalX * 0.35, torsoYaw, 0, h, h, h);
          setPart(propInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        }
      } else {
        setPart(propInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
        setPart(briefcaseInst, i, 0, -100, 0, 0, 0, 0, 0.001, 0.001, 0.001);
      }
    }

    leftThighInst.instanceMatrix.needsUpdate = true;
    rightThighInst.instanceMatrix.needsUpdate = true;
    leftShinInst.instanceMatrix.needsUpdate = true;
    rightShinInst.instanceMatrix.needsUpdate = true;
    leftBootInst.instanceMatrix.needsUpdate = true;
    rightBootInst.instanceMatrix.needsUpdate = true;
    hipsInst.instanceMatrix.needsUpdate = true;
    coatSkirtInst.instanceMatrix.needsUpdate = true;
    torsoInst.instanceMatrix.needsUpdate = true;
    scarfInst.instanceMatrix.needsUpdate = true;
    leftUpperArmInst.instanceMatrix.needsUpdate = true;
    rightUpperArmInst.instanceMatrix.needsUpdate = true;
    leftForearmInst.instanceMatrix.needsUpdate = true;
    rightForearmInst.instanceMatrix.needsUpdate = true;
    leftHandInst.instanceMatrix.needsUpdate = true;
    rightHandInst.instanceMatrix.needsUpdate = true;
    headInst.instanceMatrix.needsUpdate = true;
    flowHairInst.instanceMatrix.needsUpdate = true;
    hatInst.instanceMatrix.needsUpdate = true;
    propInst.instanceMatrix.needsUpdate = true;
    briefcaseInst.instanceMatrix.needsUpdate = true;
  };

  const reseed = (newSeed?: number) => {
    seed =
      newSeed !== undefined
        ? newSeed >>> 0
        : ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0);
    rng = mulberry32(seed);
    spawnAgents();
    applyOutfitColors();
  };

  const getRayTargets = (origin: THREE.Vector3, radiusM: number): FpsRayTarget[] => {
    const out: FpsRayTarget[] = [];
    const r2 = radiusM * radiusM;
    for (let i = 0; i < totalCount; i++) {
      const ag = agents[i];
      if (!ag.alive) continue;
      const dx = ag.x - origin.x;
      const dy = ag.y + 0.9 - origin.y;
      const dz = ag.z - origin.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      const hr = PED_CAPSULE_RADIUS;
      const height = 1.72 * ag.heightScale;
      const box = new THREE.Box3(
        new THREE.Vector3(ag.x - hr, ag.y, ag.z - hr),
        new THREE.Vector3(ag.x + hr, ag.y + height, ag.z + hr)
      );
      out.push({
        id: ag.id,
        bounds: box,
        kind: 'npc',
        agentId: ag.id,
      });
    }
    return out;
  };

  const getActiveSubtitle = (x: number, y: number, z: number): string => {
    let bestD2 = 8.5 * 8.5;
    let bestText = '';
    for (let i = 0; i < totalCount; i++) {
      const ag = agents[i];
      if (ag.upsetTimer <= 0 || !ag.mutterText) continue;
      const dy = ag.y - y;
      if (Math.abs(dy) > 3.5) continue;
      const d2 = (ag.x - x) ** 2 + (ag.z - z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestText = ag.mutterText;
      }
    }
    return bestText;
  };

  return {
    root,
    totalCount,
    agents,
    update,
    reseed,
    getRayTargets,
    getActiveSubtitle,
    applyDamageToAgent,
    notifyPlayerGunshot,
    getHiddenHeat: () => hiddenHeat,
    getGangCrewStates: () =>
      crews.map((c) => {
        let maxSusp = 0;
        let aliveCount = 0;
        for (let k = 0; k < c.memberIndices.length; k++) {
          const m = agents[c.memberIndices[k]];
          if (m.alive) aliveCount++;
          if (m.suspicion > maxSusp) maxSusp = m.suspicion;
        }
        return {
          id: c.id,
          districtId: c.districtId,
          state: c.state,
          anchorX: c.anchorX,
          anchorZ: c.anchorZ,
          maxSuspicion: maxSusp,
          memberCount: aliveCount,
        };
      }),
  };
}

