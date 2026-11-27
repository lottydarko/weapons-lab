import * as THREE from 'three';
import { FPS_EYE_HEIGHT_M, FpsBridgeHooks, FpsRayTarget, TrainFrame } from './fpsBridge';
import {
  createSharedWeaponMesh,
  fireSharedWeapon,
  SHARED_WEAPON_SPEC,
  SharedWeaponFxPool,
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

/**
 * First-person weapons viewmodel + shared weapon firing controller
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

  // Shared weapon mesh (identical definition to gang/enemy weapon)
  const weaponMesh = createSharedWeaponMesh(0.86);
  // Rotate +Z weapon forward so it points along -Z camera forward
  weaponMesh.rotation.y = Math.PI;
  weaponPivot.add(weaponMesh);

  // First-person gloved hands & tactical sleeves gripping the shared carbine
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

  // Left support hand + forearm cupping the carbine handguard
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

  const muzzleObj = weaponMesh.getObjectByName('MuzzleAnchor') ?? weaponMesh;

  // State
  let active = false;
  let mode: 'driving' | 'onFoot' | 'train' = 'driving';
  let drawn = true;
  let drawFrac = 0; // 0 = holstered, 1 = ready
  let recoilKick = 0;
  let fireCooldown = 0;
  let lastShotAtMs = -Infinity;
  let ammoInMag = SHARED_WEAPON_SPEC.magazineSize;
  let reloadTimer = 0;
  let swayPhase = 0;
  let trainSpeedMps = 0;
  let trainYawRate = 0;
  let trainSeated = false;

  const _rayDir = new THREE.Vector3();
  const _muzzleWorld = new THREE.Vector3();

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
    if (!active || !drawn || reloadTimer > 0) return;
    if (ammoInMag >= SHARED_WEAPON_SPEC.magazineSize) return;
    reloadTimer = SHARED_WEAPON_SPEC.reloadSec;
  };

  const triggerFire = (): boolean => {
    if (!active || !drawn || drawFrac < 0.72 || reloadTimer > 0 || fireCooldown > 0) {
      return false;
    }
    // Wall-clock rate gate: no input path (click, hold, gamepad, duplicate
    // handler) can ever stack two shots inside one fire interval — one press
    // is one shot, holding is a steady stream at the rated fire rate.
    const nowMs = performance.now();
    if (nowMs - lastShotAtMs < 1000 / SHARED_WEAPON_SPEC.fireRateHz) {
      return false;
    }
    if (ammoInMag <= 0) {
      triggerReload();
      return false;
    }

    ammoInMag--;
    lastShotAtMs = nowMs;
    fireCooldown = 1 / SHARED_WEAPON_SPEC.fireRateHz;
    recoilKick = Math.min(1.0, recoilKick + 0.65);

    camera.getWorldDirection(_rayDir);
    muzzleObj.getWorldPosition(_muzzleWorld);
    if (
      !Number.isFinite(_muzzleWorld.x + _muzzleWorld.y + _muzzleWorld.z) ||
      _muzzleWorld.distanceToSquared(camera.position) > 9
    ) {
      // Muzzle node's world matrix was stale (mode switch / pre-render frame):
      // anchor the tracer to the eye so a shot can never appear to come from
      // the sky or from world origin.
      _muzzleWorld.copy(camera.position).addScaledVector(_rayDir, 0.45);
      _muzzleWorld.y -= 0.12;
    }

    const targets = hooks.getRayTargets(camera.position, SHARED_WEAPON_SPEC.rangeM);
    const distTag = getDistrictAt(camera.position.x, camera.position.z).slice(0, 3).trim();

    const hit = fireSharedWeapon({
      origin: camera.position.clone(),
      muzzleWorld: _muzzleWorld.clone(),
      dir: _rayDir,
      shooterKind: 'player',
      shooterId: 'player',
      spreadRad: SHARED_WEAPON_SPEC.playerSpreadRad,
      rayTargets: targets,
      collisionWorld: callbacks.collisionWorld,
      fxPool: callbacks.fxPool,
      districtId: distTag,
      onSound: () => callbacks.onPlayShotSound(),
      listenerPos: camera.position,
    });

    if (hit.hit && hit.kind === 'npc' && hit.agentId) {
      callbacks.onHitNpc(hit.agentId, hit.damage, camera.position);
    }

    if (ammoInMag <= 0) {
      reloadTimer = SHARED_WEAPON_SPEC.reloadSec;
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

    fireCooldown = Math.max(0, fireCooldown - dt);
    if (reloadTimer > 0) {
      reloadTimer = Math.max(0, reloadTimer - dt);
      if (reloadTimer === 0) {
        ammoInMag = SHARED_WEAPON_SPEC.magazineSize;
      }
    }

    const targetDraw = drawn ? 1.0 : 0.0;
    const drawRate = drawn ? 6.5 : 8.0;
    drawFrac = THREE.MathUtils.damp(drawFrac, targetDraw, drawRate, dt);
    recoilKick = THREE.MathUtils.damp(recoilKick, 0, 14.0, dt);

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
    const reloadDip = reloadTimer > 0 ? Math.sin((reloadTimer / SHARED_WEAPON_SPEC.reloadSec) * Math.PI) * 0.12 : 0;
    const holsterDrop = (1 - drawFrac) * 0.34;
    const seatedOffsetY = trainSeated ? -0.015 : 0;

    weaponPivot.position.set(
      0.205 + bobX + trainSwayX,
      -0.195 + bobY - holsterDrop - reloadDip + seatedOffsetY + recoilKick * 0.012,
      -0.41 + recoilKick * 0.048
    );
    weaponPivot.rotation.set(
      recoilKick * 0.085 - (1 - drawFrac) * 0.58 - reloadDip * 1.4,
      trainSwayX * 0.65,
      -recoilKick * 0.035 - (1 - drawFrac) * 0.24
    );
  };

  return {
    hooks,
    isDrawn: () => drawn && active,
    isActive: () => active,
    toggleDraw,
    triggerFire,
    triggerReload,
    update,
    dispose: () => {
      camera.remove(viewRoot);
    },
  };
}
