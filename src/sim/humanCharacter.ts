import * as THREE from 'three';
import { TextureLibrary } from './textures';
import {
  createSharedWeaponMesh,
  getSharedWeaponSpec,
  SHARED_WEAPON_SPEC,
  type SharedWeaponId,
} from './sharedWeapon';

export type HumanBuildType = 'athletic_male' | 'slender_female' | 'stocky_heavy' | 'tall_lean';
export type HairStyleType =
  | 'short_cropped'
  | 'long_flowing'
  | 'bob_cut'
  | 'ponytail'
  | 'knit_beanie'
  | 'newsboy_cap'
  | 'side_part';

export type OutfitStyleType =
  // Varied Civilian Jackets & Streetwear
  | 'trench_coat'
  | 'puffer_jacket'
  | 'leather_biker'
  | 'hoodie_parka'
  | 'tailored_blazer'
  | 'cardigan_scarf'
  // Distinct Transit & Civic Uniforms
  | 'metro_worker'
  | 'transit_security'
  | 'rail_engineer'
  // Grand Archipelago Factions & Station Staff (reusing exact same HumanRig!)
  | 'soviet_soldier'
  | 'pow_prisoner'
  | 'station_barista'
  | 'gang_2059';

export type CommuterActivityType = 'none' | 'newspaper' | 'phone' | 'cigarette';

export interface HumanPoseParams {
  mode: 'seated' | 'standing_strap' | 'standing_idle' | 'walking' | 'worker_desk' | 'worker_guide';
  elapsed: number;
  phase: number;
  walkCycle?: number;
  railSway?: number;
  windStrength?: number; // 0.0 (still) .. 1.0+ (rainy outdoor gust)
  variantStyle?: number;
  // Optional exact overhead strap handle target in rig.root local space (pre-heightScale, meters)
  strapTargetLocal?: { x: number; y: number; z: number };
  // Spec 1: Polite aisle/queue passing & upset reaction overlays
  sidestepYaw?: number;
  nodPitch?: number;
  upsetProgress?: number; // 0..1 envelope
  upsetLookYaw?: number; // relative yaw toward bumper (rad)
}

export interface HumanRig {
  root: THREE.Group;
  pelvis: THREE.Bone;
  spine: THREE.Bone;
  chest: THREE.Bone;
  neck: THREE.Group;
  head: THREE.Group;
  leftShoulder: THREE.Bone;
  leftElbow: THREE.Bone;
  leftHandGrp: THREE.Group;
  leftHandNormalMesh: THREE.Group;
  leftHandStrapMesh: THREE.Group;
  rightShoulder: THREE.Bone;
  rightElbow: THREE.Bone;
  rightHandGrp: THREE.Group;
  rightHandNormalMesh: THREE.Group;
  rightHandStrapMesh: THREE.Group;
  leftHip: THREE.Bone;
  leftKnee: THREE.Bone;
  leftAnkle: THREE.Group;
  rightHip: THREE.Bone;
  rightKnee: THREE.Bone;
  rightAnkle: THREE.Group;
  // Wind-driven secondary cloth & hair bones
  coatTailBone: THREE.Bone;
  scarfTailBone: THREE.Group | null;
  scarfSideTailBone: THREE.Group | null;
  hairTailBone: THREE.Group | null;
  jacketFlapLeft: THREE.Group | null;
  jacketFlapRight: THREE.Group | null;
  // Articulated 3D eyes, eyelids & brows for natural blinking, saccades & micro-expressions
  eyelidLeft: THREE.Object3D;
  eyelidRight: THREE.Object3D;
  eyeballLeft: THREE.Object3D;
  eyeballRight: THREE.Object3D;
  browLeft: THREE.Object3D;
  browRight: THREE.Object3D;
  // Per-rig GPU wind cloth shader uniform (smoothly matches indoor cabin vs outdoor gusts!)
  windUniform: { value: number };
  // Lifelike commuter activity props (newspaper, glowing phone, strictly ONE cigarette + ember + rising smoke + ambient haze!)
  activity: CommuterActivityType;
  newspaperProp: THREE.Group | null;
  phoneProp: THREE.Group | null;
  cigaretteProp: THREE.Group | null;
  cigEmberMat: THREE.MeshStandardMaterial | null;
  smokePuffs: THREE.Sprite[];
  ambientSmokeClouds: THREE.Sprite[];
  build: HumanBuildType;
  outfit: OutfitStyleType;
  heightScale: number;
  standingPelvisY: number;
  seatedPelvisY: number;
}

// Soft billowing wispy tobacco smoke cloud texture (cached ONCE globally — zero per-rig allocations!)
let _sharedSmokeCloudTex: THREE.CanvasTexture | null = null;
function getSmokeCloudTexture(): THREE.CanvasTexture {
  if (_sharedSmokeCloudTex) return _sharedSmokeCloudTex;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  // Multi-lobe organic billowing smoke puffs with ultra-soft feathered falloff (never streaks or hard circles!)
  const lobes: [number, number, number, number][] = [
    [64, 64, 52, 0.34],
    [48, 56, 36, 0.24],
    [80, 60, 34, 0.22],
    [60, 44, 32, 0.20],
    [68, 78, 34, 0.18],
    [42, 72, 26, 0.14],
  ];
  for (const [lx, ly, r, a] of lobes) {
    const g = ctx.createRadialGradient(lx, ly, 2, lx, ly, r);
    g.addColorStop(0, `rgba(218, 226, 236, ${a})`);
    g.addColorStop(0.45, `rgba(196, 208, 222, ${a * 0.58})`);
    g.addColorStop(0.78, `rgba(176, 190, 208, ${a * 0.16})`);
    g.addColorStop(1, 'rgba(170, 185, 205, 0.0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(lx, ly, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _sharedSmokeCloudTex = tex;
  return tex;
}

// =========================================================================
// SHARED GPU WIND CLOTH SHADER (PBR-preserving travelling wind waves!)
// Runs on BOTH SkinnedMesh (metro/station humans) AND InstancedMesh (314 street pedestrians!)
// Uses customProgramCacheKey so WebGL compiles the program ONCE for all civilians!
// =========================================================================
export const CLOTH_WIND_TIME_UNIFORM = { value: 0 };

export function applyClothWindShader(
  mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
  windStrengthUniform: { value: number },
  cacheTag = 'cloth-wind-pbr-v3'
): void {
  mat.customProgramCacheKey = () => cacheTag;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uClothTime = CLOTH_WIND_TIME_UNIFORM;
    shader.uniforms.uClothWind = windStrengthUniform;

    shader.vertexShader =
      `attribute float aClothWind;\nuniform float uClothTime;\nuniform float uClothWind;\n` +
      shader.vertexShader;

    // Analytical normal perturbation so traveling fabric waves catch live shifting specular light & shadows!
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `#include <beginnormal_vertex>
      {
        float cwN = aClothWind * max(uClothWind, 0.16);
        if (cwN > 0.0005) {
          #ifdef USE_INSTANCING
            vec3 wOrigN = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          #else
            vec3 wOrigN = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
          #endif
          float wPhN = wOrigN.x * 0.37 + wOrigN.z * 0.53;
          float gustN = 0.62 + 0.38 * sin(uClothTime * 1.45 + wPhN);
          float ph1 = uClothTime * 5.2 - position.y * 11.2 + position.x * 7.2 + wPhN * 1.7;
          float ph2 = uClothTime * 8.6 - position.y * 16.5 - position.z * 8.8 + wPhN * 2.3;
          float ph3 = uClothTime * 3.4 + position.y * 6.8 + position.x * 11.0 + wPhN * 1.1;
          float dRippleDy = (-11.2 * cos(ph1) + 16.5 * 0.46 * sin(ph2) + 6.8 * 0.28 * cos(ph3)) * gustN;
          float dRippleDx = (7.2 * cos(ph1) + 11.0 * 0.28 * cos(ph3)) * gustN;
          float nAmp = cwN * 0.054;
          objectNormal = normalize(objectNormal + vec3(-dRippleDx * nAmp * 0.55, dRippleDy * nAmp * 0.42, dRippleDy * nAmp * 0.28));
        }
      }`
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        float cw = aClothWind * max(uClothWind, 0.16);
        if (cw > 0.0005) {
          #ifdef USE_INSTANCING
            vec3 wOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          #else
            vec3 wOrigin = vec3(modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2]);
          #endif
          float wPhase = wOrigin.x * 0.37 + wOrigin.z * 0.53;
          float gustEnv = 0.62 + 0.38 * sin(uClothTime * 1.45 + wPhase);
          float w1 = sin(uClothTime * 5.2 - position.y * 11.2 + position.x * 7.2 + wPhase * 1.7);
          float w2 = cos(uClothTime * 8.6 - position.y * 16.5 - position.z * 8.8 + wPhase * 2.3) * 0.46;
          float w3 = sin(uClothTime * 3.4 + position.y * 6.8 + position.x * 11.0 + wPhase * 1.1) * 0.28;
          float wMacro = sin(uClothTime * 2.25 + position.x * 3.8 + wPhase) * 0.34;
          float ripple = (w1 + w2 + w3) * gustEnv;
          transformed.z -= cw * (0.044 * gustEnv * uClothWind + 0.048 * ripple);
          transformed.x += cw * (0.036 * ripple + 0.024 * wMacro);
          transformed.y += cw * abs(ripple) * 0.015;
        }
      }`
    );
  };
}

/**
 * Lightweight realistic human Subsurface Scattering (SSS) wrap-lighting & warm blood-terminator glow!
 * Softens harsh CG shadow edges on cheekbones, nose tip, ears, lips & fingers under moody lighting.
 */
function applyHumanSkinShader(
  mat: THREE.MeshPhysicalMaterial,
  cacheTag = 'human-skin-sss-v1'
): void {
  mat.customProgramCacheKey = () => cacheTag;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `
      {
        // Warm dermal translucency & velvety grazing skin scatter along shadow terminators
        vec3 sssN = normalize(normal);
        vec3 sssV = normalize(vViewPosition);
        float ndotv = clamp(dot(sssN, sssV), 0.0, 1.0);
        float rimWrap = pow(1.0 - ndotv, 2.4);
        float luma = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
        float terminatorMask = smoothstep(0.02, 0.34, luma) * (1.0 - smoothstep(0.32, 0.78, luma));
        vec3 warmBloodTint = vec3(0.16, 0.048, 0.028);
        gl_FragColor.rgb += warmBloodTint * (terminatorMask * 0.34 + rimWrap * luma * 0.28);
      }
      #include <dithering_fragment>`
    );
  };
}

/** Assign aClothWind attribute to any static geometry rendered with a cloth-wind material */
function tagClothWindAttr(
  geo: THREE.BufferGeometry,
  weightFn: (x: number, y: number, z: number) => number
): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  const arr = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    arr[i] = weightFn(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  geo.setAttribute('aClothWind', new THREE.BufferAttribute(arr, 1));
  return geo;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// =========================================================================
// HIGH-DETAIL DRAPED-FABRIC & CONTINUOUS SKINNED GARMENT SCULPTORS
// ZERO exposed ball joints — single continuous skinned jacket+sleeves & trousers!
// =========================================================================

// Bone indices in every HumanRig skeleton (12 bones)
const BONE_PELVIS = 0;
const BONE_SPINE = 1;
const BONE_CHEST = 2;
const BONE_L_SHOULDER = 3;
const BONE_L_ELBOW = 4;
const BONE_R_SHOULDER = 5;
const BONE_R_ELBOW = 6;
const BONE_L_HIP = 7;
const BONE_L_KNEE = 8;
const BONE_R_HIP = 9;
const BONE_R_KNEE = 10;
const BONE_COAT_TAIL = 11;

interface LoftRing {
  y: number;
  rx: number;
  rz: number;
  xShift?: number;
  zShift?: number;
  frontBulge?: number;
  backBulge?: number;
  foldAmp?: number;
  foldFreq?: number;
  creaseAmp?: number;
  windWeight?: number;
}

function buildDrapedLoft(rings: LoftRing[], radialSegs = 28, foldPhase = 0): THREE.BufferGeometry {
  const numRings = rings.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const winds: number[] = [];
  const indices: number[] = [];

  for (let r = 0; r < numRings; r++) {
    const ring = rings[r];
    const v = r / Math.max(1, numRings - 1);
    const xShift = ring.xShift ?? 0;
    const zShift = ring.zShift ?? 0;
    const fBulge = ring.frontBulge ?? 0;
    const bBulge = ring.backBulge ?? 0;
    const foldAmp = ring.foldAmp ?? 0;
    const foldFreq = ring.foldFreq ?? 6;
    const creaseAmp = ring.creaseAmp ?? 0;
    const windW = ring.windWeight ?? 0;

    for (let s = 0; s <= radialSegs; s++) {
      const u = s / radialSegs;
      // Align u = 0.5 directly with +Z (front of body/face!)
      const theta = (u - 0.5) * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);

      let foldScale = 1.0;
      if (foldAmp > 0) {
        const w1 = Math.sin(theta * foldFreq + v * 4.2 + foldPhase);
        const w2 = Math.sin(theta * (foldFreq * 1.5 - 1) - v * 6.5 + foldPhase * 1.7) * 0.45;
        const w3 = Math.cos(v * Math.PI * 5.0 + theta * 2.0 + foldPhase) * creaseAmp;
        foldScale += (w1 + w2) * foldAmp + w3;
      }

      const x = sinT * ring.rx * foldScale + xShift;
      let z = cosT * ring.rz * foldScale + zShift;

      if (cosT > 0 && fBulge !== 0) {
        z += Math.pow(cosT, 1.8) * fBulge;
      }
      if (cosT < 0 && bBulge !== 0) {
        z -= Math.pow(-cosT, 1.8) * bBulge;
      }

      positions.push(x, ring.y, z);
      uvs.push(u, 1 - v);
      winds.push(windW);
    }
  }

  const stride = radialSegs + 1;
  for (let r = 0; r < numRings - 1; r++) {
    for (let s = 0; s < radialSegs; s++) {
      const a = r * stride + s;
      const b = a + 1;
      const c = (r + 1) * stride + s;
      const d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aClothWind', new THREE.Float32BufferAttribute(winds, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Merge multiple skinned BufferGeometries into a single draw call while preserving skinIndex, skinWeight & aClothWind */
function mergeSkinnedGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;
  for (let g = 0; g < geos.length; g++) {
    totalVerts += geos[g].attributes.position.count;
    totalIndices += geos[g].index ? geos[g].index!.count : geos[g].attributes.position.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const skinIndices = new Uint16Array(totalVerts * 4);
  const skinWeights = new Float32Array(totalVerts * 4);
  const clothWinds = new Float32Array(totalVerts);
  const indices = new Uint32Array(totalIndices);

  let vOff = 0;
  let iOff = 0;
  for (let g = 0; g < geos.length; g++) {
    const geo = geos[g];
    const pos = geo.attributes.position;
    const norm = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const si = geo.attributes.skinIndex;
    const sw = geo.attributes.skinWeight;
    const cw = geo.attributes.aClothWind;
    const count = pos.count;

    positions.set(pos.array as Float32Array, vOff * 3);
    normals.set(norm.array as Float32Array, vOff * 3);
    uvs.set(uv.array as Float32Array, vOff * 2);
    skinIndices.set(si.array as Uint16Array, vOff * 4);
    skinWeights.set(sw.array as Float32Array, vOff * 4);
    clothWinds.set(cw.array as Float32Array, vOff);

    if (geo.index) {
      const idxArr = geo.index.array;
      for (let k = 0; k < idxArr.length; k++) {
        indices[iOff + k] = idxArr[k] + vOff;
      }
      iOff += idxArr.length;
    } else {
      for (let k = 0; k < count; k++) {
        indices[iOff + k] = vOff + k;
      }
      iOff += count;
    }
    vOff += count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  merged.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  merged.setAttribute('aClothWind', new THREE.BufferAttribute(clothWinds, 1));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

/** Build build-specific skeleton proportion metrics (shared between bones and skinned garment builders!) */
function getBuildMetrics(build: HumanBuildType) {
  const standingPelvisY = 0.92;
  const chestBaseY = standingPelvisY + 0.085; // 1.005
  const torsoTopY = build === 'tall_lean' ? 0.53 : build === 'slender_female' ? 0.47 : 0.5;
  const shoulderHalfW =
    build === 'slender_female'
      ? 0.158
      : build === 'stocky_heavy'
      ? 0.208
      : build === 'tall_lean'
      ? 0.174
      : 0.194;
  const shoulderY = torsoTopY - 0.082;
  const hipHalfW =
    build === 'slender_female'
      ? 0.094
      : build === 'stocky_heavy'
      ? 0.112
      : 0.098;
  const legThick = build === 'slender_female' ? 0.94 : build === 'stocky_heavy' ? 1.18 : 1.02;
  const armThickBase = build === 'slender_female' ? 0.9 : build === 'stocky_heavy' ? 1.18 : 1.02;
  return {
    standingPelvisY,
    chestBaseY,
    torsoTopY,
    shoulderHalfW,
    shoulderY,
    hipHalfW,
    legThick,
    armThickBase,
  };
}

/**
 * Build ONE seamless, continuous skinned jacket + flowing coat hem + left & right draped sleeves!
 * Eliminates shoulder balls, elbow balls, waist gaps, and sleeve/torso seams completely!
 */
function buildSkinnedJacketAndSleevesGeo(
  build: HumanBuildType,
  outfit: OutfitStyleType
): THREE.BufferGeometry {
  const m = getBuildMetrics(build);
  const wScale =
    build === 'slender_female'
      ? 0.9
      : build === 'stocky_heavy'
      ? 1.18
      : build === 'tall_lean'
      ? 0.96
      : 1.02;
  const armThick = m.armThickBase * (outfit === 'puffer_jacket' ? 1.14 : 1.05);

  const isLongCoat = outfit === 'trench_coat' || outfit === 'soviet_soldier';
  const isMidCoat =
    outfit === 'hoodie_parka' ||
    outfit === 'cardigan_scarf' ||
    outfit === 'metro_worker' ||
    outfit === 'pow_prisoner' ||
    outfit === 'station_barista' ||
    outfit === 'gang_2059';
  const isBlazer = outfit === 'tailored_blazer' || outfit === 'transit_security';
  const isPuffer = outfit === 'puffer_jacket';

  // EVERY civilian outfit has a continuous hip/thigh/knee-covering draped coat hem (zero waist seam!)
  const coatLen = isLongCoat ? 0.56 : isMidCoat ? 0.38 : isBlazer ? 0.30 : 0.22;
  const hemFlare = isLongCoat ? 1.44 : isMidCoat ? 1.28 : isBlazer ? 1.18 : 1.1;
  const maxHemWind = isLongCoat ? 1.0 : isMidCoat ? 0.85 : isBlazer ? 0.65 : 0.45;

  const waistY = m.chestBaseY; // 1.005
  const topY = waistY + m.torsoTopY;
  const hemBottomY = 0.95 - coatLen;

  // 1. CONTINUOUS JACKET TORSO -> PELVIS -> FLOWING COAT SKIRT (High-subdivision pure fabric drape!)
  const bodyRings: LoftRing[] = [];
  const skirtSteps = 10;
  for (let i = 0; i < skirtSteps; i++) {
    const f = i / skirtSteps; // 0 = bottom hem, 1 = just below waist
    const tDown = 1 - f; // 1 = bottom hem, 0 = waist
    const y = THREE.MathUtils.lerp(hemBottomY, 0.95, f);
    const flare = THREE.MathUtils.lerp(1.04, hemFlare, Math.pow(tDown, 1.12));
    bodyRings.push({
      y,
      rx: 0.168 * wScale * flare,
      rz: 0.126 * wScale * flare,
      backBulge: 0.018 + tDown * 0.028,
      frontBulge: 0.009 + tDown * 0.014,
      foldAmp: 0.026 + tDown * (isLongCoat ? 0.095 : 0.068),
      foldFreq: isLongCoat ? 10 : 8,
      creaseAmp: 0.018,
      windWeight: Math.pow(tDown, 1.18) * maxHemWind,
    });
  }

  if (isPuffer) {
    const ps = build === 'slender_female' ? 0.92 : build === 'stocky_heavy' ? 1.16 : 1.04;
    const pRings: LoftRing[] = [
      { y: waistY + 0.01, rx: 0.184 * ps, rz: 0.142 * ps, frontBulge: 0.014, foldAmp: 0.024, foldFreq: 8, windWeight: 0.08 },
      { y: waistY + 0.065, rx: 0.204 * ps, rz: 0.162 * ps, frontBulge: 0.02, foldAmp: 0.018, foldFreq: 6, windWeight: 0.04 },
      { y: waistY + 0.115, rx: 0.186 * ps, rz: 0.144 * ps, foldAmp: 0.016, foldFreq: 6 },
      { y: waistY + 0.185, rx: 0.214 * ps, rz: 0.168 * ps, frontBulge: 0.024, foldAmp: 0.018, foldFreq: 6 },
      { y: waistY + 0.24, rx: 0.196 * ps, rz: 0.15 * ps, foldAmp: 0.016, foldFreq: 6 },
      { y: waistY + 0.315, rx: 0.228 * ps, rz: 0.172 * ps, frontBulge: 0.024, backBulge: 0.016, foldAmp: 0.017, foldFreq: 6 },
      { y: waistY + 0.375, rx: 0.218 * ps, rz: 0.154 * ps, foldAmp: 0.016, foldFreq: 5 },
      { y: waistY + m.torsoTopY * 0.84, rx: (m.shoulderHalfW + 0.044), rz: 0.148 * ps, foldAmp: 0.016, foldFreq: 5 },
      { y: topY - 0.035, rx: 0.176 * ps, rz: 0.118 * ps },
      { y: topY + 0.012, rx: 0.104 * ps, rz: 0.094 * ps },
    ];
    bodyRings.push(...pRings);
  } else {
    const chestBulge = build === 'slender_female' ? 0.034 : build === 'stocky_heavy' ? 0.026 : 0.022;
    const upperRings: LoftRing[] = [
      { y: waistY + 0.02, rx: 0.168 * wScale, rz: 0.124 * wScale, frontBulge: 0.01, foldAmp: 0.04, foldFreq: 8, creaseAmp: 0.02, windWeight: 0.14 },
      { y: waistY + 0.1, rx: 0.166 * wScale, rz: 0.122 * wScale, frontBulge: 0.014, foldAmp: 0.032, foldFreq: 8, creaseAmp: 0.018, windWeight: 0.08 },
      { y: waistY + 0.2, rx: 0.184 * wScale, rz: 0.132 * wScale, frontBulge: chestBulge, backBulge: 0.012, foldAmp: 0.025, foldFreq: 7, windWeight: 0.04 },
      { y: waistY + 0.31, rx: 0.208 * wScale, rz: 0.138 * wScale, frontBulge: chestBulge * 0.9, backBulge: 0.016, foldAmp: 0.02, foldFreq: 6 },
      // Draped extended shoulder mantel seamlessly covering top of arm sockets!
      { y: waistY + m.shoulderY - 0.015, rx: m.shoulderHalfW + 0.038, rz: 0.13 * wScale, backBulge: 0.016, foldAmp: 0.02, foldFreq: 5 },
      { y: waistY + m.shoulderY + 0.038, rx: m.shoulderHalfW + 0.028, rz: 0.116 * wScale, foldAmp: 0.016, foldFreq: 4 },
      { y: topY - 0.03, rx: 0.134 * wScale, rz: 0.094 * wScale },
      { y: topY + 0.014, rx: 0.088 * wScale, rz: 0.078 * wScale },
    ];
    bodyRings.push(...upperRings);
  }

  const bodyGeo = buildDrapedLoft(bodyRings, 36, build === 'slender_female' ? 0.5 : 1.2);
  const bPos = bodyGeo.attributes.position;
  const bSkinIdx = new Uint16Array(bPos.count * 4);
  const bSkinWgt = new Float32Array(bPos.count * 4);

  for (let i = 0; i < bPos.count; i++) {
    const x = bPos.getX(i);
    const y = bPos.getY(i);
    const z = bPos.getZ(i);

    if (y >= 1.07) {
      // Upper chest & draped shoulder yoke follow chest cleanly
      bSkinIdx[i * 4] = BONE_CHEST;
      bSkinWgt[i * 4] = 1.0;
    } else if (y >= 0.95) {
      // Smooth flexible waist transition between pelvis and chest
      const wChest = smoothstep(0.95, 1.07, y);
      bSkinIdx[i * 4] = BONE_CHEST;
      bSkinIdx[i * 4 + 1] = BONE_PELVIS;
      bSkinWgt[i * 4] = wChest;
      bSkinWgt[i * 4 + 1] = 1.0 - wChest;
    } else {
      // Lower coat skirt/hem: drapes naturally over seated/walking thighs AND trails in the wind!
      const tHem = THREE.MathUtils.clamp((0.95 - y) / Math.max(0.16, coatLen), 0, 1);
      const tSmooth = Math.pow(tHem, 0.85);
      const frontAmt = THREE.MathUtils.clamp((z + 0.02) / 0.16, 0, 1);
      const sideBone = x < 0 ? BONE_L_HIP : BONE_R_HIP;
      const wHip = tSmooth * frontAmt * 0.42;
      const wTail = tSmooth * (0.86 - frontAmt * 0.36);
      const wPelvis = Math.max(0.08, 1.0 - wHip - wTail);
      const sum = wPelvis + wTail + wHip;

      bSkinIdx[i * 4] = BONE_PELVIS;
      bSkinIdx[i * 4 + 1] = BONE_COAT_TAIL;
      bSkinIdx[i * 4 + 2] = sideBone;
      bSkinWgt[i * 4] = wPelvis / sum;
      bSkinWgt[i * 4 + 1] = wTail / sum;
      bSkinWgt[i * 4 + 2] = wHip / sum;
    }
  }
  bodyGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(bSkinIdx, 4));
  bodyGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(bSkinWgt, 4));

  // 2. CONTINUOUS SEAMLESS SKINNED SLEEVES (Left & Right — Shoulder Cap -> Elbow Blouson -> Wrist Cuff!)
  const buildSkinnedSleeve = (sideSign: -1 | 1): THREE.BufferGeometry => {
    const shX = sideSign * m.shoulderHalfW;
    const shY = waistY + m.shoulderY;
    const shZ = -0.004;
    const shoulderBone = sideSign < 0 ? BONE_L_SHOULDER : BONE_R_SHOULDER;
    const elbowBone = sideSign < 0 ? BONE_L_ELBOW : BONE_R_ELBOW;

    // 16 smooth rings from tucked shoulder cap (+0.062) smoothly past elbow (-0.275) to wrist cuff (-0.538)
    const sleeveProfile: {
      dy: number;
      r: number;
      inward: number;
      fold: number;
      wind: number;
    }[] = [
      { dy: -0.538, r: 0.041, inward: 0.0, fold: 0.042, wind: 0.36 }, // cuff edge covering wrist
      { dy: -0.505, r: 0.048, inward: 0.0, fold: 0.068, wind: 0.34 }, // gathered blouson cuff
      { dy: -0.455, r: 0.052, inward: 0.0, fold: 0.058, wind: 0.28 },
      { dy: -0.395, r: 0.055, inward: 0.0, fold: 0.052, wind: 0.22 },
      { dy: -0.335, r: 0.058, inward: 0.0, fold: 0.055, wind: 0.18 },
      { dy: -0.275, r: 0.060, inward: 0.0, fold: 0.062, wind: 0.16 }, // seamless cloth-draped elbow!
      { dy: -0.220, r: 0.062, inward: 0.0, fold: 0.054, wind: 0.13 },
      { dy: -0.160, r: 0.064, inward: 0.0, fold: 0.048, wind: 0.10 },
      { dy: -0.100, r: 0.067, inward: 0.004, fold: 0.042, wind: 0.06 },
      { dy: -0.045, r: 0.070, inward: 0.012, fold: 0.036, wind: 0.03 },
      { dy: 0.005, r: 0.072, inward: 0.024, fold: 0.028, wind: 0.01 }, // deltoid shoulder blend
      { dy: 0.042, r: 0.064, inward: 0.044, fold: 0.018, wind: 0.0 },
      { dy: 0.064, r: 0.040, inward: 0.064, fold: 0.010, wind: 0.0 }, // tucked cleanly inside jacket chest!
    ];

    const sRings: LoftRing[] = sleeveProfile.map((p) => ({
      y: shY + p.dy,
      rx: p.r * armThick,
      rz: p.r * armThick * 1.05,
      xShift: shX - sideSign * p.inward,
      zShift: shZ,
      backBulge: p.dy < -0.15 && p.dy > -0.38 ? 0.008 * armThick : 0,
      foldAmp: p.fold,
      foldFreq: 6,
      creaseAmp: 0.024,
      windWeight: p.wind,
    }));

    const sGeo = buildDrapedLoft(sRings, 20, sideSign < 0 ? 1.1 : 2.7);
    const pos = sGeo.attributes.position;
    const sIdx = new Uint16Array(pos.count * 4);
    const sWgt = new Float32Array(pos.count * 4);

    for (let i = 0; i < pos.count; i++) {
      const dy = pos.getY(i) - shY;
      // Smooth Hermite blend across shoulder seam (-0.055..+0.064) and elbow bend (-0.19..-0.36)!
      const wChest = smoothstep(-0.055, 0.055, dy) * 0.86;
      const wElbow = smoothstep(-0.185, -0.365, dy);
      const wSh = Math.max(0, 1.0 - wChest) * (1.0 - wElbow);
      const wElbFinal = Math.max(0, 1.0 - wChest) * wElbow;
      const sum = wChest + wSh + wElbFinal;

      sIdx[i * 4] = BONE_CHEST;
      sIdx[i * 4 + 1] = shoulderBone;
      sIdx[i * 4 + 2] = elbowBone;
      sWgt[i * 4] = wChest / sum;
      sWgt[i * 4 + 1] = wSh / sum;
      sWgt[i * 4 + 2] = wElbFinal / sum;
    }

    sGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sIdx, 4));
    sGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sWgt, 4));
    return sGeo;
  };

  return mergeSkinnedGeometries([
    bodyGeo,
    buildSkinnedSleeve(-1),
    buildSkinnedSleeve(1),
  ]);
}

/**
 * Build ONE seamless, continuous skinned trouser mesh (pelvis/seat + left & right draped legs!).
 * Eliminates hip gaps and knee joint balls completely — bends like real draped cloth when sitting or walking!
 */
function buildSkinnedTrousersGeo(build: HumanBuildType): THREE.BufferGeometry {
  const m = getBuildMetrics(build);
  const hipRx =
    build === 'slender_female'
      ? 0.174
      : build === 'stocky_heavy'
      ? 0.198
      : build === 'tall_lean'
      ? 0.152
      : 0.166;
  const hipRz =
    build === 'slender_female'
      ? 0.124
      : build === 'stocky_heavy'
      ? 0.15
      : 0.122;

  // 1. Pelvis / Seat Core (100% bound to pelvis)
  const pelvisGeo = buildDrapedLoft(
    [
      { y: m.standingPelvisY - 0.12, rx: hipRx * 0.9, rz: hipRz * 0.9, backBulge: 0.016, foldAmp: 0.025, foldFreq: 6 },
      { y: m.standingPelvisY - 0.02, rx: hipRx, rz: hipRz, backBulge: 0.026, foldAmp: 0.022, foldFreq: 6 },
      { y: m.standingPelvisY + 0.07, rx: hipRx * 0.92, rz: hipRz * 0.92, foldAmp: 0.018, foldFreq: 6 },
      { y: m.standingPelvisY + 0.13, rx: hipRx * 0.84, rz: hipRz * 0.86, foldAmp: 0.015, foldFreq: 6 },
    ],
    22
  );
  const pPos = pelvisGeo.attributes.position;
  const pIdx = new Uint16Array(pPos.count * 4);
  const pWgt = new Float32Array(pPos.count * 4);
  for (let i = 0; i < pPos.count; i++) {
    pIdx[i * 4] = BONE_PELVIS;
    pWgt[i * 4] = 1.0;
  }
  pelvisGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(pIdx, 4));
  pelvisGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(pWgt, 4));

  // 2. Continuous Draped Left & Right Trouser Legs (Upper Hip -> Thigh -> Smooth Knee -> Draped Ankle Cuff!)
  const buildLeg = (sideSign: -1 | 1): THREE.BufferGeometry => {
    const hipX = sideSign * m.hipHalfW;
    const hipY = m.standingPelvisY - 0.03; // 0.89
    const hipBone = sideSign < 0 ? BONE_L_HIP : BONE_R_HIP;
    const kneeBone = sideSign < 0 ? BONE_L_KNEE : BONE_R_KNEE;
    const lt = m.legThick;

    const legProfile: { dy: number; r: number; back: number; fold: number; wind: number }[] = [
      { dy: -0.852, r: 0.056, back: 0.004, fold: 0.068, wind: 0.34 }, // loose trouser hem over shoe
      { dy: -0.790, r: 0.061, back: 0.008, fold: 0.062, wind: 0.28 },
      { dy: -0.690, r: 0.064, back: 0.014, fold: 0.052, wind: 0.20 },
      { dy: -0.575, r: 0.068, back: 0.014, fold: 0.052, wind: 0.14 },
      { dy: -0.495, r: 0.072, back: 0.010, fold: 0.058, wind: 0.10 },
      { dy: -0.425, r: 0.075, back: 0.008, fold: 0.064, wind: 0.08 }, // seamless cloth-draped knee!
      { dy: -0.345, r: 0.080, back: 0.010, fold: 0.052, wind: 0.05 },
      { dy: -0.245, r: 0.088, back: 0.012, fold: 0.044, wind: 0.02 },
      { dy: -0.130, r: 0.095, back: 0.012, fold: 0.036, wind: 0.0 },
      { dy: -0.025, r: 0.100, back: 0.014, fold: 0.028, wind: 0.0 },
      { dy: 0.055, r: 0.094, back: 0.012, fold: 0.020, wind: 0.0 }, // seated seamlessly into pelvis!
      { dy: 0.100, r: 0.076, back: 0.006, fold: 0.012, wind: 0.0 },
    ];

    const lRings: LoftRing[] = legProfile.map((p) => ({
      y: hipY + p.dy,
      rx: p.r * lt,
      rz: p.r * lt * 1.04,
      xShift: hipX,
      backBulge: p.back * lt,
      foldAmp: p.fold,
      foldFreq: 6,
      creaseAmp: 0.022,
      windWeight: p.wind,
    }));

    const lGeo = buildDrapedLoft(lRings, 20, sideSign < 0 ? 0.8 : 2.3);
    const pos = lGeo.attributes.position;
    const sIdx = new Uint16Array(pos.count * 4);
    const sWgt = new Float32Array(pos.count * 4);

    for (let i = 0; i < pos.count; i++) {
      const dy = pos.getY(i) - hipY;
      // Smooth Hermite blend across hip socket (-0.08..+0.095) and knee bend (-0.32..-0.53)!
      const wPelvis = smoothstep(-0.075, 0.09, dy) * 0.84;
      const wKnee = smoothstep(-0.32, -0.53, dy);
      const wHip = Math.max(0, 1.0 - wPelvis) * (1.0 - wKnee);
      const wKneeFinal = Math.max(0, 1.0 - wPelvis) * wKnee;
      const sum = wPelvis + wHip + wKneeFinal;

      sIdx[i * 4] = BONE_PELVIS;
      sIdx[i * 4 + 1] = hipBone;
      sIdx[i * 4 + 2] = kneeBone;
      sWgt[i * 4] = wPelvis / sum;
      sWgt[i * 4 + 1] = wHip / sum;
      sWgt[i * 4 + 2] = wKneeFinal / sum;
    }

    lGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sIdx, 4));
    lGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sWgt, 4));
    return lGeo;
  };

  return mergeSkinnedGeometries([pelvisGeo, buildLeg(-1), buildLeg(1)]);
}

