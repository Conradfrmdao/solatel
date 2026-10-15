#!/usr/bin/env python3
"""Daybreak: an original indoor Yard combining freight, glassworks and atrium.

Build, then derive-maps.py yard and bake-light.py yard. Geometry is authored
in metres; raised routes use the same sliced stair kit as Facility.
"""
import importlib.util
import math
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('facility', ROOT / 'scripts/build-facility.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
f.PALETTE.update({
    'terminal_floor': ('#a09a8d', .38),
    'terminal_wall': ('#dad7c9', .87),
    'terminal_teal': ('#28565b', .65),
    'terminal_amber': ('#b58036', .65),
    'terminal_frame': ('#303b40', .65),
    'terminal_stone': ('#a9a28f', .88),
    'terminal_alloy': ('#909b9f', .3),
    'terminal_black': ('#202d31', .5),
    'terminal_brick': ('#a38369', .87),
    'terminal_mirror': ('#c3c9c6', .12),
    'glass': ('#b4d6df', .14),
})


def pieces(kit):
    return [(m, v, faces) for m, (v, faces) in sorted(kit.groups.items())]


def beam(kit, start, end, thickness=.16, material='terminal_frame'):
    a, b = np.array(start, float), np.array(end, float)
    along = (b-a) / np.linalg.norm(b-a)
    side = np.cross(along, [0, 0, 1] if abs(along[2]) < .9 else [0, 1, 0])
    side = side / np.linalg.norm(side) * thickness / 2
    up = np.cross(along, side)
    v = [p+s*side+t*up for p in [a,b] for s,t in [(-1,-1),(1,-1),(1,1),(-1,1)]]
    for ids in [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]:
        points = [v[i] for i in ids]
        kit.face(points, material, np.cross(points[1]-points[0], points[2]-points[0]))


def pipe(kit, start, end, radius=.1, material='terminal_alloy', segments=16):
    a,b=np.array(start,float),np.array(end,float)
    axis=(b-a)/np.linalg.norm(b-a)
    across=np.cross(axis,[0,0,1] if abs(axis[2])<.9 else [0,1,0])
    across/=np.linalg.norm(across)
    up=np.cross(axis,across)
    for i in range(segments):
        p,q=i*math.tau/segments,(i+1)*math.tau/segments
        c=(across*math.cos(p)+up*math.sin(p))*radius
        d=(across*math.cos(q)+up*math.sin(q))*radius
        kit.face([a+c,b+c,b+d,a+d],material,c+d)


def valve(kit,x,y,z,r=.28):
    for i in range(24):
        p,q=i*math.tau/24,(i+1)*math.tau/24
        pipe(kit,(x+math.cos(p)*r,y+math.sin(p)*r,z),
             (x+math.cos(q)*r,y+math.sin(q)*r,z),.025,'terminal_amber',8)
    for i in range(3):
        a=i*math.tau/3
        pipe(kit,(x,y,z),(x+math.cos(a)*r,y+math.sin(a)*r,z),.018,'terminal_alloy',8)


def bevel_box(kit,lo,hi,material,bevel=.04):
    """Machined case shell: six faces, twelve chamfers and eight corners."""
    lo,hi=np.array(lo,float),np.array(hi,float)
    centre=(lo+hi)/2
    half=(hi-lo)/2
    b=min(bevel,float(half.min())*.25)
    for axis in range(3):
        a,c=[i for i in range(3) if i!=axis]
        for sign in [-1,1]:
            pts=[]
            for s,t in [(-1,-1),(1,-1),(1,1),(-1,1)]:
                p=centre.copy();p[axis]+=sign*half[axis];p[a]+=s*(half[a]-b);p[c]+=t*(half[c]-b);pts.append(p)
            outward=np.zeros(3);outward[axis]=sign
            kit.face(pts,material,outward)
    for free in range(3):
        a,c=[i for i in range(3) if i!=free]
        for s in [-1,1]:
            for t in [-1,1]:
                pts=[]
                for end,edge in [(-1,0),(1,0),(1,1),(-1,1)]:
                    p=centre.copy();p[free]+=end*(half[free]-b)
                    p[a]+=s*(half[a]-(b if edge else 0));p[c]+=t*(half[c]-(0 if edge else b));pts.append(p)
                outward=np.zeros(3);outward[a]=s;outward[c]=t
                kit.face(pts,material,outward)
    for sx in [-1,1]:
        for sy in [-1,1]:
            for sz in [-1,1]:
                sign=np.array([sx,sy,sz]);pts=[]
                for axis in range(3):
                    h=half-np.full(3,b);h[axis]=half[axis];pts.append(centre+sign*h)
                kit.face(pts,material,sign)


def main():
    glb = f.Glb()
    glb.js['asset']['generator'] = 'scripts/build-yard.py'
    glb.js['scenes'][0]['name'] = 'Daybreak Terminal'
    structure, detail, glass = f.Kit(), f.Kit(), f.Kit()
    structure.hidden = f.Kit()
    props = []
    # A compact metre scale for a large indoor FPS: 72 x 108 m. Keeping
    # heights makes the roof monumental while lanes/cover stay human sized.
    plan_scale = .75

    def prop(model, x, y, z, dims, yaw=0, solid=False):
        props.append({'model':model, 'at':[x*plan_scale,y,z*plan_scale],
                      'dims':[dims[0]*plan_scale,dims[1],dims[2]*plan_scale], 'yaw':yaw})
        if solid:
            w,h,d=dims
            # Opaque crates only; foliage and wall lamps never block a shot.
            structure.hidden.box(x-w/2,y,z-d/2,x+w/2,y+h,z+d/2,'terminal_frame')
    # The authoring grid below is scaled to 72 x 108 m at export.
    structure.ground(-48,-72,48,72,0,'terminal_floor')
    for x in [-48,47.5]:
        structure.box(x,0,-72,x+.5,12,72,'terminal_wall')
    for z in [-72,71.5]:
        structure.box(-48,0,z,48,12,z+.5,'terminal_wall')

    # Repeating pilasters, exposed connections and ribs make the volume legible.
    for z in range(-66,67,12):
        for x in [-46.8,46.8]:
            structure.box(x-.45,0,z-.55,x+.45,12,z+.55,'terminal_frame')
            detail.box(x-.6,0,z-.7,x+.6,.3,z+.7,'steel')
            for y in [4.7,10.8]:
                detail.box(x-.52,y,z-.65,x+.52,y+.14,z+.65,'terminal_amber')
        for a,b in [((-47,12,z),(0,18,z)),((0,18,z),(47,12,z))]:
            beam(detail,a,b,.65,'terminal_wall')
        beam(detail,(-47,11.8,z),(47,11.8,z),.6,'terminal_wall')
        for x in range(-42,43,7):
            roof = 18-abs(x)*6/47
            beam(detail,(x,11.8,z),(x,roof,z),.11)
            # Diagonal web members, rather than a floating flat roof grid.
            if x < 42:
                beam(detail,(x,11.8,z),(x+7,18-abs(x+7)*6/47,z),.10,'terminal_alloy')
        # Long roof panels are split by mullions, avoiding a huge alpha layer.
        for x0,x1 in [(-47,0),(0,47)]:
            h0,h1=18-abs(x0)*6/47,18-abs(x1)*6/47
            glass.face([(x0,h0,z-6),(x1,h1,z-6),(x1,h1,z+6),(x0,h0,z+6)],'glass',(0,1,0))
    for x in range(-42,43,7):
        y=18-abs(x)*6/47
        beam(detail,(x,y,-72),(x,y,72),.1)
    # The reference is a substantial warehouse with strips of skylight,
    # not an all-glass greenhouse. Concrete roof cassettes leave three long
    # daylight slots, each framed by deep beams and aluminium mullions.
    for xa,xb in [(-47,-32),(-19,-10),(4,13),(26,47)]:
        for za in range(-72,72,12):
            ya,yb=18-abs(xa)*6/47,18-abs(xb)*6/47
            detail.face([(xa,ya-.22,za),(xb,yb-.22,za),(xb,yb-.22,za+12),(xa,ya-.22,za+12)],'terminal_wall',(0,-1,0))
            beam(detail,(xa,ya-.38,za),(xb,yb-.38,za),.45,'terminal_wall')
        for x in [xa,xb]:
            y=18-abs(x)*6/47
            beam(detail,(x,y-.3,-72),(x,y-.3,72),.38,'terminal_wall')
    # End gables close the hall while admitting daylight.
    for z in [-71.7,71.7]:
        glass.face([(-47,12,z),(47,12,z),(0,18,z)],'glass',(0,0,1))

    # Broad opaque roof shoulders concentrate daylight through the centre
    # glazing. Deep rafters and braces give the ceiling weight and rhythm.
    for side in [-1,1]:
        for z0 in range(-72,72,12):
            x0,x1=sorted((side*30,side*47))
            y0,y1=18-abs(x0)*6/47,18-abs(x1)*6/47
            detail.face([(x0,y0-.12,z0),(x1,y1-.12,z0),(x1,y1-.12,z0+12),(x0,y0-.12,z0+12)],'terminal_stone',(0,-1,0))
        for z in [-60,-36,-12,12,36,60]:
            x=side*29
            structure.box(x-.7,0,z-.7,x+.7,12,z+.7,'terminal_wall')
            detail.box(x-.85,0,z-.85,x+.85,.45,z+.85,'terminal_frame')
            # Inset steel and brass identification panel on the aisle face.
            inner=x-side*.74
            detail.box(inner-.04,1.6,z-.6,inner+.04,9,z+.6,'terminal_amber')
            for y in [1.4,4.4,9.1,11.7]:
                detail.box(x-.85,y,z-.85,x+.85,y+.15,z+.85,'terminal_frame')
            beam(detail,(x,10.5,z),(side*36,12,z),.32,'terminal_frame')
            # Steel column jackets, connection plates and exposed bolts.
            for zz in [z-.78,z+.78]:
                for xx in [x-.65,x+.65]:
                    detail.box(xx-.065,.35,zz-.04,xx+.065,11.75,zz+.04,'terminal_frame')
                    for yy in [1.2,4.3,8.9,11.4]:
                        detail.box(xx-.12,yy-.12,zz-.065,xx+.12,yy+.12,zz+.065,'terminal_alloy')
                        for dy in [-.07,.07]:
                            detail.box(xx-.035,yy+dy-.02,zz-.08,xx+.035,yy+dy+.02,zz+.08,'terminal_frame')

    # Side galleries: interrupted sightlines and four wide, modest-rise stairs.
    for side in [-1,1]:
        lo,hi=(-47,-36) if side<0 else (36,47)
        structure.box(lo,4.25,-60,hi,4.5,60,'terminal_stone')
        for z in [-56,-28,0,28,56]:
            structure.box(lo,0,z-.35,hi,4.25,z+.35,'terminal_wall')
        inner=-36 if side<0 else 36
        for za,zb in [(-60,-43),(-37,37),(43,60)]:
            structure.box(inner-.15,4.5,za,inner+.15,5.3,zb,'terminal_wall')
            beam(detail,(inner,5.65,za),(inner,5.65,zb),.08,'terminal_alloy')
            for z in np.arange(za,zb,2):
                beam(detail,(inner,5.3,z),(inner,5.65,z),.055,'terminal_frame')
        for z in [-40,40]:
            # From the centre floor towards the galleries; no jump required.
            structure.flight('x',side*23,side*36,z-2.5,z+2.5,0,4.5,'terminal_stone')
            for zz in [z-2.6,z+2.6]:
                beam(detail,(side*23,1.1,zz),(side*36,5.6,zz),.075,'terminal_alloy')
                for t in np.linspace(0,1,9):
                    xx=side*(23+13*t)
                    beam(detail,(xx,4.5*t+.1,zz),(xx,4.5*t+1.1,zz),.055,'terminal_frame')
            detail.box(min(side*23,side*36),.01,z-2.48,max(side*23,side*36),.035,z-2.36,'terminal_amber')
        # Upper-level partitions keep the entire map from one firing angle.
        for z in [-18,18]:
            structure.box(lo,4.5,z-.25,hi,7.5,z+.25,'terminal_teal')
        for z in range(-60,61,12):
            detail.box(lo+.6,3.9,z-.12,hi-.6,3.96,z+.12,'lamp')

        # Workshops behind the galleries. Inset glazing, pilasters and door
        # reveals create an actual building façade instead of blank white walls.
        wallx=side*47.22
        for z in range(-60,61,12):
            for y in [1.5,6.7]:
                detail.box(wallx-.08,y,z-4.6,wallx+.08,y+2.8,z+4.6,'terminal_frame')
                detail.box(wallx-.11,y+.14,z-4.42,wallx+.11,y+2.66,z+4.42,'terminal_black')
                for zz in np.arange(z-4.4,z+4.5,2.2):
                    detail.box(wallx-.15,y+.12,zz-.035,wallx+.15,y+2.68,zz+.035,'terminal_alloy')
            for yy in [5.9,10.7]:
                detail.box(wallx-.3,yy,z-5.8,wallx+.3,yy+.18,z+5.8,'terminal_alloy')
            detail.box(wallx-.35,3.1,z-5.1,wallx+.35,3.7,z-4.95,'lamp')
            prop('industrial_wall_lamp', side*46.5,2.7,z-4.8,[.34,.65,.28],side*math.pi/2)

        # Enterable warehouse bays on the upper gallery. Real recessed
        # doorways, panel reveals, transoms and roof soffits replace the
        # flat black façade in the first approximation.
        for z in range(-54,55,12):
            xa,xb=sorted((side*43,side*47))
            front=side*43
            for zz in [z-5.6,z+5.6]:
                structure.box(xa,4.5,zz-.18,xb,8.4,zz+.18,'terminal_wall')
            for za,zb in [(z-5.5,z-2),(z+2,z+5.5)]:
                structure.box(front-.18,4.5,za,front+.18,8.4,zb,'terminal_wall')
                detail.box(front-.22,5.4,za+.25,front+.22,7.5,zb-.25,'terminal_teal')
                for yy in np.arange(5.5,7.5,.22):
                    detail.box(front-.25,yy,za+.3,front+.25,yy+.035,zb-.3,'terminal_alloy')
            structure.box(front-.18,7.4,z-2,front+.18,8.4,z+2,'terminal_wall')
            structure.box(xa,8.4,z-5.6,xb,8.65,z+5.6,'terminal_stone')
            for zz in [z-2,z+2]:
                detail.box(front-.25,4.5,zz-.09,front+.25,7.4,zz+.09,'terminal_frame')
            detail.box(front-.35,7.28,z-2,front+.35,7.4,z+2,'terminal_frame')
            detail.box(front-.4,7.6,z-.8,front+.4,7.67,z+.8,'lamp')

    # Two crossing galleries connect both flanks, frame the machine hall and
    # make layered routes like the approved terminal/glassworks references.
    for z in [-20,20]:
        structure.box(-36,4.25,z-2,36,4.5,z+2,'terminal_stone')
        for edge in [z-2,z+2]:
            spans=[(-36,36)]
            if z==-20 and edge==z-2:
                spans=[(-36,-6.5),(-.5,36)]
            elif z==20 and edge==z+2:
                spans=[(-36,6.5),(12.5,36)]
            for xa,xb in spans:
                structure.box(xa,4.5,edge-.12,xb,5.35,edge+.12,'terminal_teal')
                beam(detail,(xa,5.65,edge),(xb,5.65,edge),.07,'terminal_alloy')
        for x in ([-26,-9,9,26] if z<0 else [-26,-9,17,26]):
            structure.box(x-.55,0,z-.6,x+.55,12,z+.6,'terminal_wall')
            detail.box(x-.7,0,z-.75,x+.7,.35,z+.75,'terminal_frame')
            for zz in [z-.63,z+.63]:
                detail.box(x-.4,1.4,zz-.04,x+.4,8.9,zz+.04,'terminal_amber')
            for y in [4.1,9.1]:
                detail.box(x-.7,y,z-.75,x+.7,y+.18,z+.75,'terminal_frame')
            for zz in [z-1.6,z+1.6]:
                detail.box(x-2,4.07,zz-.04,x+2,4.12,zz+.04,'lamp')
        beam(detail,(-36,4.08,z),(36,4.08,z),.25,'terminal_frame')

    def cargo(x,z,w=3.5,d=2,h=1.3,colour='terminal_amber'):
        structure.hidden.box(x-w/2,0,z-d/2,x+w/2,h,z+d/2,colour)
        bevel_box(detail,(x-w/2,0,z-d/2),(x+w/2,h,z+d/2),colour)
        # Skids, metal corner guards, ribs and latches: recognizable cargo,
        # rather than featureless stacked boxes or repeated giant containers.
        for xx in [x-w/2+.12,x+w/2-.12]:
            detail.box(xx-.07,.04,z-d/2-.03,xx+.07,h+.03,z+d/2+.03,'terminal_frame')
        for zz in [z-d/2-.025,z+d/2+.025]:
            for y in [.12,h-.13]:
                detail.box(x-w/2,y,zz-.03,x+w/2,y+.08,zz+.03,'terminal_alloy')
            for xx in np.arange(x-w/2+.6,x+w/2,.7):
                detail.box(xx-.025,.22,zz-.02,xx+.025,h-.22,zz+.02,'terminal_frame')
            detail.box(x-.12,h*.5,zz-.055,x+.12,h*.5+.18,zz+.055,'terminal_alloy')
            # Inset handles, safety latches, and a recessed lid seam.
            detail.box(x-.32,h*.5+.025,zz-.065,x+.32,h*.5+.15,zz+.065,'terminal_frame')
            detail.box(x-.22,h*.5+.06,zz-.072,x+.22,h*.5+.11,zz+.072,'terminal_alloy')
            for xx in [x-w*.3,x+w*.3]:
                bevel_box(detail,(xx-.055,h-.22,zz-.06),(xx+.055,h-.05,zz+.06),'terminal_alloy',.012)
        for xx in [x-w/2+.18,x+w/2-.18]:
            bevel_box(detail,(xx-.14,.04,z-d/2-.05),(xx+.14,.27,z+d/2+.05),'terminal_frame')
        for zz in [z-d/2+.16,z+d/2-.16]:
            detail.box(x-w/2+.1,h-.07,zz-.035,x+w/2-.1,h+.01,zz+.035,'terminal_frame')

    # Freight zone (south): sorting pods, equipment and protected crossings.
    for x,z,w,d,h in [(-12,-51,6,4,2.6),(13,-47,5,3,1.35),(-17,-29,4,3,1.3),(10,-27,6,4,2.4),(7,-38,4,2,1.3),(-28,-62,4,3,2.4),(27,-60,5,3,1.3)]:
        cargo(x,z,w,d,h)
        # Palletised textured equipment breaks up repeated procedural cases.
        prop('old_military_crate',x-1,h,z,[2.1,.75,1.4],solid=True)
        prop('old_military_crate',x+1.15,h,z,[1.8,.65,1.3],solid=True)
    for x in [-13,13]:
        structure.box(x-2,0,-67,x+2,3.2,-63,'terminal_teal')
        detail.box(x-1.6,1,-67.02,x+1.6,2.5,-67,'steel')

    # Dense, staggered freight pods: each lane has standing cover and an
    # alternative route, instead of a floor-wide view from the spawn.
    # Pallet-scale cases sit alongside substantial equipment containers.
    for x,z,w,d,h,colour in [
        (1,-56,8,5,3.2,'terminal_stone'),
        (-24,-51,5,8,3.6,'terminal_teal'),
        (25,-51,5,7,3.4,'terminal_stone'),
        (-13,-37,6,4,2.8,'terminal_stone'),
        (15,-59,7,4,2.7,'terminal_teal'),
        (-24,-25,4,5,2.8,'terminal_amber'),
        (23,-27,5,4,1.3,'terminal_teal'),
        (-2,-10,6,5,3.5,'terminal_teal'),
        (24,0,6,9,3.4,'terminal_stone'),
        (-24,5,5,8,3.4,'terminal_teal'),
        (-11,10,5,4,2.7,'terminal_stone'),
        (5,13,6,4,1.3,'terminal_amber'),
        (-8,29,6,5,2.8,'terminal_stone'),
        (20,27,5,8,3.2,'terminal_teal'),
        (-24,49,6,4,2.9,'terminal_stone'),
        (10,52,6,4,2.5,'terminal_teal'),
        (-12,65,7,4,2.7,'terminal_stone'),
    ]:
        cargo(x,z,w,d,h,colour)
        if h>2.7:
            # Recessed machinery vents and service doors give large cover a
            # recognisable purpose. Their solid rear panels really stop fire.
            for xx in [x-w*.28,x+w*.28]:
                detail.box(xx-.5,.6,z-d/2-.06,xx+.5,h-.4,z-d/2-.02,'terminal_frame')
                for yy in np.arange(.75,h-.5,.18):
                    detail.box(xx-.46,yy,z-d/2-.09,xx+.46,yy+.05,z-d/2-.06,'terminal_alloy')

    # Broad central access stairs double as major cover, with a concrete
    # cheek and an open approach at each end. They connect to the galleries.
    for xa,xb,start,end in [(-6,-1,-39,-22),(7,12,39,22)]:
        structure.flight('z',start,end,xa,xb,0,4.5,'terminal_stone')
        for x in [xa-.1,xb+.1]:
            beam(detail,(x,1.05,start),(x,5.55,end),.075,'terminal_alloy')
            for t in np.linspace(0,1,13):
                zz=start+(end-start)*t
                beam(detail,(x,t*4.5,zz),(x,t*4.5+1.05,zz),.055,'terminal_frame')
        # The steep side is solid on a real stair; preserve open risers only
        # at its actual entrance rather than an invisible collision envelope.
        for t in np.linspace(0,1,35):
            zz=start+(end-start)*t
            structure.box(xa-.18,0,zz-.22,xa,t*4.5+.25,zz+.22,'terminal_wall')

    # Full-height polished steel screens: opaque reflective cover, mounted
    # in heavy frames, with clear bypasses on both sides. Never a glass wall
    # a player can see through but cannot shoot through.
    for x,z,w in [(1,-43,6),(-19,-17,8),(17,17,7),(-2,54,6)]:
        structure.box(x-w/2,0,z-.24,x+w/2,2.7,z+.24,'terminal_mirror')
        for xx in [x-w/2,x+w/2]:
            detail.box(xx-.12,0,z-.35,xx+.12,2.9,z+.35,'terminal_frame')
        for y in [.08,2.7]:
            detail.box(x-w/2,y,z-.32,x+w/2,y+.1,z+.32,'terminal_frame')

    # Glassworks (middle): two machine islands, with the final-circle centre
    # kept walkable. Opaque machine bases are actual cover; glass is decorative.
    for x,z in [(-13,-5),(13,7)]:
        structure.box(x-3,0,z-4,x+3,1.4,z+4,'terminal_teal')
        for zz in [z-2,z+2]:
            structure.cylinder(x,zz,1.15,1.4,6.4,'terminal_alloy',segments=32)
            detail.cylinder(x,zz,1.27,1.5,1.7,'terminal_amber',segments=16)
            detail.cylinder(x,zz,1.27,5.7,5.9,'terminal_amber',segments=16)
            beam(detail,(x,6.4,zz),(x,9.8,zz),.35,'terminal_alloy')
            for y in [2.2,3.7,5.4]:
                pipe(detail,(x-1.15,y,zz),(x-2,y,zz),.1)
                pipe(detail,(x-2,y,zz),(x-2,y-1,zz),.1)
                valve(detail,x-1.7,y,zz+.12,.21)
            for angle in np.arange(0,math.tau,math.pi/4):
                px,pz=x+math.cos(angle)*1.18,zz+math.sin(angle)*1.18
                pipe(detail,(px,1.6,pz),(px,6.3,pz),.055,'terminal_frame',8)
            # Riveted mounting rings with readable high-light edges.
            for y in [1.65,5.8]:
                for angle in np.arange(0,math.tau,math.pi/6):
                    px,pz=x+math.cos(angle)*1.29,zz+math.sin(angle)*1.29
                    detail.box(px-.035,y-.035,pz-.035,px+.035,y+.035,pz+.035,'terminal_alloy')
        # Operator station: screen, gauges, switches and foot plinth.
        structure.box(x-1.4,0,z+4.2,x+1.4,1.45,z+5.4,'terminal_teal')
        detail.box(x-1.2,.75,z+5.4,x-.15,1.35,z+5.45,'terminal_frame')
        detail.box(x-1.1,.84,z+5.451,x-.25,1.27,z+5.47,'terminal_black')
        for xx in [x+.25,x+.65,x+1.05]:
            detail.box(xx-.08,1.05,z+5.4,xx+.08,1.21,z+5.48,'terminal_alloy')
        for xx in [x+.3,x+.8]:
            detail.box(xx-.035,.78,z+5.4,xx+.035,.85,z+5.5,'terminal_amber')
        cargo(x+(-5 if x<0 else 5),z+3,2,2,1.3,'terminal_teal')
    for x,z in [(-27,10),(27,-11),(-6,15),(7,-17)]:
        cargo(x,z,3.3,2,1.25,'terminal_teal')
    for x,z in [(-17,-11),(17,1),(-34,-10),(34,14),(-34,-51),(34,51)]:
        prop('metal_tool_chest',x,0,z,[1.35,1.2,.85],solid=True)

    # Atrium (north): contained planting as the landmark, not visual clutter
    # spread over every lane. Planter islands provide the central cover.
    for x,z,w,d in [(0,43,10,8),(-20,28,5,4),(20,56,5,4)]:
        structure.box(x-w/2,0,z-d/2,x+w/2,1.15,z+d/2,'terminal_stone')
        detail.box(x-w/2+.2,1.15,z-d/2+.2,x+w/2-.2,1.18,z+d/2-.2,'dirt')
        structure.tree(x,z,1.15,7 if x==0 else 5,2)
        for xx in [x-w/2+.5,x+w/2-.5]:
            detail.box(xx-.3,.45,z-d/2-.55,xx+.3,.6,z+d/2+.55,'wood')
        for dx in np.arange(-w/2+.7,w/2,.95):
            for dz in [-d/2+.7,d/2-.7]:
                prop('fern_02',x+dx,1.17,z+dz,[1.1,.8,1.1],(dx+dz)*1.7)
    for x,z in [(-11,59),(20,26),(25,17),(-27,49),(6,65)]:
        cargo(x,z,3.6,2,1.25,'terminal_teal')
    for side in [-1,1]:
        for z in [-48,-5,48]:
            prop('old_military_crate',side*39,4.5,z,[3.3,1.25,1.6],solid=True)
    for x,z in [(-39,-32),(39,-32),(-39,32),(39,32),(-9,20),(9,-20)]:
        prop('potted_plant_02',x,4.5,z,[1.15,2.1,1.15])

    # Service modules anchor the large volume and break cross-map shots.
    # Wide doorways remain traversable; the upper edge is reachable gallery.
    for side in [-1,1]:
        for za,zb in [(-56,-47),(-16,-7),(10,19),(47,56)]:
            xa,xb=sorted((side*29.8,side*36))
            structure.box(xa,0,za,xb,3.9,za+.4,'terminal_wall')
            structure.box(xa,0,zb-.4,xb,3.9,zb,'terminal_wall')
            structure.box(xa,3.9,za,xb,4.25,zb,'terminal_stone')
            front=side*29.8
            structure.box(front-.2,0,za,front+.2,3.9,za+2,'terminal_teal')
            structure.box(front-.2,0,zb-2,front+.2,3.9,zb,'terminal_teal')
            structure.box(front-.2,3.2,za+2,front+.2,3.9,zb-2,'terminal_teal')
            detail.box(front-.24,3.6,za+2,front+.24,3.67,zb-2,'lamp')
            detail.box(xa+.4,1.1,za+.6,xb-.4,1.3,za+1.6,'terminal_frame')

    # Additional freight racks are architectural, with a few cargo cases
    # underneath; no freestanding art-only obstacle can stop a player.
    for x,z in [(-11,-60),(14,-37),(-13,21),(15,61)]:
        for xx in [x-3.5,x+3.5]:
            structure.box(xx-.18,0,z-1.8,xx+.18,4.8,z+1.8,'terminal_frame')
        detail.box(x-3.5,4.3,z-1.8,x+3.5,4.5,z+1.8,'terminal_amber')
        for xx in [x-2,x+1.5]:
            cargo(xx,z,2.5,2.2,1.25,'terminal_teal')

    # Floor lane borders and portals give zones their own identity.
    for x in [-21,21]:
        for z in range(-66,66,4):
            detail.box(x-.06,.015,z,x+.06,.03,z+2.8,'terminal_amber')
    for z in [-22,22]:
        for x in [-31,31]:
            structure.box(x-.5,0,z-.5,x+.5,10,z+.5,'terminal_wall')
        beam(detail,(-31,10,z),(31,10,z),.45,'terminal_wall')
        for x in [-24,24]:
            detail.box(x-3,7.5,z-.3,x+3,9.5,z+.3,'terminal_teal' if z>0 else 'terminal_amber')

    for name,kit,extras in [('yard_structure',structure,{}),('yard_detail',detail,{'scenery':True}),('yard_glazing',glass,{'scenery':True}),('yard_tree_collision',structure.hidden,{'collision_only':True})]:
        if kit.groups:
            glb.node(name,glb.mesh(name,pieces(kit)),extras=extras,scale=[plan_scale,1,plan_scale])
    mat=glb.js['materials'][glb.surfaces['glass']]
    mat['alphaMode']='BLEND'
    mat['pbrMetallicRoughness']['baseColorFactor'][3]=.12
    glb.js['scenes'][0]['extras']={
        'indoor':True,'water_level':-8,'trees':[round(float(v),3) for t in structure.trees for v in t],
        'tree_kinds':list(f.TREE_KINDS),
        'terminal_props':props,
        'terminal_signs':[
            {'code':'01','name':'DAYBREAK','subtitle':'FREIGHT TERMINAL / SOUTH HALL','at':[0,8,-71.46],'normal':[0,0,1],'width':18},
            {'code':'03','name':'ATRIUM','subtitle':'RESEARCH GARDEN / NORTH HALL','at':[0,8,71.46],'normal':[0,0,-1],'width':18,'accent':'#7faaa2'},
            *[{'code':'02' if z<0 else '03','name':'GLASSWORKS' if z<0 else 'ATRIUM',
               'subtitle':'PROCESSING HALL' if z<0 else 'RESEARCH GARDEN',
               'at':[x,8.5,z-.315],'normal':[0,0,-1],'width':5.8}
              for z in [-22,22] for x in [-24,24]],
        ],
    }
    extras=glb.js['scenes'][0]['extras']
    # Metadata is in world metres; source-kit vertices carry the node scale.
    for i in range(0,len(extras['trees']),5):
        extras['trees'][i]*=plan_scale
        extras['trees'][i+2]*=plan_scale
    for sign in extras['terminal_signs']:
        sign['at'][0]*=plan_scale
        sign['at'][2]*=plan_scale
        sign['width']*=plan_scale
    glb.js['asset']['extras']={'title':'Daybreak Terminal','author':'Solatel','source':'scripts/build-yard.py','license':'Original Solatel geometry'}
    size=glb.write(ROOT/'assets/maps/yard.glb')
    print(f'Daybreak Terminal: {size/1048576:.2f} MB; 72 x 108 m; freight / glassworks / atrium; {len(props)} PBR props')


if __name__=='__main__':
    main()
