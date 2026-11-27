import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  applyHumanPose,
  applyWeaponHoldPose,
  attachWeaponToHumanRig,
  createRiggedHuman,
  disposeEnemyCarbineVisual,
  getEnemyWeaponIdForClass,
  getNpcWeaponMuzzleWorld,
  MuzzleFlashLightPool,
  type EnemyWeaponClass,
  type EnemyWeaponState,
  type HumanRig,
  type NpcWeaponRig,
  type OutfitStyleType,
} from '../sim/humanCharacter';
import {
  createSharedWeaponMesh,
  fireSharedWeapon,
  getSharedWeaponSpec,
  SHARED_WEAPON_IDS,
  SharedWeaponFxPool,
  type SharedWeaponId,
} from '../sim/sharedWeapon';
import { createFpsWeaponView } from '../sim/fpsWeaponView';
import type { CollisionWorld } from './shims/mapData';
import type { FpsRayTarget } from './shims/fpsBridge';
import { createPreviewTextureLibrary } from './shims/textures';

type PreviewMode = 'arsenal' | 'fps' | 'lineup' | 'crowd40';
type LocomotionMode = 'stand' | 'walk' | 'run';
type LightingMode = 'day' | 'night';

interface ArmedActor {
  rig: HumanRig;
  weaponRig: NpcWeaponRig;
  weaponId: SharedWeaponId;
  fixedState?: EnemyWeaponState;
  phase: number;
  baseX: number;
  baseZ: number;
  burstShotsLeft: number;
  burstShotTimer: number;
  burstCooldown: number;
  reloadTimer: number;
  ammoInMag: number;
  walkCycle: number;
}

const app = document.getElementById('app')!;

// --- RENDERER & SCENE (ACES Filmic, motivated lighting + fog) ---
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const dayFog = new THREE.FogExp2(0x8b98a8, 0.012);
const nightFog = new THREE.FogExp2(0x0b0f16, 0.024);
scene.background = new THREE.Color(0x8b98a8);
scene.fog = dayFog;

const camera = new THREE.PerspectiveCamera(44, window.innerWidth / window.innerHeight, 0.06, 180);
camera.position.set(0.0, 1.9, 5.4);
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 1.25, 0);
controls.minDistance = 1.4;
controls.maxDistance = 34;
controls.maxPolarAngle = Math.PI * 0.49;

// Motivated lighting (Day / Night)
const hemiLight = new THREE.HemisphereLight(0xd7e4f2, 0x3b4048, 0.95);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.2);
sunLight.position.set(10, 18, 12);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(1024, 1024);
sunLight.shadow.camera.near = 1;
sunLight.shadow.camera.far = 65;
sunLight.shadow.camera.left = -18;
sunLight.shadow.camera.right = 18;
sunLight.shadow.camera.top = 18;
sunLight.shadow.camera.bottom = -18;
sunLight.shadow.bias = -0.0005;
scene.add(sunLight);

const yardLamp = new THREE.PointLight(0xd2e2ff, 0, 18, 2);
yardLamp.position.set(-2.5, 4.4, 2.5);
scene.add(yardLamp);

// Wet concrete courtyard + range surfaces so muzzle flash light spill reads on hands & walls
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(110, 110),
  new THREE.MeshStandardMaterial({ color: 0x363b42, roughness: 0.48, metalness: 0.08 })
);
ground.rotation.x = -Math.PI * 0.5;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(60, 60, 0x525a66, 0x2b3038);
grid.position.y = 0.004;
scene.add(grid);

const wallMat = new THREE.MeshStandardMaterial({ color: 0x454c55, roughness: 0.86, metalness: 0.04 });
const backWall = new THREE.Mesh(new THREE.BoxGeometry(22, 3.6, 0.4), wallMat);
backWall.position.set(0, 1.8, -2.5);
backWall.receiveShadow = true;
scene.add(backWall);

for (const px of [-4.8, 4.8]) {
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.6, 3.6, 0.6), wallMat);
  pillar.position.set(px, 1.8, 0.4);
  pillar.castShadow = true;
  pillar.receiveShadow = true;
  scene.add(pillar);
}