/**
 * Ultra-high-precision, front-face-concentrated anatomical human head (96x72 mesh => ~220x160 facial density!):
 * Exact spherical (lon, lat) UV & landmark lock with 2048x1024 pedFaceSkinMap / pedFaceMap!
 * Sculpted anatomical landmarks:
 *   - Eyes:       lon = ±0.365 rad, lat = +0.032 rad (crisp recessed orbital cavity + almond upper/lower eyelid folds + inner canthus)
 *   - Eyebrows:   lon ∈ [±0.145, ±0.605], lat ≈ +0.21 rad (supraorbital brow ridge + glabella dip)
 *   - Nose:       bridge -> tip (0, -0.215), crisp lateral nose planes, tucked alar wings (±0.135, -0.236), recessed nostrils (±0.088, -0.256)
 *   - Philtrum:   twin ridges (±0.044) & groove (0, -0.34) leading into Cupid's bow (-0.392)
 *   - Lips:       upper vermilion + white roll (-0.412), recessed parting seam (-0.445), full lower lip (-0.492), oral commissures (±0.225)
 *   - Cheeks/Jaw: malar cheekbones, sub-malar hollows, nasolabial fold, labiomental crease (-0.595), sculpted chin (-0.755) & gonion jaw corner!
 */
function createSculptedHeadGeometry(
  jawSlimness = 0.0,
  radialSegs = 96,
  heightSegs = 72
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let iy = 0; iy <= heightSegs; iy++) {
    const vRaw = iy / heightSegs; // 0 = top pole (+PI/2), 1 = bottom pole (-PI/2)
    // Concentrate vertical mesh resolution across the front facial landmark band (lat ∈ [-0.85, +0.45])!
    const latLin = (0.5 - vRaw) * Math.PI;
    const lat = THREE.MathUtils.clamp(
      latLin - 0.24 * Math.sin(latLin + 0.16) * Math.cos(latLin),
      -Math.PI * 0.499,
      Math.PI * 0.499
    );
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const vUv = 0.5 + lat / Math.PI; // exact spherical V matching textures.ts (py = (1 - vUv) * H)!

    for (let ix = 0; ix <= radialSegs; ix++) {
      const uRaw = ix / radialSegs; // 0 -> -PI (back), 0.5 -> 0 (+Z front face!), 1 -> +PI (back)
      const uAngle = (uRaw - 0.5) * Math.PI * 2;
      // Concentrate horizontal mesh resolution ~2.2x denser across the front face (lon ≈ 0)!
      const lon = uAngle - 0.38 * Math.sin(uAngle);
      const uUv = 0.5 + lon / (Math.PI * 2); // exact spherical U matching textures.ts (px = uUv * W)!

      const x = Math.sin(lon) * cosLat;
      const y = sinLat;
      const z = Math.cos(lon) * cosLat;
      const ax = Math.abs(x);
      const aLon = Math.abs(lon);

      let sx = 0.0862;
      const sy = 0.1128;
      let sz = 0.1018;

      // Natural cranial occipital fullness at rear of skull
      if (y > 0.05 && z < 0) {
        sz += 0.0115 * Math.sin(Math.min(1, y) * Math.PI * 0.5) * (-z);
      }
      // Realistic temporal hollowing above cheekbones on the sides of the forehead
      if (y > 0.06 && y < 0.54 && ax > 0.56) {
        const tempMask = Math.sin(THREE.MathUtils.clamp((y - 0.06) / 0.48, 0, 1) * Math.PI);
        sx -= 0.0058 * tempMask * smoothstep(0.56, 0.88, ax);
      }

      // Tapered anatomical jawline, defined gonion jaw angle & submental chin curve
      if (y < 0.10) {
        const t = Math.min(1, (0.10 - y) / 1.10);
        const jawNarrow = Math.pow(t, 1.16) * (0.31 + jawSlimness * 0.135);
        const gonion =
          Math.exp(-Math.pow((lat + 0.48) * 4.9, 2)) *
          Math.exp(-Math.pow((aLon - 0.88) * 3.8, 2)) *
          (1.0 - jawSlimness * 0.44);
        sx *= 1.0 - jawNarrow + gonion * 0.058;
        sz *= z > 0 ? 1.0 - t * 0.125 : 1.0 - t * 0.38;
      }

      let px = x * sx;
      let py = y * sy;
      let pz = z * sz;

      // Exact anatomical front-face sculpting in (lon, lat) locked to 2048x1024 pedFaceSkinMap!
      if (z > 0.14) {
        // 1. Forehead bossing, supraorbital brow arch & central glabella depression
        const foreheadBoss =
          Math.exp(-Math.pow((lat - 0.44) * 3.7, 2)) * Math.exp(-Math.pow(lon * 2.0, 2));
        const browArchLat = 0.195 + 0.042 * Math.exp(-Math.pow((aLon - 0.41) * 4.6, 2));
        const browRidge =
          Math.exp(-Math.pow((lat - browArchLat) * 9.8, 2)) *
          Math.exp(-Math.pow((aLon - 0.34) * 3.2, 2));
        const glabellaDip =
          Math.exp(-Math.pow((lat - 0.13) * 12.0, 2)) * Math.exp(-Math.pow(lon * 11.5, 2));
        pz += foreheadBoss * 0.0040 + browRidge * 0.0086 - glabellaDip * 0.0034;

        // 2. Crisp recessed almond eye socket at EXACT (lon = ±0.365, lat = +0.032) + sculpted upper/lower eyelid rims!
        const eLon = aLon - 0.365;
        const eLat = lat - 0.032;
        const almondTilt = eLat - eLon * 0.12;
        const eyeSocket =
          Math.exp(-Math.pow(almondTilt * 10.5, 2)) * Math.exp(-Math.pow(eLon * 6.4, 2));
        const innerCanthus =
          Math.exp(-Math.pow((lat - 0.015) * 18.0, 2)) *
          Math.exp(-Math.pow((aLon - 0.215) * 16.0, 2));
        // Raised supratarsal upper eyelid fold curving gracefully over the eyeball
        const upperLidArc = 0.098 - Math.pow(eLon * 2.6, 2) * 0.045;
        const upperLidFold =
          Math.exp(-Math.pow((lat - upperLidArc) * 20.0, 2)) *
          Math.exp(-Math.pow(eLon * 6.8, 2));
        // Subtle lower eyelid pretarsal rim & tear-trough hollow beneath
        const lowerLidRim =
          Math.exp(-Math.pow((lat + 0.030 - Math.pow(eLon * 2.4, 2) * 0.025) * 24.0, 2)) *
          Math.exp(-Math.pow(eLon * 7.2, 2));
        const tearTrough =
          Math.exp(-Math.pow((lat + 0.088 + (aLon - 0.30) * 0.14) * 17.0, 2)) *
          Math.exp(-Math.pow((aLon - 0.34) * 6.5, 2));

        pz +=
          -eyeSocket * 0.0138 -
          innerCanthus * 0.0046 +
          upperLidFold * 0.0038 +
          lowerLidRim * 0.0019 -
          tearTrough * 0.0028;

        // 3. Prominent zygomatic cheekbone planes tapering into natural sub-malar cheek hollows
        const malarCheek =
          Math.exp(-Math.pow((lat + 0.12) * 5.0, 2)) *
          Math.exp(-Math.pow((aLon - 0.56) * 3.8, 2));
        const cheekHollow =
          Math.exp(-Math.pow((lat + 0.37) * 5.4, 2)) *
          Math.exp(-Math.pow((aLon - 0.58) * 4.2, 2));
        pz += malarCheek * 0.0098 - cheekHollow * 0.0044;
        px += Math.sign(lon) * (malarCheek * 0.0056 - cheekHollow * 0.0030);

        // 4. Precision sculpted human nose: radix dip, crisp dorsal bridge, defined tip, alar wings & dark nostril recesses!
        const noseRadix =
          Math.exp(-Math.pow((lat - 0.055) * 13.0, 2)) * Math.exp(-Math.pow(lon * 11.5, 2));
        const noseDorsum =
          Math.exp(-Math.pow((lat + 0.085) * 5.8, 2)) * Math.exp(-Math.pow(lon * 12.2, 2));
        const noseTip =
          Math.exp(-Math.pow((lat + 0.212) * 13.5, 2)) * Math.exp(-Math.pow(lon * 12.0, 2));
        const columella =
          Math.exp(-Math.pow((lat + 0.258) * 22.0, 2)) * Math.exp(-Math.pow(lon * 22.0, 2));
        const alarWing =
          Math.exp(-Math.pow((lat + 0.232) * 17.5, 2)) *
          Math.exp(-Math.pow((aLon - 0.128) * 16.5, 2));
        const alarCrease =
          Math.exp(-Math.pow((lat + 0.236) * 18.0, 2)) *
          Math.exp(-Math.pow((aLon - 0.168) * 22.0, 2));
        const nostrilHollow =
          Math.exp(-Math.pow((lat + 0.256) * 26.0, 2)) *
          Math.exp(-Math.pow((aLon - 0.088) * 24.0, 2));

        pz +=
          noseDorsum * 0.0156 +
          noseTip * 0.0158 +
          columella * 0.0045 +
          alarWing * 0.0064 -
          noseRadix * 0.0028 -
          alarCrease * 0.0024 -
          nostrilHollow * 0.0058;
        py -= noseTip * 0.0020;

        // 5. Realistic nasolabial fold (subtle diagonal crease & upper cheek pillow)
        const foldLon = 0.175 + THREE.MathUtils.clamp((-lat - 0.22) * 0.56, 0, 0.20);
        const nasolabialCrease =
          Math.exp(-Math.pow((aLon - foldLon) * 22.0, 2)) *
          Math.exp(-Math.pow((lat + 0.365) * 7.2, 2));
        const nasolabialRoll =
          Math.exp(-Math.pow((aLon - (foldLon + 0.052)) * 15.0, 2)) *
          Math.exp(-Math.pow((lat + 0.345) * 6.8, 2));
        pz += nasolabialRoll * 0.0026 - nasolabialCrease * 0.0024;

        // 6. Sculpted philtrum columns, Cupid's bow, crisp vermilion lips, parting seam & oral commissures!
        const philtrumGroove =
          Math.exp(-Math.pow((lat + 0.338) * 18.0, 2)) * Math.exp(-Math.pow(lon * 24.0, 2));
        const philtrumRidge =
          Math.exp(-Math.pow((lat + 0.338) * 17.0, 2)) *
          Math.exp(-Math.pow((aLon - 0.046) * 26.0, 2));

        const mouthMask = Math.exp(-Math.pow(lon * 4.8, 2));
        const cupidArch = 0.018 * Math.exp(-Math.pow((aLon - 0.058) * 20.0, 2)) - 0.007 * Math.exp(-Math.pow(lon * 24.0, 2));
        const upperLipLat = -0.412 + cupidArch - Math.pow(aLon * 2.2, 2) * 0.022;
        const upperLip = Math.exp(-Math.pow((lat - upperLipLat) * 24.0, 2)) * mouthMask;
        const upperWhiteRoll = Math.exp(-Math.pow((lat - (upperLipLat + 0.024)) * 34.0, 2)) * mouthMask;
        const lipParting =
          Math.exp(-Math.pow((lat + 0.445 + Math.pow(aLon * 2.1, 2) * 0.012) * 34.0, 2)) *
          Math.exp(-Math.pow(lon * 4.5, 2));
        const lowerLip =
          Math.exp(-Math.pow((lat + 0.488 - Math.pow(aLon * 2.2, 2) * 0.014) * 20.0, 2)) *
          Math.exp(-Math.pow(lon * 5.2, 2));
        const mouthCorner =
          Math.exp(-Math.pow((lat + 0.448) * 22.0, 2)) *
          Math.exp(-Math.pow((aLon - 0.225) * 18.0, 2));

        // 7. Labiomental chin crease & sculpted anatomical chin boss
        const chinCrease =
          Math.exp(-Math.pow((lat + 0.595) * 16.0, 2)) * Math.exp(-Math.pow(lon * 6.2, 2));
        const chinBoss =
          Math.exp(-Math.pow((lat + 0.755) * 7.8, 2)) * Math.exp(-Math.pow(lon * 4.8, 2));

        pz +=
          philtrumRidge * 0.0020 -
          philtrumGroove * 0.0026 +
          upperLip * 0.0098 +
          upperWhiteRoll * 0.0014 +
          lowerLip * 0.0096 -
          lipParting * 0.0044 -
          mouthCorner * 0.0038 -
          chinCrease * 0.0038 +
          chinBoss * 0.0118;
      }

      positions.push(px, py + 0.088, pz);
      uvs.push(uUv, vUv);
    }
  }

  const stride = radialSegs + 1;
  for (let iy = 0; iy < heightSegs; iy++) {
    for (let ix = 0; ix < radialSegs; ix++) {
      const a = iy * stride + ix;
      const b = a + 1;
      const c = (iy + 1) * stride + ix;
      const d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Anatomically curved 3D human ear (outer helix rim, recessed concha bowl & soft earlobe) */
function createSculptedEarGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.017, 16, 14);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ny = y / 0.017;
    const nz = z / 0.017;
    // Taper slightly toward earlobe at bottom, curve outer helix rim & recess central concha
    const lobeTaper = ny < 0 ? 1.0 + ny * 0.24 : 1.0;
    const rOuter = Math.hypot(ny * 0.88, nz * 1.05);
    const conchaDip = Math.exp(-Math.pow((rOuter - 0.12) * 2.6, 2)) * (x > 0 ? 0.0045 : 0);
    const helixRim = Math.exp(-Math.pow((rOuter - 0.82) * 3.8, 2)) * 0.0022;
    const px = x * 0.44 + (x >= 0 ? helixRim - conchaDip : 0) - Math.max(0, -nz) * 0.0028;
    const py = y * 1.42;
    const pz = z * 0.88 * lobeTaper - ny * 0.0022;
    pos.setXYZ(i, px, py, pz);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Organic, asymmetric, multi-fold draped wool scarf neck wrap (ZERO stiff donut torus!).
 * Rests loosely over the collarbones & upper chest with diagonal folds and gentle wind flutter!
 */
function createDrapedScarfWrapGeometry(): THREE.BufferGeometry {
  const rings: LoftRing[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; // 0 = loose draped lower edge over chest/shoulders, 1 = soft top collar fold
    const y = THREE.MathUtils.lerp(-0.115, 0.058, t);
    // Natural loose shawl drape: wider & drooping lower over the front chest, snugger at back nape
    const ease = Math.sin(t * Math.PI);
    const rx = THREE.MathUtils.lerp(0.158, 0.094, Math.pow(t, 0.72)) + ease * 0.016;
    const rz = THREE.MathUtils.lerp(0.142, 0.092, Math.pow(t, 0.72)) + ease * 0.018;
    const frontDroop = Math.pow(1 - t, 1.25) * 0.044;
    const asymShiftX = Math.sin(t * Math.PI * 1.4) * 0.012 + (1 - t) * 0.014;
    rings.push({
      y,
      rx,
      rz,
      xShift: asymShiftX,
      zShift: 0.012 + (1 - t) * 0.022,
      frontBulge: frontDroop,
      backBulge: (1 - t) * 0.014,
      foldAmp: 0.055 + (1 - t) * 0.068,
      foldFreq: 7,
      creaseAmp: 0.032,
      windWeight: Math.pow(1 - t, 1.5) * 0.38,
    });
  }
  const geo = buildDrapedLoft(rings, 36, 0.85);
  // Add organic asymmetric diagonal scarf overlap drape (so it looks genuinely wrapped, never circular!)
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ang = Math.atan2(x, z);
    const tNorm = THREE.MathUtils.clamp((y + 0.115) / 0.173, 0, 1);
    const diagFold = Math.sin(ang * 2.0 + tNorm * 7.5) * 0.0085 * (1.15 - tNorm * 0.45);
    const frontVDrop = Math.max(0, Math.cos(ang - 0.25)) * (1 - tNorm) * 0.038;
    const radialScale = 1.0 + diagFold * 5.2;
    pos.setXYZ(i, x * radialScale, y - frontVDrop, z * radialScale);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Smooth, organic, ergonomically contoured commuter backpack (ZERO polygonal capsules!):
 * Sculpted teardrop fabric body with gravity belly & curved back, rounded front zippered pocket,
 * curved fabric top grab handle, and dual padded shoulder straps wrapping forward over the coat!
 */
function createSculptedBackpackGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  // 1. Main sculpted teardrop pack body (32 radial x 16 vertical rings — ultra-smooth curves!)
  const bodyGeo = new THREE.SphereGeometry(1, 32, 16);
  const bPos = bodyGeo.attributes.position;
  for (let i = 0; i < bPos.count; i++) {
    const nx = bPos.getX(i);
    const ny = bPos.getY(i); // -1 bottom .. +1 top
    const nz = bPos.getZ(i); // +1 toward coat back, -1 outward rear of pack

    // Teardrop silhouette: fuller & wider near the base (gravity sag), smoothly tapered dome at top
    const tUp = (ny + 1) * 0.5; // 0 bottom .. 1 top
    const widthProfile = 0.146 * (1.06 - Math.pow(tUp, 1.55) * 0.28 + Math.sin(tUp * Math.PI) * 0.08);
    const depthProfile = 0.094 * (1.12 - Math.pow(tUp, 1.4) * 0.34 + Math.sin(tUp * Math.PI) * 0.1);
    const heightHalf = 0.195;

    // Soft squircle cross-section (gently rounded edges like real canvas/nylon fabric, not a round egg!)
    const sqX = Math.sign(nx) * Math.pow(Math.abs(nx), 0.84);
    let sqZ = Math.sign(nz) * Math.pow(Math.abs(nz), 0.84);

    // Ergonomically flatten & gently curve the inner back panel (+Z) so it hugs the wearer's coat!
    if (sqZ > 0) {
      sqZ *= 0.42;
      sqZ -= (1 - Math.abs(sqX)) * 0.06;
    }

    // Subtle fabric crease around upper zipper gusset & soft bottom gravity bulge
    const zipSeam = Math.exp(-Math.pow((tUp - 0.72) * 14.0, 2)) * (sqZ < -0.2 ? -0.004 : 0);
    const px = sqX * widthProfile;
    const py = ny * heightHalf - (1 - tUp) * Math.max(0, -sqZ) * 0.016;
    const pz = sqZ * depthProfile + zipSeam;
    bPos.setXYZ(i, px, py, pz);
  }
  bodyGeo.computeVertexNormals();
  parts.push(bodyGeo);

  // 2. Smooth contoured lower-front zippered pouch pocket (24x10 smooth mesh)
  const pocketGeo = new THREE.SphereGeometry(1, 24, 10);
  const pPos = pocketGeo.attributes.position;
  for (let i = 0; i < pPos.count; i++) {
    const nx = pPos.getX(i);
    const ny = pPos.getY(i);
    const nz = pPos.getZ(i);
    const sqX = Math.sign(nx) * Math.pow(Math.abs(nx), 0.78);
    const sqY = Math.sign(ny) * Math.pow(Math.abs(ny), 0.78);
    const sqZ = nz > 0 ? nz * 0.25 : -Math.pow(Math.abs(nz), 0.82);
    pPos.setXYZ(i, sqX * 0.114, sqY * 0.082 - 0.072, sqZ * 0.044 - 0.086);
  }
  pocketGeo.computeVertexNormals();
  parts.push(pocketGeo);

  // 3. Curved woven top grab loop
  const handleCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.044, 0.172, 0.006),
    new THREE.Vector3(-0.026, 0.228, 0.012),
    new THREE.Vector3(0.026, 0.228, 0.012),
    new THREE.Vector3(0.044, 0.172, 0.006),
  ]);
  parts.push(new THREE.TubeGeometry(handleCurve, 18, 0.0085, 8, false));

  // 4. Dual smooth contoured padded shoulder straps arcing over the shoulders and down around sides!
  for (const sx of [-1, 1]) {
    const strapCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sx * 0.068, 0.165, 0.028),
      new THREE.Vector3(sx * 0.128, 0.185, 0.095),
      new THREE.Vector3(sx * 0.148, 0.105, 0.175),
      new THREE.Vector3(sx * 0.156, -0.055, 0.168),
      new THREE.Vector3(sx * 0.148, -0.155, 0.072),
      new THREE.Vector3(sx * 0.112, -0.148, 0.012),
    ]);
    const strapGeo = new THREE.TubeGeometry(strapCurve, 24, 0.016, 8, false);
    // Slightly flatten strap cross-section along X/Z for a realistic webbing/padded strap look
    strapGeo.computeVertexNormals();
    parts.push(strapGeo);
  }

  return mergeStaticGeometries(parts, false);
}

/** Short, anatomically proportional neck tucked naturally into the collar & trapezius */
function createNeckGeometry(): THREE.BufferGeometry {
  return buildDrapedLoft(
    [
      { y: -0.032, rx: 0.082, rz: 0.072, zShift: -0.006 },
      { y: 0.006, rx: 0.062, rz: 0.06, zShift: -0.003 },
      { y: 0.042, rx: 0.056, rz: 0.057, zShift: 0.0 },
      { y: 0.078, rx: 0.057, rz: 0.06, zShift: 0.003 },
    ],
    20
  );
}

/** Draped torso for high-visibility uniform vests & instanced street pedestrians (with wide overlapping shoulders!) */
function createTorsoGeometry(build: HumanBuildType, wideShoulders = false): THREE.BufferGeometry {
  const shBoost = wideShoulders ? 0.038 : 0.0;
  if (build === 'slender_female') {
    return buildDrapedLoft(
      [
        { y: -0.04, rx: 0.146, rz: 0.11, zShift: -0.004, foldAmp: 0.034, foldFreq: 7, creaseAmp: 0.012, windWeight: 0.14 },
        { y: 0.07, rx: 0.132, rz: 0.098, zShift: -0.005, foldAmp: 0.028, foldFreq: 7, creaseAmp: 0.016, windWeight: 0.06 },
        { y: 0.16, rx: 0.144, rz: 0.108, frontBulge: 0.024, zShift: 0.004, foldAmp: 0.024, foldFreq: 6, creaseAmp: 0.012 },
        { y: 0.25, rx: 0.16, rz: 0.116, frontBulge: 0.036, backBulge: 0.01, foldAmp: 0.018, foldFreq: 5 },
        { y: 0.34, rx: 0.184 + shBoost, rz: 0.112, frontBulge: 0.016, backBulge: 0.014, foldAmp: 0.016, foldFreq: 5 },
        { y: 0.415, rx: 0.182 + shBoost, rz: 0.104, zShift: -0.002, foldAmp: 0.014, foldFreq: 4 },
        { y: 0.46, rx: 0.122, rz: 0.086, zShift: -0.003 },
        { y: 0.485, rx: 0.082, rz: 0.074, zShift: -0.004 },
      ],
      26,
      0.5
    );
  }
  if (build === 'stocky_heavy') {
    return buildDrapedLoft(
      [
        { y: -0.04, rx: 0.204, rz: 0.158, frontBulge: 0.018, foldAmp: 0.032, foldFreq: 7, creaseAmp: 0.014, windWeight: 0.14 },
        { y: 0.08, rx: 0.205, rz: 0.16, frontBulge: 0.026, foldAmp: 0.028, foldFreq: 6, creaseAmp: 0.016, windWeight: 0.06 },
        { y: 0.19, rx: 0.214, rz: 0.162, frontBulge: 0.024, backBulge: 0.014, foldAmp: 0.024, foldFreq: 6 },
        { y: 0.3, rx: 0.226, rz: 0.154, frontBulge: 0.018, backBulge: 0.016, foldAmp: 0.018, foldFreq: 5 },
        { y: 0.39, rx: 0.234 + shBoost, rz: 0.142, backBulge: 0.014, foldAmp: 0.016, foldFreq: 5 },
        { y: 0.455, rx: 0.202 + shBoost, rz: 0.12 },
        { y: 0.495, rx: 0.132, rz: 0.094 },
        { y: 0.52, rx: 0.09, rz: 0.082 },
      ],
      26,
      1.3
    );
  }
  if (build === 'tall_lean') {
    return buildDrapedLoft(
      [
        { y: -0.04, rx: 0.152, rz: 0.112, foldAmp: 0.034, foldFreq: 7, creaseAmp: 0.014, windWeight: 0.14 },
        { y: 0.09, rx: 0.146, rz: 0.106, zShift: -0.004, foldAmp: 0.028, foldFreq: 7, creaseAmp: 0.015, windWeight: 0.06 },
        { y: 0.21, rx: 0.166, rz: 0.118, frontBulge: 0.014, backBulge: 0.01, foldAmp: 0.022, foldFreq: 6 },
        { y: 0.33, rx: 0.194, rz: 0.122, frontBulge: 0.018, backBulge: 0.014, foldAmp: 0.018, foldFreq: 5 },
        { y: 0.42, rx: 0.204 + shBoost, rz: 0.116, foldAmp: 0.015, foldFreq: 5 },
        { y: 0.485, rx: 0.172 + shBoost, rz: 0.102 },
        { y: 0.525, rx: 0.114, rz: 0.084 },
        { y: 0.55, rx: 0.08, rz: 0.074 },
      ],
      26,
      2.1
    );
  }
  return buildDrapedLoft(
    [
      { y: -0.04, rx: 0.168, rz: 0.124, zShift: -0.003, foldAmp: 0.032, foldFreq: 7, creaseAmp: 0.014, windWeight: 0.14 },
      { y: 0.08, rx: 0.162, rz: 0.118, zShift: -0.004, foldAmp: 0.028, foldFreq: 7, creaseAmp: 0.016, windWeight: 0.06 },
      { y: 0.19, rx: 0.184, rz: 0.13, frontBulge: 0.018, backBulge: 0.01, foldAmp: 0.022, foldFreq: 6 },
      { y: 0.3, rx: 0.21, rz: 0.138, frontBulge: 0.024, backBulge: 0.016, foldAmp: 0.018, foldFreq: 5 },
      { y: 0.39, rx: 0.222 + shBoost, rz: 0.13, backBulge: 0.016, foldAmp: 0.016, foldFreq: 5 },
      { y: 0.455, rx: 0.192 + shBoost, rz: 0.114 },
      { y: 0.495, rx: 0.126, rz: 0.09 },
      { y: 0.52, rx: 0.088, rz: 0.078 },
    ],
    26,
    0.0
  );
}

function createPelvisGeometry(build: HumanBuildType): THREE.BufferGeometry {
  const hipRx =
    build === 'slender_female'
      ? 0.178
      : build === 'stocky_heavy'
      ? 0.2
      : build === 'tall_lean'
      ? 0.152
      : 0.168;
  const hipRz =
    build === 'slender_female'
      ? 0.126
      : build === 'stocky_heavy'
      ? 0.152
      : 0.124;
  const waistRx =
    build === 'slender_female'
      ? 0.136
      : build === 'stocky_heavy'
      ? 0.194
      : build === 'tall_lean'
      ? 0.146
      : 0.16;

  return buildDrapedLoft(
    [
      { y: -0.13, rx: hipRx * 0.92, rz: hipRz * 0.92, backBulge: 0.016, foldAmp: 0.028, foldFreq: 6 },
      { y: -0.02, rx: hipRx, rz: hipRz, backBulge: 0.026, foldAmp: 0.022, foldFreq: 6 },
      { y: 0.06, rx: (hipRx + waistRx) * 0.52, rz: hipRz * 0.94, backBulge: 0.012, foldAmp: 0.02, foldFreq: 6 },
      { y: 0.13, rx: waistRx, rz: hipRz * 0.88, foldAmp: 0.018, foldFreq: 6 },
    ],
    22
  );
}

/** Flowing multi-pleat wind-animated lower coat skirt with full GPU cloth-wave wind weights! */
function createCoatSkirtGeometry(length: number, widthScale: number): THREE.BufferGeometry {
  return buildDrapedLoft(
    [
      { y: -length, rx: 0.258 * widthScale, rz: 0.194 * widthScale, backBulge: 0.032, foldAmp: 0.088, foldFreq: 9, windWeight: 1.0 },
      { y: -length * 0.74, rx: 0.236 * widthScale, rz: 0.176 * widthScale, backBulge: 0.026, foldAmp: 0.072, foldFreq: 9, windWeight: 0.72 },
      { y: -length * 0.45, rx: 0.212 * widthScale, rz: 0.158 * widthScale, backBulge: 0.018, foldAmp: 0.05, foldFreq: 8, windWeight: 0.42 },
      { y: -length * 0.18, rx: 0.188 * widthScale, rz: 0.14 * widthScale, backBulge: 0.012, foldAmp: 0.03, foldFreq: 7, windWeight: 0.16 },
      { y: 0.06, rx: 0.172 * widthScale, rz: 0.13 * widthScale, foldAmp: 0.014, foldFreq: 6, windWeight: 0.0 },
    ],
    24,
    0.4
  );
}

/** Flowing open front coat lapel/flap panel with live GPU wind ripple + natural shoulder curve! */
function createJacketFlapGeometry(sideSign: -1 | 1): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(0.136, 0.46, 6, 14);
  const pos = geo.attributes.position;
  const winds = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const tDown = THREE.MathUtils.clamp(0.5 - y / 0.46, 0, 1); // 0 at chest, 1 at bottom flap tip
    const curveZ = -Math.pow((x * sideSign + 0.055) * 4.2, 2) * 0.009;
    const rippleZ = Math.sin(tDown * Math.PI * 3.2 + sideSign) * 0.008 * tDown;
    pos.setXYZ(i, x, y - 0.23, curveZ + rippleZ);
    winds[i] = Math.pow(tDown, 1.2) * 0.95;
  }
  geo.setAttribute('aClothWind', new THREE.BufferAttribute(winds, 1));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Generous overlapping draped fabric sleeve / trouser leg for outdoor instanced pedestrians:
 * Extends cleanly PAST both top & bottom joint pivots with rounded cloth caps & loose cuffs
 * so elbows, shoulders, hips, and knees NEVER look like separated sticks or ball joints!
 */
function createOverlappingDrapedLimbGeometry(
  length: number,
  topR: number,
  midR: number,
  botR: number,
  backCurve = 0,
  radialSegs = 16,
  isSleeve = false
): THREE.BufferGeometry {
  const foldA = isSleeve ? 0.062 : 0.05;
  const topOver = isSleeve ? 0.058 : 0.065;
  const botOver = isSleeve ? 0.048 : 0.055;
  return buildDrapedLoft(
    [
      { y: -length - botOver, rx: botR * 0.88, rz: botR * 0.9, foldAmp: foldA * 0.9, foldFreq: 6, windWeight: 0.32 },
      { y: -length - botOver * 0.35, rx: botR * 1.12, rz: botR * 1.14, foldAmp: foldA * 1.25, foldFreq: 6, creaseAmp: 0.025, windWeight: 0.28 },
      { y: -length * 0.78, rx: midR * 1.02, rz: midR * 1.05, backBulge: backCurve * 0.65, foldAmp: foldA, foldFreq: 5, creaseAmp: 0.02, windWeight: 0.18 },
      { y: -length * 0.46, rx: midR * 1.1, rz: midR * 1.12, backBulge: backCurve, foldAmp: foldA * 0.95, foldFreq: 5, creaseAmp: 0.02, windWeight: 0.12 },
      { y: -length * 0.14, rx: topR * 1.08, rz: topR * 1.1, foldAmp: foldA * 0.72, foldFreq: 5, windWeight: 0.05 },
      { y: topOver * 0.45, rx: topR * 1.06, rz: topR * 1.06, foldAmp: foldA * 0.45, foldFreq: 4, windWeight: 0.02 },
      { y: topOver, rx: topR * 0.72, rz: topR * 0.72, foldAmp: foldA * 0.25, foldFreq: 4, windWeight: 0.0 },
    ],
    radialSegs,
    isSleeve ? 1.1 : 2.4
  );
}

function createSculptedShoeGeometry(): THREE.BufferGeometry {
  return buildDrapedLoft(
    [
      { y: 0.0, rx: 0.048, rz: 0.122, zShift: 0.036 },
      { y: 0.026, rx: 0.053, rz: 0.128, zShift: 0.044 },
      { y: 0.056, rx: 0.049, rz: 0.106, zShift: 0.028 },
      { y: 0.09, rx: 0.045, rz: 0.065, zShift: 0.002 },
      { y: 0.118, rx: 0.048, rz: 0.054, zShift: -0.004 },
    ],
    18
  );
}

