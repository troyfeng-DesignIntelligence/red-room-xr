// The six rooms of the reconstruction by floor position: a code and a name.
// The thresholds follow the walkable floor in assets/spatial.json.
export function roomAt(x, z) {
  if (x < -19.15) return ['05', '空桌房间'];
  if (z > 16.9) return ['06', '镜像等候室'];
  if (z > 8.5 || (x < -12.4 && z > 2.7)) return ['04', '回返走廊'];
  if (x < -9.2 && z < 2.8) return ['03', '空置的房间'];
  if (x < -5.6 && x > -9.2) return ['02', '雕像长廊'];
  return ['01', '等候室'];
}