// Player canonical 3-weapon comparison rack (verifies Variation Law: player materials untouched!)
const benchGroup = new THREE.Group();
benchGroup.position.set(-4.2, 0, 1.1);
const benchTop = new THREE.Mesh(
  new THREE.BoxGeometry(1.1, 0.06, 1.35),
  new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.72, metalness: 0.15 })
);
benchTop.position.y = 0.88;
benchTop.receiveShadow = true;
benchGroup.add(benchTop);
const benchLeg = new THREE.Mesh(
  new THREE.BoxGeometry(0.14, 0.88, 0.14),
  new THREE.MeshStandardMaterial({ color: 0x1d2128, roughness: 0.65, metalness: 0.4 })
);
benchLeg.position.y = 0.44;
benchGroup.add(benchLeg);
SHARED_WEAPON_IDS.forEach((wid, idx) => {
  const sample = createSharedWeaponMesh(0.95, wid);
  sample.position.set(-0.18, 0.99, (idx - 1) * 0.38);
  sample.rotation.y = Math.PI * 0.5;
  benchGroup.add(sample);
});
scene.add(benchGroup);

// Shooting-range steel targets for FPS mode (12m, 25m, 38m — demonstrates shotgun spread & >25m falloff)
const rangeGroup = new THREE.Group();
rangeGroup.visible = false;
scene.add(rangeGroup);
const rangeTargets: Array<{ id: string; distM: number; mesh: THREE.Mesh; bounds: THREE.Box3 }> = [];
const targetMatBase = new THREE.MeshStandardMaterial({ color: 0xb8bec8, roughness: 0.45, metalness: 0.55 });
[
  { id: 'target_12m', x: -1.8, z: -12, distM: 12 },
  { id: 'target_25m', x: 0.0, z: -25, distM: 25 },
  { id: 'target_38m', x: 2.2, z: -38, distM: 38 },
].forEach((cfg) => {
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.85, 0.12), wallMat);
  stand.position.set(cfg.x, 0.925, cfg.z);
  rangeGroup.add(stand);

  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.35, 0.08), targetMatBase.clone());
  plate.position.set(cfg.x, 1.45, cfg.z + 0.08);
  plate.castShadow = true;
  plate.receiveShadow = true;
  rangeGroup.add(plate);

  const bounds = new THREE.Box3(
    new THREE.Vector3(cfg.x - 0.5, 0.75, cfg.z - 0.15),
    new THREE.Vector3(cfg.x + 0.5, 2.15, cfg.z + 0.25)
  );
  rangeTargets.push({ id: cfg.id, distM: cfg.distM, mesh: plate, bounds });
});

// Shared muzzle light pool (4 non-shadow PointLights max) + canonical tracer pool
const muzzleLightPool = new MuzzleFlashLightPool(4);
scene.add(muzzleLightPool.root);

const fxPool = new SharedWeaponFxPool(64);
scene.add(fxPool.root);

// Real FPS weapon viewmodel attached to camera (1/2/3 switching + pump animation!)
const dummyCollision: CollisionWorld = {
  resolveCircle: (x, z) => ({ hit: false, x, z, nx: 0, nz: 0 }),
  hasLineOfSight: () => true,
};

let lastRangeHitText = 'Aim & click/hold to fire | Keys 1 / 2 / 3 switch weapon | R reloads';
const fpsView = createFpsWeaponView(camera, {
  getRayTargets: (_origin, _radius): FpsRayTarget[] =>
    rangeTargets.map((t) => ({ id: t.id, kind: 'npc', agentId: t.id, bounds: t.bounds })),
  collisionWorld: dummyCollision,
  fxPool,
  onHitNpc: (agentId, damage) => {
    const tgt = rangeTargets.find((t) => t.id === agentId);
    if (tgt) {
      const m = tgt.mesh.material as THREE.MeshStandardMaterial;
      m.emissive.setHex(0x8a1c14);
      setTimeout(() => m.emissive.setHex(0x000000), 110);
      lastRangeHitText = `Hit ${tgt.distM}m target: ${damage} dmg (${fpsView.getWeaponSpec().label})`;
    }
  },
  onPlayShotSound: () => {},
});