/** Merge static BufferGeometries into one draw call (preserving position, normal, uv & optional aClothWind) */
function mergeStaticGeometries(geos: THREE.BufferGeometry[], includeWind = false): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;
  for (let g = 0; g < geos.length; g++) {
    totalVerts += geos[g].attributes.position.count;
    totalIndices += geos[g].index ? geos[g].index!.count : geos[g].attributes.position.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const winds = includeWind ? new Float32Array(totalVerts) : null;
  const indices = new Uint32Array(totalIndices);

  let vOff = 0;
  let iOff = 0;
  for (let g = 0; g < geos.length; g++) {
    const geo = geos[g];
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const pos = geo.attributes.position;
    const norm = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const wAttr = geo.attributes.aClothWind;
    const vc = pos.count;

    for (let i = 0; i < vc; i++) {
      const vi = vOff + i;
      positions[vi * 3] = pos.getX(i);
      positions[vi * 3 + 1] = pos.getY(i);
      positions[vi * 3 + 2] = pos.getZ(i);
      normals[vi * 3] = norm ? norm.getX(i) : 0;
      normals[vi * 3 + 1] = norm ? norm.getY(i) : 1;
      normals[vi * 3 + 2] = norm ? norm.getZ(i) : 0;
      uvs[vi * 2] = uv ? uv.getX(i) : 0;
      uvs[vi * 2 + 1] = uv ? uv.getY(i) : 0;
      if (winds) {
        winds[vi] = wAttr ? wAttr.getX(i) : 0;
      }
    }

    if (geo.index) {
      const idx = geo.index;
      for (let k = 0; k < idx.count; k++) {
        indices[iOff++] = idx.getX(k) + vOff;
      }
    } else {
      for (let k = 0; k < vc; k++) {
        indices[iOff++] = vOff + k;
      }
    }
    vOff += vc;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (winds) {
    out.setAttribute('aClothWind', new THREE.BufferAttribute(winds, 1));
  }
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}

// =========================================================================
// PROCEDURAL GLOSSY 3D EYEBALL MATERIALS (Untinted crisp white sclera + striated iris!)
// =========================================================================
const EYE_IRIS_PALETTE: [string, string, string][] = [
  ['#426c94', '#7ea8cc', '#c8b478'], // steel blue
  ['#5d6e3e', '#8aa05e', '#c99c52'], // emerald hazel
  ['#5c3a1e', '#8c5e34', '#c28c4e'], // warm amber-brown
  ['#301e12', '#523420', '#7a5234'], // deep espresso
  ['#4e6662', '#7c9690', '#b8b288'], // slate grey-green
];
const cachedEyeMaterials: THREE.MeshPhysicalMaterial[] = [];

function getGlossyEyeMaterial(colorIdx: number): THREE.MeshPhysicalMaterial {
  const idx = ((colorIdx % EYE_IRIS_PALETTE.length) + EYE_IRIS_PALETTE.length) % EYE_IRIS_PALETTE.length;
  if (cachedEyeMaterials[idx]) return cachedEyeMaterials[idx];

  const [outerCol, innerCol, fleckCol] = EYE_IRIS_PALETTE[idx];
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 256;
  const ctx = cv.getContext('2d')!;

  // Moist warm-white untinted sclera with subtle natural periphery shading
  const sclGrad = ctx.createRadialGradient(128, 128, 22, 128, 128, 128);
  sclGrad.addColorStop(0, '#fbfaf7');
  sclGrad.addColorStop(0.55, '#f2eee8');
  sclGrad.addColorStop(0.85, '#e2d2ca');
  sclGrad.addColorStop(1.0, '#cfaea6');
  ctx.fillStyle = sclGrad;
  ctx.fillRect(0, 0, 256, 256);

  // Subtle sclera micro-vessels near corners
  ctx.strokeStyle = 'rgba(182, 86, 82, 0.14)';
  ctx.lineWidth = 1.1;
  for (let v = 0; v < 12; v++) {
    const side = v % 2 === 0 ? -1 : 1;
    const yOff = 104 + ((v * 11) % 48);
    ctx.beginPath();
    ctx.moveTo(128 + side * 124, yOff);
    ctx.quadraticCurveTo(128 + side * 86, yOff + (v % 3 - 1) * 7, 128 + side * 52, 128 + (v % 5 - 2) * 6);
    ctx.stroke();
  }

  // Iris sits squarely at (128, 128) -> maps to +Z cornea front!
  const irisR = 35;
  // Crisp dark limbal ring
  ctx.fillStyle = '#14171c';
  ctx.beginPath();
  ctx.arc(128, 128, irisR + 3, 0, Math.PI * 2);
  ctx.fill();

  const irisGrad = ctx.createRadialGradient(128, 128, 9, 128, 128, irisR);
  irisGrad.addColorStop(0, fleckCol);
  irisGrad.addColorStop(0.32, innerCol);
  irisGrad.addColorStop(0.82, outerCol);
  irisGrad.addColorStop(1, '#12161c');
  ctx.fillStyle = irisGrad;
  ctx.beginPath();
  ctx.arc(128, 128, irisR, 0, Math.PI * 2);
  ctx.fill();

  // Radial iris stroma fibers for close-up photographic realism
  for (let f = 0; f < 56; f++) {
    const a = (f / 56) * Math.PI * 2;
    ctx.strokeStyle = f % 3 === 0 ? 'rgba(255,244,218,0.28)' : 'rgba(12,14,18,0.26)';
    ctx.lineWidth = f % 4 === 0 ? 1.5 : 0.9;
    ctx.beginPath();
    ctx.moveTo(128 + Math.cos(a) * 11, 128 + Math.sin(a) * 11);
    ctx.lineTo(128 + Math.cos(a) * (irisR - 2), 128 + Math.sin(a) * (irisR - 2));
    ctx.stroke();
  }

  // Jet-black pupil
  ctx.fillStyle = '#040507';
  ctx.beginPath();
  ctx.arc(128, 128, 13.5, 0, Math.PI * 2);
  ctx.fill();

  // Crisp moist corneal specular catchlight
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.beginPath();
  ctx.arc(120, 118, 4.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(220, 238, 255, 0.55)';
  ctx.beginPath();
  ctx.arc(136, 135, 2.2, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const mat = new THREE.MeshPhysicalMaterial({
    color: '#ffffff',
    map: tex,
    roughness: 0.04,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    envMapIntensity: 1.45,
  });
  cachedEyeMaterials[idx] = mat;
  return mat;
}

type HandGripMode = 'relaxed' | 'phone' | 'newspaper' | 'cigarette' | 'strap';

/**
 * Anatomically sculpted human hand geometry (true anatomical neutral orientation!):
 * - Wrist enters from +Y (y=+0.028 tucked inside skinned sleeve cuff -> ZERO wrist gap!)
 * - Inner palm faces INWARD (-sideSign * X), dorsum faces OUTWARD (+sideSign * X)
 * - Thumb sits on the FRONT (+Z) side (points UP toward face when elbow bends!)
 * - 4 fingers line up Index (+Z) -> Pinky (-Z) and curl INWARD toward the palm!
 * - Dedicated ergonomic grip modes ('relaxed', 'phone', 'newspaper', 'cigarette') so props NEVER clip!
 */
function buildSculptedHandGeometries(
  sideSign: -1 | 1,
  gripMode: HandGripMode = 'relaxed'
): { skin: THREE.BufferGeometry; nails: THREE.BufferGeometry } {
  const skinParts: THREE.BufferGeometry[] = [];
  const nailParts: THREE.BufferGeometry[] = [];

  // 1. Continuous wrist-to-palm anatomical loft (thin in X, wide along Z from pinky to index!)
  const palmLoft = buildDrapedLoft(
    [
      { y: -0.084, rx: 0.0115, rz: 0.035, xShift: -sideSign * 0.002, zShift: 0.002 }, // knuckle ridge
      { y: -0.062, rx: 0.0145, rz: 0.039, xShift: -sideSign * 0.002, zShift: 0.002 },
      { y: -0.035, rx: 0.0165, rz: 0.037, xShift: -sideSign * 0.001, zShift: 0.003 }, // palm body
      { y: -0.012, rx: 0.018, rz: 0.031, zShift: 0.0 }, // heel of hand
      { y: 0.006, rx: 0.0205, rz: 0.0265, zShift: 0.0 }, // carpal wrist
      { y: 0.028, rx: 0.0245, rz: 0.0295, zShift: 0.0 }, // tucked seamlessly inside sleeve cuff!
    ],
    18
  );
  skinParts.push(palmLoft);

  // Subtle thenar (thumb-base) muscle pad on the inner-front palm
  const thenarPad = new THREE.SphereGeometry(0.0175, 10, 8);
  thenarPad.scale(0.68, 1.32, 0.92);
  thenarPad.translate(-sideSign * 0.01, -0.036, 0.022);
  skinParts.push(thenarPad);

  // Helper to append a 2-segment finger curling INWARD (-sideSign * X) with dorsal fingernail on (+sideSign * X)
  const addCurvedFinger = (
    baseX: number,
    baseY: number,
    baseZ: number,
    rBase: number,
    len1: number,
    len2: number,
    curl1: number, // positive curls INWARD toward palm (-sideSign * X)!
    curl2: number,
    splayX: number, // tilt forward (+Z) or back (-Z) along hand width
    yawY = 0
  ) => {
    const qBase = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(splayX, yawY, -sideSign * curl1, 'YXZ')
    );
    const dir1 = new THREE.Vector3(0, -1, 0).applyQuaternion(qBase);
    const midPos = new THREE.Vector3(baseX, baseY, baseZ).addScaledVector(dir1, len1);

    // Subtle MCP knuckle mound
    const mcp = new THREE.SphereGeometry(rBase * 1.06, 8, 6);
    mcp.translate(baseX, baseY, baseZ);
    skinParts.push(mcp);

    // Proximal phalanx
    const seg1 = new THREE.CapsuleGeometry(rBase * 0.94, Math.max(0.007, len1 - rBase * 0.55), 4, 8);
    seg1.applyQuaternion(qBase);
    seg1.translate(
      baseX + dir1.x * len1 * 0.5,
      baseY + dir1.y * len1 * 0.5,
      baseZ + dir1.z * len1 * 0.5
    );
    skinParts.push(seg1);

    // Middle + distal phalanx curled cleanly inward
    const qDist = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(splayX * 0.55, yawY, -sideSign * (curl1 + curl2), 'YXZ')
    );
    const dir2 = new THREE.Vector3(0, -1, 0).applyQuaternion(qDist);
    const seg2 = new THREE.CapsuleGeometry(rBase * 0.8, Math.max(0.007, len2 - rBase * 0.48), 4, 8);
    seg2.applyQuaternion(qDist);
    seg2.translate(
      midPos.x + dir2.x * len2 * 0.5,
      midPos.y + dir2.y * len2 * 0.5,
      midPos.z + dir2.z * len2 * 0.5
    );
    skinParts.push(seg2);

    // Glossy dorsal fingernail on the OUTER (+sideSign * X) face of the fingertip!
    const dorsalN = new THREE.Vector3(sideSign, 0, 0).applyQuaternion(qDist);
    const tipPos = midPos.clone().addScaledVector(dir2, len2 * 0.85);
    const nail = new THREE.SphereGeometry(rBase * 0.72, 6, 5);
    nail.scale(0.24, 1.25, 0.82);
    nail.applyQuaternion(qDist);
    nail.translate(
      tipPos.x + dorsalN.x * rBase * 0.68,
      tipPos.y + dorsalN.y * rBase * 0.68,
      tipPos.z + dorsalN.z * rBase * 0.68
    );
    nailParts.push(nail);
  };

  if (gripMode === 'phone') {
    // True ergonomic smartphone portrait grip:
    // Phone width (0.068m) spans y = -0.042..-0.110 across the palm; phone height (0.136m) spans z = -0.052..+0.084!
    // Phone back sits flat on palm (x = -0.016), glowing screen faces -X (x = -0.025) toward the eyes!
    // All 4 fingers stay flat BEHIND the phone back and hook their distal tips around the y = -0.110 side bezel!
    const phoneFingers: [number, number, number, number, number, number, number, number][] = [
      // [baseZ, baseY, r, len1, len2, curl1, curl2, splayX]
      [0.026, -0.082, 0.0076, 0.033, 0.03, 0.06, 1.08, 0.04],   // Index bracing upper-back & hooking side bezel
      [0.008, -0.086, 0.0079, 0.032, 0.031, 0.06, 1.12, 0.0],   // Middle hooking side bezel
      [-0.01, -0.084, 0.0074, 0.032, 0.03, 0.08, 1.14, -0.03],  // Ring hooking side bezel
      [-0.026, -0.078, 0.0064, 0.03, 0.026, 0.14, 1.12, -0.08], // Pinky cradling lower-back edge
    ];
    for (let f = 0; f < phoneFingers.length; f++) {
      const [bz, by, r, l1, l2, c1, c2, sx] = phoneFingers[f];
      addCurvedFinger(-sideSign * 0.002, by, bz, r, l1, l2, c1, c2, sx, 0);
    }
    // Thumb rests lightly along the near (y = -0.042) bezel edge — clear of screen!
    addCurvedFinger(
      -sideSign * 0.015,
      -0.038,
      0.03,
      0.0086,
      0.026,
      0.022,
      0.48,
      0.22,
      -0.38,
      sideSign * 0.22
    );
  } else if (gripMode === 'newspaper') {
    // Classic pinch grip: 4 fingers curled smoothly behind page edge, thumb pressing flat on front margin!
    const paperFingers: [number, number, number, number, number, number, number][] = [
      [0.026, -0.082, 0.0076, 0.036, 0.035, 0.36, 0.68],
      [0.008, -0.086, 0.0079, 0.039, 0.038, 0.4, 0.72],
      [-0.01, -0.084, 0.0074, 0.036, 0.035, 0.46, 0.76],
      [-0.026, -0.078, 0.0064, 0.028, 0.028, 0.52, 0.8],
    ];
    for (let f = 0; f < paperFingers.length; f++) {
      const [bz, by, r, l1, l2, c1, c2] = paperFingers[f];
      addCurvedFinger(-sideSign * 0.003, by, bz, r, l1, l2, c1, c2, (1.4 - f) * 0.03, 0);
    }
    // Opposed thumb pinching the front edge of the newspaper!
    addCurvedFinger(
      -sideSign * 0.014,
      -0.046,
      0.032,
      0.0088,
      0.028,
      0.025,
      0.56,
      0.22,
      -0.38,
      sideSign * 0.18
    );
  } else if (gripMode === 'cigarette') {
    // Classic 2-finger V-grip: Index & Middle extend slightly splayed holding filter; Ring & Pinky curl into palm!
    addCurvedFinger(-sideSign * 0.003, -0.082, 0.027, 0.0076, 0.036, 0.036, 0.08, 0.16, 0.11, 0);  // Index
    addCurvedFinger(-sideSign * 0.003, -0.086, 0.007, 0.0079, 0.04, 0.04, 0.1, 0.18, -0.08, 0);    // Middle
    addCurvedFinger(-sideSign * 0.003, -0.084, -0.011, 0.0074, 0.036, 0.035, 0.62, 0.92, -0.04, 0); // Ring curled
    addCurvedFinger(-sideSign * 0.003, -0.078, -0.027, 0.0064, 0.028, 0.028, 0.72, 0.96, -0.06, 0); // Pinky curled
    // Thumb resting casually against curled ring finger
    addCurvedFinger(
      -sideSign * 0.014,
      -0.045,
      0.03,
      0.0088,
      0.028,
      0.024,
      0.66,
      0.34,
      -0.44,
      sideSign * 0.25
    );
  } else if (gripMode === 'strap') {
    // Firm closed cylindrical grip wrapping cleanly around overhead train strap handle!
    const strapFingers: [number, number, number, number, number, number, number][] = [
      [0.026, -0.082, 0.0078, 0.036, 0.035, 0.96, 1.38], // Index tightly wrapped around strap ring
      [0.008, -0.086, 0.0081, 0.039, 0.038, 1.00, 1.42], // Middle
      [-0.01, -0.084, 0.0076, 0.036, 0.035, 1.02, 1.44], // Ring
      [-0.026, -0.078, 0.0066, 0.029, 0.028, 1.04, 1.42], // Pinky
    ];
    for (let f = 0; f < strapFingers.length; f++) {
      const [bz, by, r, l1, l2, c1, c2] = strapFingers[f];
      addCurvedFinger(-sideSign * 0.003, by, bz, r, l1, l2, c1, c2, (1.4 - f) * 0.02, 0);
    }
    // Opposed thumb locked firmly over the front of the curled fingers closing the grip loop!
    addCurvedFinger(
      -sideSign * 0.016,
      -0.046,
      0.032,
      0.009,
      0.029,
      0.025,
      0.92,
      0.62,
      -0.58,
      sideSign * 0.34
    );
  } else {
    // Natural relaxed resting hand (palm facing inward, progressive gentle finger curl)
    const relaxedFingers: [number, number, number, number, number, number, number][] = [
      [0.026, -0.082, 0.0077, 0.036, 0.036, 0.16, 0.28], // Index
      [0.008, -0.086, 0.008, 0.04, 0.04, 0.2, 0.34],     // Middle
      [-0.01, -0.084, 0.0075, 0.037, 0.036, 0.24, 0.4],  // Ring
      [-0.026, -0.078, 0.0064, 0.029, 0.028, 0.28, 0.46], // Pinky
    ];
    for (let f = 0; f < relaxedFingers.length; f++) {
      const [bz, by, r, l1, l2, c1, c2] = relaxedFingers[f];
      const splay = (1.4 - f) * 0.042;
      addCurvedFinger(-sideSign * 0.003, by, bz, r, l1, l2, c1, c2, splay, 0);
    }
    // Natural relaxed thumb on the front (+Z) side curving gently inward
    addCurvedFinger(
      -sideSign * 0.013,
      -0.044,
      0.031,
      0.0088,
      0.028,
      0.025,
      0.36,
      0.24,
      -0.42,
      sideSign * 0.2
    );
  }

  return {
    skin: mergeStaticGeometries(skinParts, false),
    nails: mergeStaticGeometries(nailParts, false),
  };
}

/** Streamlined sculpted hand for 314 outdoor instanced pedestrians (anatomical palm-inward + thumb-forward!) */
function buildInstancedHandGeometry(sideSign: -1 | 1 = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const palm = buildDrapedLoft(
    [
      { y: -0.084, rx: 0.012, rz: 0.034, xShift: -sideSign * 0.002 },
      { y: -0.042, rx: 0.016, rz: 0.037, xShift: -sideSign * 0.001 },
      { y: 0.0, rx: 0.021, rz: 0.027 },
      { y: 0.028, rx: 0.025, rz: 0.03 },
    ],
    10
  );
  parts.push(palm);
  for (let f = 0; f < 4; f++) {
    const fg = new THREE.CapsuleGeometry(0.0072, 0.054, 3, 6);
    fg.rotateZ(-sideSign * (0.28 + f * 0.07));
    fg.translate(-sideSign * 0.014, -0.112 + Math.abs(f - 1.3) * 0.005, 0.024 - f * 0.016);
    parts.push(fg);
  }
  const thumb = new THREE.CapsuleGeometry(0.0082, 0.036, 3, 6);
  thumb.rotateX(-0.42);
  thumb.rotateZ(-sideSign * 0.34);
  thumb.translate(-sideSign * 0.018, -0.068, 0.036);
  parts.push(thumb);
  return mergeStaticGeometries(parts, false);
}

/** High-resolution silky skull-hugging hair crown (38x22 smooth mesh with natural part & organic hairline!) */
function buildSmoothHairCrown(
  rxScale = 0.94,
  ryScale = 1.04,
  rzScale = 1.05,
  coverage = Math.PI * 0.58,
  partOffsetX = 0.018
): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.098, 38, 22, 0, Math.PI * 2, 0, coverage);
  const pos = geo.attributes.position;
  const winds = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const az = Math.atan2(x, z);
    // Soft feathered organic forehead hairline (natural widow's peak & temple curve)
    const frontLift = z > 0.025 ? Math.pow(z / 0.098, 1.55) * 0.019 : 0;
    const templeCurve =
      z > 0.0 && Math.abs(x) > 0.04 ? Math.sin((Math.abs(x) / 0.098) * Math.PI) * 0.005 : 0;
    // Subtle natural hair part indentation along the crown top
    const partDip =
      y > 0.045
        ? Math.exp(-Math.pow((x - partOffsetX) * 44.0, 2)) *
          smoothstep(0.045, 0.088, y) *
          0.0046
        : 0;
    // Multi-frequency fine hair strand volume relief
    const strandWave =
      Math.sin(az * 22.0 + y * 24.0) * 0.0014 +
      Math.cos(az * 37.0 - y * 18.0) * 0.0008;
    const lowerT = THREE.MathUtils.clamp((0.03 - y) / 0.07, 0, 1);
    pos.setXYZ(
      i,
      x * rxScale * (1 + strandWave),
      y * ryScale + 0.102 + frontLift - templeCurve - partDip,
      z * rzScale * (1 + strandWave) - 0.007
    );
    winds[i] = lowerT * 0.06;
  }
  geo.setAttribute('aClothWind', new THREE.BufferAttribute(winds, 1));
  geo.computeVertexNormals();
  return geo;
}

/** High-subdivision silky, feather-tapered flowing hair lock (10x20 mesh — zero blocky card edges!) */
function buildFlowingHairRibbon(
  length: number,
  topW: number,
  botW: number,
  archZ: number,
  sweepX: number,
  windMax: number,
  wavePhase = 0
): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(1, length, 10, 20);
  const pos = geo.attributes.position;
  const winds = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i); // -0.5 .. 0.5
    const y = pos.getY(i); // -length/2 .. +length/2
    const tDown = THREE.MathUtils.clamp(0.5 - y / length, 0, 1); // 0 at root -> 1 at tip
    // Smooth organic feather taper at the ends so tips narrow into delicate silky wisps (no rectangular corners!)
    const tipFeather = Math.pow(Math.max(0.04, 1.0 - Math.pow(tDown, 2.35)), 0.62);
    const w = THREE.MathUtils.lerp(topW, botW, Math.pow(tDown, 0.78)) * tipFeather;
    const sWaveX = Math.sin(tDown * Math.PI * 2.2 + wavePhase) * 0.0075 * Math.pow(tDown, 1.15);
    const x = u * w + sweepX * Math.pow(tDown, 1.32) + sWaveX;
    // Rounded 3D cross-section curvature + silky multi-strand wave relief
    const strandGroove = Math.sin(u * Math.PI * 7.0 + tDown * 4.5 + wavePhase) * 0.0018 * (1 - tDown * 0.4);
    const curveZ =
      -Math.pow(u * 2, 2) * (0.015 * (1 - tDown * 0.45)) +
      Math.sin(tDown * Math.PI) * archZ -
      tDown * 0.015;
    const softWave =
      Math.sin(tDown * Math.PI * 2.6 + u * 3.4 + wavePhase) * 0.0052 * Math.pow(tDown, 0.9);
    // Feather the outer edges slightly shorter than center like real layered hair strands
    const edgeFeatherY = Math.pow(Math.abs(u) * 2, 1.8) * 0.018 * Math.pow(tDown, 1.4);
    pos.setXYZ(i, x, -tDown * length + edgeFeatherY, curveZ + softWave + strandGroove);
    winds[i] = Math.pow(tDown, 1.25) * windMax;
  }
  geo.setAttribute('aClothWind', new THREE.BufferAttribute(winds, 1));
  geo.computeVertexNormals();
  return geo;
}

/** High-resolution silky flowing hair for 314 outdoor street pedestrians (smooth crown + multi-ring layered drape + feathered locks!) */
function buildInstancedFlowingHairGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(buildSmoothHairCrown(0.95, 1.04, 1.05, Math.PI * 0.58, 0.016));

  // Smooth 26x8 flowing back drape with silky tapered tips & rich GPU wind waves
  const backDrape = buildDrapedLoft(
    [
      { y: -0.175, rx: 0.098, rz: 0.044, zShift: -0.056, foldAmp: 0.11, foldFreq: 11, creaseAmp: 0.032, windWeight: 1.0 },
      { y: -0.115, rx: 0.112, rz: 0.056, zShift: -0.048, foldAmp: 0.09, foldFreq: 10, creaseAmp: 0.026, windWeight: 0.72 },
      { y: -0.045, rx: 0.108, rz: 0.068, zShift: -0.036, foldAmp: 0.065, foldFreq: 9, creaseAmp: 0.02, windWeight: 0.44 },
      { y: 0.02, rx: 0.102, rz: 0.078, zShift: -0.024, foldAmp: 0.04, foldFreq: 8, windWeight: 0.18 },
      { y: 0.072, rx: 0.096, rz: 0.086, zShift: -0.015, foldAmp: 0.022, foldFreq: 7, windWeight: 0.05 },
      { y: 0.112, rx: 0.091, rz: 0.092, zShift: -0.009, windWeight: 0.0 },
    ],
    26
  );
  parts.push(backDrape);

  // Feathered face-framing side locks + windswept curtain bangs
  for (const sx of [-1, 1]) {
    const sideLock = buildFlowingHairRibbon(0.185, 0.056, 0.028, 0.014, sx * -0.015, 0.76, sx * 1.1);
    sideLock.rotateZ(sx * -0.06);
    sideLock.rotateY(sx * 1.18);
    sideLock.rotateX(0.05);
    sideLock.translate(sx * 0.086, 0.146, 0.022);
    parts.push(sideLock);

    const bang = buildFlowingHairRibbon(0.072, 0.058, 0.024, 0.015, sx * 0.024, 0.42, sx * 0.7);
    bang.rotateZ(sx * -0.15);
    bang.rotateY(sx * 0.34);
    bang.rotateX(-0.34);
    bang.translate(sx * 0.022, 0.178, 0.072);
    parts.push(bang);
  }

  return mergeStaticGeometries(parts, true);
}

/** Build silky, high-resolution, organically layered flowing hairstyles & transit uniform headwear */
function createHairOrHeadwear(
  style: HairStyleType,
  outfit: OutfitStyleType,
  hairMat: THREE.Material,
  hatMat: THREE.Material
): { group: THREE.Group; hairTailBone: THREE.Group | null } {
  const grp = new THREE.Group();
  let hairTailBone: THREE.Group | null = null;
  const zeroWind = () => 0;

  if (outfit === 'rail_engineer') {
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.112, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.54),
      hatMat
    );
    helmet.scale.set(0.98, 1.02, 1.1);
    helmet.position.set(0, 0.125, -0.002);
    grp.add(helmet);

    const brim = new THREE.Mesh(new THREE.TorusGeometry(0.106, 0.012, 12, 28), hatMat);
    brim.rotation.x = Math.PI * 0.5;
    brim.scale.set(0.98, 1.12, 1.0);
    brim.position.set(0, 0.122, 0.005);
    grp.add(brim);

    const ridge = new THREE.Mesh(new THREE.CapsuleGeometry(0.016, 0.14, 8, 16), hatMat);
    ridge.rotation.x = Math.PI * 0.5;
    ridge.position.set(0, 0.222, -0.004);
    grp.add(ridge);
    return { group: grp, hairTailBone: null };
  }

  if (outfit === 'soviet_soldier') {
    // Classic Soviet Garrison Ushanka / Field Officer Cap with crimson star badge
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.114, 0.104, 0.088, 24), hatMat);
    crown.scale.set(0.98, 1, 1.08);
    crown.position.set(0, 0.174, -0.004);
    grp.add(crown);

    const earFlapMat = new THREE.MeshStandardMaterial({ color: '#333730', roughness: 0.94 });
    for (const sx of [-1, 1]) {
      const flap = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.095, 0.092), earFlapMat);
      flap.position.set(sx * 0.106, 0.145, -0.01);
      grp.add(flap);
    }
    const frontCuff = new THREE.Mesh(new THREE.BoxGeometry(0.165, 0.078, 0.042), earFlapMat);
    frontCuff.position.set(0, 0.172, 0.098);
    grp.add(frontCuff);

    const starMat = new THREE.MeshStandardMaterial({
      color: '#c92a2a',
      emissive: new THREE.Color('#6b1010'),
      emissiveIntensity: 0.4,
      roughness: 0.35,
      metalness: 0.5,
    });
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.016, 0), starMat);
    star.scale.set(1.0, 1.0, 0.38);
    star.position.set(0, 0.176, 0.122);
    grp.add(star);
    return { group: grp, hairTailBone: null };
  }

  if (outfit === 'pow_prisoner') {
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.105, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.56),
      hatMat
    );
    cap.scale.set(0.97, 0.96, 1.08);
    cap.position.set(0, 0.132, -0.002);
    grp.add(cap);
    return { group: grp, hairTailBone: null };
  }

  if (outfit === 'metro_worker' || outfit === 'transit_security') {
    const nape = new THREE.Mesh(tagClothWindAttr(new THREE.SphereGeometry(0.092, 22, 16), zeroWind), hairMat);
    nape.scale.set(0.94, 0.78, 0.72);
    nape.position.set(0, 0.08, -0.044);
    grp.add(nape);

    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.114, 0.098, 0.072, 28), hatMat);
    crown.scale.set(0.96, 1, 1.08);
    crown.position.set(0, 0.178, -0.004);
    grp.add(crown);

    const topDome = new THREE.Mesh(
      new THREE.SphereGeometry(0.112, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.35),
      hatMat
    );
    topDome.scale.set(0.96, 0.55, 1.08);
    topDome.position.set(0, 0.198, -0.004);
    grp.add(topDome);

    const visorMat = new THREE.MeshStandardMaterial({ color: '#11151c', roughness: 0.2, metalness: 0.38 });
    const visor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.094, 0.104, 0.012, 22, 1, false, -Math.PI * 0.38, Math.PI * 0.76),
      visorMat
    );
    visor.position.set(0, 0.138, 0.056);
    visor.rotation.x = 0.16;
    grp.add(visor);

    const emblemMat = new THREE.MeshStandardMaterial({
      color: outfit === 'metro_worker' ? '#e6b842' : '#cfd8e3',
      roughness: 0.25,
      metalness: 0.85,
    });
    const emblem = new THREE.Mesh(new THREE.SphereGeometry(0.014, 14, 12), emblemMat);
    emblem.scale.set(1, 1.2, 0.45);
    emblem.position.set(0, 0.178, 0.108);
    grp.add(emblem);
    return { group: grp, hairTailBone: null };
  }

  if (style === 'short_cropped' || style === 'side_part') {
    const partX = style === 'side_part' ? -0.036 : 0.012;
    grp.add(new THREE.Mesh(buildSmoothHairCrown(0.945, 1.04, 1.055, Math.PI * 0.58, partX), hairMat));

    hairTailBone = new THREE.Group();
    hairTailBone.position.set(0, 0.106, -0.018);
    grp.add(hairTailBone);

    // Smooth layered nape flow catching breeze at the collar
    const napeFlow = new THREE.Mesh(
      buildDrapedLoft(
        [
          { y: -0.105, rx: 0.084, rz: 0.046, zShift: -0.048, foldAmp: 0.085, foldFreq: 11, creaseAmp: 0.025, windWeight: 0.56 },
          { y: -0.068, rx: 0.092, rz: 0.058, zShift: -0.039, foldAmp: 0.068, foldFreq: 10, creaseAmp: 0.02, windWeight: 0.36 },
          { y: -0.028, rx: 0.094, rz: 0.070, zShift: -0.027, foldAmp: 0.046, foldFreq: 9, windWeight: 0.18 },
          { y: 0.008, rx: 0.092, rz: 0.079, zShift: -0.016, foldAmp: 0.024, foldFreq: 8, windWeight: 0.04 },
          { y: 0.032, rx: 0.089, rz: 0.084, zShift: -0.008, windWeight: 0.0 },
        ],
        28
      ),
      hairMat
    );
    hairTailBone.add(napeFlow);

    // Layered feathered windswept fringe across forehead
    const fringeMain = new THREE.Mesh(
      buildFlowingHairRibbon(0.082, 0.118, 0.064, 0.018, style === 'side_part' ? 0.036 : 0.018, 0.48, 0.4),
      hairMat
    );
    fringeMain.position.set(style === 'side_part' ? 0.012 : 0.0, 0.180, 0.071);
    fringeMain.rotation.set(-0.36, style === 'side_part' ? 0.24 : 0.08, 0.08);
    grp.add(fringeMain);

    const fringeUpper = new THREE.Mesh(
      buildFlowingHairRibbon(0.068, 0.078, 0.038, 0.022, style === 'side_part' ? 0.044 : -0.018, 0.56, 1.9),
      hairMat
    );
    fringeUpper.position.set(style === 'side_part' ? -0.012 : 0.016, 0.186, 0.068);
    fringeUpper.rotation.set(-0.32, style === 'side_part' ? 0.14 : -0.16, 0.04);
    grp.add(fringeUpper);

    // Soft feathered temple wisps framing the ears
    for (const sx of [-1, 1]) {
      const wisp = new THREE.Mesh(
        buildFlowingHairRibbon(0.094, 0.042, 0.018, 0.009, sx * -0.012, 0.42, sx * 1.2),
        hairMat
      );
      wisp.position.set(sx * 0.085, 0.140, 0.012);
      wisp.rotation.set(0.04, sx * 1.44, sx * -0.04);
      grp.add(wisp);
    }
  } else if (style === 'long_flowing') {
    // Silky, high-resolution, multi-layered flowing shoulder-to-back hair!
    grp.add(new THREE.Mesh(buildSmoothHairCrown(0.965, 1.055, 1.065, Math.PI * 0.6, 0.012), hairMat));

    hairTailBone = new THREE.Group();
    hairTailBone.position.set(0, 0.104, -0.022);
    grp.add(hairTailBone);

    // Smooth 32x10 inner curtain volume with tapered ends & silky folds
    const backCurtain = new THREE.Mesh(
      buildDrapedLoft(
        [
          { y: -0.37, rx: 0.108, rz: 0.038, zShift: -0.068, foldAmp: 0.135, foldFreq: 13, creaseAmp: 0.036, windWeight: 1.08 },
          { y: -0.31, rx: 0.128, rz: 0.048, zShift: -0.060, foldAmp: 0.115, foldFreq: 12, creaseAmp: 0.032, windWeight: 0.94 },
          { y: -0.24, rx: 0.128, rz: 0.056, zShift: -0.050, foldAmp: 0.095, foldFreq: 11, creaseAmp: 0.026, windWeight: 0.72 },
          { y: -0.17, rx: 0.122, rz: 0.064, zShift: -0.040, foldAmp: 0.075, foldFreq: 10, creaseAmp: 0.022, windWeight: 0.48 },
          { y: -0.10, rx: 0.112, rz: 0.072, zShift: -0.029, foldAmp: 0.054, foldFreq: 9, windWeight: 0.28 },
          { y: -0.04, rx: 0.102, rz: 0.080, zShift: -0.017, foldAmp: 0.034, foldFreq: 8, windWeight: 0.11 },
          { y: 0.015, rx: 0.095, rz: 0.086, zShift: -0.004, windWeight: 0.0 },
        ],
        32
      ),
      hairMat
    );
    hairTailBone.add(backCurtain);

    // Overlapping outer flowing silky back locks so silhouette breaks into genuine hair strands!
    for (let k = -2; k <= 2; k++) {
      const ang = Math.PI + k * 0.42;
      const lockLen = 0.34 - Math.abs(k) * 0.024;
      const outerLock = new THREE.Mesh(
        buildFlowingHairRibbon(lockLen, 0.068, 0.036, 0.022, k * 0.014, 1.02, k * 1.15),
        hairMat
      );
      outerLock.position.set(Math.sin(ang) * 0.086, 0.022, Math.cos(ang) * 0.078 - 0.014);
      outerLock.rotation.set(0.14, ang, k * 0.04);
      hairTailBone.add(outerLock);
    }

    // Layered face-framing flowing side curtains (inner + wispy outer locks) streaming in the breeze
    for (const sx of [-1, 1]) {
      const sideLock = new THREE.Mesh(
        buildFlowingHairRibbon(0.295, 0.070, 0.036, 0.018, sx * -0.016, 0.92, sx * 0.9),
        hairMat
      );
      sideLock.position.set(sx * 0.086, 0.148, 0.020);
      sideLock.rotation.set(0.06, sx * 1.24, sx * -0.05);
      grp.add(sideLock);

      const frontTendril = new THREE.Mesh(
        buildFlowingHairRibbon(0.215, 0.042, 0.018, 0.016, sx * -0.012, 0.88, sx * 2.4),
        hairMat
      );
      frontTendril.position.set(sx * 0.078, 0.156, 0.044);
      frontTendril.rotation.set(0.02, sx * 0.88, sx * -0.08);
      grp.add(frontTendril);
    }

    // Soft parted curtain bangs with layered wispy volume
    for (const sx of [-1, 1]) {
      const bang = new THREE.Mesh(
        buildFlowingHairRibbon(0.098, 0.068, 0.028, 0.018, sx * 0.028, 0.44, sx * 0.6),
        hairMat
      );
      bang.position.set(sx * 0.024, 0.180, 0.072);
      bang.rotation.set(-0.34, sx * 0.36, sx * -0.16);
      grp.add(bang);
    }
  } else if (style === 'bob_cut') {
    // Silky smooth chin-to-shoulder layered bob with feathered movement!
    grp.add(new THREE.Mesh(buildSmoothHairCrown(0.965, 1.05, 1.06, Math.PI * 0.6, -0.016), hairMat));

    hairTailBone = new THREE.Group();
    hairTailBone.position.set(0, 0.102, -0.016);
    grp.add(hairTailBone);

    const bobCurtain = new THREE.Mesh(
      buildDrapedLoft(
        [
          { y: -0.175, rx: 0.106, rz: 0.062, zShift: -0.040, foldAmp: 0.095, foldFreq: 12, creaseAmp: 0.028, windWeight: 0.82 },
          { y: -0.125, rx: 0.118, rz: 0.074, zShift: -0.032, foldAmp: 0.076, foldFreq: 11, creaseAmp: 0.022, windWeight: 0.56 },
          { y: -0.068, rx: 0.115, rz: 0.084, zShift: -0.024, foldAmp: 0.052, foldFreq: 10, windWeight: 0.30 },
          { y: -0.020, rx: 0.106, rz: 0.090, zShift: -0.015, foldAmp: 0.028, foldFreq: 8, windWeight: 0.10 },
          { y: 0.018, rx: 0.098, rz: 0.093, zShift: -0.006, windWeight: 0.0 },
        ],
        32
      ),
      hairMat
    );
    hairTailBone.add(bobCurtain);

    for (const sx of [-1, 1]) {
      const sideFlow = new THREE.Mesh(
        buildFlowingHairRibbon(0.185, 0.068, 0.038, 0.018, sx * -0.012, 0.72, sx * 0.8),
        hairMat
      );
      sideFlow.position.set(sx * 0.088, 0.145, 0.022);
      sideFlow.rotation.set(0.05, sx * 1.24, sx * -0.05);
      grp.add(sideFlow);

      const cheekWisp = new THREE.Mesh(
        buildFlowingHairRibbon(0.145, 0.040, 0.018, 0.016, sx * -0.008, 0.64, sx * 2.1),
        hairMat
      );
      cheekWisp.position.set(sx * 0.076, 0.154, 0.048);
      cheekWisp.rotation.set(0.02, sx * 0.82, sx * -0.08);
      grp.add(cheekWisp);
    }

    const sweptFringe = new THREE.Mesh(
      buildFlowingHairRibbon(0.088, 0.108, 0.044, 0.018, 0.032, 0.42, 0.5),
      hairMat
    );
    sweptFringe.position.set(0.010, 0.180, 0.072);
    sweptFringe.rotation.set(-0.34, 0.22, -0.12);
    grp.add(sweptFringe);
  } else if (style === 'ponytail') {
    grp.add(new THREE.Mesh(buildSmoothHairCrown(0.945, 1.045, 1.055, Math.PI * 0.6, 0.0), hairMat));

    hairTailBone = new THREE.Group();
    hairTailBone.position.set(0, 0.098, -0.094);
    grp.add(hairTailBone);

    const tail = new THREE.Mesh(
      buildDrapedLoft(
        [
          { y: -0.33, rx: 0.022, rz: 0.020, zShift: -0.066, foldAmp: 0.12, foldFreq: 9, creaseAmp: 0.03, windWeight: 1.08 },
          { y: -0.24, rx: 0.046, rz: 0.044, zShift: -0.054, foldAmp: 0.09, foldFreq: 8, creaseAmp: 0.024, windWeight: 0.80 },
          { y: -0.15, rx: 0.052, rz: 0.052, zShift: -0.038, foldAmp: 0.065, foldFreq: 8, windWeight: 0.48 },
          { y: -0.06, rx: 0.046, rz: 0.048, zShift: -0.022, foldAmp: 0.035, foldFreq: 7, windWeight: 0.18 },
          { y: 0.0, rx: 0.024, rz: 0.024, zShift: 0.0, windWeight: 0.0 },
        ],
        24
      ),
      hairMat
    );
    hairTailBone.add(tail);

    // Outer flowing strands trailing off the ponytail
    for (const sx of [-1, 1]) {
      const tailRibbon = new THREE.Mesh(
        buildFlowingHairRibbon(0.28, 0.038, 0.016, 0.022, sx * 0.016, 1.05, sx * 1.4),
        hairMat
      );
      tailRibbon.position.set(sx * 0.022, -0.02, -0.022);
      tailRibbon.rotation.set(0.22, Math.PI + sx * 0.42, sx * 0.08);
      hairTailBone.add(tailRibbon);

      // Loose wind-blown temple tendrils framing the face
      const tendril = new THREE.Mesh(
        buildFlowingHairRibbon(0.135, 0.030, 0.012, 0.014, sx * -0.014, 0.64, sx * 1.8),
        hairMat
      );
      tendril.position.set(sx * 0.080, 0.142, 0.028);
      tendril.rotation.set(0.08, sx * 1.02, sx * -0.06);
      grp.add(tendril);
    }
  } else if (style === 'knit_beanie') {
    hairTailBone = new THREE.Group();
    hairTailBone.position.set(0, 0.096, -0.02);
    grp.add(hairTailBone);

    const underFlow = new THREE.Mesh(
      buildDrapedLoft(
        [
          { y: -0.165, rx: 0.104, rz: 0.056, zShift: -0.048, foldAmp: 0.095, foldFreq: 10, creaseAmp: 0.026, windWeight: 0.84 },
          { y: -0.095, rx: 0.105, rz: 0.068, zShift: -0.038, foldAmp: 0.07, foldFreq: 9, windWeight: 0.50 },
          { y: -0.030, rx: 0.098, rz: 0.078, zShift: -0.025, foldAmp: 0.04, foldFreq: 8, windWeight: 0.22 },
          { y: 0.020, rx: 0.092, rz: 0.084, zShift: -0.010, windWeight: 0.0 },
        ],
        26
      ),
      hairMat
    );
    hairTailBone.add(underFlow);

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.105, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.55),
      hatMat
    );
    dome.scale.set(0.95, 1.15, 1.06);
    dome.position.set(0, 0.108, -0.005);
    grp.add(dome);

    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.017, 14, 28), hatMat);
    cuff.rotation.x = Math.PI * 0.5 - 0.14;
    cuff.scale.set(0.94, 1.06, 1.0);
    cuff.position.set(0, 0.128, -0.006);
    grp.add(cuff);
  } else {
    // Medium wavy windswept flowing hair with smooth layered curtains!
    grp.add(new THREE.Mesh(buildSmoothHairCrown(0.955, 1.05, 1.06, Math.PI * 0.59, -0.02), hairMat));

    hairTailBone = new THREE.Group();
    hairTailBone.position.set(0, 0.104, -0.018);
    grp.add(hairTailBone);

    const medFlow = new THREE.Mesh(
      buildDrapedLoft(
        [
          { y: -0.205, rx: 0.112, rz: 0.052, zShift: -0.052, foldAmp: 0.105, foldFreq: 12, creaseAmp: 0.03, windWeight: 0.94 },
          { y: -0.140, rx: 0.118, rz: 0.064, zShift: -0.042, foldAmp: 0.082, foldFreq: 11, creaseAmp: 0.024, windWeight: 0.65 },
          { y: -0.072, rx: 0.110, rz: 0.075, zShift: -0.030, foldAmp: 0.056, foldFreq: 9, windWeight: 0.36 },
          { y: -0.020, rx: 0.102, rz: 0.082, zShift: -0.018, foldAmp: 0.032, foldFreq: 8, windWeight: 0.12 },
          { y: 0.015, rx: 0.094, rz: 0.086, zShift: -0.008, windWeight: 0.0 },
        ],
        30
      ),
      hairMat
    );
    hairTailBone.add(medFlow);

    for (const sx of [-1, 1]) {
      const sideWave = new THREE.Mesh(
        buildFlowingHairRibbon(0.185, 0.058, 0.026, 0.016, sx * -0.014, 0.72, sx * 1.3),
        hairMat
      );
      sideWave.position.set(sx * 0.086, 0.146, 0.020);
      sideWave.rotation.set(0.05, sx * 1.22, sx * -0.05);
      grp.add(sideWave);
    }

    const sweptBang = new THREE.Mesh(
      buildFlowingHairRibbon(0.092, 0.116, 0.052, 0.018, -0.030, 0.52, 0.9),
      hairMat
    );
    sweptBang.position.set(-0.010, 0.180, 0.072);
    sweptBang.rotation.set(-0.34, -0.22, -0.10);
    grp.add(sweptBang);
  }

  return { group: grp, hairTailBone };
}

