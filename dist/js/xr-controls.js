import * as THREE from 'three';

// Local geometry avoids controller profile/CDN requests and also provides
// a consistent pointer for devices with an unfamiliar controller profile.
export function createXRControls({
  renderer, scene, rig, camera, simulation,
  onComfortFade = () => {}, onTeleport = () => {},
}) {
  const floorY = simulation.floorY;
  const up = new THREE.Vector3(0, 1, 0);
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const head = new THREE.Vector3();
  const beforeHead = new THREE.Vector3();
  const rigWorld = new THREE.Vector3();
  const parentLocal = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const controllers = [];
  const materials = [];
  const geometries = [];
  let blink = 0, comfortFade = 0, lastFade = -1;

  function ownGeometry(geometry) { geometries.push(geometry); return geometry; }
  function ownMaterial(material) { materials.push(material); return material; }
  function getHead() {
    // A viewer pose is expressed in the rig's reference-space coordinates.
    // Apply the current rig matrix ourselves so teleport / snap changes are
    // reflected immediately, before WebXRManager's next camera matrix update.
    if (renderer.xr.isPresenting) {
      try {
        const frame = renderer.xr.getFrame();
        const referenceSpace = renderer.xr.getReferenceSpace();
        const pose = frame && referenceSpace ? frame.getViewerPose(referenceSpace) : null;
        if (pose) {
          const position = pose.transform.position;
          head.set(position.x, position.y, position.z);
          rig.localToWorld(head);
          return head;
        }
      } catch {
        // selectend may fire between active XR animation frames.
      }
    }
    camera.getWorldPosition(head);
    return head;
  }
  function addWorldRigOffset(dx, dz) {
    rig.getWorldPosition(rigWorld);
    rigWorld.x += dx;
    rigWorld.z += dz;
    if (rig.parent) {
      parentLocal.copy(rigWorld);
      rig.parent.worldToLocal(parentLocal);
      rig.position.copy(parentLocal);
    } else rig.position.copy(rigWorld);
    rig.updateMatrixWorld(true);
  }

  function hideAim(entry) {
    entry.line.visible = false;
    entry.marker.visible = false;
    entry.target = null;
  }
  function release(entry) {
    if (renderer.xr.isPresenting && entry.aiming && entry.target) {
      getHead();
      if (simulation.canTeleport([head.x, head.z], [entry.target.x, entry.target.z])) {
        const from = { x: head.x, z: head.z };
        addWorldRigOffset(entry.target.x - head.x, entry.target.z - head.z);
        simulation.updateProgress(entry.target.x, entry.target.z);
        blink = 0.13;
        onTeleport({ from, to: { ...entry.target } });
      }
    }
    entry.aiming = false;
    hideAim(entry);
  }

  for (let index = 0; index < 2; index++) {
    const controller = renderer.xr.getController(index);
    const grip = renderer.xr.getControllerGrip(index);
    rig.add(controller, grip);
    const body = new THREE.Mesh(
      ownGeometry(new THREE.CapsuleGeometry(0.022, 0.095, 3, 7)),
      ownMaterial(new THREE.MeshBasicMaterial({ color: 0x746864 })),
    );
    body.rotation.x = Math.PI / 5;
    body.position.set(0, -0.02, 0.035);
    grip.add(body);
    const ring = new THREE.Mesh(
      ownGeometry(new THREE.TorusGeometry(0.034, 0.003, 4, 18)),
      ownMaterial(new THREE.MeshBasicMaterial({ color: 0xe0c49b })),
    );
    ring.position.set(0, 0.008, -0.025);
    grip.add(ring);

    const positions = new Float32Array(3 * 85);
    const geometry = ownGeometry(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setDrawRange(0, 0);
    const material = ownMaterial(new THREE.LineBasicMaterial({ color: 0xc8b58a, transparent: true, opacity: 0.9, depthTest: false }));
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = 20;
    line.visible = false;
    const marker = new THREE.Mesh(
      ownGeometry(new THREE.RingGeometry(0.17, 0.2, 32)),
      ownMaterial(new THREE.MeshBasicMaterial({ color: 0xd1c196, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthTest: false })),
    );
    marker.rotation.x = -Math.PI / 2;
    marker.renderOrder = 21;
    marker.visible = false;
    scene.add(line, marker);
    const entry = { controller, grip, body, ring, geometry, positions, material, line, marker,
      aiming: false, source: null, target: null, turnArmed: true, cooldown: 0 };
    entry.onStart = () => { if (renderer.xr.isPresenting) entry.aiming = true; };
    entry.onEnd = () => release(entry);
    entry.onConnected = event => {
      entry.source = event.data;
      body.visible = ring.visible = !event.data.hand && event.data.targetRayMode === 'tracked-pointer';
    };
    entry.onDisconnected = () => {
      entry.source = null;
      entry.aiming = false;
      hideAim(entry);
    };
    controller.addEventListener('selectstart', entry.onStart);
    controller.addEventListener('selectend', entry.onEnd);
    controller.addEventListener('connected', entry.onConnected);
    controller.addEventListener('disconnected', entry.onDisconnected);
    controllers.push(entry);
  }

  function updateAim(entry) {
    entry.controller.getWorldPosition(origin);
    entry.controller.getWorldQuaternion(rotation);
    direction.set(0, 0, -1).applyQuaternion(rotation);
    const velocity = direction.clone().multiplyScalar(5.2);
    let previous = origin.clone();
    let count = 0, hit = null, blocked = false;
    entry.positions.set([origin.x, origin.y, origin.z], 0);
    count++;
    for (let i = 1; i < 85; i++) {
      const t = i / 40;
      const point = origin.clone().addScaledVector(velocity, t);
      point.y -= 0.5 * 9.81 * t * t;
      if (point.y <= floorY) {
        const fraction = (previous.y - floorY) / (previous.y - point.y);
        point.lerpVectors(previous, point, Math.max(0, Math.min(1, fraction)));
        point.y = floorY + 0.015;
        hit = point.clone();
      }
      if (simulation.wallBetween([previous.x, previous.z], [point.x, point.z])) {
        blocked = true;
        hit = null;
      }
      entry.positions.set([point.x, point.y, point.z], count * 3);
      count++;
      if (blocked || hit || Math.hypot(point.x - origin.x, point.z - origin.z) > 6) break;
      previous = point;
    }
    getHead();
    const valid = hit && !blocked && simulation.canTeleport([head.x, head.z], [hit.x, hit.z]);
    entry.target = valid ? { x: hit.x, z: hit.z } : null;
    entry.material.color.setHex(valid ? 0xc8b58a : 0x9d302f);
    entry.marker.material.color.setHex(valid ? 0xe2d3a2 : 0x9d302f);
    entry.marker.visible = !!hit;
    if (hit) entry.marker.position.copy(hit);
    entry.geometry.attributes.position.needsUpdate = true;
    entry.geometry.setDrawRange(0, count);
    entry.line.visible = true;
  }

  function snapTurn(angle) {
    beforeHead.copy(getHead());
    rig.rotateOnWorldAxis(up, angle);
    rig.updateMatrixWorld(true);
    // The XR ArrayCamera matrix is only refreshed by WebXRManager before render.
    // Rotate the actual rig offset around the tracked head's world position.
    rig.getWorldPosition(rigWorld);
    const offset = rigWorld.clone().sub(beforeHead).applyAxisAngle(up, angle);
    const newWorld = beforeHead.clone().add(offset);
    if (rig.parent) {
      rig.parent.worldToLocal(newWorld);
      rig.position.copy(newWorld);
    } else rig.position.copy(newWorld);
    rig.updateMatrixWorld(true);
    blink = 0.085;
  }

  function reset() {
    blink = 0; comfortFade = 0;
    for (const entry of controllers) {
      entry.aiming = false;
      entry.turnArmed = true;
      entry.cooldown = 0;
      hideAim(entry);
    }
    lastFade = 0;
    onComfortFade(0);
  }
  renderer.xr.addEventListener('sessionend', reset);

  function update(dt) {
    if (!renderer.xr.isPresenting) return;
    const delta = Math.min(0.1, Math.max(0, dt));
    blink = Math.max(0, blink - delta);
    for (const entry of controllers) {
      entry.cooldown = Math.max(0, entry.cooldown - delta);
      const axes = entry.source?.gamepad?.axes;
      // xr-standard reserves axes 0/1 for touchpad, 2/3 for thumbstick.
      const horizontal = axes ? (axes.length >= 4 ? axes[2] : axes[0] ?? 0) : 0;
      if (Math.abs(horizontal) < 0.25) entry.turnArmed = true;
      if (Math.abs(horizontal) > 0.7 && entry.turnArmed && entry.cooldown === 0) {
        snapTurn(-Math.sign(horizontal) * Math.PI / 6);
        entry.turnArmed = false;
        entry.cooldown = 0.32;
      }
      if (entry.aiming) updateAim(entry);
      else hideAim(entry);
    }
    getHead();
    simulation.updateProgress(head.x, head.z);
    const inRoom = simulation.isValidPosition(head.x, head.z, 0.04);
    const nearCurtain = !simulation.isValidPosition(head.x, head.z, 0.14);
    const desiredFade = !inRoom ? 1 : nearCurtain ? 0.42 : 0;
    comfortFade += (desiredFade - comfortFade) * Math.min(1, delta * 22);
    const fade = Math.max(comfortFade, blink > 0 ? Math.min(1, blink / 0.055) : 0);
    if (Math.abs(fade - lastFade) > 0.005) {
      onComfortFade(fade);
      lastFade = fade;
    }
  }

  function dispose() {
    renderer.xr.removeEventListener('sessionend', reset);
    for (const entry of controllers) {
      entry.controller.removeEventListener('selectstart', entry.onStart);
      entry.controller.removeEventListener('selectend', entry.onEnd);
      entry.controller.removeEventListener('connected', entry.onConnected);
      entry.controller.removeEventListener('disconnected', entry.onDisconnected);
      entry.grip.remove(entry.body, entry.ring);
      rig.remove(entry.controller, entry.grip);
      scene.remove(entry.line, entry.marker);
    }
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  return { update, dispose, reset };
}
