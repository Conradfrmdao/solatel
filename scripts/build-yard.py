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
    'terminal_floor': ('#838278', .38),
    'terminal_wall': ('#dad7c9', .87),
    'terminal_teal': ('#28565b', .65),
    'terminal_amber': ('#b58036', .65),
    'terminal_frame': ('#303b40', .65),
    'terminal_stone': ('#a9a28f', .88),
    'terminal_alloy': ('#909b9f', .3),
    'terminal_black': ('#202d31', .5),
    'terminal_brick': ('#a38369', .87),
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
    # A 96 x 144 metre enclosed hall. No outside apron or inaccessible roofs.
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
            beam(detail,a,b,.65)
        beam(detail,(-47,11.8,z),(47,11.8,z),.45)
        for x in range(-42,43,7):
            roof = 18-abs(x)*6/47
            beam(detail,(x,11.8,z),(x,roof,z),.11)
        # Long roof panels are split by mullions, avoiding a huge alpha layer.
        for x0,x1 in [(-47,0),(0,47)]:
            h0,h1=18-abs(x0)*6/47,18-abs(x1)*6/47
            glass.face([(x0,h0,z-6),(x1,h1,z-6),(x1,h1,z+6),(x0,h0,z+6)],'glass',(0,1,0))
    for x in range(-42,43,7):
        y=18-abs(x)*6/47
        beam(detail,(x,y,-72),(x,y,72),.1)
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
    for x,z,w,d,h in [(-12,-51,6,4,2.6),(13,-47,5,3,1.35),(-17,-29,4,3,1.3),(10,-27,6,4,2.4),(0,-38,4,2,1.3),(-28,-62,4,3,2.4),(27,-60,5,3,1.3)]:
        cargo(x,z,w,d,h)
    for x in [-13,13]:
        structure.box(x-2,0,-67,x+2,3.2,-63,'terminal_teal')
        detail.box(x-1.6,1,-67.02,x+1.6,2.5,-67,'steel')

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

    # Atrium (north): contained planting as the landmark, not visual clutter
    # spread over every lane. Planter islands provide the central cover.
    for x,z,w,d in [(0,43,10,8),(-20,28,5,4),(20,56,5,4)]:
        structure.box(x-w/2,0,z-d/2,x+w/2,1.15,z+d/2,'terminal_stone')
        detail.box(x-w/2+.2,1.15,z-d/2+.2,x+w/2-.2,1.18,z+d/2-.2,'dirt')
        structure.tree(x,z,1.15,7 if x==0 else 5,2)
        for xx in [x-w/2+.5,x+w/2-.5]:
            detail.box(xx-.3,.45,z-d/2-.55,xx+.3,.6,z+d/2+.55,'wood')
    for x,z in [(-11,59),(15,28),(25,17),(-27,49),(6,65)]:
        cargo(x,z,3.6,2,1.25,'terminal_teal')

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
            glb.node(name,glb.mesh(name,pieces(kit)),extras=extras)
    mat=glb.js['materials'][glb.surfaces['glass']]
    mat['alphaMode']='BLEND'
    mat['pbrMetallicRoughness']['baseColorFactor'][3]=.12
    glb.js['scenes'][0]['extras']={
        'indoor':True,'water_level':-8,'trees':[round(float(v),3) for t in structure.trees for v in t],
        'tree_kinds':list(f.TREE_KINDS),
        'terminal_signs':[
            {'code':'01','name':'DAYBREAK','subtitle':'FREIGHT TERMINAL / SOUTH HALL','at':[0,8,-71.46],'normal':[0,0,1],'width':18},
            {'code':'03','name':'ATRIUM','subtitle':'RESEARCH GARDEN / NORTH HALL','at':[0,8,71.46],'normal':[0,0,-1],'width':18,'accent':'#7faaa2'},
            *[{'code':'02' if z<0 else '03','name':'GLASSWORKS' if z<0 else 'ATRIUM',
               'subtitle':'PROCESSING HALL' if z<0 else 'RESEARCH GARDEN',
               'at':[x,8.5,z-.315],'normal':[0,0,-1],'width':5.8}
              for z in [-22,22] for x in [-24,24]],
        ],
    }
    glb.js['asset']['extras']={'title':'Daybreak Terminal','author':'Solatel','source':'scripts/build-yard.py','license':'Original Solatel geometry'}
    size=glb.write(ROOT/'assets/maps/yard.glb')
    print(f'Daybreak Terminal: {size/1048576:.2f} MB; 96 x 144 m; freight / glassworks / atrium')


if __name__=='__main__':
    main()