// =========================================================================
// CACHED GEOMETRY LIBRARY (Built once, shared across ALL humans for 60 FPS!)
// =========================================================================
export interface SharedHumanGeometries {
  headMale: THREE.BufferGeometry;
  headFemale: THREE.BufferGeometry;
  neck: THREE.BufferGeometry;
  ear: THREE.BufferGeometry;
  eyeball: THREE.BufferGeometry;
  upperEyelid: THREE.BufferGeometry;
  lowerEyelid: THREE.BufferGeometry;
  eyelashRim: THREE.BufferGeometry;
  eyebrowArch: THREE.BufferGeometry;
  torso: Record<HumanBuildType, THREE.BufferGeometry>;
  pelvis: Record<HumanBuildType, THREE.BufferGeometry>;
  skinnedJacketCache: Map<string, THREE.BufferGeometry>;
  skinnedTrousers: Record<HumanBuildType, THREE.BufferGeometry>;
  jacketFlapLeft: THREE.BufferGeometry;
  jacketFlapRight: THREE.BufferGeometry;
  handSkinLeft: THREE.BufferGeometry;
  handSkinRight: THREE.BufferGeometry;
  handNailsLeft: THREE.BufferGeometry;
  handNailsRight: THREE.BufferGeometry;
  handPhoneSkinRight: THREE.BufferGeometry;
  handPhoneNailsRight: THREE.BufferGeometry;
  handPaperSkinLeft: THREE.BufferGeometry;
  handPaperNailsLeft: THREE.BufferGeometry;
  handPaperSkinRight: THREE.BufferGeometry;
  handPaperNailsRight: THREE.BufferGeometry;
  handCigSkinRight: THREE.BufferGeometry;
  handCigNailsRight: THREE.BufferGeometry;
  handStrapSkinLeft: THREE.BufferGeometry;
  handStrapNailsLeft: THREE.BufferGeometry;
  handStrapSkinRight: THREE.BufferGeometry;
  handStrapNailsRight: THREE.BufferGeometry;
  shoe: THREE.BufferGeometry;
  scarfWrap: THREE.BufferGeometry;
  scarfTail: THREE.BufferGeometry;
  scarfSideTail: THREE.BufferGeometry;
  collarLapel: THREE.BufferGeometry;
  hoodDrape: THREE.BufferGeometry;
  backpack: THREE.BufferGeometry;
  // Activity prop geometries
  newspaperSheet: THREE.BufferGeometry;
  phoneBody: THREE.BufferGeometry;
  phoneScreen: THREE.BufferGeometry;
  cigBody: THREE.BufferGeometry;
  cigFilter: THREE.BufferGeometry;
  cigEmber: THREE.BufferGeometry;
  // Seamless draped instanced geometries for 314 city street pedestrians
  instHead: THREE.BufferGeometry;
  instTorso: THREE.BufferGeometry;
  instPelvis: THREE.BufferGeometry;
  instCoatSkirt: THREE.BufferGeometry;
  instScarf: THREE.BufferGeometry;
  instThigh: THREE.BufferGeometry;
  instShin: THREE.BufferGeometry;
  instUpperArm: THREE.BufferGeometry;
  instForearm: THREE.BufferGeometry;
  instHandLeft: THREE.BufferGeometry;
  instHandRight: THREE.BufferGeometry;
  instBriefcase: THREE.BufferGeometry;
  instShoe: THREE.BufferGeometry;
  instHairCap: THREE.BufferGeometry;
  instFlowHair: THREE.BufferGeometry;
}

let cachedGeos: SharedHumanGeometries | null = null;

function createCurvedNewspaperGeometry(): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(0.42, 0.31, 10, 6);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const foldZ = Math.abs(x) * 0.24 - Math.pow(Math.abs(x), 2) * 0.35;
    // Gentle outward upper-page broadsheet curl away from reader's face (+Z)
    const droopZ = Math.max(0, y) * 0.088 * (0.42 + Math.abs(x) * 2.1);
    pos.setZ(i, foldZ + droopZ);
  }
  geo.computeVertexNormals();
  return geo;
}

export function getSharedHumanGeometries(): SharedHumanGeometries {
  if (cachedGeos) return cachedGeos;

  const shoe = createSculptedShoeGeometry();
  const handLeft = buildSculptedHandGeometries(-1, 'relaxed');
  const handRight = buildSculptedHandGeometries(1, 'relaxed');
  const handPhoneRight = buildSculptedHandGeometries(1, 'phone');
  const handPaperLeft = buildSculptedHandGeometries(-1, 'newspaper');
  const handPaperRight = buildSculptedHandGeometries(1, 'newspaper');
  const handCigRight = buildSculptedHandGeometries(1, 'cigarette');
  const handStrapLeft = buildSculptedHandGeometries(-1, 'strap');
  const handStrapRight = buildSculptedHandGeometries(1, 'strap');

  // Sculpted commuter briefcase/tote with top handle anchored at origin (0,0,0) = exact hand grip point!
  const briefBody = new THREE.BoxGeometry(0.088, 0.28, 0.36);
  briefBody.translate(0, -0.21, 0);
  const briefHandleTop = new THREE.CylinderGeometry(0.011, 0.011, 0.13, 8);
  briefHandleTop.rotateX(Math.PI * 0.5);
  briefHandleTop.translate(0, -0.012, 0);
  const briefPostF = new THREE.CylinderGeometry(0.009, 0.009, 0.068, 6);
  briefPostF.translate(0, -0.044, 0.06);
  const briefPostB = new THREE.CylinderGeometry(0.009, 0.009, 0.068, 6);
  briefPostB.translate(0, -0.044, -0.06);
  const instBriefcase = mergeStaticGeometries([briefBody, briefHandleTop, briefPostF, briefPostB], false);

  // 3D glossy clearcoat eyeball rotated so canvas center (u=0.5, v=0.5) faces straight forward (+Z)!
  const eyeball = new THREE.SphereGeometry(0.0132, 24, 18);
  eyeball.rotateY(-Math.PI * 0.5);

  const upperEyelid = new THREE.SphereGeometry(0.0143, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.45);
  const lowerEyelid = new THREE.SphereGeometry(0.0140, 18, 8, 0, Math.PI * 2, Math.PI * 0.67, Math.PI * 0.33);
  const eyelashRim = new THREE.TorusGeometry(0.0142, 0.0012, 6, 18, Math.PI * 0.86);
  eyelashRim.rotateX(Math.PI * 0.5);
  eyelashRim.rotateY(Math.PI * 0.07);

  const eyebrowArch = new THREE.CapsuleGeometry(0.0025, 0.024, 5, 10);
  eyebrowArch.rotateZ(Math.PI * 0.5);
  eyebrowArch.scale(1.0, 0.72, 0.65);

  // Seamless overlapping draped geometries for 314 street pedestrians (zero exposed joints!)
  const instHead = createSculptedHeadGeometry(0.35, 28, 22);
  const instTorso = createTorsoGeometry('athletic_male', true);
  const instPelvis = createPelvisGeometry('athletic_male');
  const instCoatSkirt = createCoatSkirtGeometry(0.46, 1.05);
  const instThigh = createOverlappingDrapedLimbGeometry(0.425, 0.096, 0.088, 0.074, 0.01, 14, false);
  const instShin = createOverlappingDrapedLimbGeometry(0.415, 0.072, 0.068, 0.056, 0.014, 14, false);
  const instUpperArm = createOverlappingDrapedLimbGeometry(0.285, 0.068, 0.062, 0.056, 0.006, 14, true);
  const instForearm = createOverlappingDrapedLimbGeometry(0.255, 0.054, 0.05, 0.042, 0.005, 14, true);
  const instHandLeft = buildInstancedHandGeometry(-1);
  const instHandRight = buildInstancedHandGeometry(1);
  const instShoe = createSculptedShoeGeometry();
  const instHairCap = buildSmoothHairCrown(0.94, 1.05, 1.05, Math.PI * 0.6);
  const instFlowHair = buildInstancedFlowingHairGeometry();

  // Organic non-donut flowing draped scarf wrap + trailing wind-blown tail for street pedestrians!
  const instScarfWrap = createDrapedScarfWrapGeometry();
  const instScarfTail = buildDrapedLoft(
    [
      { y: -0.42, rx: 0.062, rz: 0.015, zShift: 0.145, xShift: 0.056, foldAmp: 0.22, foldFreq: 7, creaseAmp: 0.035, windWeight: 1.05 },
      { y: -0.29, rx: 0.058, rz: 0.018, zShift: 0.140, xShift: 0.050, foldAmp: 0.17, foldFreq: 6, creaseAmp: 0.028, windWeight: 0.72 },
      { y: -0.15, rx: 0.054, rz: 0.022, zShift: 0.128, xShift: 0.042, foldAmp: 0.12, foldFreq: 5, windWeight: 0.36 },
      { y: -0.04, rx: 0.048, rz: 0.025, zShift: 0.108, xShift: 0.032, foldAmp: 0.06, foldFreq: 4, windWeight: 0.10 },
    ],
    20
  );
  const instScarf = mergeStaticGeometries([instScarfWrap, instScarfTail], true);

  // Flowing multi-fold draped scarf main tail & shorter layered shoulder side-tail for close-up civilians!
  const scarfWrap = createDrapedScarfWrapGeometry();
  const scarfTailGeo = buildDrapedLoft(
    [
      { y: -0.44, rx: 0.064, rz: 0.013, foldAmp: 0.24, foldFreq: 7, creaseAmp: 0.036, windWeight: 1.08 },
      { y: -0.34, rx: 0.060, rz: 0.015, foldAmp: 0.19, foldFreq: 7, creaseAmp: 0.03, windWeight: 0.84 },
      { y: -0.24, rx: 0.056, rz: 0.017, foldAmp: 0.15, foldFreq: 6, creaseAmp: 0.024, windWeight: 0.58 },
      { y: -0.14, rx: 0.050, rz: 0.019, foldAmp: 0.11, foldFreq: 5, windWeight: 0.30 },
      { y: -0.05, rx: 0.046, rz: 0.021, foldAmp: 0.06, foldFreq: 5, windWeight: 0.10 },
      { y: 0.01, rx: 0.042, rz: 0.022, windWeight: 0.0 },
    ],
    24
  );
  const scarfSideTailGeo = buildDrapedLoft(
    [
      { y: -0.27, rx: 0.052, rz: 0.012, foldAmp: 0.20, foldFreq: 6, creaseAmp: 0.03, windWeight: 0.96 },
      { y: -0.18, rx: 0.048, rz: 0.015, foldAmp: 0.15, foldFreq: 6, windWeight: 0.60 },
      { y: -0.09, rx: 0.044, rz: 0.018, foldAmp: 0.09, foldFreq: 5, windWeight: 0.24 },
      { y: 0.01, rx: 0.040, rz: 0.020, windWeight: 0.0 },
    ],
    20
  );

  const collarLapel = tagClothWindAttr(
    new THREE.TorusGeometry(0.112, 0.029, 14, 28, Math.PI * 1.48),
    () => 0.04
  );
  const hoodDrape = tagClothWindAttr(
    new THREE.SphereGeometry(0.124, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.58),
    (_x, y, z) => (z < -0.02 ? THREE.MathUtils.clamp((0.06 - y) * 3.0, 0, 0.45) : 0.05)
  );
  const backpack = createSculptedBackpackGeometry();

  cachedGeos = {
    headMale: createSculptedHeadGeometry(0.12, 96, 72),
    headFemale: createSculptedHeadGeometry(0.85, 96, 72),
    neck: createNeckGeometry(),
    ear: createSculptedEarGeometry(),
    eyeball,
    upperEyelid,
    lowerEyelid,
    eyelashRim,
    eyebrowArch,
    torso: {
      athletic_male: createTorsoGeometry('athletic_male'),
      slender_female: createTorsoGeometry('slender_female'),
      stocky_heavy: createTorsoGeometry('stocky_heavy'),
      tall_lean: createTorsoGeometry('tall_lean'),
    },
    pelvis: {
      athletic_male: createPelvisGeometry('athletic_male'),
      slender_female: createPelvisGeometry('slender_female'),
      stocky_heavy: createPelvisGeometry('stocky_heavy'),
      tall_lean: createPelvisGeometry('tall_lean'),
    },
    skinnedJacketCache: new Map<string, THREE.BufferGeometry>(),
    skinnedTrousers: {
      athletic_male: buildSkinnedTrousersGeo('athletic_male'),
      slender_female: buildSkinnedTrousersGeo('slender_female'),
      stocky_heavy: buildSkinnedTrousersGeo('stocky_heavy'),
      tall_lean: buildSkinnedTrousersGeo('tall_lean'),
    },
    jacketFlapLeft: createJacketFlapGeometry(-1),
    jacketFlapRight: createJacketFlapGeometry(1),
    handSkinLeft: handLeft.skin,
    handSkinRight: handRight.skin,
    handNailsLeft: handLeft.nails,
    handNailsRight: handRight.nails,
    handPhoneSkinRight: handPhoneRight.skin,
    handPhoneNailsRight: handPhoneRight.nails,
    handPaperSkinLeft: handPaperLeft.skin,
    handPaperNailsLeft: handPaperLeft.nails,
    handPaperSkinRight: handPaperRight.skin,
    handPaperNailsRight: handPaperRight.nails,
    handCigSkinRight: handCigRight.skin,
    handCigNailsRight: handCigRight.nails,
    handStrapSkinLeft: handStrapLeft.skin,
    handStrapNailsLeft: handStrapLeft.nails,
    handStrapSkinRight: handStrapRight.skin,
    handStrapNailsRight: handStrapRight.nails,
    shoe,
    scarfWrap,
    scarfTail: scarfTailGeo,
    scarfSideTail: scarfSideTailGeo,
    collarLapel,
    hoodDrape,
    backpack,
    newspaperSheet: createCurvedNewspaperGeometry(),
    // Ergonomic portrait smartphone: thin in X (0.0085m), width across palm Y (0.068m), tall height along Z (0.136m)!
    phoneBody: new THREE.BoxGeometry(0.0085, 0.068, 0.136),
    phoneScreen: new THREE.PlaneGeometry(0.061, 0.124),
    cigBody: new THREE.CylinderGeometry(0.0036, 0.0036, 0.054, 8),
    cigFilter: new THREE.CylinderGeometry(0.0038, 0.0038, 0.022, 8),
    cigEmber: new THREE.SphereGeometry(0.0042, 8, 8),
    instHead,
    instTorso,
    instPelvis,
    instCoatSkirt,
    instScarf,
    instThigh,
    instShin,
    instUpperArm,
    instForearm,
    instHandLeft,
    instHandRight,
    instBriefcase,
    instShoe,
    instHairCap,
    instFlowHair,
  };

  return cachedGeos;
}

function getCachedSkinnedJacket(
  geos: SharedHumanGeometries,
  build: HumanBuildType,
  outfit: OutfitStyleType
): THREE.BufferGeometry {
  const key = `${build}:${outfit}`;
  let geo = geos.skinnedJacketCache.get(key);
  if (!geo) {
    geo = buildSkinnedJacketAndSleevesGeo(build, outfit);
    geos.skinnedJacketCache.set(key, geo);
  }
  return geo;
}

// =========================================================================
// VARIED CIVILIAN JACKETS & TRANSIT UNIFORMS PALETTES
// =========================================================================
const SKIN_PALETTE = ['#e5c0a8', '#d8ae92', '#c5977a', '#f0ceb8', '#a6765a', '#deb59b', '#bc8a6e'];
const HAIR_PALETTE = ['#1d1916', '#38281e', '#5a412d', '#8c7150', '#6e3422', '#8a8b90', '#26201c'];
const CIVILIAN_JACKET_COLORS = [
  '#3e4f63', // slate wool overcoat
  '#82664a', // camel trench
  '#2f5448', // forest parka
  '#7e313d', // burgundy puffer
  '#292b32', // black leather biker
  '#524e46', // olive field jacket
  '#375476', // navy tailored coat
  '#6f4b64', // plum wool coat
  '#905d3a', // cognac suede
  '#565f6c', // heather grey hoodie/cardigan
  '#2c4a62', // deep petrol blue
  '#683d35', // rust shearling
];
const PANTS_PALETTE = ['#242c38', '#323947', '#3d3832', '#263346', '#46413a', '#2c313c'];
const SHOE_PALETTE = ['#1e1b19', '#3f2c20', '#2a2e36', '#523a2c', '#cfd6de'];
const SCARF_PALETTE = ['#a0343e', '#387082', '#b98d46', '#587252', '#825c78', '#dcd2c4'];

const BUILDS: HumanBuildType[] = ['athletic_male', 'slender_female', 'stocky_heavy', 'tall_lean'];
const MALE_HAIRS: HairStyleType[] = ['side_part', 'newsboy_cap', 'short_cropped', 'long_flowing', 'knit_beanie'];
const FEMALE_HAIRS: HairStyleType[] = ['long_flowing', 'bob_cut', 'ponytail', 'long_flowing'];
const CIVILIAN_OUTFITS: OutfitStyleType[] = [
  'trench_coat',
  'puffer_jacket',
  'leather_biker',
  'hoodie_parka',
  'tailored_blazer',
  'cardigan_scarf',
];

/**
 * Create a lifelike, seamlessly clothed, SkinnedMesh human:
 * - ZERO exposed ball joints (continuous skinned jacket+sleeves+coat-hem & skinned draped trousers!)
 * - Live GPU vertex-shader cloth wind ripples + secondary articulated cloth bones
 * - Varied civilian jackets/coats/scarves & transit uniforms + newspaper / phone / smoking props!
 */
