export interface ArmoredTruckState {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  stopped?: boolean;
  [key: string]: unknown;
}