const textures = createPreviewTextureLibrary();
const actorGroup = new THREE.Group();
scene.add(actorGroup);

// --- STATE ---
let previewMode: PreviewMode = 'arsenal';
let lightingMode: LightingMode = 'day';
let locomotionMode: LocomotionMode = 'stand';
let actors: ArmedActor[] = [];
let fpsFireHeld = false;
let fpsYaw = 0;
let fpsPitch = -0.02;
let fpsDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;

function applyLighting(mode: LightingMode): void {
  lightingMode = mode;
  if (mode === 'day') {
    scene.background = new THREE.Color(0x8e9dad);
    scene.fog = dayFog;
    hemiLight.color.setHex(0xdde8f5);
    hemiLight.groundColor.setHex(0x454a52);
    hemiLight.intensity = 1.05;
    sunLight.color.setHex(0xfff5e4);
    sunLight.intensity = 2.35;
    yardLamp.intensity = 0;
    renderer.toneMappingExposure = 1.05;
  } else {
    scene.background = new THREE.Color(0x0b0f16);
    scene.fog = nightFog;
    hemiLight.color.setHex(0x2d4363);
    hemiLight.groundColor.setHex(0x10131a);
    hemiLight.intensity = 0.28;
    sunLight.color.setHex(0x7ca2d6);
    sunLight.intensity = 0.32;
    yardLamp.intensity = 14;
    renderer.toneMappingExposure = 1.0;
  }
}

function clearActors(): void {
  for (const a of actors) {
    disposeEnemyCarbineVisual(a.weaponRig.visual);
    actorGroup.remove(a.rig.root);
  }
  actors = [];
}

function spawnActor(
  variantIdx: number,
  outfit: OutfitStyleType,
  enemyClass: EnemyWeaponClass,
  x: number,
  z: number,
  fixedState?: EnemyWeaponState
): ArmedActor {
  const rig = createRiggedHuman(variantIdx, textures, outfit, 'none');
  rig.root.position.set(x, 0, z);
  const weaponId = getEnemyWeaponIdForClass(enemyClass);
  const spec = getSharedWeaponSpec(weaponId);
  const weaponRig = attachWeaponToHumanRig(rig, enemyClass, 0.95);
  actorGroup.add(rig.root);

  return {
    rig,
    weaponRig,
    weaponId,
    fixedState,
    phase: variantIdx * 1.13,
    baseX: x,
    baseZ: z,
    burstShotsLeft: spec.sustainedFire ? spec.magazineSize : 0,
    burstShotTimer: 0,
    burstCooldown: 0.2 + (variantIdx % 4) * 0.16,
    reloadTimer: 0,
    ammoInMag: spec.magazineSize,
    walkCycle: variantIdx * 0.8,
  };
}