export function createRiggedHuman(
  variantIdx: number,
  textures: TextureLibrary,
  forcedOutfit?: OutfitStyleType,
  forcedActivity?: CommuterActivityType
): HumanRig {
  const geos = getSharedHumanGeometries();
  const outfit: OutfitStyleType =
    forcedOutfit ??
    (variantIdx % 13 === 12
      ? 'metro_worker'
      : variantIdx % 19 === 18
      ? 'transit_security'
      : CIVILIAN_OUTFITS[(variantIdx * 5 + Math.floor(variantIdx / 3)) % CIVILIAN_OUTFITS.length]);

  const isUniform =
    outfit === 'metro_worker' ||
    outfit === 'transit_security' ||
    outfit === 'rail_engineer' ||
    outfit === 'soviet_soldier' ||
    outfit === 'pow_prisoner' ||
    outfit === 'station_barista' ||
    outfit === 'gang_2059';

  const rAct = variantIdx % 10;
  const activity: CommuterActivityType =
    forcedActivity ??
    (isUniform
      ? 'none'
      : rAct === 0 || rAct === 1 || rAct === 3 || rAct === 6 || rAct === 9
      ? 'phone'
      : rAct === 2 || rAct === 8
      ? 'newspaper'
      : rAct === 4
      ? 'cigarette'
      : 'none');

  const build: HumanBuildType =
    outfit === 'station_barista'
      ? variantIdx % 2 === 0
        ? 'slender_female'
        : 'athletic_male'
      : isUniform
      ? variantIdx % 3 === 0
        ? 'stocky_heavy'
        : 'athletic_male'
      : BUILDS[variantIdx % BUILDS.length];
  const isFemale = build === 'slender_female';
  const hairList = isFemale ? FEMALE_HAIRS : MALE_HAIRS;
  const hairStyle = hairList[(variantIdx * 5 + 1) % hairList.length];

  const heightScale =
    build === 'slender_female'
      ? 0.91 + ((variantIdx * 17) % 10) * 0.01
      : build === 'tall_lean'
      ? 1.02 + ((variantIdx * 13) % 8) * 0.01
      : build === 'stocky_heavy'
      ? 0.96 + ((variantIdx * 11) % 9) * 0.01
      : 0.98 + ((variantIdx * 19) % 9) * 0.01;

  const skinColor = SKIN_PALETTE[(variantIdx * 3) % SKIN_PALETTE.length];
  const hairColor = HAIR_PALETTE[(variantIdx * 5 + 2) % HAIR_PALETTE.length];
  let jacketColor = CIVILIAN_JACKET_COLORS[(variantIdx * 7 + 1) % CIVILIAN_JACKET_COLORS.length];
  let pantsColor = PANTS_PALETTE[(variantIdx * 5 + 3) % PANTS_PALETTE.length];
  let hatColor = SCARF_PALETTE[(variantIdx * 11) % SCARF_PALETTE.length];
  const shoeColor = isUniform ? '#181a1f' : SHOE_PALETTE[(variantIdx * 3 + 2) % SHOE_PALETTE.length];
  const scarfColor = SCARF_PALETTE[(variantIdx * 13 + 2) % SCARF_PALETTE.length];

  if (outfit === 'metro_worker') {
    jacketColor = '#1e3554';
    pantsColor = '#16253b';
    hatColor = '#1c304c';
  } else if (outfit === 'transit_security') {
    jacketColor = '#222b36';
    pantsColor = '#192029';
    hatColor = '#1c2430';
  } else if (outfit === 'rail_engineer') {
    jacketColor = '#343c44';
    pantsColor = '#283038';
    hatColor = '#e2a820';
  } else if (outfit === 'soviet_soldier') {
    jacketColor = '#3d4a35';
    pantsColor = '#2e3828';
    hatColor = '#3a4632';
  } else if (outfit === 'pow_prisoner') {
    jacketColor = '#4c525c';
    pantsColor = '#383e47';
    hatColor = '#363b42';
  } else if (outfit === 'station_barista') {
    jacketColor = '#30241e';
    pantsColor = '#1c1b20';
    hatColor = '#5e3c28';
  } else if (outfit === 'gang_2059') {
    // 2059 Russia darker tactical trench & industrial street silhouette
    jacketColor = variantIdx % 2 === 0 ? '#14171e' : '#1f161a';
    pantsColor = '#0f1218';
    hatColor = variantIdx % 3 === 0 ? '#2b1218' : '#13161c';
  } else if (outfit === 'leather_biker') {
    jacketColor = variantIdx % 2 === 0 ? '#24252a' : '#4a2b20';
  }

  const windUniform = { value: 0.35 };

  const skinMat = new THREE.MeshPhysicalMaterial({
    color: skinColor,
    roughness: 0.52,
    metalness: 0.0,
    clearcoat: 0.08,
    clearcoatRoughness: 0.62,
    sheen: 0.34,
    sheenColor: new THREE.Color('#ffd8c4'),
    sheenRoughness: 0.72,
  });
  applyHumanSkinShader(skinMat, 'human-skin-sss-v1');

  // Close-up rigged faces use pure pore/crease/lip pedFaceSkinMap or weathered variant (NO double painted 2D eyes!) + SSS!
  const useWeatheredFace =
    outfit === 'leather_biker' ||
    outfit === 'gang_2059' ||
    outfit === 'rail_engineer' ||
    variantIdx % 2 === 1;
  const faceMat = new THREE.MeshPhysicalMaterial({
    color: skinColor,
    map: useWeatheredFace ? textures.pedFaceWeatheredMap : textures.pedFaceSkinMap,
    bumpMap: textures.pedFaceBump,
    bumpScale: 0.0115,
    roughness: 0.42,
    metalness: 0.0,
    clearcoat: 0.18,
    clearcoatRoughness: 0.50,
    sheen: 0.48,
    sheenColor: new THREE.Color('#ffccb2'),
    sheenRoughness: 0.58,
  });
  applyHumanSkinShader(faceMat, 'human-face-sss-v1');

  const isLeather = outfit === 'leather_biker' || outfit === 'gang_2059';
  const isPuffer = outfit === 'puffer_jacket';
  const isKnit =
    outfit === 'cardigan_scarf' || outfit === 'hoodie_parka' || outfit === 'pow_prisoner';
  const coatMat = new THREE.MeshPhysicalMaterial({
    color: jacketColor,
    map: isLeather
      ? textures.pedFabricLeatherMap
      : isKnit
      ? textures.pedFabricKnitMap
      : textures.pedClothingMap,
    roughnessMap: isLeather
      ? textures.pedFabricLeatherRoughness
      : isKnit
      ? textures.pedFabricKnitRoughness
      : textures.pedClothingRoughness,
    bumpMap: isLeather
      ? textures.pedFabricLeatherBump
      : isKnit
      ? textures.pedFabricKnitBump
      : textures.pedClothingBump,
    bumpScale: isLeather ? 0.024 : isKnit ? 0.044 : 0.032,
    roughness: isLeather ? 0.34 : isPuffer ? 0.38 : isKnit ? 0.96 : 0.88,
    metalness: isLeather ? 0.14 : 0.01,
    clearcoat: isLeather ? 0.18 : isPuffer ? 0.22 : 0.0,
    clearcoatRoughness: 0.42,
    sheen: isLeather ? 0.22 : 0.94,
    sheenColor: new THREE.Color(jacketColor).lerp(new THREE.Color('#f4f8ff'), 0.48),
    sheenRoughness: isKnit ? 0.68 : 0.48,
    side: THREE.DoubleSide,
  });
  applyClothWindShader(coatMat, windUniform, 'cloth-wind-pbr-v3');

  const isTailored =
    outfit === 'trench_coat' || outfit === 'tailored_blazer' || outfit === 'transit_security';
  const pantsMat = new THREE.MeshPhysicalMaterial({
    color: pantsColor,
    map: isTailored ? textures.pedClothingMap : textures.pedFabricDenimMap,
    roughnessMap: isTailored ? textures.pedClothingRoughness : textures.pedFabricDenimRoughness,
    bumpMap: isTailored ? textures.pedClothingBump : textures.pedFabricDenimBump,
    bumpScale: isTailored ? 0.024 : 0.038,
    roughness: isTailored ? 0.82 : 0.94,
    metalness: 0.01,
    sheen: isTailored ? 0.54 : 0.84,
    sheenColor: new THREE.Color(pantsColor).lerp(new THREE.Color('#dde6f2'), 0.36),
    sheenRoughness: 0.62,
    side: THREE.DoubleSide,
  });
  applyClothWindShader(pantsMat, windUniform, 'cloth-wind-pbr-v3');

  const shoeMat = new THREE.MeshStandardMaterial({
    color: shoeColor,
    map: textures.pedFabricLeatherMap,
    bumpMap: textures.pedFabricLeatherBump,
    bumpScale: 0.016,
    roughness: 0.36,
    metalness: 0.16,
  });
  const hairMat = new THREE.MeshPhysicalMaterial({
    color: hairColor,
    map: textures.pedHairMap,
    bumpMap: textures.pedHairBump,
    bumpScale: 0.018,
    roughness: 0.40,
    metalness: 0.05,
    clearcoat: 0.26,
    clearcoatRoughness: 0.36,
    sheen: 0.78,
    sheenColor: new THREE.Color(hairColor).lerp(new THREE.Color('#f4e8dc'), 0.38),
    sheenRoughness: 0.40,
    side: THREE.DoubleSide,
  });
  applyClothWindShader(hairMat, windUniform, 'cloth-wind-pbr-v3');

  const hatMat = new THREE.MeshPhysicalMaterial({
    color: hatColor,
    roughnessMap: outfit === 'rail_engineer' ? undefined : textures.pedClothingRoughness,
    bumpMap: outfit === 'rail_engineer' ? undefined : textures.pedClothingBump,
    bumpScale: 0.022,
    roughness: outfit === 'rail_engineer' ? 0.28 : 0.92,
    metalness: outfit === 'rail_engineer' ? 0.16 : 0.01,
    sheen: outfit === 'rail_engineer' ? 0.0 : 0.72,
    sheenRoughness: 0.68,
  });
  const scarfMat = new THREE.MeshPhysicalMaterial({
    color: scarfColor,
    map: textures.pedFabricKnitMap,
    roughnessMap: textures.pedFabricKnitRoughness,
    bumpMap: textures.pedFabricKnitBump,
    bumpScale: 0.044,
    roughness: 0.98,
    metalness: 0.0,
    sheen: 0.95,
    sheenColor: new THREE.Color(scarfColor).lerp(new THREE.Color('#ffffff'), 0.44),
    sheenRoughness: 0.58,
    side: THREE.DoubleSide,
  });
  applyClothWindShader(scarfMat, windUniform, 'cloth-wind-pbr-v3');

  // =========================================================================
  // BUILD SKELETON HIERARCHY AT UNSCALED BIND POSE (root at identity!)
  // =========================================================================
  const m = getBuildMetrics(build);
  const root = new THREE.Group();
  const standingPelvisY = m.standingPelvisY;
  const seatedPelvisY = 0.54;

  const pelvis = new THREE.Bone();
  pelvis.position.set(0, standingPelvisY, 0);
  root.add(pelvis);

  const spine = new THREE.Bone();
  spine.position.set(0, 0.085, 0);
  pelvis.add(spine);

  const chest = new THREE.Bone();
  spine.add(chest);

  const coatTailBone = new THREE.Bone();
  coatTailBone.position.set(0, 0.08, 0);
  pelvis.add(coatTailBone);

  const leftShoulder = new THREE.Bone();
  leftShoulder.position.set(-m.shoulderHalfW, m.shoulderY, -0.004);
  chest.add(leftShoulder);

  const leftElbow = new THREE.Bone();
  leftElbow.position.set(0, -0.275, 0);
  leftShoulder.add(leftElbow);

  const rightShoulder = new THREE.Bone();
  rightShoulder.position.set(m.shoulderHalfW, m.shoulderY, -0.004);
  chest.add(rightShoulder);

  const rightElbow = new THREE.Bone();
  rightElbow.position.set(0, -0.275, 0);
  rightShoulder.add(rightElbow);

  const leftHip = new THREE.Bone();
  leftHip.position.set(-m.hipHalfW, -0.03, 0);
  pelvis.add(leftHip);

  const leftKnee = new THREE.Bone();
  leftKnee.position.set(0, -0.425, 0);
  leftHip.add(leftKnee);

  const rightHip = new THREE.Bone();
  rightHip.position.set(m.hipHalfW, -0.03, 0);
  pelvis.add(rightHip);

  const rightKnee = new THREE.Bone();
  rightKnee.position.set(0, -0.425, 0);
  rightHip.add(rightKnee);

  // Ordered exactly matching BONE_* constants (0..11)
  const bones: THREE.Bone[] = [
    pelvis,
    spine,
    chest,
    leftShoulder,
    leftElbow,
    rightShoulder,
    rightElbow,
    leftHip,
    leftKnee,
    rightHip,
    rightKnee,
    coatTailBone,
  ];

  // Compute exact unscaled bind matrices before binding the SkinnedMeshes!
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  // 1. SEAMLESS CONTINUOUS SKINNED JACKET + FLOWING COAT HEM + DRAPED SLEEVES (1 draw call!)
  const jacketSkinnedMesh = new THREE.SkinnedMesh(
    getCachedSkinnedJacket(geos, build, outfit),
    coatMat
  );
  jacketSkinnedMesh.frustumCulled = false;
  root.add(jacketSkinnedMesh);
  jacketSkinnedMesh.bind(skeleton);

  // 2. SEAMLESS CONTINUOUS SKINNED DRAPED TROUSERS + PELVIS (1 draw call!)
  const trousersSkinnedMesh = new THREE.SkinnedMesh(geos.skinnedTrousers[build], pantsMat);
  trousersSkinnedMesh.frustumCulled = false;
  root.add(trousersSkinnedMesh);
  trousersSkinnedMesh.bind(skeleton);

  // Now safely scale root for varied human height!
  root.scale.setScalar(heightScale);

  // =========================================================================
  // OUTFIT DETAILS, FLOWING WIND LAPELS, SCARVES, COLLARS & UNIFORM GEAR
  // =========================================================================
  const torsoTopY = m.torsoTopY;
  let scarfTailBone: THREE.Group | null = null;
  let scarfSideTailBone: THREE.Group | null = null;
  let jacketFlapLeft: THREE.Group | null = null;
  let jacketFlapRight: THREE.Group | null = null;

  if (outfit === 'metro_worker' || outfit === 'rail_engineer') {
    const vestMat = new THREE.MeshPhysicalMaterial({
      color: outfit === 'metro_worker' ? '#e67e12' : '#b8d91c',
      emissive: new THREE.Color(outfit === 'metro_worker' ? '#ff7b00' : '#94b810'),
      emissiveIntensity: 0.25,
      bumpMap: textures.pedClothingBump,
      bumpScale: 0.015,
      roughness: 0.58,
      sheen: 0.4,
    });
    const vestMesh = new THREE.Mesh(geos.torso[build], vestMat);
    vestMesh.scale.set(1.06, 0.85, 1.07);
    vestMesh.position.set(0, 0.03, 0);
    chest.add(vestMesh);

    const reflMat = new THREE.MeshStandardMaterial({
      color: '#e2ebf4',
      emissive: new THREE.Color('#b8d4ec'),
      emissiveIntensity: 0.42,
      roughness: 0.25,
      metalness: 0.65,
    });
    for (const bandY of [0.13, 0.26]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.178, 0.014, 8, 24), reflMat);
      band.rotation.x = Math.PI * 0.5;
      band.scale.set(build === 'stocky_heavy' ? 1.24 : 1.09, build === 'stocky_heavy' ? 0.94 : 0.82, 1);
      band.position.set(0, bandY, 0.006);
      chest.add(band);
    }
  } else if (outfit === 'transit_security') {
    const badgeMat = new THREE.MeshStandardMaterial({ color: '#d8e2ec', roughness: 0.22, metalness: 0.9 });
    const badge = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.008, 12), badgeMat);
    badge.rotation.x = Math.PI * 0.5;
    badge.position.set(0.084, torsoTopY - 0.14, 0.148);
    chest.add(badge);

    const beltMat = new THREE.MeshStandardMaterial({ color: '#14161a', roughness: 0.42, metalness: 0.28 });
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 10, 24), beltMat);
    belt.rotation.x = Math.PI * 0.5;
    belt.scale.set(build === 'stocky_heavy' ? 1.2 : 1.02, 0.8, 1);
    belt.position.set(0, 0.02, 0);
    chest.add(belt);
  } else if (outfit === 'soviet_soldier') {
    const beltMat = new THREE.MeshStandardMaterial({ color: '#2c1d12', roughness: 0.36, metalness: 0.22 });
    const buckleMat = new THREE.MeshStandardMaterial({ color: '#cfa948', roughness: 0.26, metalness: 0.86 });
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.019, 10, 24), beltMat);
    belt.rotation.x = Math.PI * 0.5;
    belt.scale.set(build === 'stocky_heavy' ? 1.2 : 1.04, 0.82, 1);
    belt.position.set(0, 0.02, 0);
    chest.add(belt);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.052, 0.024), buckleMat);
    buckle.position.set(0, 0.02, 0.145);
    chest.add(buckle);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.44, 0.018), beltMat);
    strap.rotation.z = -0.56;
    strap.position.set(0, torsoTopY - 0.22, 0.142);
    chest.add(strap);
    const tabMat = new THREE.MeshStandardMaterial({ color: '#b42323', roughness: 0.72 });
    for (const sx of [-1, 1]) {
      const ep = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.018, 0.044), tabMat);
      ep.position.set(sx * (m.shoulderHalfW - 0.035), torsoTopY + 0.008, 0);
      chest.add(ep);
    }
  } else if (outfit === 'station_barista') {
    const apronMat = new THREE.MeshStandardMaterial({
      color: '#6e452a',
      map: textures.pedClothingMap,
      roughness: 0.88,
    });
    const apron = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.52, 0.024), apronMat);
    apron.position.set(0, torsoTopY - 0.26, 0.142);
    chest.add(apron);
  } else if (outfit === 'pow_prisoner') {
    const patchMat = new THREE.MeshStandardMaterial({ color: '#d4d8dc', roughness: 0.9 });
    const patch = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.048, 0.014), patchMat);
    patch.position.set(0.068, torsoTopY - 0.14, 0.142);
    chest.add(patch);
  } else if (outfit === 'hoodie_parka') {
    const hood = new THREE.Mesh(geos.hoodDrape, coatMat);
    hood.position.set(0, torsoTopY - 0.035, -0.078);
    hood.rotation.x = -0.75;
    hood.scale.set(1.2, 0.84, 1.08);
    chest.add(hood);
  } else if (outfit === 'leather_biker') {
    const zipMat = new THREE.MeshStandardMaterial({ color: '#c8d2dc', roughness: 0.2, metalness: 0.92 });
    const zip = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.38, 8), zipMat);
    zip.position.set(0.028, torsoTopY * 0.48, 0.142);
    zip.rotation.z = -0.14;
    chest.add(zip);
  }

  // Flowing open coat front panels / lapels on trench coats, blazers, parkas & cardigans!
  if (
    outfit === 'trench_coat' ||
    outfit === 'tailored_blazer' ||
    outfit === 'cardigan_scarf' ||
    outfit === 'hoodie_parka'
  ) {
    jacketFlapLeft = new THREE.Group();
    jacketFlapLeft.position.set(-0.084, torsoTopY - 0.095, 0.132);
    chest.add(jacketFlapLeft);
    jacketFlapLeft.add(new THREE.Mesh(geos.jacketFlapLeft, coatMat));

    jacketFlapRight = new THREE.Group();
    jacketFlapRight.position.set(0.084, torsoTopY - 0.095, 0.132);
    chest.add(jacketFlapRight);
    jacketFlapRight.add(new THREE.Mesh(geos.jacketFlapRight, coatMat));
  }

  // Organic flowing draped wool scarf (ZERO donut torus!) + dual wind-rippled cascading tails!
  if (outfit === 'cardigan_scarf' || (!isUniform && variantIdx % 2 === 0)) {
    const scarfWrap = new THREE.Mesh(geos.scarfWrap, scarfMat);
    scarfWrap.position.set(0, torsoTopY - 0.012, 0.004);
    chest.add(scarfWrap);

    scarfTailBone = new THREE.Group();
    scarfTailBone.position.set(0.056, torsoTopY - 0.036, 0.132);
    chest.add(scarfTailBone);
    scarfTailBone.add(new THREE.Mesh(geos.scarfTail, scarfMat));

    scarfSideTailBone = new THREE.Group();
    scarfSideTailBone.position.set(-0.072, torsoTopY - 0.048, 0.124);
    chest.add(scarfSideTailBone);
    scarfSideTailBone.add(new THREE.Mesh(geos.scarfSideTail, scarfMat));
  } else {
    const collar = new THREE.Mesh(geos.collarLapel, coatMat);
    collar.rotation.x = Math.PI * 0.5 + 0.22;
    collar.rotation.z = Math.PI * 0.8;
    collar.position.set(0, torsoTopY - 0.008, -0.004);
    chest.add(collar);
  }

  if (!isUniform && (variantIdx % 5 === 1 || variantIdx % 5 === 4)) {
    const pack = new THREE.Mesh(geos.backpack, hatMat);
    const packW = build === 'slender_female' ? 0.94 : build === 'stocky_heavy' ? 1.12 : 1.02;
    pack.scale.set(packW, 1.0, 1.0);
    pack.position.set(0, torsoTopY * 0.56, -0.148);
    chest.add(pack);
  }

  // Natural Neck -> High-Res Sculpted Head + Living 3D Eyes/Brows + Sculpted Ears + Silky Flowing Hair
  const neck = new THREE.Group();
  neck.position.set(0, torsoTopY - 0.012, 0);
  chest.add(neck);
  neck.add(new THREE.Mesh(geos.neck, skinMat));

  const head = new THREE.Group();
  head.position.set(0, 0.068, 0.006);
  neck.add(head);
  head.add(new THREE.Mesh(isFemale ? geos.headFemale : geos.headMale, faceMat));

  // Glossy 3D eyeballs (with live eye saccades!) + blinking 3D eyelids + lashes + expressive 3D brows
  const eyeMat = getGlossyEyeMaterial(variantIdx);
  const lashMat = new THREE.MeshStandardMaterial({
    color: '#120f0e',
    roughness: 0.72,
    metalness: 0.0,
  });
  const browMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hairColor).multiplyScalar(0.82),
    roughness: 0.74,
    metalness: 0.02,
  });

  const buildEyeAssembly = (
    sx: -1 | 1
  ): { upperLidPivot: THREE.Object3D; eyeballMesh: THREE.Object3D; browMesh: THREE.Object3D } => {
    // Locked to exact orbital cavity spherical landmark (lon = ±0.365, lat = +0.032)
    const socket = new THREE.Group();
    socket.position.set(sx * 0.0302, 0.0916, 0.0815);
    head.add(socket);

    // Glossy clearcoat eyeball (articulated for natural living saccades!)
    const eyeballMesh = new THREE.Mesh(geos.eyeball, eyeMat);
    socket.add(eyeballMesh);

    // Lower eyelid cradling bottom of sclera
    const lowerLid = new THREE.Mesh(geos.lowerEyelid, skinMat);
    lowerLid.rotation.x = 0.16;
    socket.add(lowerLid);

    // Articulated upper eyelid pivot + dark lash rim (rotates down smoothly when blinking!)
    const upperLidPivot = new THREE.Group();
    upperLidPivot.rotation.x = -0.24; // open resting angle
    socket.add(upperLidPivot);
    upperLidPivot.add(new THREE.Mesh(geos.upperEyelid, skinMat));

    const lash = new THREE.Mesh(geos.eyelashRim, lashMat);
    lash.position.set(0, 0.0025, 0.0012);
    lash.rotation.x = 0.22;
    upperLidPivot.add(lash);

    // 3D sculpted brow arch sitting along the brow ridge (articulated for subtle micro-expressions!)
    const browMesh = new THREE.Mesh(geos.eyebrowArch, browMat);
    browMesh.position.set(sx * 0.0308, 0.1112, 0.0902);
    browMesh.rotation.set(0, sx * -0.24, sx * -0.085);
    head.add(browMesh);

    return { upperLidPivot, eyeballMesh, browMesh };
  };

  const leftEye = buildEyeAssembly(-1);
  const rightEye = buildEyeAssembly(1);

  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(geos.ear, skinMat);
    ear.scale.set(sx, 1.0, 1.0);
    ear.position.set(sx * 0.084, 0.086, -0.008);
    head.add(ear);
  }

  const hairBuilt = createHairOrHeadwear(hairStyle, outfit, hairMat, hatMat);
  head.add(hairBuilt.group);

  // Anatomically sculpted 5-finger hands + glossy fingernails matched to their activity grip,
  // PLUS toggleable closed strap-grip hands so standing train passengers actually grip the overhead loop!
  const nailMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(skinColor).lerp(new THREE.Color('#f4dcd6'), 0.55),
    roughness: 0.22,
    metalness: 0.0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.18,
  });
  const handScale = isFemale ? 0.92 : 1.02;

  const leftHandSkinGeo =
    activity === 'newspaper' ? geos.handPaperSkinLeft : geos.handSkinLeft;
  const leftHandNailsGeo =
    activity === 'newspaper' ? geos.handPaperNailsLeft : geos.handNailsLeft;
  const rightHandSkinGeo =
    activity === 'phone'
      ? geos.handPhoneSkinRight
      : activity === 'newspaper'
      ? geos.handPaperSkinRight
      : activity === 'cigarette'
      ? geos.handCigSkinRight
      : geos.handSkinRight;
  const rightHandNailsGeo =
    activity === 'phone'
      ? geos.handPhoneNailsRight
      : activity === 'newspaper'
      ? geos.handPaperNailsRight
      : activity === 'cigarette'
      ? geos.handCigNailsRight
      : geos.handNailsRight;

  const leftHandGrp = new THREE.Group();
  leftHandGrp.scale.setScalar(handScale);
  leftHandGrp.position.set(0, -0.252, 0);
  const leftHandNormalMesh = new THREE.Group();
  leftHandNormalMesh.add(new THREE.Mesh(leftHandSkinGeo, skinMat));
  leftHandNormalMesh.add(new THREE.Mesh(leftHandNailsGeo, nailMat));
  leftHandGrp.add(leftHandNormalMesh);
  const leftHandStrapMesh = new THREE.Group();
  leftHandStrapMesh.add(new THREE.Mesh(geos.handStrapSkinLeft, skinMat));
  leftHandStrapMesh.add(new THREE.Mesh(geos.handStrapNailsLeft, nailMat));
  leftHandStrapMesh.visible = false;
  leftHandGrp.add(leftHandStrapMesh);
  leftElbow.add(leftHandGrp);

  const rightHandGrp = new THREE.Group();
  rightHandGrp.scale.setScalar(handScale);
  rightHandGrp.position.set(0, -0.252, 0);
  const rightHandNormalMesh = new THREE.Group();
  rightHandNormalMesh.add(new THREE.Mesh(rightHandSkinGeo, skinMat));
  rightHandNormalMesh.add(new THREE.Mesh(rightHandNailsGeo, nailMat));
  rightHandGrp.add(rightHandNormalMesh);
  const rightHandStrapMesh = new THREE.Group();
  rightHandStrapMesh.add(new THREE.Mesh(geos.handStrapSkinRight, skinMat));
  rightHandStrapMesh.add(new THREE.Mesh(geos.handStrapNailsRight, nailMat));
  rightHandStrapMesh.visible = false;
  rightHandGrp.add(rightHandStrapMesh);
  rightElbow.add(rightHandGrp);

  // Sculpted shoes tucked neatly under the continuous skinned trouser cuffs!
  const leftAnkle = new THREE.Group();
  leftAnkle.position.set(0, -0.415, 0);
  leftKnee.add(leftAnkle);
  const leftShoe = new THREE.Mesh(geos.shoe, shoeMat);
  leftShoe.position.set(0, -0.088, 0);
  leftAnkle.add(leftShoe);

  const rightAnkle = new THREE.Group();
  rightAnkle.position.set(0, -0.415, 0);
  rightKnee.add(rightAnkle);
  const rightShoe = new THREE.Mesh(geos.shoe, shoeMat);
  rightShoe.position.set(0, -0.088, 0);
  rightAnkle.add(rightShoe);

  // =========================================================================
  // COMMUTER ACTIVITY PROPS — ERGONOMICALLY CRADLED IN THE HANDS (ZERO CLIPPING!)
  // =========================================================================
  let newspaperProp: THREE.Group | null = null;
  let phoneProp: THREE.Group | null = null;
  let cigaretteProp: THREE.Group | null = null;
  let cigEmberMat: THREE.MeshStandardMaterial | null = null;
  const smokePuffs: THREE.Sprite[] = [];
  const ambientSmokeClouds: THREE.Sprite[] = [];

  if (activity === 'newspaper') {
    newspaperProp = new THREE.Group();
    const newsMat = new THREE.MeshStandardMaterial({
      map: textures.newspaperMap,
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    const sheet = new THREE.Mesh(geos.newspaperSheet, newsMat);
    newspaperProp.add(sheet);
    newspaperProp.position.set(0, torsoTopY - 0.14, 0.36);
    newspaperProp.rotation.set(0.26, 0, 0); // tilted naturally outward away from reader's face!
    chest.add(newspaperProp);
  } else if (activity === 'phone') {
    // Portrait phone seated flat against right palm cradle (x=-0.0205), fingers wrapped behind & around y=-0.110 bezel!
    phoneProp = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#141820', roughness: 0.25, metalness: 0.72 });
    const screenMat = new THREE.MeshStandardMaterial({
      map: textures.phoneScreenMap,
      emissiveMap: textures.phoneScreenMap,
      emissive: new THREE.Color('#bce4ff'),
      emissiveIntensity: 1.55,
      roughness: 0.14,
    });
    phoneProp.add(new THREE.Mesh(geos.phoneBody, bodyMat));
    const screen = new THREE.Mesh(geos.phoneScreen, screenMat);
    screen.position.set(-0.0046, 0, 0);
    // Rotate plane so its normal (+Z) faces -X (toward eyes) and its portrait top (+Y) points along +Z (up)!
    screen.rotation.set(0, -Math.PI * 0.5, -Math.PI * 0.5, 'XYZ');
    phoneProp.add(screen);
    phoneProp.position.set(-0.0205, -0.076, 0.016);
    rightHandGrp.add(phoneProp);
  } else if (activity === 'cigarette') {
    // STRICTLY ONE CIGARETTE in right hand V-grip (between index & middle fingers):
    // Orange filter points INWARD (-X, palm side toward lips); white paper + ash + lit ember point OUTWARD (+X, back-of-hand side)!
    cigaretteProp = new THREE.Group();
    const paperMat = new THREE.MeshStandardMaterial({ color: '#ece9e1', roughness: 0.88 });
    const filterMat = new THREE.MeshStandardMaterial({ color: '#cf8942', roughness: 0.82 });
    const ashMat = new THREE.MeshStandardMaterial({ color: '#6b6e74', roughness: 0.96 });
    cigEmberMat = new THREE.MeshStandardMaterial({
      color: '#ff520a',
      emissive: new THREE.Color('#ff3e00'),
      emissiveIntensity: 2.4,
      roughness: 0.35,
    });

    const filter = new THREE.Mesh(geos.cigFilter, filterMat);
    filter.rotation.z = Math.PI * 0.5;
    filter.position.set(-0.010, 0, 0); // spans [-0.021 .. +0.001], pinched neatly between index & middle fingers!
    cigaretteProp.add(filter);

    const body = new THREE.Mesh(geos.cigBody, paperMat);
    body.rotation.z = Math.PI * 0.5;
    body.position.set(0.028, 0, 0); // spans [+0.001 .. +0.055] cleanly outward away from palm/face!
    cigaretteProp.add(body);

    const ash = new THREE.Mesh(geos.cigEmber, ashMat);
    ash.scale.set(1.1, 0.92, 0.92);
    ash.position.set(0.0545, 0, 0);
    cigaretteProp.add(ash);

    const ember = new THREE.Mesh(geos.cigEmber, cigEmberMat);
    ember.position.set(0.058, 0, 0);
    cigaretteProp.add(ember);

    // Pinched precisely in the V-slot between index (z=+0.027) and middle (z=+0.007) fingers!
    cigaretteProp.position.set(-0.002, -0.118, 0.017);
    cigaretteProp.rotation.set(0.0, 0.0, 0.04);
    rightHandGrp.add(cigaretteProp);

    // Soft billowing smoke cloud texture (NEVER raindrop streaks!)
    const smokeTex = getSmokeCloudTexture();

    // 1. Direct curling smoke plume rising from the lit cigarette tip & exhale (5 soft wisps)
    for (let s = 0; s < 5; s++) {
      const spMat = new THREE.SpriteMaterial({
        map: smokeTex,
        color: '#d4dde8',
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
      });
      const sp = new THREE.Sprite(spMat);
      sp.scale.set(0.08, 0.08, 1);
      chest.add(sp);
      smokePuffs.push(sp);
    }

    // 2. General atmospheric air smoke haze around the smoker:
    //    thicker close to the smoker (yet transparent enough to clearly see faces!) and thinner farther away!
    for (let a = 0; a < 4; a++) {
      const ambMat = new THREE.SpriteMaterial({
        map: smokeTex,
        color: a < 2 ? '#ccd6e2' : '#bcc8d8',
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
      });
      const amb = new THREE.Sprite(ambMat);
      amb.scale.set(1.2, 1.2, 1);
      root.add(amb);
      ambientSmokeClouds.push(amb);
    }
  }

  return {
    root,
    pelvis,
    spine,
    chest,
    neck,
    head,
    leftShoulder,
    leftElbow,
    leftHandGrp,
    leftHandNormalMesh,
    leftHandStrapMesh,
    rightShoulder,
    rightElbow,
    rightHandGrp,
    rightHandNormalMesh,
    rightHandStrapMesh,
    leftHip,
    leftKnee,
    leftAnkle,
    rightHip,
    rightKnee,
    rightAnkle,
    coatTailBone,
    scarfTailBone,
    scarfSideTailBone,
    hairTailBone: hairBuilt.hairTailBone,
    jacketFlapLeft,
    jacketFlapRight,
    eyelidLeft: leftEye.upperLidPivot,
    eyelidRight: rightEye.upperLidPivot,
    eyeballLeft: leftEye.eyeballMesh,
    eyeballRight: rightEye.eyeballMesh,
    browLeft: leftEye.browMesh,
    browRight: rightEye.browMesh,
    windUniform,
    activity,
    newspaperProp,
    phoneProp,
    cigaretteProp,
    cigEmberMat,
    smokePuffs,
    ambientSmokeClouds,
    build,
    outfit,
    heightScale,
    standingPelvisY,
    seatedPelvisY,
  };
}

// Zero-GC scratch vectors/quaternions for exact FK & 2-bone analytical strap IK!
const _fkQ1 = new THREE.Quaternion();
const _fkQ2 = new THREE.Quaternion();
const _fkV1 = new THREE.Vector3();
const _fkV2 = new THREE.Vector3();
const _ikChestPos = new THREE.Vector3();
const _ikChestQ = new THREE.Quaternion();
const _ikChestInvQ = new THREE.Quaternion();
const _ikTargetChest = new THREE.Vector3();
const _ikRel = new THREE.Vector3();
const _ikDir = new THREE.Vector3();
const _ikPole = new THREE.Vector3();
const _ikBendN = new THREE.Vector3();
const _ikElbowPos = new THREE.Vector3();
const _ikUpperDir = new THREE.Vector3();
const _ikUpperAxisX = new THREE.Vector3();
const _ikUpperAxisY = new THREE.Vector3();
const _ikUpperAxisZ = new THREE.Vector3();
const _ikUpperMat = new THREE.Matrix4();
const _ikUpperQ = new THREE.Quaternion();
const _ikNegY = new THREE.Vector3(0, -1, 0);

function computeHandPalmInChest(
  shoulder: THREE.Bone,
  elbow: THREE.Bone,
  out: THREE.Vector3
): THREE.Vector3 {
  _fkQ1.setFromEuler(shoulder.rotation);
  _fkQ2.setFromEuler(elbow.rotation);
  // Elbow position in chest space
  _fkV1.copy(elbow.position).applyQuaternion(_fkQ1).add(shoulder.position);
  // Hand palm center (0, -0.305, 0) in elbow space -> chest space
  _fkV2.set(0, -0.305, 0).applyQuaternion(_fkQ2).applyQuaternion(_fkQ1);
  return out.copy(_fkV1).add(_fkV2);
}

/**
 * Exact zero-GC 2-bone analytical arm IK locking a passenger's curled strap-grip fist
 * directly around the actual hanging metro strap handle in rig.root local space!
 */
function solveStrapArmIK(
  rig: HumanRig,
  sideSign: -1 | 1,
  targetRootLocal: { x: number; y: number; z: number }
): void {
  const shoulder = sideSign < 0 ? rig.leftShoulder : rig.rightShoulder;
  const elbow = sideSign < 0 ? rig.leftElbow : rig.rightElbow;
  const handGrp = sideSign < 0 ? rig.leftHandGrp : rig.rightHandGrp;

  // Convert target from rig.root local space -> chest local space (compensating for pelvis/spine/chest tilt!)
  _fkQ1.setFromEuler(rig.pelvis.rotation);
  _fkQ2.setFromEuler(rig.spine.rotation);
  _ikChestQ.copy(_fkQ1).multiply(_fkQ2);
  _fkQ2.setFromEuler(rig.chest.rotation);
  _ikChestQ.multiply(_fkQ2);

  _ikChestPos.copy(rig.spine.position).applyQuaternion(_fkQ1).add(rig.pelvis.position);
  _ikChestInvQ.copy(_ikChestQ).invert();
  _ikTargetChest
    .set(targetRootLocal.x, targetRootLocal.y, targetRootLocal.z)
    .sub(_ikChestPos)
    .applyQuaternion(_ikChestInvQ);

  // Vector from shoulder pivot to target grip center (palm center sits at -0.328m down the forearm!)
  _ikRel.copy(_ikTargetChest).sub(shoulder.position);
  const L1 = 0.275; // shoulder -> elbow
  const L2 = 0.328; // elbow -> closed strap-fist palm center
  const rawDist = _ikRel.length();
  const minDist = Math.abs(L1 - L2) + 0.04;
  const maxDist = L1 + L2 - 0.008;
  const dist = THREE.MathUtils.clamp(rawDist, minDist, maxDist);

  if (rawDist < 1e-4) {
    _ikDir.set(0, 1, 0);
  } else {
    _ikDir.copy(_ikRel).multiplyScalar(1 / rawDist);
  }

  // Law of cosines for exact elbow bend angle
  const cosA = THREE.MathUtils.clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const cosC = THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1);
  const elbowBend = Math.PI - Math.acos(cosC); // 0 = straight, +PI = bent forward

  // Natural anatomical elbow pole: points slightly outward & forward-down
  _ikPole.set(sideSign * 0.42, -0.38, 0.82).normalize();
  _ikBendN.copy(_ikPole).addScaledVector(_ikDir, -_ikPole.dot(_ikDir));
  if (_ikBendN.lengthSq() < 1e-5) {
    _ikBendN.set(sideSign, 0, 1).normalize();
  } else {
    _ikBendN.normalize();
  }

  // Compute exact upper-arm bone direction (-Y axis of shoulder points from shoulder -> elbow!)
  _ikElbowPos
    .copy(_ikDir)
    .multiplyScalar(L1 * cosA)
    .addScaledVector(_ikBendN, L1 * sinA);
  _ikUpperDir.copy(_ikElbowPos).normalize(); // shoulder -> elbow

  // Local bone basis for shoulder:
  //   -Y = _ikUpperDir (bone down axis)
  //   +Z = forearm bend direction (so elbow.rotation.x = -elbowBend bends forearm cleanly along +Z toward target!)
  _ikUpperAxisY.copy(_ikUpperDir).negate();
  // Direction from elbow toward target lies in the plane spanned by _ikDir and _ikBendN, opposite _ikBendN!
  _ikUpperAxisZ.copy(_ikDir).multiplyScalar(dist).sub(_ikElbowPos);
  _ikUpperAxisZ.addScaledVector(_ikUpperAxisY, -_ikUpperAxisZ.dot(_ikUpperAxisY));
  if (_ikUpperAxisZ.lengthSq() < 1e-6) {
    _ikUpperAxisZ.set(0, 0, 1);
  } else {
    _ikUpperAxisZ.normalize();
  }
  _ikUpperAxisX.crossVectors(_ikUpperAxisY, _ikUpperAxisZ).normalize();
  _ikUpperAxisZ.crossVectors(_ikUpperAxisX, _ikUpperAxisY).normalize();

  _ikUpperMat.makeBasis(_ikUpperAxisX, _ikUpperAxisY, _ikUpperAxisZ);
  _ikUpperQ.setFromRotationMatrix(_ikUpperMat);
  shoulder.rotation.setFromQuaternion(_ikUpperQ, 'XYZ');

  // Forearm bends strictly around local X by -elbowBend so palm center hits targetRootLocal to <1mm!
  elbow.rotation.set(-elbowBend, 0, 0);
  // Orient closed cylindrical fist around horizontal bar/loop nicely
  handGrp.rotation.set(0.08, sideSign * -0.18, 0);
}

