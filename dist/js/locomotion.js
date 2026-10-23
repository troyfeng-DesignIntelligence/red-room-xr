// Desktop and touch walking feel, in metres and seconds. No DOM or rendering
// dependencies: eased velocity, footfall cadence and an optional head bob.
const TAU = Math.PI * 2;
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export function createWalker({ speed = 1.25, accelTime = 0.35, decelTime = 0.25, stepLength = 0.72 } = {}) {
  const velocity = { x: 0, z: 0 };
  let stride = 0, steps = 0, moving = false;

  // The direction is the desired world heading; any length, zero to stop.
  function update(dt, directionX = 0, directionZ = 0) {
    const elapsed = Math.max(0, finite(dt));
    const length = Math.hypot(finite(directionX), finite(directionZ));
    const wanted = length > 1e-6;
    const targetX = wanted ? finite(directionX) / length * speed : 0;
    const targetZ = wanted ? finite(directionZ) / length * speed : 0;
    // Exponential easing reaches ~95% of the target in accelTime / decelTime,
    // independent of the frame rate.
    const blend = 1 - Math.exp(-elapsed * 3 / (wanted ? accelTime : decelTime));
    velocity.x += (targetX - velocity.x) * blend;
    velocity.z += (targetZ - velocity.z) * blend;
    if (!wanted && Math.hypot(velocity.x, velocity.z) < 0.02) velocity.x = velocity.z = 0;
    // From a standstill the first footfall lands early, as a real first step.
    if (wanted && !moving) stride = stepLength * 0.55;
    moving = wanted || velocity.x !== 0 || velocity.z !== 0;
    if (!moving) stride = 0;
    return velocity;
  }

  // Distance actually travelled after collision; returns the footfalls crossed.
  function advance(distance) {
    if (!(distance > 0) || !Number.isFinite(distance)) return 0;
    stride += distance;
    let count = 0;
    while (stride >= stepLength) { stride -= stepLength; count++; }
    steps += count;
    return count;
  }

  const speedFraction = () => Math.min(1, Math.hypot(velocity.x, velocity.z) / speed);

  // Lowest at each footfall, highest mid-step; fades out with speed.
  const bob = amplitude => -amplitude * Math.cos(stride / stepLength * TAU) * speedFraction() || 0;

  function stop() {
    velocity.x = velocity.z = 0;
    stride = 0;
    moving = false;
  }

  return { velocity, update, advance, speedFraction, bob, stop, inspect: () => ({ ...velocity, stride, steps, moving }) };
}
