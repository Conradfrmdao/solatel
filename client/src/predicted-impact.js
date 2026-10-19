// Static-world feedback may be predicted; player hits and rewards may not.
export function endpointHitsWorld(path, brushes) {
  if (path.length < 6) return false;
  const [x,y,z] = path.slice(-3);
  const pad = .002;
  for (let i=0;i<brushes.length;i+=6) {
    if (x>=brushes[i]-pad && x<=brushes[i+3]+pad &&
        y>=brushes[i+1]-pad && y<=brushes[i+4]+pad &&
        z>=brushes[i+2]-pad && z<=brushes[i+5]+pad) return true;
  }
  return false;
}

// Conservatively withhold a wall prediction if a displayed soldier could
// intercept any segment. This never awards a hit or draws predicted blood.
export function pathMayHitPlayer(path, players) {
  for (const player of players) {
    if (player.diedAt !== null) continue;
    const p=player.root.position;
    const min=[p.x-.65,p.y-.1,p.z-.65],max=[p.x+.65,p.y+2.1,p.z+.65];
    for(let i=3;i<path.length;i+=3) {
      let near=0,far=1;
      for(let axis=0;axis<3;axis++) {
        const start=path[i-3+axis],delta=path[i+axis]-start;
        if(Math.abs(delta)<1e-8) {
          if(start<min[axis]||start>max[axis]) {far=-1;break;}
        } else {
          const a=(min[axis]-start)/delta,b=(max[axis]-start)/delta;
          near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));
        }
      }
      if(near<=far)return true;
    }
  }
  return false;
}