function rebuildScene(mode: PreviewMode): void {
  previewMode = mode;
  clearActors();
  fpsFireHeld = false;

  if (mode === 'fps') {
    controls.enabled = false;
    benchGroup.visible = false;
    backWall.visible = false;
    rangeGroup.visible = true;
    fpsYaw = 0;
    fpsPitch = -0.02;
    camera.position.set(0, 1.68, 0);
    camera.rotation.set(fpsPitch, fpsYaw, 0, 'YXZ');
    fpsView.hooks.onEnterOnFoot?.(camera.position, fpsYaw);
  } else {
    controls.enabled = true;
    backWall.visible = true;
    rangeGroup.visible = false;
    fpsView.hooks.onEnterVehicle?.();

    if (mode === 'arsenal') {
      benchGroup.visible = true;
      // All 3 enemy variations via data-driven ENEMY_CLASS_WEAPON_TABLE, firing live with red LED at fire!
      // Guard -> Service Carbine | Mob Enforcer -> Full-Auto Carbine | Heavy -> Pump Shotgun
      actors.push(spawnActor(2, 'transit_security', 'guard', -2.0, 0.0, 'fire'));
      actors.push(spawnActor(4, 'leather_biker', 'enforcer', 0.0, 0.0, 'fire'));
      actors.push(spawnActor(6, 'soviet_soldier', 'heavy', 2.0, 0.0, 'fire'));
      camera.position.set(0.2, 1.85, 5.2);
      controls.target.set(0.0, 1.25, 0.0);
    } else if (mode === 'lineup') {
      benchGroup.visible = true;
      actors.push(spawnActor(1, 'gang_2059', 'gang', -2.7, 0.0, 'patrol'));
      actors.push(spawnActor(2, 'transit_security', 'guard', -0.9, 0.0, 'aim'));
      actors.push(spawnActor(3, 'soviet_soldier', 'soldier', 0.9, 0.0, 'fire'));
      actors.push(spawnActor(4, 'leather_biker', 'enforcer', 2.7, 0.0, 'reload'));
      camera.position.set(0.0, 1.95, 6.4);
      controls.target.set(0.0, 1.25, 0.0);
    } else {
      benchGroup.visible = false;
      // 40 armed enemies distributed across ALL THREE variations via ENEMY_CLASS_WEAPON_TABLE
      const classes: EnemyWeaponClass[] = ['guard', 'enforcer', 'heavy', 'soldier', 'enforcer', 'brute'];
      const outfits: OutfitStyleType[] = [
        'transit_security',
        'leather_biker',
        'soviet_soldier',
        'gang_2059',
        'hoodie_parka',
        'leather_biker',
      ];
      let idx = 0;
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 8; c++) {
          const x = (c - 3.5) * 1.95;
          const z = (r - 2) * 2.2;
          actors.push(spawnActor(idx + 1, outfits[idx % outfits.length], classes[idx % classes.length], x, z));
          idx++;
        }
      }
      camera.position.set(0, 7.2, 14.5);
      controls.target.set(0, 1.1, 0);
    }
    controls.update();
  }
  syncUi();
}

// --- MINIMAL TACTICAL CONTROL BAR ---
const ui = document.createElement('div');
ui.className =
  'fixed top-3 left-3 right-3 pointer-events-none flex flex-wrap items-start justify-between gap-2 z-10';
ui.innerHTML = `
  <div class="pointer-events-auto bg-zinc-950/85 backdrop-blur-md border border-zinc-800 rounded-md px-3.5 py-2.5 flex flex-wrap items-center gap-2 text-xs">
    <span class="font-semibold tracking-wider uppercase text-zinc-200 mr-1">Shared Arsenal</span>
    <div class="h-4 w-px bg-zinc-800"></div>
    <button data-mode="arsenal" class="px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">3 Enemy Variations (Fire)</button>
    <button data-mode="fps" class="px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">Player View (1/2/3)</button>
    <button data-mode="lineup" class="px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">4-State Lineup</button>
    <button data-mode="crowd40" class="px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">40 Armed NPCs (All 3)</button>
    <div class="h-4 w-px bg-zinc-800"></div>
    <button data-light="day" class="px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">Day</button>
    <button data-light="night" class="px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">Night</button>
    <div class="h-4 w-px bg-zinc-800"></div>
    <button data-loco="stand" class="px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">Stand</button>
    <button data-loco="walk" class="px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">Walk</button>
    <button data-loco="run" class="px-2 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">Run</button>
  </div>
  <div id="fps-bar" class="pointer-events-auto hidden bg-zinc-950/85 backdrop-blur-md border border-zinc-800 rounded-md px-3.5 py-2.5 flex flex-wrap items-center gap-2 text-xs">
    <button data-wep="service_carbine" class="px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">[1] Carbine</button>
    <button data-wep="full_auto_carbine" class="px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">[2] Full-Auto</button>
    <button data-wep="pump_shotgun" class="px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">[3] Pump Shotgun</button>
    <button id="fps-fire-btn" class="px-2.5 py-1 rounded bg-red-700 hover:bg-red-600 text-white font-medium transition">Fire</button>
    <button id="fps-reload-btn" class="px-2.5 py-1 rounded border border-zinc-700 hover:bg-zinc-800 transition">Reload (R)</button>
    <span id="fps-ammo" class="font-mono text-zinc-200 ml-1">30/30</span>
  </div>
`;
app.appendChild(ui);

