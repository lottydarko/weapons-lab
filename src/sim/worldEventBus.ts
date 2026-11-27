/**
 * Shared simulation event bus for NPC reactions, crime broadcasts, and radio perception.
 */

export type WorldEvent =
  | {
      type: 'gunfire';
      x: number;
      y: number;
      z: number;
      shooterKind: 'player' | 'gang' | 'killer' | 'shooter' | 'police';
      loudRadius: number;
      districtId?: string;
    }
  | {
      type: 'chase';
      x: number;
      y: number;
      z: number;
      dirX: number;
      dirZ: number;
      radius: number;
      kind: 'gang' | 'police' | 'outbreak';
    }
  | {
      type: 'crime';
      kind:
        | 'bother'
        | 'kill'
        | 'mass_shooting'
        | 'armored_truck_robbery'
        | 'gang_heist'
        | 'outbreak'
        | 'gang_firefight';
      x: number;
      y: number;
      z: number;
      districtId: string;
      severity: number; // 0..1
    };

export type WorldEventListener = (ev: WorldEvent) => void;

class WorldEventBus {
  private listeners = new Set<WorldEventListener>();
  private recentQueue: WorldEvent[] = [];

  public subscribe(listener: WorldEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emit(ev: WorldEvent): void {
    this.recentQueue.push(ev);
    if (this.recentQueue.length > 64) {
      this.recentQueue.shift();
    }
    this.listeners.forEach((fn) => fn(ev));
  }

  public drainQueued(): WorldEvent[] {
    if (this.recentQueue.length === 0) return [];
    const copy = this.recentQueue.slice();
    this.recentQueue.length = 0;
    return copy;
  }
}

export const worldEventBus = new WorldEventBus();
