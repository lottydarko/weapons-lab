import * as THREE from 'three';

export const FPS_EYE_HEIGHT_M = 1.68;

export interface FpsRayTarget {
  id: string;
  kind: 'npc' | 'world' | 'player';
  agentId: string;
  bounds: THREE.Box3;
}

export interface TrainFrame {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  yawDeltaPerSec: number;
  seated: boolean;
}

export interface FpsBridgeHooks {
  onEnterOnFoot?: (spawnPos: THREE.Vector3, yaw: number) => void;
  onEnterTrain?: (frame: TrainFrame) => void;
  updateTrainFrame?: (frame: TrainFrame) => void;
  onEnterVehicle?: () => void;
  getRayTargets: (origin: THREE.Vector3, radiusM: number) => FpsRayTarget[];
}