// Subtle FPS reticle (shown only in Player View)
const crosshair = document.createElement('div');
crosshair.className = 'fixed inset-0 pointer-events-none hidden items-center justify-center z-10';
crosshair.innerHTML = `<div class="w-4 h-4 relative"><div class="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-white/75"></div><div class="absolute top-1/2 left-0 right-0 h-px -translate-y-1/2 bg-white/75"></div></div>`;
app.appendChild(crosshair);

const captionBar = document.createElement('div');
captionBar.className =
  'fixed bottom-3 left-3 pointer-events-none bg-zinc-950/80 border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-300';
app.appendChild(captionBar);

const fpsBar = document.getElementById('fps-bar')!;
const fpsAmmoEl = document.getElementById('fps-ammo')!;
const fpsFireBtn = document.getElementById('fps-fire-btn')!;
const fpsReloadBtn = document.getElementById('fps-reload-btn')!;

function setActiveBtn(selector: string, attr: string, value: string): void {
  ui.querySelectorAll<HTMLButtonElement>(selector).forEach((btn) => {
    const active = btn.dataset[attr] === value;
    btn.classList.toggle('bg-zinc-200', active);
    btn.classList.toggle('text-zinc-950', active);
    btn.classList.toggle('border-zinc-200', active);
    btn.classList.toggle('font-semibold', active);
  });
}

function syncUi(): void {
  setActiveBtn('[data-mode]', 'mode', previewMode);
  setActiveBtn('[data-light]', 'light', lightingMode);
  setActiveBtn('[data-loco]', 'loco', locomotionMode);
  setActiveBtn('[data-wep]', 'wep', fpsView.getWeaponId());
  fpsBar.classList.toggle('hidden', previewMode !== 'fps');
  crosshair.classList.toggle('hidden', previewMode !== 'fps');
  crosshair.classList.toggle('flex', previewMode === 'fps');
}

ui.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => rebuildScene(btn.dataset.mode as PreviewMode));
});
ui.querySelectorAll<HTMLButtonElement>('[data-light]').forEach((btn) => {
  btn.addEventListener('click', () => {
    applyLighting(btn.dataset.light as LightingMode);
    syncUi();
  });
});
ui.querySelectorAll<HTMLButtonElement>('[data-loco]').forEach((btn) => {
  btn.addEventListener('click', () => {
    locomotionMode = btn.dataset.loco as LocomotionMode;
    syncUi();
  });
});
ui.querySelectorAll<HTMLButtonElement>('[data-wep]').forEach((btn) => {
  btn.addEventListener('click', () => {
    fpsView.selectWeapon(btn.dataset.wep as SharedWeaponId);
    syncUi();
  });
});
fpsFireBtn.addEventListener('pointerdown', () => {
  fpsFireHeld = true;
  fpsView.triggerFire();
});
window.addEventListener('pointerup', () => {
  fpsFireHeld = false;
  fpsDragging = false;
});
fpsReloadBtn.addEventListener('click', () => fpsView.triggerReload());