// Exact lip parting seam in rig.head local space (from createSculptedHeadGeometry at lat=-0.445, lon=0)
const HEAD_LIP_LOCAL = new THREE.Vector3(0, 0.03944, 0.09316);
const MOUTH_TARGET_SURFACE_OFFSET = 0.02; // 0.02m finger-pinch offset from lip surface -> filter tip (-0.021m) touches lips!
const CIG_FILTER_TIP_LOCAL = new THREE.Vector3(-0.021, 0, 0);
const CIG_EMBER_LOCAL = new THREE.Vector3(0.058, 0, 0);
const CIG_PROP_LOCAL_POS = new THREE.Vector3(-0.002, -0.118, 0.017);
const CIG_PROP_LOCAL_EULER = new THREE.Euler(0, 0, 0.04, 'XYZ');
const _cigPropQ = new THREE.Quaternion().setFromEuler(CIG_PROP_LOCAL_EULER);
const _cigPropInvQ = _cigPropQ.clone().invert();
const _cigOutDir = new THREE.Vector3(0.32, -0.06, 0.945).normalize();
const _cigAxisX = new THREE.Vector3();
const _cigAxisY = new THREE.Vector3();
const _cigAxisZ = new THREE.Vector3();
const _cigMat = new THREE.Matrix4();
const _cigTargetQ = new THREE.Quaternion();
const _cigTipOffsetInHand = new THREE.Vector3();
const _cigWristChest = new THREE.Vector3();
const _cigLipChest = new THREE.Vector3();
const _cigNeckQ = new THREE.Quaternion();
const _cigHeadQ = new THREE.Quaternion();
const _cigElbowQ = new THREE.Quaternion();
const _cigElbowInChestQ = new THREE.Quaternion();
const _cigHandQ = new THREE.Quaternion();
const _cigRestShQ = new THREE.Quaternion();
const _cigRestElQ = new THREE.Quaternion();
const _cigRestHdQ = new THREE.Quaternion();
const _cigRestShE = new THREE.Euler(-0.36, -0.14, -0.06, 'XYZ');
const _cigRestElE = new THREE.Euler(-1.02, 0, 0.18, 'XYZ');
const _cigRestHdE = new THREE.Euler(0.06, 0.28, 0.08, 'XYZ');
const _cigTmpV = new THREE.Vector3();

function computeMouthTargetInChest(rig: HumanRig, outLip: THREE.Vector3): THREE.Vector3 {
  _cigHeadQ.setFromEuler(rig.head.rotation);
  _cigNeckQ.setFromEuler(rig.neck.rotation);
  return outLip
    .copy(HEAD_LIP_LOCAL)
    .applyQuaternion(_cigHeadQ)
    .add(rig.head.position)
    .applyQuaternion(_cigNeckQ)
    .add(rig.neck.position);
}

function computeCigarettePointInChest(
  rig: HumanRig,
  cigLocalX: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const handScale = rig.rightHandGrp.scale.x;
  _fkQ1.setFromEuler(rig.rightShoulder.rotation);
  _fkQ2.setFromEuler(rig.rightElbow.rotation);
  _cigHandQ.setFromEuler(rig.rightHandGrp.rotation);

  // Point in cigaretteProp local space -> rightHandGrp local space
  out.set(cigLocalX, 0, 0).applyQuaternion(_cigPropQ).add(CIG_PROP_LOCAL_POS).multiplyScalar(handScale);
  // rightHandGrp -> rightElbow -> rightShoulder -> chest
  out.applyQuaternion(_cigHandQ).add(rig.rightHandGrp.position);
  out.applyQuaternion(_fkQ2).add(rig.rightElbow.position);
  out.applyQuaternion(_fkQ1).add(rig.rightShoulder.position);
  return out;
}

/**
 * Pure diagnostic readout in chest local space (used by verification checks).
 */
export function getCigaretteTipAndLipInChest(rig: HumanRig): {
  tip: THREE.Vector3;
  lip: THREE.Vector3;
  mouthTarget: THREE.Vector3;
  distanceM: number;
} {
  const lip = computeMouthTargetInChest(rig, new THREE.Vector3());
  const mouthTarget = lip.clone().addScaledVector(_cigOutDir, MOUTH_TARGET_SURFACE_OFFSET);
  const tip = computeCigarettePointInChest(rig, CIG_FILTER_TIP_LOCAL.x, new THREE.Vector3());
  return {
    tip,
    lip,
    mouthTarget,
    distanceM: tip.distanceTo(lip),
  };
}

/**
 * Spec 2: Exact zero-GC 2-bone analytical IK solving rightShoulder, rightElbow & rightHandGrp
 * so the cigarette filter tip (-0.021m) touches the lip surface while the grip sits 0.02m in front.
 */
function solveCigaretteArmIK(rig: HumanRig, puffWeight: number): void {
  const shoulder = rig.rightShoulder;
  const elbow = rig.rightElbow;
  const handGrp = rig.rightHandGrp;
  const handScale = handGrp.scale.x;

  // 1. Compute live lip surface target in chest space from neck + head transforms
  computeMouthTargetInChest(rig, _cigLipChest);

  // 2. Desired cigarette orientation in chest space:
  //    +X_cig = outward away from lips (_cigOutDir);
  //    +Z_cig = roughly to wearer's right/outward; +Y_cig = upward normal
  _cigAxisX.copy(_cigOutDir);
  _cigTmpV.set(0, 1, 0);
  _cigAxisZ.crossVectors(_cigAxisX, _cigTmpV).normalize();
  _cigAxisY.crossVectors(_cigAxisZ, _cigAxisX).normalize();
  _cigMat.makeBasis(_cigAxisX, _cigAxisY, _cigAxisZ);
  _cigTargetQ.setFromRotationMatrix(_cigMat);

  // Desired cigaretteProp->rightHandGrp quaternion in chest space: Q_hand_in_chest = _cigTargetQ * _cigPropInvQ
  _cigHandQ.copy(_cigTargetQ).multiply(_cigPropInvQ);

  // Vector from wrist (rightHandGrp origin) to cigarette filter tip in chest space
  _cigTipOffsetInHand
    .copy(CIG_FILTER_TIP_LOCAL)
    .applyQuaternion(_cigPropQ)
    .add(CIG_PROP_LOCAL_POS)
    .multiplyScalar(handScale)
    .applyQuaternion(_cigHandQ);

  // Target wrist position in chest space so filter tip meets _cigLipChest cleanly (within <1mm)
  // Notice: cigaretteProp origin (pinch point) is at +0.021m along _cigOutDir from filter tip => ~0.02m off lip surface!
  _cigWristChest.copy(_cigLipChest).sub(_cigTipOffsetInHand);

  // 3. 2-bone analytical IK from rightShoulder.position to _cigWristChest (L1=0.275, L2=0.252)
  _ikRel.copy(_cigWristChest).sub(shoulder.position);
  const L1 = 0.275;
  const L2 = 0.252;
  const rawDist = _ikRel.length();
  const minDist = Math.abs(L1 - L2) + 0.035;
  const maxDist = L1 + L2 - 0.008;
  const dist = THREE.MathUtils.clamp(rawDist, minDist, maxDist);

  if (rawDist < 1e-4) {
    _ikDir.set(0, 0, 1);
  } else {
    _ikDir.copy(_ikRel).multiplyScalar(1 / rawDist);
  }

  const cosA = THREE.MathUtils.clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const cosC = THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1);
  const elbowBend = Math.PI - Math.acos(cosC);

  // Natural anatomical elbow pole pointing outward, downward, and slightly forward
  _ikPole.set(0.68, -0.66, 0.32).normalize();
  _ikBendN.copy(_ikPole).addScaledVector(_ikDir, -_ikPole.dot(_ikDir));
  if (_ikBendN.lengthSq() < 1e-5) {
    _ikBendN.set(1, -1, 0).normalize();
  } else {
    _ikBendN.normalize();
  }

  _ikElbowPos
    .copy(_ikDir)
    .multiplyScalar(L1 * cosA)
    .addScaledVector(_ikBendN, L1 * sinA);
  _ikUpperDir.copy(_ikElbowPos).normalize();

  _ikUpperAxisY.copy(_ikUpperDir).negate();
  _ikUpperAxisZ.copy(_ikDir).multiplyScalar(dist).sub(_ikElbowPos);
  _ikUpperAxisZ.addScaledVector(_ikUpperAxisY, -_ikUpperAxisZ.dot(_ikUpperAxisY));
  if (_ikUpperAxisZ.lengthSq() < 1e-6) {
    _ikUpperAxisZ.set(0, 0, 1);
  } else {
    _ikUpperAxisZ.normalize();
  }
  _ikUpperAxisX.crossVectors(_ikUpperAxisY, _ikUpperAxisZ).normalize();
  _ikUpperAxisZ.crossVectors(_ikUpperAxisX, _ikUpperAxisY).normalize();

  _ikUpperMat.makeBasis(_ikUpperAxisX, _ikUpperAxisY, _ikUpperAxisZ);
  _ikUpperQ.setFromRotationMatrix(_ikUpperMat);

  _cigElbowQ.setFromAxisAngle(_ikUpperAxisX.set(1, 0, 0), -elbowBend);
  _cigElbowInChestQ.copy(_ikUpperQ).multiply(_cigElbowQ).invert();
  // Local wrist rotation aligning cigarette filter to lips
  _cigHandQ.premultiply(_cigElbowInChestQ);

  if (puffWeight >= 0.999) {
    shoulder.rotation.setFromQuaternion(_ikUpperQ, 'XYZ');
    elbow.rotation.set(-elbowBend, 0, 0);
    handGrp.rotation.setFromQuaternion(_cigHandQ, 'XYZ');
  } else {
    _cigRestShQ.setFromEuler(_cigRestShE);
    _cigRestElQ.setFromEuler(_cigRestElE);
    _cigRestHdQ.setFromEuler(_cigRestHdE);
    _cigRestShQ.slerp(_ikUpperQ, puffWeight);
    _cigRestElQ.slerp(_cigElbowQ, puffWeight);
    _cigRestHdQ.slerp(_cigHandQ, puffWeight);
    shoulder.rotation.setFromQuaternion(_cigRestShQ, 'XYZ');
    elbow.rotation.setFromQuaternion(_cigRestElQ, 'XYZ');
    handGrp.rotation.setFromQuaternion(_cigRestHdQ, 'XYZ');
  }
}

// Smooth natural gaze-and-pause curve (humans glance, settle on a point, then shift — never metronomic!)
function naturalGazePlateau(t: number, sharpness = 2.2): number {
  return Math.tanh(Math.sin(t) * sharpness);
}

// =========================================================================
// BIOMECHANICAL POSE ANIMATOR + LIVING FACE + CONTRAPPOSTO + CLOTH WIND!
// =========================================================================
export function applyHumanPose(rig: HumanRig, params: HumanPoseParams): void {
  const { mode, elapsed, phase } = params;
  const sway = params.railSway ?? 0;
  const wind = params.windStrength ?? 0.28;
  const vStyle = params.variantStyle ?? 0;
  // Multi-harmonic natural chest breathing (gentle inhale & slightly slower relaxed exhale)
  const breath = (Math.sin(elapsed * 1.85 + phase) + Math.sin(elapsed * 3.7 + phase) * 0.16) * 0.013;

  // Drive live GPU vertex cloth waves (calm gentle ripple indoors, full billowing gusts outdoors!)
  CLOTH_WIND_TIME_UNIFORM.value = elapsed;
  rig.windUniform.value = mode === 'walking' ? Math.max(wind, 0.58) : wind;

  // Layered organic macro wind gust simulation for coats, dual scarf tails, lapels & flowing hair
  const windGust =
    (0.55 + 0.45 * Math.sin(elapsed * 1.45 + phase * 0.7)) *
    (Math.sin(elapsed * 4.6 + phase * 1.9) * 0.65 +
      Math.sin(elapsed * 9.8 + phase * 3.1) * 0.35);
  const windGust2 =
    (0.55 + 0.45 * Math.cos(elapsed * 1.32 + phase * 1.1)) *
    (Math.sin(elapsed * 5.2 + phase * 2.5 + 1.2) * 0.65 +
      Math.cos(elapsed * 10.4 + phase * 1.8) * 0.35);
  const clothFlutter = wind * windGust;
  const clothFlutter2 = wind * windGust2;

  if (rig.scarfTailBone) {
    rig.scarfTailBone.rotation.x = -0.12 - Math.abs(clothFlutter) * 0.44 - wind * 0.22;
    rig.scarfTailBone.rotation.z = -0.14 + clothFlutter * 0.56;
  }
  if (rig.scarfSideTailBone) {
    rig.scarfSideTailBone.rotation.x = -0.10 - Math.abs(clothFlutter2) * 0.38 - wind * 0.18;
    rig.scarfSideTailBone.rotation.z = 0.16 + clothFlutter2 * 0.48;
  }
  if (rig.hairTailBone) {
    rig.hairTailBone.rotation.x = 0.06 + Math.abs(clothFlutter) * 0.32 + wind * 0.14;
    rig.hairTailBone.rotation.z = clothFlutter * 0.38;
  }
  if (rig.jacketFlapLeft && rig.jacketFlapRight) {
    rig.jacketFlapLeft.rotation.y = -0.18 - wind * 0.26 + clothFlutter * 0.32;
    rig.jacketFlapLeft.rotation.x = -wind * 0.1 - Math.abs(clothFlutter) * 0.18;
    rig.jacketFlapRight.rotation.y = 0.18 + wind * 0.26 + clothFlutter * 0.32;
    rig.jacketFlapRight.rotation.x = -wind * 0.1 - Math.abs(clothFlutter) * 0.18;
  }

  // Organic periodic eye blinking + subtle quick double-blink rhythm
  const blinkPeriod = 3.9 + ((vStyle * 0.37) % 1.4);
  const blinkCycle = (((elapsed + phase * 1.37) % blinkPeriod) + blinkPeriod) % blinkPeriod;
  const blinkAmt = blinkCycle < 0.15 ? Math.sin((blinkCycle / 0.15) * Math.PI) : 0;

  // Living 3D eye saccades (quick darting focal fixations) + subtle 3D eyebrow micro-expressions!
  const isReadingProp =
    (mode === 'seated' || mode === 'standing_idle' || mode === 'standing_strap') &&
    (rig.activity === 'phone' || rig.activity === 'newspaper');
  const saccadeYaw = isReadingProp
    ? Math.tanh(Math.sin(elapsed * 2.1 + phase * 1.7) * 3.2) * 0.11
    : Math.tanh(Math.sin(elapsed * 0.85 + phase * 1.9) * 3.8) * 0.21;
  const saccadePitch = isReadingProp
    ? 0.14 + Math.tanh(Math.sin(elapsed * 1.2 + phase) * 2.5) * 0.05
    : Math.tanh(Math.sin(elapsed * 0.58 + phase * 2.3) * 2.8) * 0.08;
  rig.eyeballLeft.rotation.set(saccadePitch, saccadeYaw, 0);
  rig.eyeballRight.rotation.set(saccadePitch, saccadeYaw, 0);

  // Upper eyelid follows eye pitch slightly for natural realism + blinks cleanly
  const lidPitch = -0.24 + saccadePitch * 0.42 + blinkAmt * 0.58;
  rig.eyelidLeft.rotation.x = lidPitch;
  rig.eyelidRight.rotation.x = lidPitch;

  // Subtle eyebrow lift on upward/sideways glances, gentle focused knit when reading phone/newspaper
  const browExpr = isReadingProp
    ? -0.0014 + Math.sin(elapsed * 0.9 + phase) * 0.0006
    : Math.max(0, -saccadePitch) * 0.022 + Math.sin(elapsed * 0.55 + phase * 1.3) * 0.0012;
  const browAsym = Math.sin(elapsed * 0.38 + phase * 2.1) * 0.0007;
  rig.browLeft.position.y = 0.1118 + browExpr + browAsym;
  rig.browRight.position.y = 0.1118 + browExpr - browAsym;
  rig.browLeft.rotation.z = 0.085 + (isReadingProp ? -0.055 : browExpr * 18.0);
  rig.browRight.rotation.z = -0.085 - (isReadingProp ? -0.055 : browExpr * 18.0);

  const showProps = mode === 'seated' || mode === 'standing_idle' || mode === 'standing_strap';
  if (rig.newspaperProp) {
    rig.newspaperProp.visible = showProps && mode !== 'standing_strap';
  }
  if (rig.phoneProp) {
    rig.phoneProp.visible = showProps;
  }
  if (rig.cigaretteProp) {
    rig.cigaretteProp.visible = showProps;
  }

  // Spec 2: 4.8s smoking cycle with 0.85s lip-contact hold + inhale ember flare + exhale puff
  const cigCycle = (((elapsed / 4.8 + phase * 0.37) % 1) + 1) % 1;
  const cigSec = cigCycle * 4.8;
  const activeCig = rig.activity === 'cigarette' && showProps;
  let puffWeight = 0;
  let inhaleFactor = 0;
  if (activeCig) {
    if (cigSec < 0.65) {
      puffWeight = smoothstep(0, 0.65, cigSec);
    } else if (cigSec < 1.50) {
      puffWeight = 1.0; // exact 0.85s hold at lips!
      inhaleFactor = smoothstep(0.65, 1.15, cigSec);
    } else if (cigSec < 2.20) {
      puffWeight = 1.0 - smoothstep(1.50, 2.20, cigSec);
      inhaleFactor = (1.0 - smoothstep(1.50, 1.85, cigSec)) * 0.65;
    }
  }
  const exhaleFactor = activeCig
    ? Math.sin(THREE.MathUtils.clamp((cigSec - 1.55) / 1.30, 0, 1) * Math.PI)
    : 0;
  if (rig.cigEmberMat) {
    rig.cigEmberMat.emissiveIntensity =
      1.65 + (puffWeight * 0.55 + inhaleFactor * 1.15) * 2.8 + Math.sin(elapsed * 9 + phase) * 0.25;
  }

  // Defer smoke puff placement until after upper-body arm IK solves below (see end of applyHumanPose)

  // 2. General ambient smoke haze hanging around smokers:
  //    thicker close near the smoker (noticeable, never obscuring!) and thinner farther away!
  if (rig.ambientSmokeClouds.length > 0) {
    const activeSmoke = rig.activity === 'cigarette' && showProps;
    const basePelvisY = mode === 'seated' ? rig.seatedPelvisY : rig.standingPelvisY;
    for (let a = 0; a < rig.ambientSmokeClouds.length; a++) {
      const amb = rig.ambientSmokeClouds[a];
      amb.visible = activeSmoke;
      if (!activeSmoke) continue;
      const nearZone = a < 2; // 0,1 = closer, slightly thicker; 2,3 = wider outer drifting veil, thinner!
      const driftPhase = elapsed * (nearZone ? 0.32 : 0.22) + phase * 1.7 + a * 1.57;
      const radialDist = nearZone ? 0.36 + a * 0.24 : 1.15 + (a - 2) * 0.68;
      const ax = Math.sin(driftPhase) * radialDist + wind * (nearZone ? 0.28 : 0.68);
      const ay =
        basePelvisY +
        (nearZone ? 0.64 + a * 0.22 : 0.88 + (a - 2) * 0.30) +
        Math.sin(driftPhase * 0.75 + a) * 0.12;
      const az = Math.cos(driftPhase * 0.85) * radialDist * 0.72 + (nearZone ? 0.22 : 0.34);
      amb.position.set(ax, ay, az);
      const cloudSize = nearZone ? 0.95 + a * 0.32 : 1.75 + (a - 2) * 0.58;
      amb.scale.set(cloudSize, cloudSize * 0.78, 1);
      // Noticeable near smoker (~0.13-0.16), softer & thinner farther away (~0.055-0.08) — never blocks sight!
      const pulse = 0.86 + Math.sin(elapsed * 0.9 + a * 1.9 + phase) * 0.14;
      (amb.material as THREE.SpriteMaterial).opacity = (nearZone ? 0.145 : 0.068) * pulse;
    }
  }

  // Reset wrists, neck & hand grip meshes cleanly to neutral before pose-specific shaping
  rig.leftHandGrp.rotation.set(0, 0, 0);
  rig.rightHandGrp.rotation.set(0, 0, 0);
  rig.leftHandNormalMesh.visible = true;
  rig.leftHandStrapMesh.visible = false;
  rig.rightHandNormalMesh.visible = true;
  rig.rightHandStrapMesh.visible = false;
  rig.neck.rotation.set(0, 0, 0);

  const gripStrapWithArm = (sideSign: -1 | 1) => {
    if (sideSign < 0) {
      rig.leftHandNormalMesh.visible = false;
      rig.leftHandStrapMesh.visible = true;
    } else {
      rig.rightHandNormalMesh.visible = false;
      rig.rightHandStrapMesh.visible = true;
    }
    const strapTarget = params.strapTargetLocal ?? {
      x: sideSign * 0.16,
      y: 1.62,
      z: 0.28,
    };
    solveStrapArmIK(rig, sideSign, strapTarget);
  };

  const applyActivityUpperPose = (isStandingStrap: boolean) => {
    if (rig.activity === 'newspaper' && !isStandingStrap) {
      const pageRustle = Math.sin(elapsed * 1.05 + phase) * 0.018;
      rig.leftShoulder.rotation.set(-0.62 + pageRustle, 0.12, 0.05);
      rig.leftElbow.rotation.set(-1.08, 0, -0.08);
      rig.leftHandGrp.rotation.set(0.12, -0.32, 0.08);

      rig.rightShoulder.rotation.set(-0.62 - pageRustle, -0.12, -0.05);
      rig.rightElbow.rotation.set(-1.08, 0, 0.08);
      rig.rightHandGrp.rotation.set(0.12, 0.32, -0.08);

      const readYaw = naturalGazePlateau(elapsed * 0.36 + phase, 1.8) * 0.11;
      rig.neck.rotation.set(0.08, readYaw * 0.35, 0);
      rig.head.rotation.set(
        0.18 + Math.sin(elapsed * 0.55 + phase) * 0.025,
        readYaw * 0.65,
        Math.sin(elapsed * 0.3 + phase) * 0.025
      );

      // Lock the newspaper margins EXACTLY between the left & right pinching hands, tilted naturally OUTWARD!
      if (rig.newspaperProp) {
        const lPalm = computeHandPalmInChest(rig.leftShoulder, rig.leftElbow, _fkV1);
        const lx = lPalm.x;
        const ly = lPalm.y;
        const lz = lPalm.z;
        const rPalm = computeHandPalmInChest(rig.rightShoulder, rig.rightElbow, _fkV2);
        const spanX = Math.max(0.24, Math.abs(rPalm.x - lx));
        rig.newspaperProp.position.set(
          (lx + rPalm.x) * 0.5,
          (ly + rPalm.y) * 0.5 + 0.044,
          (lz + rPalm.z) * 0.5 + 0.022
        );
        rig.newspaperProp.scale.set((spanX + 0.028) / 0.42, 1.0, 1.0);
        rig.newspaperProp.rotation.set(0.26, 0, pageRustle * 0.65);
      }
      return true;
    }
    if (rig.activity === 'phone') {
      const scrollFlick = Math.sin(elapsed * 2.8 + phase) * 0.018;
      if (isStandingStrap) {
        gripStrapWithArm(-1);
      } else {
        // Natural relaxed left arm hanging softly by hip/waist while right hand holds phone!
        rig.leftShoulder.rotation.set(-0.10 + breath * 1.4, 0.06, 0.045);
        rig.leftElbow.rotation.set(-0.32, 0, -0.06);
        rig.leftHandGrp.rotation.set(0, -0.10, 0);
      }
      // Ergonomic chest-height smartphone reading pose: forearm supinated so upright screen faces eyes cleanly!
      rig.rightShoulder.rotation.set(-0.56, -0.28, -0.06);
      rig.rightElbow.rotation.set(-1.32 + scrollFlick, 0, 0.22);
      rig.rightHandGrp.rotation.set(0.14, 0.72, -0.18);
      // Occasional brief glance up from phone, then natural return to screen
      const glanceUp = Math.max(0, Math.sin(elapsed * 0.32 + phase * 1.7) - 0.72) * 0.65;
      rig.neck.rotation.set(0.10 - glanceUp * 0.4, -0.02, 0);
      rig.head.rotation.set(
        0.22 - glanceUp * 0.75 + Math.sin(elapsed * 0.65 + phase) * 0.022,
        -0.05 + glanceUp * 0.22,
        -0.03
      );
      return true;
    }
    if (rig.activity === 'cigarette') {
      if (isStandingStrap) {
        gripStrapWithArm(-1);
      } else {
        rig.leftShoulder.rotation.set(-0.12 + breath * 1.2, 0.06, 0.048);
        rig.leftElbow.rotation.set(-0.36, 0, -0.06);
      }
      const smokeLook =
        naturalGazePlateau(elapsed * 0.34 + phase, 2.0) * 0.18 * (1 - puffWeight * 0.85);
      rig.neck.rotation.set(-puffWeight * 0.02, smokeLook * 0.35, 0);
      rig.head.rotation.set(0.02 - puffWeight * 0.04, smokeLook * 0.65, 0.02 * (1 - puffWeight));

      if (puffWeight > 0.001) {
        solveCigaretteArmIK(rig, puffWeight);
      } else {
        rig.rightShoulder.rotation.copy(_cigRestShE);
        rig.rightElbow.rotation.copy(_cigRestElE);
        rig.rightHandGrp.rotation.copy(_cigRestHdE);
      }
      return true;
    }
    return false;
  };

  if (mode === 'seated') {
    rig.pelvis.position.set(0, rig.seatedPelvisY, 0.04);
    rig.pelvis.rotation.set(-0.08, 0, sway * 0.24);
    rig.coatTailBone.rotation.set(-0.52, 0, clothFlutter * 0.08);

    rig.spine.rotation.set(0.06 + breath, 0, sway * 0.45);
    rig.chest.rotation.set(breath * 0.7, 0, 0);

    const legStyle = vStyle % 3;
    rig.leftHip.rotation.set(-1.46, legStyle === 1 ? -0.12 : 0.06, -0.05);
    rig.leftKnee.rotation.set(1.42, 0, 0);
    rig.leftAnkle.rotation.set(0.04, 0, 0);
    rig.rightHip.rotation.set(-1.46, legStyle === 2 ? 0.12 : -0.06, 0.05);
    rig.rightKnee.rotation.set(1.42, 0, 0);
    rig.rightAnkle.rotation.set(0.04, 0, 0);

    if (!applyActivityUpperPose(false)) {
      const lookYaw = naturalGazePlateau(elapsed * 0.36 + phase, 2.1) * 0.26;
      const lookPitch = naturalGazePlateau(elapsed * 0.24 + phase * 1.4, 1.8) * 0.07;
      rig.neck.rotation.set(lookPitch * 0.35, lookYaw * 0.38, 0);
      rig.head.rotation.set(lookPitch * 0.65, lookYaw * 0.62, Math.sin(elapsed * 0.32 + phase) * 0.035);

      const armVar = vStyle % 3;
      if (armVar === 0) {
        rig.leftShoulder.rotation.set(-0.42, 0.16, 0.07);
        rig.leftElbow.rotation.set(-0.92, 0, -0.22);
        rig.rightShoulder.rotation.set(-0.42, -0.16, -0.07);
        rig.rightElbow.rotation.set(-0.92, 0, 0.22);
      } else if (armVar === 1) {
        rig.leftShoulder.rotation.set(-0.56, 0.34, 0.10);
        rig.leftElbow.rotation.set(-1.38, 0, -0.40);
        rig.rightShoulder.rotation.set(-0.52, -0.34, -0.10);
        rig.rightElbow.rotation.set(-1.34, 0, 0.40);
      } else {
        rig.leftShoulder.rotation.set(-0.34, 0.10, 0.08);
        rig.leftElbow.rotation.set(-0.78, 0, -0.16);
        rig.rightShoulder.rotation.set(-0.5, -0.22, -0.08);
        rig.rightElbow.rotation.set(-1.1, 0, 0.26);
      }
    }
  } else if (mode === 'worker_desk') {
    rig.pelvis.position.set(0, rig.seatedPelvisY + 0.04, 0);
    rig.pelvis.rotation.set(-0.04, 0, 0);
    rig.coatTailBone.rotation.set(-0.36, 0, 0);
    const deskTurn = naturalGazePlateau(elapsed * 0.42 + phase, 2.0) * 0.12;
    rig.spine.rotation.set(0.1 + breath, deskTurn, 0);
    rig.chest.rotation.set(breath, 0, 0);
    rig.neck.rotation.set(0.03, deskTurn * 0.8, 0);
    rig.head.rotation.set(0.05, deskTurn * 1.4, 0);

    const typeMotion = Math.sin(elapsed * 4.8 + phase) * 0.048;
    rig.leftShoulder.rotation.set(-0.74, 0.16, 0.08);
    rig.leftElbow.rotation.set(-0.92 + typeMotion, 0, -0.10);
    rig.rightShoulder.rotation.set(-0.74, -0.16, -0.08);
    rig.rightElbow.rotation.set(-0.92 - typeMotion, 0, 0.10);

    rig.leftHip.rotation.set(-1.38, 0.04, 0);
    rig.leftKnee.rotation.set(1.36, 0, 0);
    rig.rightHip.rotation.set(-1.38, -0.04, 0);
    rig.rightKnee.rotation.set(1.36, 0, 0);
  } else if (mode === 'worker_guide') {
    const wShift = naturalGazePlateau(elapsed * 0.28 + phase, 1.8); // -1..+1 weight transfer
    const rRelax = Math.max(0, -wShift);
    const lRelax = Math.max(0, wShift);
    rig.pelvis.position.set(wShift * 0.022, rig.standingPelvisY - 0.012, 0);
    rig.pelvis.rotation.set(0.01, -wShift * 0.04, -wShift * 0.038);
    rig.coatTailBone.rotation.set(
      0.08 + Math.abs(clothFlutter) * 0.22 + wind * 0.1,
      0,
      clothFlutter * 0.22
    );
    const gTurn = naturalGazePlateau(elapsed * 0.48 + phase, 2.0);
    rig.spine.rotation.set(breath, gTurn * 0.12, wShift * 0.032);
    rig.chest.rotation.set(breath * 0.8, 0, wShift * 0.016);
    rig.neck.rotation.set(0, gTurn * 0.09, 0);
    rig.head.rotation.set(0.02, gTurn * 0.18, 0);

    const wave = Math.sin(elapsed * 3.1 + phase) * 0.22;
    rig.rightShoulder.rotation.set(-1.12 + wave, -0.16, -0.28);
    rig.rightElbow.rotation.set(-0.68 + wave * 0.4, 0, 0);
    rig.leftShoulder.rotation.set(-0.12 + breath, 0.08, 0.055);
    rig.leftElbow.rotation.set(-0.34, 0, -0.04);

    rig.leftHip.rotation.set(-0.04 - lRelax * 0.08, -0.06 - lRelax * 0.08, -0.03 + wShift * 0.03);
    rig.leftKnee.rotation.set(0.06 + lRelax * 0.16, 0, 0);
    rig.leftAnkle.rotation.set(-0.02 - lRelax * 0.08, 0, 0);
    rig.rightHip.rotation.set(-0.04 - rRelax * 0.08, 0.06 + rRelax * 0.08, 0.03 + wShift * 0.03);
    rig.rightKnee.rotation.set(0.06 + rRelax * 0.16, 0, 0);
    rig.rightAnkle.rotation.set(-0.02 - rRelax * 0.08, 0, 0);
  } else if (mode === 'standing_strap') {
    // Organic balanced contrapposto while holding metro strap + absorbing subtle rail sway
    const wShift = naturalGazePlateau(elapsed * 0.22 + phase, 1.8) * 0.72;
    const rRelax = Math.max(0, -wShift);
    const lRelax = Math.max(0, wShift);
    rig.pelvis.position.set(wShift * 0.020 + sway * 0.015, rig.standingPelvisY - 0.010, 0);
    rig.pelvis.rotation.set(0.015, -wShift * 0.04, -wShift * 0.035 + sway * 0.32);
    rig.coatTailBone.rotation.set(
      0.06 + Math.abs(clothFlutter) * 0.2 + wind * 0.08,
      0,
      clothFlutter * 0.22
    );
    rig.spine.rotation.set(0.01 + breath, wShift * 0.03, wShift * 0.028 + sway * 0.65);
    rig.chest.rotation.set(breath * 0.75, 0, wShift * 0.014);

    rig.leftHip.rotation.set(-0.04 - lRelax * 0.09, -0.07 - lRelax * 0.08, -0.035 + wShift * 0.03);
    rig.leftKnee.rotation.set(0.06 + lRelax * 0.17, 0, 0);
    rig.leftAnkle.rotation.set(-0.02 - lRelax * 0.08, 0, 0);
    rig.rightHip.rotation.set(-0.04 - rRelax * 0.09, 0.07 + rRelax * 0.08, 0.035 + wShift * 0.03);
    rig.rightKnee.rotation.set(0.06 + rRelax * 0.17, 0, 0);
    rig.rightAnkle.rotation.set(-0.02 - rRelax * 0.08, 0, 0);

    if (!applyActivityUpperPose(true)) {
      const lookYaw = naturalGazePlateau(elapsed * 0.34 + phase, 2.2) * 0.28;
      const lookPitch = naturalGazePlateau(elapsed * 0.23 + phase * 1.3, 1.8) * 0.06;
      rig.neck.rotation.set(lookPitch * 0.35, lookYaw * 0.38, -sway * 0.15);
      rig.head.rotation.set(lookPitch * 0.65, lookYaw * 0.62, -sway * 0.22 + wShift * 0.03);
      const useRight = vStyle % 2 === 0;
      if (useRight) {
        gripStrapWithArm(1);
        rig.leftShoulder.rotation.set(-0.10 + sway * 0.32 + breath, 0.06, 0.048);
        rig.leftElbow.rotation.set(-0.32, 0, -0.05);
      } else {
        gripStrapWithArm(-1);
        rig.rightShoulder.rotation.set(-0.10 - sway * 0.32 + breath, -0.06, -0.048);
        rig.rightElbow.rotation.set(-0.32, 0, 0.05);
      }
    }
  } else if (mode === 'standing_idle') {
    // Natural human contrapposto: resting weight on one hip/leg with slow, organic weight transfers!
    const stanceSide = vStyle % 2 === 0 ? 1 : -1;
    const wShift = THREE.MathUtils.clamp(
      stanceSide * 0.42 + naturalGazePlateau(elapsed * 0.24 + phase, 1.9) * 0.62,
      -1,
      1
    );
    const lRelax = Math.max(0, wShift); // >0 when resting on right leg, so left knee relaxes!
    const rRelax = Math.max(0, -wShift); // >0 when resting on left leg, so right knee relaxes!
    const settleDrop = Math.abs(wShift) * 0.015;

    rig.pelvis.position.set(wShift * 0.030, rig.standingPelvisY - settleDrop, 0);
    rig.pelvis.rotation.set(0.015, -wShift * 0.065, -wShift * 0.052);
    rig.coatTailBone.rotation.set(
      0.08 + Math.abs(clothFlutter) * 0.28 + wind * 0.14,
      0,
      clothFlutter * 0.32 - wShift * 0.04
    );
    // Natural spine S-curve counter-tilting over the loaded hip + subtle breathing
    rig.spine.rotation.set(0.012 + breath, wShift * 0.045, wShift * 0.044);
    rig.chest.rotation.set(breath * 0.85, wShift * 0.025, wShift * 0.022);

    // Loaded stance leg stays tall & straight; relaxed leg bends softly at the knee & turns gently out!
    rig.leftHip.rotation.set(
      -0.02 - lRelax * 0.12,
      -0.07 - lRelax * 0.10,
      -0.025 + wShift * 0.048
    );
    rig.leftKnee.rotation.set(0.04 + lRelax * 0.22, 0, 0);
    rig.leftAnkle.rotation.set(-0.02 - lRelax * 0.10, 0, -wShift * 0.02);

    rig.rightHip.rotation.set(
      -0.02 - rRelax * 0.12,
      0.07 + rRelax * 0.10,
      0.025 + wShift * 0.048
    );
    rig.rightKnee.rotation.set(0.04 + rRelax * 0.22, 0, 0);
    rig.rightAnkle.rotation.set(-0.02 - rRelax * 0.10, 0, -wShift * 0.02);

    if (!applyActivityUpperPose(false)) {
      const lookYaw = naturalGazePlateau(elapsed * 0.34 + phase, 2.2) * 0.29;
      const lookPitch = naturalGazePlateau(elapsed * 0.22 + phase * 1.4, 1.8) * 0.065;
      rig.neck.rotation.set(lookPitch * 0.36, lookYaw * 0.38, -wShift * 0.02);
      rig.head.rotation.set(
        lookPitch * 0.64,
        lookYaw * 0.62,
        -wShift * 0.032 + Math.sin(elapsed * 0.28 + phase) * 0.025
      );

      // Relaxed, natural hanging shoulders (close to torso, never awkward A-pose!) + subtle weight asymmetry
      const idleVar = vStyle % 3;
      if (idleVar === 0) {
        rig.leftShoulder.rotation.set(-0.07 + breath * 1.6, 0.05, 0.042 - wShift * 0.015);
        rig.leftElbow.rotation.set(-0.26 - lRelax * 0.08, 0, -0.05);
        rig.rightShoulder.rotation.set(-0.10 - breath * 1.2, -0.05, -0.042 - wShift * 0.015);
        rig.rightElbow.rotation.set(-0.32 - rRelax * 0.08, 0, 0.05);
      } else if (idleVar === 1) {
        // Casual relaxed stance with one hand gently raised near coat pocket / waist
        rig.leftShoulder.rotation.set(-0.22 + breath * 1.4, 0.14, 0.055);
        rig.leftElbow.rotation.set(-0.68, 0, -0.18);
        rig.rightShoulder.rotation.set(-0.08 - breath * 1.2, -0.05, -0.042);
        rig.rightElbow.rotation.set(-0.28, 0, 0.05);
      } else {
        // Lightly folded relaxed arms across lower torso
        rig.leftShoulder.rotation.set(-0.32 + breath * 1.4, 0.24, 0.065);
        rig.leftElbow.rotation.set(-1.12, 0, -0.32);
        rig.rightShoulder.rotation.set(-0.30 - breath * 1.2, -0.24, -0.065);
        rig.rightElbow.rotation.set(-1.08, 0, 0.32);
      }
    }
  } else {
    // Smooth, grounded biomechanical walking gait (natural hip sway/drop, soft knee drive, relaxed arms!)
    const w = params.walkCycle ?? elapsed * 6.8 + phase;
    const sinW = Math.sin(w);
    const cosW = Math.cos(w);
    const doubleBounce = Math.abs(cosW) * 0.028;

    rig.pelvis.position.set(sinW * 0.016, rig.standingPelvisY - 0.016 + doubleBounce, 0);
    rig.pelvis.rotation.set(0.035, sinW * 0.085, -sinW * 0.042);
    rig.coatTailBone.rotation.set(
      0.16 + Math.abs(sinW) * 0.18 + wind * 0.18 + Math.abs(clothFlutter) * 0.24,
      0,
      clothFlutter * 0.3
    );
    rig.spine.rotation.set(0.035 + breath * 0.6, -sinW * 0.11, sinW * 0.034);
    rig.chest.rotation.set(breath * 0.7, -sinW * 0.04, 0);
    const walkLook = naturalGazePlateau(elapsed * 0.42 + phase, 1.9) * 0.14;
    rig.neck.rotation.set(-0.01, walkLook * 0.38, 0);
    rig.head.rotation.set(-0.015, walkLook * 0.62, -sinW * 0.014);

    const lStride = sinW * 0.52;
    const rStride = -sinW * 0.52;
    rig.leftHip.rotation.set(-lStride, -0.03, -0.015 + sinW * 0.018);
    rig.leftKnee.rotation.set(Math.max(0.04, -cosW * 0.64 + 0.11), 0, 0);
    rig.leftAnkle.rotation.set(lStride * 0.28 - Math.max(0, -cosW) * 0.12, 0, 0);

    rig.rightHip.rotation.set(-rStride, 0.03, 0.015 + sinW * 0.018);
    rig.rightKnee.rotation.set(Math.max(0.04, cosW * 0.64 + 0.11), 0, 0);
    rig.rightAnkle.rotation.set(rStride * 0.28 - Math.max(0, cosW) * 0.12, 0, 0);

    rig.leftShoulder.rotation.set(sinW * 0.40 - 0.05, 0.04, 0.048);
    rig.leftElbow.rotation.set(-0.22 - Math.max(0, -sinW) * 0.34, 0, -0.04);
    rig.rightShoulder.rotation.set(-sinW * 0.40 - 0.05, -0.04, -0.048);
    rig.rightElbow.rotation.set(-0.22 - Math.max(0, sinW) * 0.34, 0, 0.04);
  }

  // Spec 1: Polite aisle/queue sidestep (±0.65 rad) + head-nod overlay
  const sidestepYaw = params.sidestepYaw ?? 0;
  if (Math.abs(sidestepYaw) > 0.002) {
    rig.spine.rotation.y += sidestepYaw * 0.45;
    rig.chest.rotation.y += sidestepYaw * 0.55;
    rig.neck.rotation.y -= sidestepYaw * 0.22; // keep eyes gently toward travel path
  }
  const nodPitch = params.nodPitch ?? 0;
  if (Math.abs(nodPitch) > 0.002) {
    rig.neck.rotation.x += nodPitch * 0.42;
    rig.head.rotation.x += nodPitch * 0.58;
  }

  // Spec 1: Upset reaction after rude bump (glare w/ eyeballs+brows, frustrated gesture)
  const upset = THREE.MathUtils.clamp(params.upsetProgress ?? 0, 0, 1);
  if (upset > 0.005) {
    const glareYaw = THREE.MathUtils.clamp(params.upsetLookYaw ?? 0.55, -0.95, 0.95);
    rig.neck.rotation.y = THREE.MathUtils.lerp(rig.neck.rotation.y, glareYaw * 0.36, upset);
    rig.head.rotation.y = THREE.MathUtils.lerp(rig.head.rotation.y, glareYaw * 0.64, upset);
    rig.head.rotation.x = THREE.MathUtils.lerp(rig.head.rotation.x, -0.05, upset);
    rig.eyeballLeft.rotation.y = THREE.MathUtils.lerp(rig.eyeballLeft.rotation.y, glareYaw * 0.24, upset);
    rig.eyeballRight.rotation.y = THREE.MathUtils.lerp(rig.eyeballRight.rotation.y, glareYaw * 0.24, upset);
    rig.eyeballLeft.rotation.x = THREE.MathUtils.lerp(rig.eyeballLeft.rotation.x, -0.04, upset);
    rig.eyeballRight.rotation.x = THREE.MathUtils.lerp(rig.eyeballRight.rotation.x, -0.04, upset);
    rig.eyelidLeft.rotation.x += 0.14 * upset;
    rig.eyelidRight.rotation.x += 0.14 * upset;
    rig.browLeft.position.y -= 0.0044 * upset;
    rig.browRight.position.y -= 0.0044 * upset;
    rig.browLeft.rotation.z -= 0.22 * upset;
    rig.browRight.rotation.z += 0.22 * upset;

    // Frustrated free-arm shake gesture (never breaks strap grip or seated newspaper)
    const shake = Math.sin(elapsed * 9.5 + phase) * 0.18 * upset;
    if (mode !== 'seated' && rig.activity !== 'newspaper') {
      const canUseLeft = !rig.leftHandStrapMesh.visible;
      if (canUseLeft) {
        rig.leftShoulder.rotation.x = THREE.MathUtils.lerp(rig.leftShoulder.rotation.x, -0.78 + shake * 0.4, upset);
        rig.leftShoulder.rotation.z = THREE.MathUtils.lerp(rig.leftShoulder.rotation.z, 0.18, upset);
        rig.leftElbow.rotation.x = THREE.MathUtils.lerp(rig.leftElbow.rotation.x, -1.28 + shake, upset);
        rig.leftHandGrp.rotation.set(0.24, -0.22, shake * 0.8);
      } else if (rig.activity !== 'cigarette') {
        rig.rightShoulder.rotation.x = THREE.MathUtils.lerp(rig.rightShoulder.rotation.x, -0.78 + shake * 0.4, upset);
        rig.rightShoulder.rotation.z = THREE.MathUtils.lerp(rig.rightShoulder.rotation.z, -0.18, upset);
        rig.rightElbow.rotation.x = THREE.MathUtils.lerp(rig.rightElbow.rotation.x, -1.28 + shake, upset);
        rig.rightHandGrp.rotation.set(0.24, 0.22, -shake * 0.8);
      }
    }
  }

  // Update cigarette smoke puffs AFTER final upper-body + IK + social reaction poses!
  if (rig.smokePuffs.length > 0) {
    if (activeCig) {
      computeCigarettePointInChest(rig, CIG_EMBER_LOCAL.x, _cigTmpV);
      computeMouthTargetInChest(rig, _cigLipChest);
    }
    for (let s = 0; s < rig.smokePuffs.length; s++) {
      const sp = rig.smokePuffs[s];
      sp.visible = activeCig;
      if (!activeCig) continue;
      const t = (((elapsed * 0.36 + s / rig.smokePuffs.length + phase * 0.2) % 1) + 1) % 1;
      const isExhalePuff = s === 4 && exhaleFactor > 0.08;
      const ox = isExhalePuff ? _cigLipChest.x : _cigTmpV.x;
      const oy = isExhalePuff ? _cigLipChest.y : _cigTmpV.y;
      const oz = isExhalePuff ? _cigLipChest.z + t * 0.26 : _cigTmpV.z + t * 0.10;
      const curlX =
        Math.sin(elapsed * 1.85 + s * 2.1 + t * 4.5 + phase) * (0.04 + t * 0.12) +
        wind * 0.24 * t;
      const curlZ = Math.cos(elapsed * 1.45 + s * 1.7 + t * 3.2 + phase) * (0.03 + t * 0.08);
      sp.position.set(ox + curlX, oy + t * 0.62, oz + curlZ);
      const sz = (isExhalePuff ? 0.12 : 0.055) + t * (isExhalePuff ? 0.44 : 0.34);
      sp.scale.set(sz, sz, 1);
      const env = Math.sin(t * Math.PI);
      const baseAlpha = isExhalePuff ? 0.28 * exhaleFactor : 0.26 + puffWeight * 0.14;
      (sp.material as THREE.SpriteMaterial).opacity = env * baseAlpha;
    }
  }
}

