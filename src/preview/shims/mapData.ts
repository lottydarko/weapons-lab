import * as THREE from 'three';

export interface CollisionWorld {
  resolveCircle: (
    x: number,
    z: number,
    radius: number
  ) => { hit: boolean; x: number; z: number; nx: number; nz: number };
  hasLineOfSight: (x0: number, z0: number, x1: number, z1: number) => boolean;
  raycast?: (
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number
  ) => { hit: boolean; distance: number; point: THREE.Vector3 } | null;
  raycastStatic?: (
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number
  ) => { hit: boolean; distance: number; point: THREE.Vector3 } | null;
}

export interface RoadDef {
  id: string;
  kind: 'boulevard' | 'arterial' | 'street' | 'highway' | 'alley' | 'ramp' | 'bridge';
  width: number;
  points: Array<{ x: number; z: number }>;
  sidewalkWidth?: number;
}

export interface SignalizedIntersection {
  id: string;
  x: number;
  z: number;
  halfSpanNS: number;
  halfSpanEW: number;
  phaseOffset: number;
}

export interface BusStopDef {
  id: string;
  x: number;
  z: number;
  rotY: number;
  side?: number;
}

export interface GangTerritoryDef {
  id: string;
  districtId: 'D1' | 'D8';
  anchorX: number;
  anchorZ: number;
  crewSize: number;
  patrolPoints: Array<{ x: number; z: number }>;
}

export const ROADS: RoadDef[] = [];
export const SIGNALIZED_INTERSECTIONS: SignalizedIntersection[] = [];
export const BUS_STOPS: BusStopDef[] = [];
export const METRO_DOOR_QUEUE_LANES: Array<{ localX: number; localZ: number }> = [
  { localX: -3.4, localZ: -1.6 },
  { localX: -3.4, localZ: 1.6 },
];
export const GANG_TERRITORIES: GangTerritoryDef[] = [];

export function getTerrainHeight(_x: number, _z: number): number {
  return 0;
}

export function getRoadElevationAt(_x: number, _z: number): number {
  return 0;
}

export function getDistrictAt(_x: number, _z: number): string {
  return 'D1 Preview Yard';
}

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
