/**
 * PER-CLASS HANDLING TABLE — owned by the handling/drift piece (ART_DIRECTION.md §6.2).
 *
 * This lives apart from the car files on purpose: the vehicle-ART builder owns geometry and
 * identity, the HANDLING builder owns how each class drives. Neither has to touch the other's
 * files, so they can work at the same time.
 *
 *   mass        kg — affects how much force it takes to change direction
 *   topSpeed    m/s — 67 m/s ≈ 150 mph, the speed the reference sits at
 *   power       drive force scalar
 *   brake       braking force scalar
 *   gripFront/gripRear   lateral grip. Rear grip is scaled down while drifting.
 *   steerMax    max steering angle in radians
 *   driftEase   how readily a slide starts (higher = tail-happier)
 *   driftHold   how long a slide holds before grip recovers (higher = longer)
 *   downforce   grip gained with speed
 *   rollStiff   suspension stiffness — LOW value = MORE visible body roll
 *   yawInertia  rotational inertia (higher = slower to rotate and slower to stop)
 *   offroadGrip optional: grip retained off tarmac (default ~0.6)
 */
export const HANDLING = {
  tuner: {
    mass: 1240, topSpeed: 71, power: 24.0, brake: 30,
    gripFront: 1.22, gripRear: 1.10, steerMax: 0.62, driftEase: 1.05,
    driftHold: 1.35, downforce: 0.22, rollStiff: 0.80, yawInertia: 0.82,
  },
  muscle: {
    mass: 1780, topSpeed: 74, power: 26.0, brake: 26,
    gripFront: 1.06, gripRear: 0.90, steerMax: 0.52, driftEase: 1.28,
    driftHold: 1.20, downforce: 0.10, rollStiff: 0.55, yawInertia: 1.20,
  },
  suv: {
    mass: 2650, topSpeed: 63, power: 25.0, brake: 22,
    gripFront: 1.00, gripRear: 0.98, steerMax: 0.46, driftEase: 0.80,
    driftHold: 0.85, downforce: 0.02, rollStiff: 0.32, yawInertia: 1.55,
    offroadGrip: 0.92,
  },
  supercar: {
    mass: 1420, topSpeed: 82, power: 30.0, brake: 34,
    gripFront: 1.30, gripRear: 1.24, steerMax: 0.56, driftEase: 0.95,
    driftHold: 1.10, downforce: 0.40, rollStiff: 0.92, yawInertia: 0.86,
  },
};

export function getHandling(id) {
  const h = HANDLING[id];
  if (!h) throw new Error(`No handling profile for vehicle "${id}"`);
  return h;
}