// =========================================================================
// ENEMY WEAPON SYSTEM: BLACK NPC CARBINE CLONE, RED LED POWER-UP,
// DAY/NIGHT MUZZLE FLASH + LIGHT SPILL, & ADDITIVE HUMANRIG HOLD-POSE LAYER
// =========================================================================

export type EnemyWeaponState =
  | 'patrol'
  | 'draw'
  | 'aim'
  | 'fire'
  | 'low_ready'
  | 'reload';

export type EnemyWeaponClass =
  | 'guard'
  | 'soldier'
  | 'enforcer'
  | 'gang'
  | 'bandit'
  | 'heavy'
  | 'brute';

/**
 * Single data-driven enemy class -> canonical weapon assignment table:
 * - guards / soldiers / gang / bandits -> Service Carbine
 * - mob enforcers -> Full-Auto Carbine
 * - heavy / brute classes -> Pump Shotgun
 */
export const ENEMY_CLASS_WEAPON_TABLE: Record<EnemyWeaponClass, SharedWeaponId> = {
  guard: 'service_carbine',
  soldier: 'service_carbine',
  gang: 'service_carbine',
  bandit: 'service_carbine',
  enforcer: 'full_auto_carbine',
  heavy: 'pump_shotgun',
  brute: 'pump_shotgun',
};

export function getEnemyWeaponIdForClass(
  enemyClass: EnemyWeaponClass = 'gang'
): SharedWeaponId {
  return ENEMY_CLASS_WEAPON_TABLE[enemyClass] ?? 'service_carbine';
}

export interface EnemyWeaponClassProfile {
  kind: EnemyWeaponClass;
  /** Torso blading yaw into rifle stance (rad) */
  stanceYaw: number;
  /** Blend responsiveness for draw/aim/low-ready transitions (1/s) */
  blendRate: number;
  /** Organic sway & tremor amplitude multiplier */
  swayAmp: number;
  /** Weapon roll cant in aim/fire (rad, visual swagger vs disciplined vertical) */
  weaponCant: number;
  /** Recoil kick amplitude multiplier (visual only) */
  recoilAmp: number;
  /** Recoil exponential recovery rate (1/s) */
  recoilDamp: number;
  /** Low-ready muzzle dip pitch (rad) */
  lowReadyPitch: number;
  /** Upper-body forward combat lean (rad) */
  combatLean: number;
}

const ENEMY_WEAPON_CLASS_PROFILES: Record<EnemyWeaponClass, EnemyWeaponClassProfile> = {
  guard: {
    kind: 'guard',
    stanceYaw: 0.34,
    blendRate: 10.5,
    swayAmp: 0.26,
    weaponCant: -0.015,
    recoilAmp: 0.85,
    recoilDamp: 16.5,
    lowReadyPitch: 0.36,
    combatLean: 0.055,
  },
  soldier: {
    kind: 'soldier',
    stanceYaw: 0.38,
    blendRate: 11.5,
    swayAmp: 0.22,
    weaponCant: -0.01,
    recoilAmp: 0.82,
    recoilDamp: 17.5,
    lowReadyPitch: 0.34,
    combatLean: 0.068,
  },
  enforcer: {
    kind: 'enforcer',
    stanceYaw: 0.26,
    blendRate: 6.4,
    swayAmp: 0.42,
    weaponCant: -0.045,
    recoilAmp: 1.12,
    recoilDamp: 10.8,
    lowReadyPitch: 0.42,
    combatLean: 0.075,
  },
  gang: {
    kind: 'gang',
    stanceYaw: 0.30,
    blendRate: 8.6,
    swayAmp: 0.82,
    weaponCant: -0.105,
    recoilAmp: 1.08,
    recoilDamp: 12.2,
    lowReadyPitch: 0.44,
    combatLean: 0.048,
  },
  bandit: {
    kind: 'bandit',
    stanceYaw: 0.28,
    blendRate: 7.8,
    swayAmp: 0.95,
    weaponCant: -0.135,
    recoilAmp: 1.15,
    recoilDamp: 11.4,
    lowReadyPitch: 0.48,
    combatLean: 0.042,
  },
  heavy: {
    kind: 'heavy',
    stanceYaw: 0.24,
    blendRate: 6.0,
    swayAmp: 0.34,
    weaponCant: -0.03,
    recoilAmp: 1.38,
    recoilDamp: 9.2,
    lowReadyPitch: 0.38,
    combatLean: 0.088,
  },
  brute: {
    kind: 'brute',
    stanceYaw: 0.22,
    blendRate: 5.6,
    swayAmp: 0.48,
    weaponCant: -0.055,
    recoilAmp: 1.46,
    recoilDamp: 8.6,
    lowReadyPitch: 0.40,
    combatLean: 0.095,
  },
};

export function getEnemyWeaponClassProfile(
  enemyClass: EnemyWeaponClass = 'gang'
): EnemyWeaponClassProfile {
  return ENEMY_WEAPON_CLASS_PROFILES[enemyClass] ?? ENEMY_WEAPON_CLASS_PROFILES.gang;
}

// Cached procedural textures & geometries for enemy carbines (allocated ONCE, zero GC!)
let _npcBlackMaterials: {
  gunMetal: THREE.MeshStandardMaterial;
  polymer: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
} | null = null;

let _ledGlowTex: THREE.CanvasTexture | null = null;
let _flashFinTex: THREE.CanvasTexture | null = null;
let _flashHaloTex: THREE.CanvasTexture | null = null;
let _ledHousingGeo: THREE.BoxGeometry | null = null;
let _ledDiodeGeo: THREE.SphereGeometry | null = null;
let _flashFinGeo: THREE.PlaneGeometry | null = null;
let _flashConeGeo: THREE.ConeGeometry | null = null;

