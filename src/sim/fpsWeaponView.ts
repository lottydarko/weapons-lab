import * as THREE from 'three';
import { FPS_EYE_HEIGHT_M, FpsBridgeHooks, FpsRayTarget, TrainFrame } from './fpsBridge';
import {
  createSharedWeaponMesh,
  fireSharedWeapon,
  getSharedWeaponSpec,
  SHARED_WEAPON_IDS,
  SHARED_WEAPON_SPECS,
  SharedWeaponFxPool,
  type SharedWeaponId,
  type SharedWeaponSpec,
} from './sharedWeapon';
import { CollisionWorld, getDistrictAt } from './mapData';

export interface FpsWeaponViewCallbacks {
  getRayTargets: (origin: THREE.Vector3, radiusM: number) => FpsRayTarget[];
  collisionWorld: CollisionWorld;
  fxPool: SharedWeaponFxPool;
  onHitNpc: (agentId: string, damage: number, shooterPos: THREE.Vector3) => void;
  onPlayShotSound: () => void;
}

export interface FpsWeaponViewHandles {
  hooks: FpsBridgeHooks;
  isDrawn: () => boolean;
  isActive: () => boolean;
  toggleDraw: () => boolean;
  selectWeapon: (weaponId: SharedWeaponId) => SharedWeaponId;
  getWeaponId: () => SharedWeaponId;
  getWeaponSpec: () => SharedWeaponSpec;
  getAmmoState: () => { ammoInMag: number; magazineSize: number; reloading: boolean };
  triggerFire: () => boolean;
  triggerReload: () => void;
  update: (
    dt: number,
    elapsed: number,
    camera: THREE.PerspectiveCamera,
    walkSpeedKmh: number
  ) => void;
  dispose: () => void;
}

interface WeaponSlotView {
  id: SharedWeaponId;
  mesh: THREE.Group;
  muzzleObj: THREE.Object3D;
  pumpForend: THREE.Object3D | null;
  pumpForendRestZ: number;
}

/**
 * First-person weapons viewmodel + shared arsenal firing controller
 * (1 = Service Carbine, 2 = Full-Auto Carbine, 3 = Pump Shotgun)
 * wired strictly through FpsBridgeHooks (active on foot & in train, hidden in car).
 */