// Direct canvas fire/look in FPS mode + R reload + 1/2/3 UI sync
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (previewMode !== 'fps') return;
  if (e.button === 0) {
    fpsFireHeld = true;
    fpsView.triggerFire();
  }
  fpsDragging = true;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
});
window.addEventListener('pointermove', (e) => {
  if (previewMode !== 'fps' || !fpsDragging) return;
  const dx = e.clientX - lastMouseX;
  const dy = e.clientY - lastMouseY;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  fpsYaw -= dx * 0.003;
  fpsPitch = THREE.MathUtils.clamp(fpsPitch - dy * 0.003, -0.45, 0.45);
});
window.addEventListener('keydown', (e) => {
  if (previewMode !== 'fps') return;
  if (e.key === '1' || e.key === '2' || e.key === '3') {
    setTimeout(syncUi, 0);
  } else if (e.key === 'r' || e.key === 'R') {
    fpsView.triggerReload();
  } else if (e.code === 'Space') {
    fpsFireHeld = true;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') fpsFireHeld = false;
});

// Zero-GC scratch vectors for firing
const _shotOrigin = new THREE.Vector3();
const _shotMuzzle = new THREE.Vector3();
const _shotDir = new THREE.Vector3(0, 0, 1);

const clock = new THREE.Clock();
let elapsed = 0;
let frameSmoothedMs = 0;

applyLighting('day');
rebuildScene('arsenal');

function stepActorFireLogic(a: ArmedActor, dt: number, wantFire: boolean): { fired: boolean; reloading: boolean; reloadProgress?: number } {
  const spec = getSharedWeaponSpec(a.weaponId);
  if (a.reloadTimer > 0) {
    a.reloadTimer = Math.max(0, a.reloadTimer - dt);
    const prog = 1.0 - a.reloadTimer / spec.reloadSec;
    if (a.reloadTimer === 0) {
      a.ammoInMag = spec.magazineSize;
    }
    return { fired: false, reloading: true, reloadProgress: prog };
  }
  if (!wantFire) return { fired: false, reloading: false };

  if (a.ammoInMag <= 0) {
    a.reloadTimer = spec.reloadSec;
    a.burstShotsLeft = 0;
    return { fired: false, reloading: true, reloadProgress: 0 };
  }

  if (spec.sustainedFire && a.burstShotsLeft <= 0) {
    a.burstShotsLeft = a.ammoInMag;
    a.burstCooldown = 0;
  }

  let fired = false;
  if (a.burstShotsLeft > 0) {
    a.burstShotTimer -= dt;
    if (a.burstShotTimer <= 0) {
      a.burstShotsLeft--;
      a.burstShotTimer = 1 / spec.fireRateHz;
      a.ammoInMag = Math.max(0, a.ammoInMag - 1);
      fired = true;
      if (a.ammoInMag <= 0) {
        a.reloadTimer = spec.reloadSec;
        a.burstShotsLeft = 0;
      }
    }
  } else {
    a.burstCooldown -= dt;
    if (a.burstCooldown <= 0) {
      a.burstShotsLeft = Math.max(1, spec.burstCount);
      a.burstShotTimer = 0;
      a.burstCooldown = spec.pumpCycleSec > 0 ? spec.pumpCycleSec : spec.burstCooldownSec;
    }
  }
  return { fired, reloading: false };
}

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, Math.max(0.001, clock.getDelta()));
  elapsed += dt;

  const tStart = performance.now();
  muzzleLightPool.update(dt);
  fxPool.update(dt);

  if (previewMode === 'fps') {
    camera.rotation.set(fpsPitch, fpsYaw, 0, 'YXZ');
    const walkKmh = locomotionMode === 'run' ? 16 : locomotionMode === 'walk' ? 6 : 0;
    if (fpsFireHeld) {
      fpsView.triggerFire();
    }
    fpsView.update(dt, elapsed, camera, walkKmh);
    const ammo = fpsView.getAmmoState();
    const spec = fpsView.getWeaponSpec();
    fpsAmmoEl.textContent = ammo.reloading
      ? `RELOADING (${spec.reloadSec}s)`
      : `${ammo.ammoInMag}/${ammo.magazineSize} • ${spec.fireRateHz}Hz`;
    captionBar.textContent = `${spec.label} (${spec.pellets > 1 ? `${spec.pellets}x${spec.damage}` : `${spec.damage}`} dmg${spec.falloffStartM > 0 ? `, falloff >${spec.falloffStartM}m` : ''}) — ${lastRangeHitText}`;
  } else {
    const isMoving = locomotionMode !== 'stand';
    const moveSpeedNorm = locomotionMode === 'run' ? 1.0 : locomotionMode === 'walk' ? 0.55 : 0.0;
    const walkStepRate = locomotionMode === 'run' ? 11.5 : 6.4;

    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (isMoving) a.walkCycle += dt * walkStepRate;

      applyHumanPose(a.rig, {
        mode: isMoving ? 'walking' : 'standing_idle',
        elapsed,
        phase: a.phase,
        walkCycle: a.walkCycle,
        windStrength: 0.35,
      });

      const spec = getSharedWeaponSpec(a.weaponId);
      let state: EnemyWeaponState = a.fixedState ?? 'patrol';
      let detectionRamp = 0;
      let reloadProgress: number | undefined;
      let firedThisFrame = false;

      if (previewMode === 'arsenal') {
        const res = stepActorFireLogic(a, dt, true);
        firedThisFrame = res.fired;
        if (res.reloading) {
          state = 'reload';
          reloadProgress = res.reloadProgress;
          detectionRamp = 0.2;
        } else {
          state = 'fire';
          detectionRamp = 1.0;
        }
      } else if (previewMode === 'lineup' && a.fixedState) {
        if (a.fixedState === 'patrol') {
          detectionRamp = 0.0;
        } else if (a.fixedState === 'aim') {
          detectionRamp = 0.78 + Math.sin(elapsed * 1.4) * 0.14;
        } else if (a.fixedState === 'fire') {
          detectionRamp = 1.0;
          const res = stepActorFireLogic(a, dt, true);
          firedThisFrame = res.fired;
          if (res.reloading) {
            a.ammoInMag = spec.magazineSize;
            a.reloadTimer = 0;
          }
        } else if (a.fixedState === 'reload') {
          detectionRamp = 0.12;
          reloadProgress = (elapsed % spec.reloadSec) / spec.reloadSec;
        }
      } else {
        // 40-NPC crowd across all 3 weapon variations
        const cycle = (elapsed + a.phase * 0.9) % 7.5;
        if (cycle < 1.2) {
          state = 'patrol';
          detectionRamp = 0;
        } else if (cycle < 2.2) {
          state = 'aim';
          detectionRamp = 0.78;
        } else if (cycle < 4.4) {
          const res = stepActorFireLogic(a, dt, true);
          firedThisFrame = res.fired;
          state = res.reloading ? 'reload' : 'fire';
          reloadProgress = res.reloadProgress;
          detectionRamp = res.reloading ? 0.14 : 1.0;
        } else if (cycle < 5.7) {
          state = 'low_ready';
          detectionRamp = 0.2;
        } else {
          state = 'reload';
          detectionRamp = 0.12;
          reloadProgress = Math.min(1, (cycle - 5.7) / spec.reloadSec);
        }
      }

      applyWeaponHoldPose(a.rig, a.weaponRig, {
        dt,
        elapsed,
        phase: a.phase,
        state,
        detectionRamp,
        moveSpeedNorm,
        reloadProgress,
        firedThisFrame,
        lightPool: muzzleLightPool,
      });

      if (firedThisFrame) {
        getNpcWeaponMuzzleWorld(a.weaponRig, _shotMuzzle);
        _shotOrigin.set(a.baseX, 1.44, a.baseZ);
        _shotDir.set(0, 0, 1);
        fireSharedWeapon({
          origin: _shotOrigin,
          muzzleWorld: _shotMuzzle,
          dir: _shotDir,
          shooterKind: 'gang',
          shooterId: `preview_enemy_${i}`,
          spreadRad: spec.npcSpreadRad,
          rayTargets: [],
          fxPool,
          weaponId: a.weaponId,
        });
      }
    }

    const updateMs = performance.now() - tStart;
    frameSmoothedMs = frameSmoothedMs === 0 ? updateMs : frameSmoothedMs * 0.92 + updateMs * 0.08;

    if (previewMode === 'arsenal') {
      captionBar.textContent =
        'Left -> Right: Player 3-Weapon Rack (bench, untouched) | Guard: Carbine (3-rd burst) | Mob Enforcer: Full-Auto (11Hz sustained, 40-rd) | Heavy: Pump Shotgun (8x9 pellets, 0.9Hz pump)';
    } else if (previewMode === 'crowd40') {
      captionBar.textContent = `40 Armed NPCs across all 3 variations (Carbine + Full-Auto + Pump Shotgun) — update: ${frameSmoothedMs.toFixed(2)} ms/frame | Pooled flash lights: 4`;
    } else {
      captionBar.textContent =
        '4-State Lineup: Patrol (1-hand, dark LED) | Aim (2-hand, red LED) | Fire (muzzle flash + light spill) | Reload';
    }
    controls.update();
  }

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();