function getRedLedGlowTexture(): THREE.CanvasTexture {
  if (_ledGlowTex) return _ledGlowTex;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  g.addColorStop(0.0, 'rgba(255, 235, 235, 1.0)');
  g.addColorStop(0.16, 'rgba(255, 64, 48, 0.96)');
  g.addColorStop(0.42, 'rgba(235, 16, 16, 0.62)');
  g.addColorStop(0.72, 'rgba(175, 0, 8, 0.20)');
  g.addColorStop(1.0, 'rgba(120, 0, 0, 0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _ledGlowTex = tex;
  return tex;
}

function getMuzzleFlashFinTexture(): THREE.CanvasTexture {
  if (_flashFinTex) return _flashFinTex;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);

  // Forward-jetting hot muzzle flame plume (base at bottom y=124 -> tip at top y=4)
  const coreG = ctx.createRadialGradient(64, 102, 2, 64, 66, 60);
  coreG.addColorStop(0.0, 'rgba(255, 255, 245, 1.0)');
  coreG.addColorStop(0.24, 'rgba(255, 232, 130, 0.98)');
  coreG.addColorStop(0.55, 'rgba(255, 138, 28, 0.72)');
  coreG.addColorStop(0.84, 'rgba(220, 48, 6, 0.22)');
  coreG.addColorStop(1.0, 'rgba(160, 16, 0, 0.0)');

  ctx.fillStyle = coreG;
  ctx.beginPath();
  ctx.moveTo(64, 4);
  ctx.quadraticCurveTo(84, 48, 104, 86);
  ctx.quadraticCurveTo(84, 96, 94, 114);
  ctx.quadraticCurveTo(72, 122, 64, 124);
  ctx.quadraticCurveTo(56, 122, 34, 114);
  ctx.quadraticCurveTo(44, 96, 24, 86);
  ctx.quadraticCurveTo(44, 48, 64, 4);
  ctx.closePath();
  ctx.fill();

  // Blinding white-yellow inner hot jet
  const hotG = ctx.createRadialGradient(64, 98, 2, 64, 86, 30);
  hotG.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  hotG.addColorStop(0.55, 'rgba(255, 245, 196, 0.85)');
  hotG.addColorStop(1.0, 'rgba(255, 200, 90, 0.0)');
  ctx.fillStyle = hotG;
  ctx.beginPath();
  ctx.ellipse(64, 88, 16, 34, 0, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _flashFinTex = tex;
  return tex;
}

function getMuzzleFlashHaloTexture(): THREE.CanvasTexture {
  if (_flashHaloTex) return _flashHaloTex;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);

  // Star-spiked radial flash so it reads cleanly even head-on in bright daylight
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 60);
  g.addColorStop(0.0, 'rgba(255, 255, 244, 1.0)');
  g.addColorStop(0.22, 'rgba(255, 232, 138, 0.96)');
  g.addColorStop(0.48, 'rgba(255, 146, 34, 0.65)');
  g.addColorStop(0.76, 'rgba(230, 62, 10, 0.22)');
  g.addColorStop(1.0, 'rgba(180, 20, 0, 0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);

  // Crisp 6-point muzzle brake gas spikes
  ctx.save();
  ctx.translate(64, 64);
  for (let i = 0; i < 6; i++) {
    ctx.rotate(Math.PI / 3);
    const sg = ctx.createLinearGradient(0, 0, 0, -58);
    sg.addColorStop(0, 'rgba(255, 252, 224, 0.95)');
    sg.addColorStop(0.45, 'rgba(255, 178, 56, 0.55)');
    sg.addColorStop(1, 'rgba(255, 80, 0, 0.0)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(0, -58);
    ctx.lineTo(7, -8);
    ctx.lineTo(-7, -8);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _flashHaloTex = tex;
  return tex;
}

/**
 * Pooled non-shadow PointLight manager for brief enemy muzzle flash light spill
 * illuminating the shooter's hands, weapon, torso, and nearby walls/ground at 60 fps.
 */
export class MuzzleFlashLightPool {
  public readonly root = new THREE.Group();
  private readonly lights: THREE.PointLight[] = [];
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly peakIntensity: Float32Array;
  private cursor = 0;

  constructor(poolSize = 4) {
    this.root.name = 'EnemyMuzzleFlashLightPool';
    this.life = new Float32Array(poolSize);
    this.maxLife = new Float32Array(poolSize);
    this.peakIntensity = new Float32Array(poolSize);

    for (let i = 0; i < poolSize; i++) {
      const pt = new THREE.PointLight(0xffb44c, 0, 7.5, 2.0);
      pt.castShadow = false;
      pt.visible = false;
      this.root.add(pt);
      this.lights.push(pt);
    }
  }

  public trigger(
    worldPos: THREE.Vector3,
    intensity = 8.2,
    duration = 0.072
  ): void {
    // Reuse an expired slot first; otherwise steal round-robin
    let idx = -1;
    for (let i = 0; i < this.lights.length; i++) {
      if (this.life[i] <= 0) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.lights.length;
    }
    const lt = this.lights[idx];
    lt.position.copy(worldPos);
    lt.intensity = intensity;
    lt.visible = true;
    this.life[idx] = duration;
    this.maxLife[idx] = duration;
    this.peakIntensity[idx] = intensity;
  }

  public update(dt: number): void {
    for (let i = 0; i < this.lights.length; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.life[i] = 0;
        this.lights[i].intensity = 0;
        this.lights[i].visible = false;
      } else {
        const frac = this.life[i] / Math.max(0.001, this.maxLife[i]);
        // Fast bright spike with warm falloff onto hands & nearby geometry
        this.lights[i].intensity = this.peakIntensity[i] * frac * frac;
      }
    }
  }

  public dispose(): void {
    for (let i = 0; i < this.lights.length; i++) {
      this.root.remove(this.lights[i]);
      this.lights[i].dispose();
    }
    this.lights.length = 0;
  }
}

export interface EnemyCarbineVisual {
  weaponId: SharedWeaponId;
  root: THREE.Group;
  muzzleAnchor: THREE.Object3D;
  muzzleLocalPos: THREE.Vector3;
  magazineMesh: THREE.Mesh | null;
  magazineRestPos: THREE.Vector3;
  magazineRestRot: THREE.Euler;
  pumpForend: THREE.Object3D | null;
  pumpForendRestZ: number;
  pumpTimer: number;
  pumpCycleSec: number;
  pumpStroke: number;
  ledMesh: THREE.Mesh;
  ledMat: THREE.MeshStandardMaterial;
  ledGlowSprite: THREE.Sprite;
  ledGlowMat: THREE.SpriteMaterial;
  flashGroup: THREE.Group;
  flashFinMat: THREE.MeshBasicMaterial;
  flashHaloMat: THREE.SpriteMaterial;
  flashCoreMat: THREE.SpriteMaterial;
  flashTimer: number;
  flashDuration: number;
  flashJustTriggered: boolean;
  ledIntensity: number;
  ledFirePulse: number;
}

const _ledOffColor = new THREE.Color('#190406');
const _ledKindleColor = new THREE.Color('#7f0a0e');
const _ledFullColor = new THREE.Color('#ff2218');
const _ledEmissiveColor = new THREE.Color('#ff1410');
const _flashWorldScratch = new THREE.Vector3();

/**
 * Builds an NPC enemy weapon strictly from createSharedWeaponMesh(scale, weaponId)
 * (Variation Law: same canonical mesh & stats as the player's arsenal),
 * cloning the shared materials to matte tactical black (player gun materials untouched),
 * attaching the detection-driven red LED + glow halo sprite, and mounting a daylight/night
 * multi-layer muzzle flash at the true MuzzleAnchor.
 */
export function createEnemyCarbineVisual(
  scale = 0.95,
  weaponId: SharedWeaponId = 'service_carbine'
): EnemyCarbineVisual {
  const spec = getSharedWeaponSpec(weaponId);
  const root = createSharedWeaponMesh(scale, weaponId);
  root.name =
    weaponId === 'full_auto_carbine'
      ? 'EnemyBlackFullAutoCarbine'
      : weaponId === 'pump_shotgun'
      ? 'EnemyBlackPumpShotgun'
      : 'EnemyBlackServiceCarbine';
  root.userData.isWeapon = true;
  root.userData.weaponId = weaponId;

  // Clone the shared materials ONCE for black NPC finish — never mutate sharedWeapon.ts materials!
  if (!_npcBlackMaterials) {
    let baseGun: THREE.MeshStandardMaterial | null = null;
    let basePoly: THREE.MeshStandardMaterial | null = null;
    let baseSteel: THREE.MeshStandardMaterial | null = null;
    root.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh || !(m.material instanceof THREE.MeshStandardMaterial)) return;
      const mat = m.material;
      if (mat.metalness > 0.82 && !baseSteel) baseSteel = mat;
      else if (mat.metalness > 0.5 && !baseGun) baseGun = mat;
      else if (!basePoly) basePoly = mat;
    });
    const gunMetal = (baseGun ?? new THREE.MeshStandardMaterial()).clone();
    gunMetal.color.set('#0b0d11');
    gunMetal.roughness = 0.44;
    gunMetal.metalness = 0.72;

    const polymer = (basePoly ?? new THREE.MeshStandardMaterial()).clone();
    polymer.color.set('#07080b');
    polymer.roughness = 0.76;
    polymer.metalness = 0.14;

    const steel = (baseSteel ?? new THREE.MeshStandardMaterial()).clone();
    steel.color.set('#141820');
    steel.roughness = 0.34;
    steel.metalness = 0.84;

    _npcBlackMaterials = { gunMetal, polymer, steel };
  }

  let magazineMesh: THREE.Mesh | null = null;
  const magazineRestPos = new THREE.Vector3(0, -0.062, 0.105);
  const magazineRestRot = new THREE.Euler(-0.14, 0, 0);

  root.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    const orig = m.material as THREE.MeshStandardMaterial;
    if (orig && orig.isMeshStandardMaterial) {
      if (orig.metalness > 0.82) m.material = _npcBlackMaterials!.steel;
      else if (orig.metalness > 0.5) m.material = _npcBlackMaterials!.gunMetal;
      else m.material = _npcBlackMaterials!.polymer;
    }
    if (
      !magazineMesh &&
      (m.name === 'MagazineMesh' || (weaponId !== 'pump_shotgun' && m.position.y < -0.05 && m.position.z > 0.05))
    ) {
      magazineMesh = m;
      magazineRestPos.copy(m.position);
      magazineRestRot.copy(m.rotation);
    }
  });

  const pumpForend = root.getObjectByName('PumpForend') ?? null;
  const pumpForendRestZ = pumpForend ? pumpForend.position.z : 0.31;

  // Ensure true MuzzleAnchor node exists
  let muzzleAnchor = root.getObjectByName('MuzzleAnchor');
  if (!muzzleAnchor) {
    muzzleAnchor = new THREE.Object3D();
    muzzleAnchor.name = 'MuzzleAnchor';
    muzzleAnchor.position.set(0, 0.042, 0.625);
    root.add(muzzleAnchor);
  }
  const muzzleLocalPos = muzzleAnchor.position.clone();

  // --- RED LED WARM-UP INDICATOR (sight/light housing on the gun + glow sprite) ---
  if (!_ledHousingGeo) {
    _ledHousingGeo = new THREE.BoxGeometry(0.032, 0.018, 0.036);
    _ledDiodeGeo = new THREE.SphereGeometry(0.0135, 10, 8);
  }
  const ledY = weaponId === 'pump_shotgun' ? 0.095 : 0.098;
  const ledHousing = new THREE.Mesh(_ledHousingGeo, _npcBlackMaterials.polymer);
  ledHousing.name = 'EnemyWeaponLedHousing';
  ledHousing.position.set(0, ledY, 0.042);
  root.add(ledHousing);

  // Per-instance LED material so each enemy's detection/aim ramp glows independently!
  const ledMat = new THREE.MeshStandardMaterial({
    color: _ledOffColor.clone(),
    emissive: _ledEmissiveColor.clone(),
    emissiveIntensity: 0.0,
    roughness: 0.18,
    metalness: 0.12,
    toneMapped: false,
  });
  const ledMesh = new THREE.Mesh(_ledDiodeGeo!, ledMat);
  ledMesh.name = 'EnemyWeaponRedLed';
  ledMesh.scale.set(1.15, 0.92, 1.35);
  ledMesh.position.set(0, ledY + 0.008, 0.054);
  root.add(ledMesh);

  const ledGlowMat = new THREE.SpriteMaterial({
    map: getRedLedGlowTexture(),
    color: '#ff241a',
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
  });
  const ledGlowSprite = new THREE.Sprite(ledGlowMat);
  ledGlowSprite.name = 'EnemyWeaponLedGlow';
  ledGlowSprite.position.set(0, ledY + 0.010, 0.060);
  ledGlowSprite.scale.set(0.08, 0.08, 1);
  ledGlowSprite.visible = false;
  ledGlowSprite.renderOrder = 6;
  root.add(ledGlowSprite);

  // --- TRUE MUZZLE FLASH ASSEMBLY (daylight + night visible, per-round randomized) ---
  if (!_flashFinGeo) {
    _flashFinGeo = new THREE.PlaneGeometry(0.24, 0.34);
    _flashFinGeo.translate(0, 0.15, 0);
    _flashConeGeo = new THREE.ConeGeometry(0.072, 0.28, 6, 1, true);
    _flashConeGeo.rotateX(Math.PI * 0.5);
    _flashConeGeo.translate(0, 0, 0.14);
  }

  const flashGroup = new THREE.Group();
  flashGroup.name = 'EnemyMuzzleFlash';
  flashGroup.visible = false;
  muzzleAnchor.add(flashGroup);

  const flashFinMat = new THREE.MeshBasicMaterial({
    map: getMuzzleFlashFinTexture(),
    color: '#fff2cc',
    transparent: true,
    opacity: 0.96,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });

  // 3 crossed star-burst flame planes oriented along +Z barrel axis
  for (let k = 0; k < 3; k++) {
    const fin = new THREE.Mesh(_flashFinGeo, flashFinMat);
    fin.rotation.x = Math.PI * 0.5;
    fin.rotation.y = (k * Math.PI) / 3;
    fin.renderOrder = 7;
    flashGroup.add(fin);
  }

  // Forward gas-jet cone so flash reads unmistakably from side profiles too
  const cone = new THREE.Mesh(_flashConeGeo!, flashFinMat);
  cone.renderOrder = 7;
  flashGroup.add(cone);

  // Bright daylight-punch opaque-core + additive star-halo sprite at the muzzle brake
  const flashCoreMat = new THREE.SpriteMaterial({
    map: getMuzzleFlashHaloTexture(),
    color: '#fff9dc',
    transparent: true,
    opacity: 0.95,
    blending: THREE.NormalBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const flashCore = new THREE.Sprite(flashCoreMat);
  flashCore.position.set(0, 0, 0.03);
  flashCore.scale.set(0.22, 0.22, 1);
  flashCore.renderOrder = 7;
  flashGroup.add(flashCore);

  const flashHaloMat = new THREE.SpriteMaterial({
    map: getMuzzleFlashHaloTexture(),
    color: '#ffaa28',
    transparent: true,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const flashHalo = new THREE.Sprite(flashHaloMat);
  flashHalo.position.set(0, 0, 0.045);
  flashHalo.scale.set(0.42, 0.42, 1);
  flashHalo.renderOrder = 8;
  flashGroup.add(flashHalo);

  return {
    weaponId,
    root,
    muzzleAnchor,
    muzzleLocalPos,
    magazineMesh,
    magazineRestPos,
    magazineRestRot,
    pumpForend,
    pumpForendRestZ,
    pumpTimer: 0,
    pumpCycleSec: spec.pumpCycleSec,
    pumpStroke: 0,
    ledMesh,
    ledMat,
    ledGlowSprite,
    ledGlowMat,
    flashGroup,
    flashFinMat,
    flashHaloMat,
    flashCoreMat,
    flashTimer: 0,
    flashDuration: 0.068,
    flashJustTriggered: false,
    ledIntensity: 0,
    ledFirePulse: 0,
  };
}

/**
 * Evaluates normalized pump-shotgun forend stroke (0 = locked forward, 1 = pulled rearward)
 * across the 0.9 Hz shot cycle.
 */
export function evaluatePumpShotgunCycle(cycleU: number): number {
  if (cycleU <= 0.16 || cycleU >= 0.78) return 0;
  const p = (cycleU - 0.16) / 0.62;
  return Math.sin(p * Math.PI);
}

/**
 * Sets the sliding shotgun pump forend stroke directly (0 = forward, 1 = pulled back).
 */
export function setEnemyWeaponPumpStroke(visual: EnemyCarbineVisual, stroke01: number): void {
  const s = THREE.MathUtils.clamp(stroke01, 0, 1);
  visual.pumpStroke = s;
  if (visual.pumpForend) {
    visual.pumpForend.position.z = visual.pumpForendRestZ - s * 0.098;
  }
}

/**
 * Triggers a vivid per-round muzzle flash at the weapon's true MuzzleAnchor
 * plus a brief pooled PointLight spill onto the shooter's hands and nearby surfaces.
 * Also kicks off the coupled pump-forend cycle on pump_shotgun.
 */
export function triggerEnemyCarbineFlash(
  visual: EnemyCarbineVisual,
  lightPool?: MuzzleFlashLightPool,
  muzzleWorldOverride?: THREE.Vector3
): void {
  const isShotgun = visual.weaponId === 'pump_shotgun';
  const isFullAuto = visual.weaponId === 'full_auto_carbine';
  visual.flashDuration = isShotgun
    ? 0.082 + Math.random() * 0.016
    : isFullAuto
    ? 0.052 + Math.random() * 0.012
    : 0.062 + Math.random() * 0.014;
  visual.flashTimer = visual.flashDuration;
  visual.flashJustTriggered = true;
  visual.flashGroup.visible = true;
  visual.flashGroup.rotation.z = Math.random() * Math.PI * 2;
  const baseScale = isShotgun ? 1.28 : isFullAuto ? 0.92 : 1.0;
  const s = baseScale * (0.88 + Math.random() * 0.42);
  visual.flashGroup.scale.set(s, s, s * (0.92 + Math.random() * 0.35));
  visual.flashFinMat.opacity = 1.0;
  visual.flashCoreMat.opacity = 0.96;
  visual.flashHaloMat.opacity = 0.96;
  visual.ledFirePulse = 1.0;

  if (isShotgun && visual.pumpCycleSec > 0) {
    visual.pumpTimer = visual.pumpCycleSec;
  }

  if (lightPool) {
    if (muzzleWorldOverride) {
      _flashWorldScratch.copy(muzzleWorldOverride);
    } else {
      visual.root.updateMatrixWorld(true);
      visual.muzzleAnchor.getWorldPosition(_flashWorldScratch);
    }
    lightPool.trigger(_flashWorldScratch, isShotgun ? 11.2 : 8.6, isShotgun ? 0.095 : 0.075);
  }
}

/**
 * Animates the magazine mesh offset during reload (mag out -> mag in -> seated).
 */
export function setEnemyCarbineMagOffset(
  visual: EnemyCarbineVisual,
  ox: number,
  oy: number,
  oz: number,
  rotX = 0,
  rotZ = 0
): void {
  if (!visual.magazineMesh) return;
  visual.magazineMesh.position.set(
    visual.magazineRestPos.x + ox,
    visual.magazineRestPos.y + oy,
    visual.magazineRestPos.z + oz
  );
  visual.magazineMesh.rotation.set(
    visual.magazineRestRot.x + rotX,
    visual.magazineRestRot.y,
    visual.magazineRestRot.z + rotZ
  );
}

/**
 * Updates enemy weapon red LED power-up readout (0=dark patrol .. 1=full fire lock),
 * decays active muzzle flash cleanly, and advances coupled pump-shotgun forend cycle.
 * Zero per-frame allocations.
 */
export function updateEnemyCarbineVisual(
  visual: EnemyCarbineVisual,
  dt: number,
  elapsed: number,
  ledTarget: number,
  phase = 0
): void {
  const clampedTarget = THREE.MathUtils.clamp(ledTarget, 0, 1.2);
  // Power up crisply on detection/aim, decay organically on low-ready / lost LOS
  const rampRate = clampedTarget > visual.ledIntensity ? 7.5 : 3.4;
  visual.ledIntensity = THREE.MathUtils.damp(visual.ledIntensity, clampedTarget, rampRate, dt);
  visual.ledFirePulse = THREE.MathUtils.damp(visual.ledFirePulse, 0, 14.0, dt);

  const level = Math.min(1.25, visual.ledIntensity + visual.ledFirePulse * 0.35);

  if (level <= 0.015) {
    visual.ledMat.color.copy(_ledOffColor);
    visual.ledMat.emissiveIntensity = 0.0;
    visual.ledGlowSprite.visible = false;
  } else {
    // Smooth perceptual curve: faint crimson kindling -> bright warning red -> blazing fire lock
    const norm = Math.min(1, level);
    if (norm < 0.45) {
      visual.ledMat.color.copy(_ledOffColor).lerp(_ledKindleColor, norm / 0.45);
    } else {
      visual.ledMat.color.copy(_ledKindleColor).lerp(_ledFullColor, (norm - 0.45) / 0.55);
    }
    const microFlicker =
      norm > 0.65 ? 1.0 + Math.sin(elapsed * 22.0 + phase * 3.1) * 0.07 : 1.0;
    // Emissive ramps 0 -> ~0.9 (kindling) -> ~3.4 (aim) -> ~7.2 (fire) so it reads day & night!
    visual.ledMat.emissiveIntensity =
      (0.35 + Math.pow(level, 1.45) * 5.8) * microFlicker;

    visual.ledGlowSprite.visible = level > 0.05;
    const haloScale = (0.065 + Math.pow(norm, 1.15) * 0.26 + visual.ledFirePulse * 0.11) * microFlicker;
    visual.ledGlowSprite.scale.set(haloScale, haloScale, 1);
    visual.ledGlowMat.opacity = THREE.MathUtils.clamp(
      (0.14 + Math.pow(norm, 1.1) * 0.84) * microFlicker,
      0,
      1
    );
  }

  // Advance coupled pump-shotgun cycle if active
  if (visual.pumpForend) {
    if (visual.pumpTimer > 0 && visual.pumpCycleSec > 0) {
      visual.pumpTimer = Math.max(0, visual.pumpTimer - dt);
      const cycleU = 1.0 - visual.pumpTimer / visual.pumpCycleSec;
      setEnemyWeaponPumpStroke(visual, evaluatePumpShotgunCycle(cycleU));
    } else if (visual.pumpStroke > 0.001) {
      setEnemyWeaponPumpStroke(visual, THREE.MathUtils.damp(visual.pumpStroke, 0, 18.0, dt));
    }
  }

  // Decay active muzzle flash smoothly (guarantee full peak flash on its trigger frame)
  if (visual.flashJustTriggered) {
    visual.flashJustTriggered = false;
  } else if (visual.flashTimer > 0) {
    visual.flashTimer -= dt;
    if (visual.flashTimer <= 0) {
      visual.flashTimer = 0;
      visual.flashGroup.visible = false;
    } else {
      const f = visual.flashTimer / Math.max(0.001, visual.flashDuration);
      visual.flashFinMat.opacity = Math.min(1, f * 1.45);
      visual.flashCoreMat.opacity = Math.min(1, f * 1.35);
      visual.flashHaloMat.opacity = f;
      const shrink = 0.65 + f * 0.45;
      visual.flashGroup.scale.multiplyScalar(Math.pow(shrink, dt * 12));
    }
  }
}

export function disposeEnemyCarbineVisual(visual: EnemyCarbineVisual): void {
  visual.ledMat.dispose();
  visual.ledGlowMat.dispose();
  visual.flashFinMat.dispose();
  visual.flashHaloMat.dispose();
  visual.flashCoreMat.dispose();
}

// =========================================================================
// ADDITIVE WEAPON-HOLD POSE LAYER FOR HumanRig (FROZEN RIG COMPATIBLE!)
// =========================================================================

export interface NpcWeaponRig {
  visual: EnemyCarbineVisual;
  weaponId: SharedWeaponId;
  gripPivot: THREE.Group;
  enemyClass: EnemyWeaponClass;
  profile: EnemyWeaponClassProfile;
  state: EnemyWeaponState;
  drawWeight: number;
  aimWeight: number;
  lowReadyWeight: number;
  twoHandWeight: number;
  reloadWeight: number;
  recoilKick: number;
  ammoInMag: number;
  reloadTimer: number;
  lastShotElapsed: number;
}

export interface WeaponHoldPoseParams {
  dt: number;
  elapsed: number;
  phase: number;
  state: EnemyWeaponState;
  /** 0..1 detection / aim ramp (same fill driving "?" suspicion over enemies) */
  detectionRamp: number;
  /** Relative horizontal aim yaw in rig.root local space (rad, 0 = straight ahead) */
  aimYawOffset?: number;
  /** Vertical aim pitch toward target (rad, +up / -down) */
  aimPitch?: number;
  /** Normalized locomotion speed (0 = standing, 0.5 = walking, 1.0 = running) */
  moveSpeedNorm?: number;
  /** 0..1 normalized reload progress (if driven externally); otherwise uses weaponRig.reloadTimer */
  reloadProgress?: number;
  /** Set true on the frame a shot fires to trigger recoil impulse + muzzle flash + light spill */
  firedThisFrame?: boolean;
  /** Optional pooled PointLight manager for brief muzzle flash light spill */
  lightPool?: MuzzleFlashLightPool;
}

/**
 * Parents the class-assigned black enemy weapon (from ENEMY_CLASS_WEAPON_TABLE)
 * to rig.rightHandGrp without modifying HumanRig or createRiggedHuman.
 */
export function attachWeaponToHumanRig(
  rig: HumanRig,
  enemyClass: EnemyWeaponClass = 'gang',
  scale = 0.95,
  weaponIdOverride?: SharedWeaponId
): NpcWeaponRig {
  const weaponId = weaponIdOverride ?? getEnemyWeaponIdForClass(enemyClass);
  const spec = getSharedWeaponSpec(weaponId);

  const gripPivot = new THREE.Group();
  gripPivot.name = 'NpcWeaponGripPivot';
  // Seat pistol grip (0, -0.038, -0.016) directly inside the curled right palm
  gripPivot.position.set(0.0, -0.058, 0.016);
  rig.rightHandGrp.add(gripPivot);

  const visual = createEnemyCarbineVisual(scale, weaponId);
  gripPivot.add(visual.root);

  // Hide civilian hand props if this rigged human is armed
  if (rig.newspaperProp) rig.newspaperProp.visible = false;
  if (rig.phoneProp) rig.phoneProp.visible = false;
  if (rig.cigaretteProp) rig.cigaretteProp.visible = false;

  return {
    visual,
    weaponId,
    gripPivot,
    enemyClass,
    profile: getEnemyWeaponClassProfile(enemyClass),
    state: 'patrol',
    drawWeight: 0,
    aimWeight: 0,
    lowReadyWeight: 0,
    twoHandWeight: 0,
    reloadWeight: 0,
    recoilKick: 0,
    ammoInMag: spec.magazineSize,
    reloadTimer: 0,
    lastShotElapsed: -99,
  };
}

// Zero-GC scratch objects for additive weapon-hold pose & 2-bone IK
const _wpBaseRShQ = new THREE.Quaternion();
const _wpBaseRElQ = new THREE.Quaternion();
const _wpBaseRHdQ = new THREE.Quaternion();
const _wpSolveShQ = new THREE.Quaternion();
const _wpSolveElQ = new THREE.Quaternion();
const _wpSolveHdQ = new THREE.Quaternion();
const _wpGunChestQ = new THREE.Quaternion();
const _wpGunChestE = new THREE.Euler(0, 0, 0, 'YXZ');
const _wpGripChestPos = new THREE.Vector3();
const _wpTargetWrist = new THREE.Vector3();
const _wpSuppTarget = new THREE.Vector3();
const _wpAxisX = new THREE.Vector3();
const _wpAxisY = new THREE.Vector3();
const _wpAxisZ = new THREE.Vector3();
const _wpMat4 = new THREE.Matrix4();
const _wpTmpV = new THREE.Vector3();
const _wpElbInChestInvQ = new THREE.Quaternion();
const _wpHandLocalOffset = new THREE.Vector3(0, -0.058, 0.016);

/**
 * Solves 2-bone analytical arm IK in chest local space for either arm (-1 left, +1 right),
 * blending smoothly by `weight` over the base pose already written by applyHumanPose().
 */
function solveChestArmIKBlended(
  shoulder: THREE.Bone,
  elbow: THREE.Bone,
  handGrp: THREE.Group,
  sideSign: -1 | 1,
  wristTargetChest: THREE.Vector3,
  desiredHandInChestQ: THREE.Quaternion | null,
  poleChest: THREE.Vector3,
  weight: number
): void {
  if (weight <= 0.002) return;

  _wpBaseRShQ.setFromEuler(shoulder.rotation);
  _wpBaseRElQ.setFromEuler(elbow.rotation);
  _wpBaseRHdQ.setFromEuler(handGrp.rotation);

  const L1 = 0.275;
  const L2 = 0.252;
  _ikRel.copy(wristTargetChest).sub(shoulder.position);
  const rawDist = _ikRel.length();
  const minDist = Math.abs(L1 - L2) + 0.04;
  const maxDist = L1 + L2 - 0.008;
  const dist = THREE.MathUtils.clamp(rawDist, minDist, maxDist);

  if (rawDist < 1e-4) {
    _ikDir.set(0, -1, 0);
  } else {
    _ikDir.copy(_ikRel).multiplyScalar(1 / rawDist);
  }

  const cosA = THREE.MathUtils.clamp(
    (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist),
    -1,
    1
  );
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const cosC = THREE.MathUtils.clamp(
    (L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2),
    -1,
    1
  );
  const elbowBend = Math.PI - Math.acos(cosC);

  _ikPole.copy(poleChest).normalize();
  _ikBendN.copy(_ikPole).addScaledVector(_ikDir, -_ikPole.dot(_ikDir));
  if (_ikBendN.lengthSq() < 1e-5) {
    _ikBendN.set(sideSign, -0.4, -0.3).normalize();
  } else {
    _ikBendN.normalize();
  }

  _ikElbowPos
    .copy(_ikDir)
    .multiplyScalar(L1 * cosA)
    .addScaledVector(_ikBendN, L1 * sinA);
  _ikUpperDir.copy(_ikElbowPos).normalize();

  _wpAxisY.copy(_ikUpperDir).negate();
  _wpAxisZ.copy(_ikDir).multiplyScalar(dist).sub(_ikElbowPos);
  _wpAxisZ.addScaledVector(_wpAxisY, -_wpAxisZ.dot(_wpAxisY));
  if (_wpAxisZ.lengthSq() < 1e-6) {
    _wpAxisZ.set(0, 0, 1);
  } else {
    _wpAxisZ.normalize();
  }
  _wpAxisX.crossVectors(_wpAxisY, _wpAxisZ).normalize();
  _wpAxisZ.crossVectors(_wpAxisX, _wpAxisY).normalize();

  _wpMat4.makeBasis(_wpAxisX, _wpAxisY, _wpAxisZ);
  _wpSolveShQ.setFromRotationMatrix(_wpMat4);
  _wpSolveElQ.setFromAxisAngle(_wpTmpV.set(1, 0, 0), -elbowBend);

  if (desiredHandInChestQ) {
    _wpElbInChestInvQ.copy(_wpSolveShQ).multiply(_wpSolveElQ).invert();
    _wpSolveHdQ.copy(desiredHandInChestQ).premultiply(_wpElbInChestInvQ);
  } else {
    _wpSolveHdQ.set(0, 0, 0, 1);
  }

  if (weight >= 0.998) {
    shoulder.rotation.setFromQuaternion(_wpSolveShQ, 'XYZ');
    elbow.rotation.set(-elbowBend, 0, 0);
    if (desiredHandInChestQ) {
      handGrp.rotation.setFromQuaternion(_wpSolveHdQ, 'XYZ');
    }
  } else {
    _wpBaseRShQ.slerp(_wpSolveShQ, weight);
    _wpBaseRElQ.slerp(_wpSolveElQ, weight);
    shoulder.rotation.setFromQuaternion(_wpBaseRShQ, 'XYZ');
    elbow.rotation.setFromQuaternion(_wpBaseRElQ, 'XYZ');
    if (desiredHandInChestQ) {
      _wpBaseRHdQ.slerp(_wpSolveHdQ, weight);
      handGrp.rotation.setFromQuaternion(_wpBaseRHdQ, 'XYZ');
    }
  }
}

/**
 * Evaluates weapon-specific reload trajectory in weapon-local space (duration = spec.reloadSec):
 * - Carbines (1.75s / 2.1s): tilt -> mag out -> mag in/tap -> rack charging handle -> handguard
 * - Pump Shotgun (3.2s): tilt -> 3 shell-load belt-to-loading-port strokes -> final pump rack
 */
export function evaluateReloadChoreography(
  u: number,
  outHandLocal: THREE.Vector3,
  outMagOffset: THREE.Vector3,
  outTilt: { roll: number; pitch: number; yaw: number; impulse: number; pumpStroke?: number },
  weaponId: SharedWeaponId = 'service_carbine'
): void {
  const t = THREE.MathUtils.clamp(u, 0, 1);
  const env = Math.sin(t * Math.PI);
  outTilt.roll = 0.54 * env; // tilt weapon ~31 deg inward so ejection port & loading port face support hand
  outTilt.pitch = -0.26 * env;
  outTilt.yaw = 0.24 * env;
  outTilt.impulse = 0;
  outTilt.pumpStroke = 0;
  outMagOffset.set(0, 0, 0);

  if (weaponId === 'pump_shotgun') {
    // Shotgun tube-feed reload: tilt underside toward support hand, feed shells into receiver port, then pump!
    outTilt.roll = 0.72 * env;
    if (t < 0.14) {
      const p = smoothstep(0.0, 0.14, t);
      outHandLocal.set(
        THREE.MathUtils.lerp(0.0, -0.08, p),
        THREE.MathUtils.lerp(0.0, -0.24, p),
        THREE.MathUtils.lerp(0.31, 0.04, p)
      );
    } else if (t < 0.76) {
      // Three crisp shell-feed strokes from belt pouch up into underside loading port (0, -0.02, 0.085)
      const cycle = ((t - 0.14) / 0.62) * 3.0;
      const frac = cycle - Math.floor(cycle);
      const lift = Math.sin(frac * Math.PI);
      outHandLocal.set(
        THREE.MathUtils.lerp(-0.085, 0.0, lift),
        THREE.MathUtils.lerp(-0.25, -0.025, lift),
        THREE.MathUtils.lerp(0.03, 0.088, lift)
      );
      if (frac > 0.42 && frac < 0.62) {
        outTilt.impulse = Math.sin(((frac - 0.42) / 0.20) * Math.PI) * 0.25;
      }
    } else if (t < 0.94) {
      // Grasp pump forend and rack back -> snap forward to chamber first shell
      const p = (t - 0.76) / 0.18;
      const stroke = p > 0.22 ? Math.sin(THREE.MathUtils.clamp((p - 0.22) / 0.78, 0, 1) * Math.PI) : 0;
      outTilt.pumpStroke = stroke;
      outHandLocal.set(0.0, 0.0, 0.31 - stroke * 0.098);
      outTilt.impulse = -stroke * 0.42;
    } else {
      outHandLocal.set(0.0, 0.0, 0.31);
    }
    return;
  }

  if (t < 0.20) {
    // Support hand moves from handguard (0, 0.002, 0.265) to magazine base (0, -0.10, 0.105)
    const p = smoothstep(0.0, 0.20, t);
    outHandLocal.set(0.0, THREE.MathUtils.lerp(0.002, -0.105, p), THREE.MathUtils.lerp(0.265, 0.105, p));
  } else if (t < 0.46) {
    // Pull magazine downward and back toward hip pouch
    const p = smoothstep(0.20, 0.46, t);
    const ox = -0.075 * p;
    const oy = -0.24 * p;
    const oz = -0.07 * p;
    outMagOffset.set(ox, oy, oz);
    outHandLocal.set(ox, -0.105 + oy, 0.105 + oz);
  } else if (t < 0.74) {
    // Bring fresh magazine up from pouch and seat firmly into mag well
    const p = smoothstep(0.46, 0.70, t);
    const inv = 1.0 - p;
    const ox = -0.075 * inv;
    const oy = -0.24 * inv;
    const oz = -0.07 * inv;
    outMagOffset.set(ox, oy, oz);
    outHandLocal.set(ox, -0.105 + oy, 0.105 + oz);
    // Crisp upward tap seating magazine home at t=0.68..0.74
    if (t > 0.66) {
      outTilt.impulse = Math.sin(((t - 0.66) / 0.08) * Math.PI) * 0.35;
    }
  } else if (t < 0.90) {
    // Work the action / charging handle along receiver side
    const reach = smoothstep(0.74, 0.80, t);
    const rack = t > 0.80 ? Math.sin(THREE.MathUtils.clamp((t - 0.80) / 0.10, 0, 1) * Math.PI) : 0;
    outHandLocal.set(
      THREE.MathUtils.lerp(0.0, -0.036, reach),
      THREE.MathUtils.lerp(-0.08, 0.064, reach),
      THREE.MathUtils.lerp(0.105, 0.085, reach) - rack * 0.095
    );
    outTilt.impulse = -rack * 0.48;
  } else {
    // Return support hand smoothly to handguard
    const p = smoothstep(0.90, 1.0, t);
    outHandLocal.set(
      THREE.MathUtils.lerp(-0.036, 0.0, p),
      THREE.MathUtils.lerp(0.064, 0.002, p),
      THREE.MathUtils.lerp(0.085, 0.265, p)
    );
  }
}

const _relHandLocal = new THREE.Vector3();
const _relMagOffset = new THREE.Vector3();
const _relTilt = { roll: 0, pitch: 0, yaw: 0, impulse: 0, pumpStroke: 0 };
const _wpPoleRight = new THREE.Vector3();
const _wpPoleLeft = new THREE.Vector3();

/**
 * ADDITIVE weapon-hold pose layer for HumanRig.
 * Call right after applyHumanPose(rig, baseParams) — preserves lower-body walk/run/idle/seated
 * poses completely while smoothly layering patrol-carry, draw, shouldered aim, recoil fire,
 * low-ready, and 4-phase reload with 2-bone IK on both arms.
 */
export function applyWeaponHoldPose(
  rig: HumanRig,
  weaponRig: NpcWeaponRig,
  params: WeaponHoldPoseParams
): void {
  const safeDt = Math.min(0.05, Math.max(0.001, params.dt));
  const { elapsed, phase, state } = params;
  const prof = weaponRig.profile;
  weaponRig.state = state;

  // Trigger recoil + muzzle flash + light spill on fired frame
  if (params.firedThisFrame) {
    weaponRig.recoilKick = Math.min(1.15, weaponRig.recoilKick + 0.72 * prof.recoilAmp);
    weaponRig.lastShotElapsed = elapsed;
    triggerEnemyCarbineFlash(weaponRig.visual, params.lightPool);
  }

  // Smooth exponential state transitions (150-250ms, zero pose pops!)
  const isPatrol = state === 'patrol';
  const isDraw = state === 'draw';
  const isAim = state === 'aim' || state === 'fire';
  const isLowReady = state === 'low_ready';
  const isReload = state === 'reload';

  const targetDraw = isPatrol ? 0.0 : 1.0;
  const targetAim = isAim ? 1.0 : 0.0;
  const targetLowReady = isLowReady ? 1.0 : isDraw ? 0.65 : 0.0;
  const targetTwoHand = isPatrol ? 0.0 : 1.0;
  const targetReload = isReload ? 1.0 : 0.0;

  weaponRig.drawWeight = THREE.MathUtils.damp(
    weaponRig.drawWeight,
    targetDraw,
    isPatrol ? prof.blendRate * 0.85 : prof.blendRate,
    safeDt
  );
  weaponRig.aimWeight = THREE.MathUtils.damp(
    weaponRig.aimWeight,
    targetAim,
    prof.blendRate,
    safeDt
  );
  weaponRig.lowReadyWeight = THREE.MathUtils.damp(
    weaponRig.lowReadyWeight,
    targetLowReady,
    prof.blendRate * 0.9,
    safeDt
  );
  weaponRig.twoHandWeight = THREE.MathUtils.damp(
    weaponRig.twoHandWeight,
    targetTwoHand,
    prof.blendRate * 1.1,
    safeDt
  );
  weaponRig.reloadWeight = THREE.MathUtils.damp(
    weaponRig.reloadWeight,
    targetReload,
    10.0,
    safeDt
  );
  weaponRig.recoilKick = THREE.MathUtils.damp(
    weaponRig.recoilKick,
    0,
    prof.recoilDamp,
    safeDt
  );

  // Red LED warm-up target driven strictly by detection/aim/fire ramp
  let ledTarget = 0;
  if (state === 'fire') {
    ledTarget = 1.1;
  } else if (state === 'aim') {
    ledTarget = 0.74 + 0.22 * THREE.MathUtils.clamp(params.detectionRamp, 0, 1);
  } else if (state === 'reload') {
    ledTarget = 0.14;
  } else if (state === 'low_ready') {
    ledTarget = params.detectionRamp > 0.05 ? 0.22 * params.detectionRamp : 0.0;
  } else if (state === 'draw') {
    ledTarget = 0.24 + 0.42 * THREE.MathUtils.clamp(params.detectionRamp, 0, 1);
  } else {
    // patrol: dark unless detection ramp is actively kindling
    ledTarget =
      params.detectionRamp > 0.03 ? 0.12 + 0.44 * THREE.MathUtils.clamp(params.detectionRamp, 0, 1) : 0;
  }
  updateEnemyCarbineVisual(weaponRig.visual, safeDt, elapsed, ledTarget, phase);

  // Compute reload choreography if reloading (duration strictly matches weapon spec reloadSec!)
  const wSpec = getSharedWeaponSpec(weaponRig.weaponId);
  let reloadU = 0;
  if (isReload) {
    if (params.reloadProgress !== undefined) {
      reloadU = THREE.MathUtils.clamp(params.reloadProgress, 0, 1);
    } else if (weaponRig.reloadTimer > 0) {
      reloadU = 1.0 - weaponRig.reloadTimer / wSpec.reloadSec;
    }
    evaluateReloadChoreography(reloadU, _relHandLocal, _relMagOffset, _relTilt, weaponRig.weaponId);
    setEnemyCarbineMagOffset(
      weaponRig.visual,
      _relMagOffset.x,
      _relMagOffset.y,
      _relMagOffset.z,
      _relMagOffset.y * 1.4,
      _relMagOffset.x * 2.2
    );
    if (weaponRig.weaponId === 'pump_shotgun' && _relTilt.pumpStroke !== undefined) {
      setEnemyWeaponPumpStroke(weaponRig.visual, _relTilt.pumpStroke);
    }
  } else {
    setEnemyCarbineMagOffset(weaponRig.visual, 0, 0, 0, 0, 0);
    _relTilt.roll = 0;
    _relTilt.pitch = 0;
    _relTilt.yaw = 0;
    _relTilt.impulse = 0;
    _relTilt.pumpStroke = 0;
  }

  // Organic layered breathing + weapon-class sway + locomotion carry bob
  const moveNorm = THREE.MathUtils.clamp(params.moveSpeedNorm ?? 0, 0, 1.2);
  const swayX =
    Math.sin(elapsed * 2.1 + phase * 1.7) * 0.008 * prof.swayAmp +
    Math.sin(elapsed * 5.6 + phase) * 0.006 * moveNorm;
  const swayY =
    Math.cos(elapsed * 1.85 + phase) * 0.006 * prof.swayAmp -
    Math.abs(Math.sin(elapsed * 5.6 + phase)) * 0.010 * moveNorm;
  const aimYawOff = THREE.MathUtils.clamp(params.aimYawOffset ?? 0, -0.75, 0.75);
  const aimPitch = THREE.MathUtils.clamp(params.aimPitch ?? 0, -0.55, 0.55);

  const combatBlend = Math.max(weaponRig.aimWeight, weaponRig.lowReadyWeight, weaponRig.reloadWeight);
  const recoil = weaponRig.recoilKick;

  // 1. ADDITIVE UPPER-BODY STANCE & RECOIL (preserves lower-body walk/run completely!)
  // Blade torso into weaver/rifle stance so left shoulder advances comfortably toward handguard
  const stanceYaw = prof.stanceYaw * combatBlend;
  // Counter-stabilize walking torso twist during aim/fire so muzzle stays locked on target line
  const twistStabilize = weaponRig.aimWeight * 0.85;
  rig.spine.rotation.y =
    rig.spine.rotation.y * (1 - twistStabilize) + stanceYaw * 0.45 + aimYawOff * 0.35 * combatBlend;
  rig.chest.rotation.y =
    rig.chest.rotation.y * (1 - twistStabilize) + stanceYaw * 0.55 + aimYawOff * 0.65 * combatBlend;
  rig.spine.rotation.x += prof.combatLean * combatBlend - recoil * 0.045;
  rig.chest.rotation.x += -aimPitch * 0.25 * weaponRig.aimWeight - recoil * 0.065;

  // Head tracks target cleanly over the sights (compensating for torso blading)
  if (combatBlend > 0.02) {
    const targetHeadYaw = -stanceYaw + aimYawOff * 0.12;
    const targetHeadPitch = -aimPitch * 0.65 + 0.06 * weaponRig.aimWeight - recoil * 0.03;
    rig.neck.rotation.y = THREE.MathUtils.lerp(rig.neck.rotation.y, targetHeadYaw * 0.4, combatBlend);
    rig.head.rotation.y = THREE.MathUtils.lerp(rig.head.rotation.y, targetHeadYaw * 0.6, combatBlend);
    rig.neck.rotation.x = THREE.MathUtils.lerp(rig.neck.rotation.x, targetHeadPitch * 0.35, combatBlend);
    rig.head.rotation.x = THREE.MathUtils.lerp(rig.head.rotation.x, targetHeadPitch * 0.65, combatBlend);
    rig.head.rotation.z = THREE.MathUtils.lerp(
      rig.head.rotation.z,
      -0.08 * weaponRig.aimWeight,
      combatBlend
    );
  }

  // 2. COMPUTE TARGET WEAPON GRIP POSE IN CHEST LOCAL SPACE
  // Patrol (one-handed low-carry at right hip/thigh) -> Low-Ready -> Shouldered Aim/Fire
  const shX = rig.rightShoulder.position.x;
  const shY = rig.rightShoulder.position.y;
  const drawW = weaponRig.drawWeight;
  const aimW = weaponRig.aimWeight;
  const relW = weaponRig.reloadWeight;

  // Patrol one-handed low-carry (clears thigh/coat, barrel angled down-forward)
  const patX = shX + 0.032;
  const patY = shY - 0.385;
  const patZ = 0.135;

  // Low-ready two-handed across upper chest (barrel dipped safely down)
  const lrX = shX - 0.055;
  const lrY = shY - 0.165;
  const lrZ = 0.245;

  // Shouldered aim/fire (buttpad in right shoulder pocket, muzzle height = 1.38*heightScale!)
  const aimX = shX - 0.072;
  const aimY = shY - 0.082 + Math.sin(aimPitch) * 0.05;
  const aimZ = 0.235 - recoil * 0.042 + _relTilt.impulse * 0.018;

  // Blend smoothly patrol -> low-ready -> aim
  const baseGX = THREE.MathUtils.lerp(THREE.MathUtils.lerp(patX, lrX, drawW), aimX, aimW);
  const baseGY = THREE.MathUtils.lerp(THREE.MathUtils.lerp(patY, lrY, drawW), aimY, aimW);
  const baseGZ = THREE.MathUtils.lerp(THREE.MathUtils.lerp(patZ, lrZ, drawW), aimZ, aimW);

  _wpGripChestPos.set(
    baseGX + swayX * (0.4 + 0.6 * drawW),
    baseGY + swayY + recoil * 0.016 - relW * 0.035,
    baseGZ + relW * 0.02
  );

  // Target gun orientation in chest local space (compensates torso stanceYaw so world barrel = target line!)
  const gunPitchPatrol = 0.78 + Math.sin(elapsed * 3.0 + phase) * 0.04 * moveNorm;
  const gunPitchLowReady = prof.lowReadyPitch + swayY * 1.4;
  const gunPitchAim = -aimPitch - recoil * 0.115 + swayY * 0.85;
  const gunPitch =
    THREE.MathUtils.lerp(THREE.MathUtils.lerp(gunPitchPatrol, gunPitchLowReady, drawW), gunPitchAim, aimW) +
    _relTilt.pitch * relW;

  const gunYawPatrol = -0.14;
  const gunYawLowReady = -stanceYaw - 0.26;
  const gunYawAim = -stanceYaw + swayX * 1.2;
  const gunYaw =
    THREE.MathUtils.lerp(THREE.MathUtils.lerp(gunYawPatrol, gunYawLowReady, drawW), gunYawAim, aimW) +
    _relTilt.yaw * relW;

  const gunRollPatrol = 0.16;
  const gunRollReady = prof.weaponCant - recoil * 0.045;
  const gunRoll =
    THREE.MathUtils.lerp(gunRollPatrol, gunRollReady, drawW) + _relTilt.roll * relW;

  _wpGunChestE.set(gunPitch, gunYaw, gunRoll, 'YXZ');
  _wpGunChestQ.setFromEuler(_wpGunChestE);

  // Compute right wrist target in chest space so weapon gripPivot sits exactly at _wpGripChestPos
  const rHandScale = rig.rightHandGrp.scale.x;
  _wpTmpV.copy(_wpHandLocalOffset).multiplyScalar(rHandScale).applyQuaternion(_wpGunChestQ);
  _wpTargetWrist.copy(_wpGripChestPos).sub(_wpTmpV);

  // 3. SOLVE RIGHT ARM IK (ALWAYS ACTIVE FOR ARMED HUMAN — GRIP NEVER FLOATS!)
  _wpPoleRight.set(0.65, -0.72, -0.24);
  solveChestArmIKBlended(
    rig.rightShoulder,
    rig.rightElbow,
    rig.rightHandGrp,
    1,
    _wpTargetWrist,
    _wpGunChestQ,
    _wpPoleRight,
    1.0
  );
  // Closed curled grip fist around pistol grip
  rig.rightHandNormalMesh.visible = false;
  rig.rightHandStrapMesh.visible = true;

  // 4. SOLVE LEFT (SUPPORT) ARM IK UNDER HANDGUARD, SHOTGUN PUMP FOREND, OR RELOAD TRAJECTORY
  const suppW = weaponRig.twoHandWeight;
  if (suppW > 0.01) {
    const gunScale = weaponRig.visual.root.scale.x;
    const baseHandguardZ =
      weaponRig.weaponId === 'pump_shotgun'
        ? weaponRig.visual.pumpForendRestZ - weaponRig.visual.pumpStroke * 0.098
        : 0.265;
    if (relW > 0.02) {
      // Blend smoothly from handguard/forend anchor into exact weapon reload trajectory
      _wpSuppTarget.set(
        THREE.MathUtils.lerp(0.0, _relHandLocal.x, relW),
        THREE.MathUtils.lerp(0.002, _relHandLocal.y, relW),
        THREE.MathUtils.lerp(baseHandguardZ, _relHandLocal.z, relW)
      );
    } else {
      // Directly under carbine handguard or live sliding shotgun pump forend!
      _wpSuppTarget.set(0.0, 0.002, baseHandguardZ);
    }
    _wpSuppTarget.multiplyScalar(gunScale).applyQuaternion(_wpGunChestQ).add(_wpGripChestPos);
    // Offset slightly back to wrist from left palm center
    const lHandScale = rig.leftHandGrp.scale.x;
    _wpTmpV.set(0, -0.052 * lHandScale, 0).applyQuaternion(_wpGunChestQ);
    _wpSuppTarget.sub(_wpTmpV);

    _wpPoleLeft.set(-0.62, -0.76, -0.18);
    solveChestArmIKBlended(
      rig.leftShoulder,
      rig.leftElbow,
      rig.leftHandGrp,
      -1,
      _wpSuppTarget,
      null,
      _wpPoleLeft,
      suppW
    );
    rig.leftHandGrp.rotation.set(0.18 * suppW, -0.35 * suppW, 0.24 * suppW);
    if (suppW > 0.45) {
      rig.leftHandNormalMesh.visible = false;
      rig.leftHandStrapMesh.visible = true;
    }
  }
}

/**
 * Returns the exact live world position of an armed HumanRig's visual carbine muzzle.
 */
export function getNpcWeaponMuzzleWorld(
  weaponRig: NpcWeaponRig,
  out = new THREE.Vector3()
): THREE.Vector3 {
  weaponRig.visual.root.updateMatrixWorld(true);
  return weaponRig.visual.muzzleAnchor.getWorldPosition(out);
}

