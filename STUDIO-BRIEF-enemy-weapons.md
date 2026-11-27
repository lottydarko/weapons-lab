# STUDIO BRIEF — Enemy Weapon Interaction: Holding, Aiming, Firing, Reloading

## The simulation (what this is in the world)

Kaluga's bad men already know how to shoot — the city's shared weapon system decides every bullet. What they cannot do yet is *hold* a gun like a man who has held one before. Right now the violence is invisible math: shots come from eye height, but no hands close around a grip, no shoulders roll into a stance, no one works a slide or drops a magazine.

Build the visible half of enemy gunplay. When a gang soldier, a mob enforcer, a guard, or a bandit decides to fight, the weapon must be IN his hands — gripped, shouldered, aimed at what he is actually shooting at. When he fires, the gun must kick in his hands and the muzzle must be where the bullet is born. When his burst ends, he breaks aim the way men do — weapon drops to a low ready, he moves, he re-acquires. When the magazine is spent, he reloads: magazine out, magazine in, action worked, back on target. Zombies do not hold weapons — the living do, and the difference must read at fifty meters.

This is one simulation of armed men, shared by every enemy class in the city. A soldier, an enforcer, and a black guard hold the same carbine the same correct way; what differs is stance, aggression, and discipline — never the mechanics of the gun.

## Builder's Notes (machine precision — follow exactly)

**Files you may change (files back = 3):**
- `src/sim/humanCharacter.ts` — add weapon-hold pose layer + grip anchoring on the existing rig
- `src/sim/pedestrianSystem.ts` — wire hold/aim/fire/reload animation states to the EXISTING gang/crime fire behavior
- `src/sim/zombieSystem.ts` — ONLY to guarantee zombies never receive a weapon (assert/guard); no other zombie changes

**Reference-only (read, never edit):**
- `src/sim/sharedWeapon.ts` — SHARED_WEAPON_SPEC and fireSharedWeapon are the law: damage 18, fireRateHz 8.2, burstCount 3, burstCooldownSec 1.05, npcSpreadRad 0.052, magSize 30, reloadSec 1.75. NPC shots originate at eye height (ag.y + 1.44·heightScale) with muzzle at ag.y + 1.38·heightScale — your visual muzzle must agree with these numbers, not invent new ones.
- `src/sim/fpsWeaponView.ts` — the player's viewmodel implementation; mirror its state language (drawn, firing, reloading, cooldown) for NPCs where sensible. Do not edit it.
- `src/sim/crimeDirector.ts`, `src/sim/worldEventBus.ts` — behavior triggers and events; consume, never modify.

**Frozen (do not touch, do not re-signature):**
- `createRiggedHuman`, `applyHumanPose`, `HumanRig` and all existing pose names in humanCharacter.ts. Weapon holding is an ADDITIVE pose layer blended over existing poses (walk, stand, seated, etc.), never a replacement rig.
- All existing exports of pedestrianSystem.ts and zombieSystem.ts; all fire-rate/damage/spread values everywhere.

**Build these behaviors:**
1. **Grip:** carbine parented to the right-hand bone of the rig; left (support) hand anchored under the handguard. Two-handed hold in aim and fire states; one-handed low-carry in patrol/transit states. Weapon never floats, never clips the chest, at any existing pose.
2. **Aim state:** on acquiring a target, weapon rises to shoulder, body yaws toward the target, head tracks. Aim must visually match the actual fire direction used by fireSharedWeapon.
3. **Fire state:** per-shot recoil impulse on the weapon + upper body, muzzle flash positioned at the visual muzzle, timed to the existing burst logic (burstCount 3, burstCooldownSec 1.05) — do not change when shots happen, only make them visible.
4. **Reload state:** when the existing logic reloads (magSize 30, reloadSec 1.75), play a reload: weapon tilts, magazine hand leaves the grip and returns, action worked. Duration must equal reloadSec.
5. **Transitions:** patrol → draw → aim → fire → low-ready → reload → aim, with no pose pops. Draw/holster uses the same draw language as the player viewmodel.
6. **Class discipline (visual only):** guards/soldiers — crisp, minimal movement; mob enforcers — slower, heavier stance; gang/bandits — looser, more sway. Same mechanics, different posture parameters.
7. **Weapon finish + red warm-up light (Lotty, Nov 27):** enemy carbines are **black** — a simple material color change on the existing carbine mesh, no new model, no texture work. Each enemy weapon carries a small **red light** element (sight/light housing on the gun). The light is the warm-up readout, driven by the enemy's existing detection/aim ramp (the same fill that drives the "?" over a gang member): dark in patrol-carry → dim red on acquire → brightening through aim → full red at the moment of fire → decays back at low-ready. It is a light on the gun, not a HUD element and not a laser beam. This is how the player reads an enemy who is about to shoot.

8. **Armed locomotion (Lotty, Nov 27):** the hold layer blends over walk AND run — an enemy can advance, retreat, and reposition while aiming and firing. Upper body stays in the aim/fire state; lower body keeps its locomotion cycle; no foot-lock, no statue-glide. Firing while running is allowed by the existing burst logic — make it visible: recoil reads through the moving stance, muzzle stays on the true fire line.

**Proof required (your report back):**
- Day stills: one enemy in each state — patrol-carry, aim, fire (muzzle flash visible at the gun), reload — plus one crowd-cost line: frame cost with 40 armed NPCs active.
- A 3-line report: what you added, which poses you layered, any place the rig fought you.

**Never:** new weapon stats, new rigs, new pose-name changes to existing poses, edits to reference-only files, placeholder boxes as weapons. The enemy carbine is built by calling `createSharedWeaponMesh()` from sharedWeapon.ts — the exact builder the player viewmodel uses (one definition: model, behavior, stats). For the black finish: clone the shared materials for NPC instances and tint the clones black — do NOT edit the shared materials in sharedWeapon.ts, or the player's gun changes too.