export function createFpsWeaponView(
  camera: THREE.PerspectiveCamera,
  callbacks: FpsWeaponViewCallbacks
): FpsWeaponViewHandles {
  const viewRoot = new THREE.Group();
  viewRoot.name = 'FpsWeaponViewRoot';
  viewRoot.visible = false;
  camera.add(viewRoot);

  const weaponPivot = new THREE.Group();
  weaponPivot.position.set(0.21, -0.20, -0.42);
  viewRoot.add(weaponPivot);

  // Build all 3 canonical player weapon meshes from sharedWeapon.ts (player materials untouched!)
  const slots: Record<SharedWeaponId, WeaponSlotView> = {} as Record<SharedWeaponId, WeaponSlotView>;
  const ammoByWeapon: Record<SharedWeaponId, number> = {
    service_carbine: SHARED_WEAPON_SPECS.service_carbine.magazineSize,
    full_auto_carbine: SHARED_WEAPON_SPECS.full_auto_carbine.magazineSize,
    pump_shotgun: SHARED_WEAPON_SPECS.pump_shotgun.magazineSize,
  };

  for (const id of SHARED_WEAPON_IDS) {
    const mesh = createSharedWeaponMesh(0.86, id);
    // Rotate +Z weapon forward so it points along -Z camera forward
    mesh.rotation.y = Math.PI;
    mesh.visible = id === 'service_carbine';
    weaponPivot.add(mesh);

    const muzzleObj = mesh.getObjectByName('MuzzleAnchor') ?? mesh;
    const pumpForend = mesh.getObjectByName('PumpForend') ?? null;
    slots[id] = {
      id,
      mesh,
      muzzleObj,
      pumpForend,
      pumpForendRestZ: pumpForend ? pumpForend.position.z : 0.31,
    };
  }

  // First-person gloved hands & tactical sleeves gripping the equipped weapon
  const sleeveMat = new THREE.MeshStandardMaterial({
    color: '#1e242d',
    emissive: '#0c1118',
    emissiveIntensity: 0.35,
    roughness: 0.72,
    metalness: 0.1,
  });
  const gloveMat = new THREE.MeshStandardMaterial({
    color: '#161b22',
    emissive: '#0a0f16',
    emissiveIntensity: 0.3,
    roughness: 0.52,
    metalness: 0.16,
  });
  const knuckleMat = new THREE.MeshStandardMaterial({
    color: '#2d343e',
    emissive: '#0f1620',
    emissiveIntensity: 0.25,
    roughness: 0.4,
    metalness: 0.32,
  });

  // Right grip hand + forearm
  const rightArm = new THREE.Group();
  const rForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.044, 0.34, 10), sleeveMat);
  rForearm.rotation.x = Math.PI * 0.46;
  rForearm.rotation.z = -0.16;
  rForearm.position.set(0.045, -0.095, 0.18);
  rightArm.add(rForearm);

  const rPalm = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.068, 0.062), gloveMat);
  rPalm.position.set(0.004, -0.038, 0.012);
  rPalm.rotation.x = 0.24;
  rightArm.add(rPalm);

  const rKnuckle = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.018, 0.022), knuckleMat);
  rKnuckle.position.set(0.004, -0.014, -0.012);
  rightArm.add(rKnuckle);
  weaponPivot.add(rightArm);

  // Left support hand + forearm cupping the carbine handguard / shotgun pump forend
  const leftArm = new THREE.Group();
  const lForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.043, 0.38, 10), sleeveMat);
  lForearm.rotation.x = Math.PI * 0.41;
  lForearm.rotation.z = 0.42;
  lForearm.rotation.y = 0.36;
  lForearm.position.set(-0.145, -0.105, -0.035);
  leftArm.add(lForearm);

  const lPalm = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.052, 0.072), gloveMat);
  lPalm.position.set(-0.012, -0.012, -0.235);
  lPalm.rotation.z = 0.28;
  leftArm.add(lPalm);

  const lKnuckle = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.016, 0.024), knuckleMat);
  lKnuckle.position.set(-0.024, -0.028, -0.235);
  leftArm.add(lKnuckle);
  weaponPivot.add(leftArm);

  // State
  let currentWeaponId: SharedWeaponId = 'service_carbine';
  let active = false;
  let mode: 'driving' | 'onFoot' | 'train' = 'driving';
  let drawn = true;
  let drawFrac = 0; // 0 = holstered, 1 = ready
  let recoilKick = 0;
  let fireCooldown = 0;
  let pumpTimer = 0;
  let lastShotAtMs = -Infinity;
  let reloadTimer = 0;
  let swayPhase = 0;
  let trainSpeedMps = 0;
  let trainYawRate = 0;
  let trainSeated = false;

  const _rayDir = new THREE.Vector3();
  const _muzzleWorld = new THREE.Vector3();

  const selectWeapon = (weaponId: SharedWeaponId): SharedWeaponId => {
    if (!slots[weaponId]) return currentWeaponId;
    if (weaponId === currentWeaponId) return currentWeaponId;

    // Reset previous slot's pump forend to rest before hiding
    const prevSlot = slots[currentWeaponId];
    if (prevSlot.pumpForend) {
      prevSlot.pumpForend.position.z = prevSlot.pumpForendRestZ;
    }
    prevSlot.mesh.visible = false;

    currentWeaponId = weaponId;
    slots[currentWeaponId].mesh.visible = true;
    reloadTimer = 0;
    pumpTimer = 0;
    fireCooldown = 0.14;
    recoilKick = 0;
    drawn = true;
    drawFrac = Math.min(drawFrac, 0.12);
    return currentWeaponId;
  };

  // Direct 1 / 2 / 3 weapon switching (no inventory UI or system)
  const onKeyDown = (e: KeyboardEvent) => {
    if (!active) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === '1') selectWeapon('service_carbine');
    else if (e.key === '2') selectWeapon('full_auto_carbine');
    else if (e.key === '3') selectWeapon('pump_shotgun');
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
  }

  const hooks: FpsBridgeHooks = {
    onEnterOnFoot: (_spawnPos: THREE.Vector3, _yaw: number) => {
      mode = 'onFoot';
      active = true;
      drawn = true;
      drawFrac = 0.15;
      trainSpeedMps = 0;
      trainYawRate = 0;
      trainSeated = false;
      viewRoot.visible = true;
      // Contract eye height verified in DrivingEngine (FPS_EYE_HEIGHT_M = 1.68)
      void FPS_EYE_HEIGHT_M;
    },
    onEnterTrain: (frame: TrainFrame) => {
      mode = 'train';
      active = true;
      drawn = true;
      drawFrac = 0.15;
      trainSpeedMps = frame.velocity.length();
      trainYawRate = frame.yawDeltaPerSec;
      trainSeated = frame.seated;
      viewRoot.visible = true;
    },
    updateTrainFrame: (frame: TrainFrame) => {
      if (mode !== 'train') return;
      trainSpeedMps = frame.velocity.length();
      trainYawRate = frame.yawDeltaPerSec;
      trainSeated = frame.seated;
    },
    onEnterVehicle: () => {
      mode = 'driving';
      active = false;
      drawFrac = 0;
      recoilKick = 0;
      pumpTimer = 0;
      viewRoot.visible = false;
    },
    getRayTargets: callbacks.getRayTargets,
  };

  const toggleDraw = (): boolean => {
    if (!active) return false;
    drawn = !drawn;
    return drawn;
  };

  const triggerReload = () => {
    const spec = getSharedWeaponSpec(currentWeaponId);
    if (!active || !drawn || reloadTimer > 0) return;
    if (ammoByWeapon[currentWeaponId] >= spec.magazineSize) return;
    reloadTimer = spec.reloadSec;
    pumpTimer = 0;
  };

  const triggerFire = (): boolean => {
    const spec = getSharedWeaponSpec(currentWeaponId);
    if (!active || !drawn || drawFrac < 0.72 || reloadTimer > 0 || fireCooldown > 0) {
      return false;
    }
    // Wall-clock rate gate: no input path (click, hold, gamepad, duplicate
    // handler) can ever stack two shots inside one fire interval.
    const nowMs = performance.now();
    if (nowMs - lastShotAtMs < 1000 / spec.fireRateHz) {
      return false;
    }
    if (ammoByWeapon[currentWeaponId] <= 0) {
      triggerReload();
      return false;
    }

    ammoByWeapon[currentWeaponId]--;
    lastShotAtMs = nowMs;
    fireCooldown = 1 / spec.fireRateHz;

    if (currentWeaponId === 'pump_shotgun') {
      recoilKick = Math.min(1.45, recoilKick + 1.25);
      pumpTimer = spec.pumpCycleSec;
    } else if (currentWeaponId === 'full_auto_carbine') {
      recoilKick = Math.min(0.95, recoilKick + 0.44);
    } else {
      recoilKick = Math.min(1.0, recoilKick + 0.65);
    }

    const activeSlot = slots[currentWeaponId];
    camera.getWorldDirection(_rayDir);
    activeSlot.muzzleObj.getWorldPosition(_muzzleWorld);
    if (
      !Number.isFinite(_muzzleWorld.x + _muzzleWorld.y + _muzzleWorld.z) ||
      _muzzleWorld.distanceToSquared(camera.position) > 9
    ) {
      _muzzleWorld.copy(camera.position).addScaledVector(_rayDir, 0.45);
      _muzzleWorld.y -= 0.12;
    }

    const targets = hooks.getRayTargets(camera.position, spec.rangeM);
    const distTag = getDistrictAt(camera.position.x, camera.position.z).slice(0, 3).trim();

    const hit = fireSharedWeapon({
      origin: camera.position.clone(),
      muzzleWorld: _muzzleWorld.clone(),
      dir: _rayDir,
      shooterKind: 'player',
      shooterId: 'player',
      spreadRad: spec.playerSpreadRad,
      rayTargets: targets,
      collisionWorld: callbacks.collisionWorld,
      fxPool: callbacks.fxPool,
      districtId: distTag,
      onSound: () => callbacks.onPlayShotSound(),
      listenerPos: camera.position,
      weaponId: currentWeaponId,
    });

    if (hit.hits && hit.hits.length > 0) {
      for (let i = 0; i < hit.hits.length; i++) {
        const ph = hit.hits[i];
        if (ph.kind === 'npc' && ph.agentId) {
          callbacks.onHitNpc(ph.agentId, ph.damage, camera.position);
        }
      }
    } else if (hit.hit && hit.kind === 'npc' && hit.agentId) {
      callbacks.onHitNpc(hit.agentId, hit.damage, camera.position);
    }

    if (ammoByWeapon[currentWeaponId] <= 0) {
      reloadTimer = spec.reloadSec;
      pumpTimer = 0;
    }
    return true;
  };

  const update = (
    dt: number,
    elapsed: number,
    _camera: THREE.PerspectiveCamera,
    walkSpeedKmh: number
  ) => {
    if (!active) {
      viewRoot.visible = false;
      return;
    }

    const spec = getSharedWeaponSpec(currentWeaponId);
    const activeSlot = slots[currentWeaponId];

    fireCooldown = Math.max(0, fireCooldown - dt);
    if (pumpTimer > 0) {
      pumpTimer = Math.max(0, pumpTimer - dt);
    }
    if (reloadTimer > 0) {
      reloadTimer = Math.max(0, reloadTimer - dt);
      if (reloadTimer === 0) {
        ammoByWeapon[currentWeaponId] = spec.magazineSize;
      }
    }

    const targetDraw = drawn ? 1.0 : 0.0;
    const drawRate = drawn ? 6.5 : 8.0;
    drawFrac = THREE.MathUtils.damp(drawFrac, targetDraw, drawRate, dt);
    recoilKick = THREE.MathUtils.damp(
      recoilKick,
      0,
      currentWeaponId === 'pump_shotgun' ? 9.5 : 14.0,
      dt
    );

    viewRoot.visible = drawFrac > 0.02;
    if (!viewRoot.visible) return;

    const walkNorm = mode === 'onFoot' ? Math.min(1, walkSpeedKmh / 18) : 0;
    const trainNorm = mode === 'train' ? Math.min(1, trainSpeedMps / 22) : 0;
    swayPhase += dt * (2.2 + walkNorm * 8.5 + trainNorm * 3.8);

    const bobX = Math.cos(swayPhase * 0.5) * (0.002 + walkNorm * 0.011);
    const bobY = Math.abs(Math.sin(swayPhase)) * -(0.002 + walkNorm * 0.012);
    const trainSwayX =
      mode === 'train'
        ? THREE.MathUtils.clamp(-trainYawRate * 0.04, -0.025, 0.025) +
          Math.sin(elapsed * 4.2) * 0.003 * trainNorm
        : 0;
    const reloadU = reloadTimer > 0 ? 1 - reloadTimer / spec.reloadSec : 0;
    const reloadDip = reloadTimer > 0 ? Math.sin(reloadU * Math.PI) * 0.12 : 0;
    const holsterDrop = (1 - drawFrac) * 0.34;
    const seatedOffsetY = trainSeated ? -0.015 : 0;

    // Pump shotgun forend + support hand stroke coupled cleanly to the 0.9 Hz shot cycle
    // (also performs a crisp final rack at the end of a 3.2s shell reload!)
    let pumpStroke = 0; // 0 = forward locked, 1 = pulled fully rearward
    let pumpTilt = 0;
    if (currentWeaponId === 'pump_shotgun') {
      if (pumpTimer > 0 && spec.pumpCycleSec > 0) {
        const u = 1.0 - pumpTimer / spec.pumpCycleSec; // 0..1 across shot cycle
        if (u > 0.16 && u < 0.78) {
          const p = (u - 0.16) / 0.62;
          // Crisp pull back (0..0.46) -> quick pause -> slam forward (0.56..1.0)
          pumpStroke = p < 0.5 ? Math.sin(p * Math.PI) : Math.sin(p * Math.PI);
          pumpTilt = Math.sin(p * Math.PI);
        }
      } else if (reloadTimer > 0 && reloadU > 0.78 && reloadU < 0.96) {
        const p = (reloadU - 0.78) / 0.18;
        pumpStroke = Math.sin(p * Math.PI);
        pumpTilt = pumpStroke * 0.8;
      }

      if (activeSlot.pumpForend) {
        activeSlot.pumpForend.position.z = activeSlot.pumpForendRestZ - pumpStroke * 0.098;
      }
      // Left hand sits slightly farther forward on the shotgun pump and slides back with it
      leftArm.position.set(0, -0.008, -0.022 + pumpStroke * 0.084);
    } else {
      leftArm.position.set(0, 0, 0);
    }

    const recoilPitch =
      currentWeaponId === 'pump_shotgun' ? recoilKick * 0.145 : recoilKick * 0.085;
    const recoilBack =
      currentWeaponId === 'pump_shotgun' ? recoilKick * 0.072 : recoilKick * 0.048;

    weaponPivot.position.set(
      0.205 + bobX + trainSwayX - pumpTilt * 0.012,
      -0.195 + bobY - holsterDrop - reloadDip + seatedOffsetY + recoilKick * 0.014 - pumpTilt * 0.01,
      -0.41 + recoilBack + pumpStroke * 0.014
    );
    weaponPivot.rotation.set(
      recoilPitch - (1 - drawFrac) * 0.58 - reloadDip * 1.4 + pumpTilt * 0.065,
      trainSwayX * 0.65 - pumpTilt * 0.04,
      -recoilKick * 0.035 - (1 - drawFrac) * 0.24 + pumpTilt * 0.16
    );
  };

  return {
    hooks,
    isDrawn: () => drawn && active,
    isActive: () => active,
    toggleDraw,
    selectWeapon,
    getWeaponId: () => currentWeaponId,
    getWeaponSpec: () => getSharedWeaponSpec(currentWeaponId),
    getAmmoState: () => ({
      ammoInMag: ammoByWeapon[currentWeaponId],
      magazineSize: getSharedWeaponSpec(currentWeaponId).magazineSize,
      reloading: reloadTimer > 0,
    }),
    triggerFire,
    triggerReload,
    update,
    dispose: () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onKeyDown);
      }
      camera.remove(viewRoot);
    },
  };
}
