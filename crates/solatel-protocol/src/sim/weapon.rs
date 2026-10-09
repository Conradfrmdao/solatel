//! The guns: what each one does, and how its rounds fly.
//!
//! Shared, like the rest of the simulation, so there is one description of a
//! weapon. The server enforces every number here - how fast it fires, how many
//! rounds a magazine holds, how long a reload or a change of weapon takes, how
//! a round flies and what it does where it lands - and the client predicts its
//! own shots from the same table and draws everybody's tracers along the same
//! flight, so the kick, the count and the streak agree with what the server
//! decides.
//!
//! # Five guns and a choice
//!
//! A player picks a primary before they queue - an SMG, the assault rifle, a
//! machine gun or a sniper rifle - and an optic for it, and everybody carries
//! the pistol as well. The choice is made with the stake, not found on the
//! map: one entry fee buys one life with the weapon its owner chose, and
//! nobody is killed for being unlucky with what was lying near their spawn.
//!
//! What sets them apart is the server's to enforce, so it is all here: the
//! rate of fire, the magazine, the reload, how long it takes to bring each to
//! bear, the damage at each range, and the round's speed. An optic changes
//! what its owner can see and nothing about where a round goes.
//!
//! # Rounds fly
//!
//! Nothing arrives instantly. A round leaves at its weapon's muzzle velocity
//! and on the way it falls, under real gravity, and slows, under air drag in
//! proportion to the square of its speed. The velocities and the drag are the
//! real cartridges', rounded: .45 ACP from the M1911 at 255 m/s, 9 mm from the
//! MP5's short barrel at 400, 7.62x39 mm from the AK-47 and the RPK's longer
//! barrel at 715 and 745, and .308 from the M700 at 790, each slowing at the
//! rate its bullet does - for each, half the air's density times the
//! bullet's drag coefficient and cross-section over its mass. Every sight is zeroed - the round is launched a fraction of a degree
//! up, so it crosses the line of sight at the zero distance - which is what a
//! real rifle's sights are set to do, and why the middle of the crosshair is
//! dead on at the range each gun is meant for.
//!
//! At the ranges these maps are played over, what that means in practice:
//!
//! | | 50 m | 100 m | 200 m | 300 m |
//! |---|---|---|---|---|
//! | rifle | 72 ms, +3 cm | 149 ms, 0 | 317 ms, -25 cm | 506 ms, -81 cm |
//! | machine gun | 69 ms, +2 cm | 143 ms, 0 | 304 ms, -23 cm | 486 ms, -75 cm |
//! | sniper | 64 ms, +2 cm | 131 ms, 0 | 272 ms, -18 cm | 423 ms, -57 cm |
//! | SMG | 129 ms, 0 | 267 ms, -18 cm | 572 ms, -115 cm | |
//! | pistol | 201 ms, -10 cm | 410 ms, -61 cm | | |
//!
//! The drop is the smaller half of it. A player running across the line of
//! fire at eight metres a second covers two metres while a .308 round crosses
//! 200 m, so a long shot is led - which is the skill a sniper rifle is, and
//! the reason it can be allowed to kill with one round to the head.
//!
//! A round is stepped a tick at a time and judged on the straight line between
//! one tick's position and the next: fourteen metres at most, along which the
//! true curve sags by a third of a millimetre.

use std::sync::OnceLock;

use glam::Vec3;
use serde::{Deserialize, Serialize};

use super::{HitRegion, look_direction};
use crate::net::{TICK_DT, TICK_HZ};

/// Gravity on a round, in metres per second squared: the real one. Players
/// fall under [`super::GRAVITY`], which is heavier because a game's jump has
/// to come down quicker than a real one; a bullet has no such need.
pub const BULLET_GRAVITY: f32 = 9.81;

/// Ticks in `seconds`, rounded: every timer a weapon has is kept in ticks, so
/// the rate of fire is exact however long the server has been running.
const fn ticks(seconds: f32) -> u32 {
    (seconds * TICK_HZ as f32 + 0.5) as u32
}

/// Which gun.
///
/// Named on the wire by what each is, and drawn as a real one (the client's
/// `guns.js`): the rifle an AK-47, the SMG an MP5, the machine gun an RPK,
/// the sniper rifle a bolt-action M700 in .308 and the pistol an M1911. Their
/// rounds fly as those guns' cartridges do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Weapon {
    Pistol,
    Smg,
    #[default]
    Rifle,
    Lmg,
    Sniper,
}

/// One range band of a weapon's damage: from `from` metres out, until the
/// next band starts, a hit does this much to each region.
///
/// Stated per region and per band, never as a multiplier on a base: a
/// multiplier means a rounding rule, and a rounding rule is one more thing
/// that has to match between whatever computes the number and whatever checks
/// it. These are the numbers, and the shots-to-kill they imply are the design.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Band {
    pub from: u16,
    pub head: i16,
    pub body: i16,
    pub legs: i16,
}

/// Everything about one gun that decides anything.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stats {
    /// What the menu and the killfeed call it.
    pub name: &'static str,
    /// Fires for as long as the trigger is held. The pistol and the sniper
    /// rifle fire once a pull: holding the trigger fires nothing more.
    pub automatic: bool,
    /// Ticks from one round to the next, at the fastest the gun will go. A
    /// sniper rifle's is the bolt being worked.
    pub fire_ticks: u32,
    /// Rounds in a full magazine.
    pub magazine: u32,
    /// Ticks to put a fresh magazine in.
    pub reload_ticks: u32,
    /// Ticks from deciding to use this gun to it being ready to fire: taking
    /// it out, or switching to it from the other.
    pub draw_ticks: u32,
    /// Metres per second as the round leaves.
    pub muzzle_velocity: f32,
    /// How fast the air slows the round: its deceleration is this times the
    /// square of its speed, per metre.
    pub drag: f32,
    /// Where the sights are zeroed, in metres: the round crosses the line of
    /// sight here and the crosshair is dead on.
    pub zero: f32,
    /// How far a round goes before it is spent, along its flight. Further
    /// than any of these maps is wide for the long guns; a pistol round at
    /// 150 m is a metre low and has nothing left worth counting.
    pub range: f32,
    /// Damage by distance, nearest first. The first band starts at zero.
    pub bands: &'static [Band],
}

// The table. Fire rates are whole ticks at 64 a second, so what is written is
// what happens: 8 ticks is 480 rounds a minute, 5 is 768.
//
// Body shots to kill at close range, against `MAX_HEALTH` of 100: pistol 5,
// SMG 5, rifle 4, machine gun 5, sniper 2 - which at their rates is 0.63 s,
// 0.31 s, 0.38 s, 0.44 s and 1.25 s. Each falls off with range at its own
// pace: the SMG fastest, the machine gun least, the sniper rifle never. So
// the SMG wins up close, the rifle in the middle, the machine gun at range
// and for as long as its seventy-five rounds last, and the sniper rifle wherever
// its owner can put a round on a head.

// A table: its damage bands read across, one range to a line.
#[rustfmt::skip]
const PISTOL: Stats = Stats {
    name: "Pistol",
    automatic: false,
    fire_ticks: 10,
    magazine: 15,
    reload_ticks: ticks(1.5),
    draw_ticks: ticks(0.35),
    muzzle_velocity: 255.0,
    drag: 0.0009,
    zero: 25.0,
    range: 150.0,
    bands: &[
        Band { from: 0, head: 40, body: 20, legs: 17 },
        Band { from: 20, head: 30, body: 15, legs: 12 },
    ],
};

#[rustfmt::skip]
const SMG: Stats = Stats {
    name: "SMG",
    automatic: true,
    fire_ticks: 5,
    magazine: 30,
    reload_ticks: ticks(1.9),
    draw_ticks: ticks(0.45),
    muzzle_velocity: 400.0,
    drag: 0.0013,
    zero: 50.0,
    range: 250.0,
    bands: &[
        Band { from: 0, head: 34, body: 20, legs: 17 },
        Band { from: 15, head: 30, body: 17, legs: 14 },
        Band { from: 30, head: 26, body: 13, legs: 11 },
    ],
};

#[rustfmt::skip]
const RIFLE: Stats = Stats {
    name: "Assault rifle",
    automatic: true,
    fire_ticks: 8,
    magazine: 30,
    reload_ticks: ticks(2.2),
    draw_ticks: ticks(0.55),
    muzzle_velocity: 715.0,
    drag: 0.0012,
    zero: 100.0,
    range: 450.0,
    bands: &[
        // Two to the head, four to the body, five to the legs - the rifle as
        // it has always been, out to fifty metres.
        Band { from: 0, head: 50, body: 25, legs: 20 },
        Band { from: 50, head: 45, body: 20, legs: 17 },
        Band { from: 100, head: 40, body: 17, legs: 14 },
    ],
};

#[rustfmt::skip]
const LMG: Stats = Stats {
    name: "Machine gun",
    automatic: true,
    fire_ticks: 7,
    // An RPK's drum: seventy-five rounds, and a drum is quicker to change
    // than a belt.
    magazine: 75,
    reload_ticks: ticks(4.0),
    draw_ticks: ticks(0.8),
    muzzle_velocity: 745.0,
    drag: 0.0012,
    zero: 100.0,
    range: 450.0,
    bands: &[
        Band { from: 0, head: 45, body: 22, legs: 18 },
        Band { from: 60, head: 40, body: 20, legs: 17 },
    ],
};

#[rustfmt::skip]
const SNIPER: Stats = Stats {
    name: "Sniper rifle",
    automatic: false,
    fire_ticks: ticks(1.25),
    magazine: 5,
    reload_ticks: ticks(3.0),
    draw_ticks: ticks(0.7),
    muzzle_velocity: 790.0,
    drag: 0.0007,
    zero: 100.0,
    range: 800.0,
    // One round to the head kills from full health, at any range: the only
    // shot in the game that does. It is a bolt action with five rounds, a
    // second and a quarter between them and a round in flight long enough to
    // have to be led, and that is what pays for it. Two to the body.
    bands: &[Band { from: 0, head: 100, body: 75, legs: 60 }],
};

impl Weapon {
    pub const ALL: [Weapon; 5] = [
        Weapon::Pistol,
        Weapon::Smg,
        Weapon::Rifle,
        Weapon::Lmg,
        Weapon::Sniper,
    ];

    /// The guns a player may choose to carry. The pistol is everybody's
    /// second, never a choice.
    pub const PRIMARIES: [Weapon; 4] = [Weapon::Smg, Weapon::Rifle, Weapon::Lmg, Weapon::Sniper];

    pub const fn stats(self) -> &'static Stats {
        match self {
            Weapon::Pistol => &PISTOL,
            Weapon::Smg => &SMG,
            Weapon::Rifle => &RIFLE,
            Weapon::Lmg => &LMG,
            Weapon::Sniper => &SNIPER,
        }
    }

    pub const fn is_primary(self) -> bool {
        !matches!(self, Weapon::Pistol)
    }

    /// Its name on the wire, exactly as serde writes it.
    pub const fn id(self) -> &'static str {
        match self {
            Weapon::Pistol => "pistol",
            Weapon::Smg => "smg",
            Weapon::Rifle => "rifle",
            Weapon::Lmg => "lmg",
            Weapon::Sniper => "sniper",
        }
    }

    /// What a hit on `region` does from `distance` metres.
    pub fn damage(self, region: HitRegion, distance: f32) -> i16 {
        let bands = self.stats().bands;
        let band = bands
            .iter()
            .rev()
            .find(|band| distance >= f32::from(band.from))
            .unwrap_or(&bands[0]);
        match region {
            HitRegion::Head => band.head,
            HitRegion::Body => band.body,
            HitRegion::Legs => band.legs,
        }
    }

    /// The optics this gun can carry, the first of them its default. A
    /// pistol has iron sights; a sniper rifle has nothing under 3x; nothing
    /// has more than 4x, which is as much as these maps have room for.
    pub const fn optics(self) -> &'static [Optic] {
        match self {
            Weapon::Pistol => &[Optic::Irons],
            Weapon::Smg => &[Optic::RedDot, Optic::X2],
            Weapon::Rifle => &[Optic::RedDot, Optic::X2, Optic::X3, Optic::X4],
            Weapon::Lmg => &[Optic::RedDot, Optic::X2, Optic::X3],
            Weapon::Sniper => &[Optic::X4, Optic::X3],
        }
    }

    pub const fn default_optic(self) -> Optic {
        self.optics()[0]
    }

    /// How far above the line of sight a round is launched, in radians, so
    /// that it comes back down to it at the zero distance.
    ///
    /// Found by flying a round rather than by formula, so it is exact for
    /// the flight it is used with, drag included. The same on every machine:
    /// it is this crate's arithmetic on this crate's numbers.
    pub fn zero_angle(self) -> f32 {
        static ANGLES: OnceLock<[f32; 5]> = OnceLock::new();
        ANGLES.get_or_init(|| Weapon::ALL.map(|weapon| weapon.find_zero()))[self as usize]
    }

    fn find_zero(self) -> f32 {
        let stats = self.stats();
        let mut angle = 0.0_f32;
        // Each pass corrects by the miss; three take it well under a
        // millimetre at the zero.
        for _ in 0..3 {
            let mut round = Round {
                position: Vec3::ZERO,
                velocity: Vec3::new(0.0, angle.sin(), -angle.cos()) * stats.muzzle_velocity,
            };
            let mut previous = round.position;
            while -round.position.z < stats.zero {
                previous = round.position;
                round.step(stats.drag, TICK_DT);
            }
            // Height where the flight crosses the zero distance.
            let span = previous.z - round.position.z;
            let along = (-stats.zero - previous.z) / -span;
            let height = previous.y + (round.position.y - previous.y) * along;
            angle += (-height).atan2(stats.zero);
        }
        angle
    }
}

/// What a gun is aimed through.
///
/// Changes what its owner can see and nothing about where a round goes: the
/// shot leaves along the aim either way. Told to everybody, because a scope
/// on a rifle is plain to see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Optic {
    /// The pistol's own sights.
    Irons,
    /// A red dot: no magnification to speak of.
    #[default]
    RedDot,
    X2,
    X3,
    X4,
}

impl Optic {
    pub const ALL: [Optic; 5] = [Optic::Irons, Optic::RedDot, Optic::X2, Optic::X3, Optic::X4];

    /// Its name on the wire, exactly as serde writes it.
    pub const fn id(self) -> &'static str {
        match self {
            Optic::Irons => "irons",
            Optic::RedDot => "red_dot",
            Optic::X2 => "x2",
            Optic::X3 => "x3",
            Optic::X4 => "x4",
        }
    }

    /// How much it magnifies: the tangent of the view's half-angle is
    /// divided by this with the sights up. Iron sights and a red dot narrow
    /// the view a little, the way leaning into a sight does.
    pub const fn magnification(self) -> f32 {
        match self {
            Optic::Irons => 1.15,
            Optic::RedDot => 1.25,
            Optic::X2 => 2.0,
            Optic::X3 => 3.0,
            Optic::X4 => 4.0,
        }
    }
}

/// Which of the two guns a player carries is in their hands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Slot {
    #[default]
    Primary,
    Sidearm,
}

/// What a player takes into a match: a primary and its optic. The pistol is
/// everybody's, so it is not part of the choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct Loadout {
    #[serde(default)]
    pub primary: Weapon,
    #[serde(default)]
    pub optic: Optic,
}

impl Loadout {
    /// A loadout this game allows. A client may ask for anything; a pistol
    /// as a primary is the rifle, and an optic the gun cannot carry is that
    /// gun's own. Never refused - the client is choosing from a list, and a
    /// stale or doctored list is not worth a match.
    pub fn sanitized(self) -> Self {
        let primary = if self.primary.is_primary() {
            self.primary
        } else {
            Weapon::default()
        };
        let optic = if primary.optics().contains(&self.optic) {
            self.optic
        } else {
            primary.default_optic()
        };
        Self { primary, optic }
    }

    /// The gun in a slot.
    pub const fn weapon(self, slot: Slot) -> Weapon {
        match slot {
            Slot::Primary => self.primary,
            Slot::Sidearm => Weapon::Pistol,
        }
    }

    /// The optic on the gun in a slot.
    pub const fn optic_for(self, slot: Slot) -> Optic {
        match slot {
            Slot::Primary => self.optic,
            Slot::Sidearm => Optic::Irons,
        }
    }
}

/// A round in flight.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Round {
    pub position: Vec3,
    pub velocity: Vec3,
}

impl Round {
    /// A round fired from `eye` along the aim `yaw`/`pitch`, launched up by
    /// the gun's zero.
    pub fn fired(weapon: Weapon, eye: Vec3, yaw: f32, pitch: f32) -> Self {
        let stats = weapon.stats();
        Self {
            position: eye,
            velocity: look_direction(yaw, pitch + weapon.zero_angle()) * stats.muzzle_velocity,
        }
    }

    /// One step of flight: gravity and drag, taken as constant across the
    /// step at their values where it starts. Over a tick the drag changes by
    /// a percent or two, which moves a round by millimetres.
    pub fn step(&mut self, drag: f32, dt: f32) {
        let speed = self.velocity.length();
        let acceleration = Vec3::new(0.0, -BULLET_GRAVITY, 0.0) - self.velocity * (drag * speed);
        self.position += self.velocity * dt + acceleration * (0.5 * dt * dt);
        self.velocity += acceleration * dt;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Flies a round level-launched-plus-zero along -Z and reports, at each
    /// asked distance, the height relative to the line of sight and the time.
    fn flight(weapon: Weapon, distances: &[f32]) -> Vec<(f32, f32)> {
        let stats = weapon.stats();
        let mut round = Round::fired(weapon, Vec3::ZERO, 0.0, 0.0);
        let mut previous = round;
        let mut t = 0.0;
        let mut out = Vec::new();
        for &d in distances {
            while -round.position.z < d {
                previous = round;
                round.step(stats.drag, TICK_DT);
                t += TICK_DT;
            }
            let along = (-d - previous.position.z) / (round.position.z - previous.position.z);
            let height = previous.position.y + (round.position.y - previous.position.y) * along;
            let time = t - TICK_DT * (1.0 - along);
            out.push((height, time));
        }
        out
    }

    #[test]
    fn every_sight_is_dead_on_at_its_zero() {
        for weapon in Weapon::ALL {
            let zero = weapon.stats().zero;
            let (height, _) = flight(weapon, &[zero])[0];
            assert!(
                height.abs() < 0.002,
                "{weapon:?} is {height} m off at its zero of {zero} m"
            );
        }
    }

    #[test]
    fn a_long_shot_drops_and_takes_time_to_arrive() {
        // The figures in the module's table, within a centimetre and a
        // couple of milliseconds: if these move, the table is wrong.
        let rifle = flight(Weapon::Rifle, &[200.0, 300.0]);
        assert!(
            (rifle[0].0 + 0.25).abs() < 0.01,
            "rifle at 200 m: {:?}",
            rifle[0]
        );
        assert!(
            (rifle[1].0 + 0.81).abs() < 0.01,
            "rifle at 300 m: {:?}",
            rifle[1]
        );
        assert!(
            (rifle[1].1 - 0.506).abs() < 0.003,
            "rifle at 300 m: {:?}",
            rifle[1]
        );
        let sniper = flight(Weapon::Sniper, &[300.0]);
        assert!(
            (sniper[0].0 + 0.57).abs() < 0.01,
            "sniper at 300 m: {:?}",
            sniper[0]
        );
        assert!(
            (sniper[0].1 - 0.423).abs() < 0.003,
            "sniper at 300 m: {:?}",
            sniper[0]
        );
        let pistol = flight(Weapon::Pistol, &[100.0]);
        assert!(
            (pistol[0].0 + 0.61).abs() < 0.01,
            "pistol at 100 m: {:?}",
            pistol[0]
        );
    }

    #[test]
    fn a_round_slows_but_never_speeds_up() {
        for weapon in Weapon::ALL {
            let stats = weapon.stats();
            let mut round = Round::fired(weapon, Vec3::ZERO, 0.0, 0.0);
            let mut last = round.velocity.length();
            for _ in 0..64 {
                round.step(stats.drag, TICK_DT);
                let speed = round.velocity.length();
                assert!(speed < last, "{weapon:?} sped up");
                last = speed;
            }
            assert!(
                last > stats.muzzle_velocity * 0.3,
                "{weapon:?} all but stopped in a second"
            );
        }
    }

    #[test]
    fn shots_to_kill_are_the_design() {
        let to_kill = |weapon: Weapon, region: HitRegion, distance: f32| {
            let damage = weapon.damage(region, distance);
            (super::super::MAX_HEALTH + damage - 1) / damage
        };
        // The rifle up close is the rifle as it always was.
        assert_eq!(to_kill(Weapon::Rifle, HitRegion::Head, 10.0), 2);
        assert_eq!(to_kill(Weapon::Rifle, HitRegion::Body, 10.0), 4);
        assert_eq!(to_kill(Weapon::Rifle, HitRegion::Legs, 10.0), 5);
        // And weaker further out.
        assert_eq!(to_kill(Weapon::Rifle, HitRegion::Body, 75.0), 5);
        assert_eq!(to_kill(Weapon::Rifle, HitRegion::Body, 150.0), 6);
        // The only one-shot kill in the game, at any range; never to the body.
        assert_eq!(to_kill(Weapon::Sniper, HitRegion::Head, 5.0), 1);
        assert_eq!(to_kill(Weapon::Sniper, HitRegion::Head, 400.0), 1);
        assert_eq!(to_kill(Weapon::Sniper, HitRegion::Body, 50.0), 2);
        for weapon in [Weapon::Pistol, Weapon::Smg, Weapon::Rifle, Weapon::Lmg] {
            for region in [HitRegion::Head, HitRegion::Body, HitRegion::Legs] {
                for distance in [0.0, 10.0, 25.0, 60.0, 120.0, 300.0] {
                    assert!(
                        to_kill(weapon, region, distance) >= 2,
                        "{weapon:?} kills with one round to the {region:?} at {distance} m"
                    );
                }
            }
        }
        // The SMG is the quickest kill up close and loses it with range.
        let ttk = |weapon: Weapon, distance: f32| {
            (to_kill(weapon, HitRegion::Body, distance) - 1) as u32 * weapon.stats().fire_ticks
        };
        assert!(ttk(Weapon::Smg, 10.0) < ttk(Weapon::Rifle, 10.0));
        assert!(ttk(Weapon::Smg, 40.0) > ttk(Weapon::Rifle, 40.0));
        // The rifle beats the machine gun up close; the machine gun holds
        // its damage furthest.
        assert!(ttk(Weapon::Rifle, 10.0) < ttk(Weapon::Lmg, 10.0));
        assert!(ttk(Weapon::Lmg, 120.0) < ttk(Weapon::Rifle, 120.0));
    }

    #[test]
    fn bands_start_at_zero_and_go_outwards() {
        for weapon in Weapon::ALL {
            let bands = weapon.stats().bands;
            assert_eq!(bands[0].from, 0, "{weapon:?}");
            for pair in bands.windows(2) {
                assert!(pair[0].from < pair[1].from, "{weapon:?}");
                assert!(
                    pair[1].body <= pair[0].body,
                    "{weapon:?} hits harder further out"
                );
            }
            for band in bands {
                assert!(
                    band.head >= band.body && band.body >= band.legs,
                    "{weapon:?}"
                );
            }
        }
    }

    #[test]
    fn a_loadout_is_always_one_the_game_allows() {
        let asked = Loadout {
            primary: Weapon::Pistol,
            optic: Optic::X4,
        };
        assert_eq!(
            asked.sanitized(),
            Loadout {
                primary: Weapon::Rifle,
                optic: Optic::X4
            }
        );
        let smg_x4 = Loadout {
            primary: Weapon::Smg,
            optic: Optic::X4,
        };
        assert_eq!(smg_x4.sanitized().optic, Optic::RedDot);
        let sniper_dot = Loadout {
            primary: Weapon::Sniper,
            optic: Optic::RedDot,
        };
        assert_eq!(sniper_dot.sanitized().optic, Optic::X4);
        for primary in Weapon::PRIMARIES {
            for optic in primary.optics() {
                let fine = Loadout {
                    primary,
                    optic: *optic,
                };
                assert_eq!(fine.sanitized(), fine);
            }
        }
        assert_eq!(Loadout::default().sanitized(), Loadout::default());
    }

    #[test]
    fn a_loadout_reads_from_the_wire_and_fills_in_what_is_missing() {
        let parsed: Loadout = serde_json::from_str(r#"{"primary":"sniper","optic":"x3"}"#).unwrap();
        assert_eq!(
            parsed,
            Loadout {
                primary: Weapon::Sniper,
                optic: Optic::X3
            }
        );
        let empty: Loadout = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, Loadout::default());
        assert!(serde_json::from_str::<Loadout>(r#"{"primary":"railgun"}"#).is_err());
    }

    #[test]
    fn the_ids_are_the_names_on_the_wire() {
        // Records, the menu and the wasm's tables name guns by these; if they
        // drifted from serde's, a loadout sent back would quietly become the
        // rifle.
        for weapon in Weapon::ALL {
            assert_eq!(
                serde_json::to_string(&weapon).unwrap(),
                format!("\"{}\"", weapon.id())
            );
        }
        for optic in Optic::ALL {
            assert_eq!(
                serde_json::to_string(&optic).unwrap(),
                format!("\"{}\"", optic.id())
            );
        }
    }

    #[test]
    fn fire_rates_are_what_the_table_says() {
        // Rounds a minute, from whole ticks.
        let rpm = |weapon: Weapon| 60.0 * TICK_HZ as f32 / weapon.stats().fire_ticks as f32;
        assert_eq!(rpm(Weapon::Rifle), 480.0);
        assert_eq!(rpm(Weapon::Smg), 768.0);
        assert_eq!(Weapon::Lmg.stats().fire_ticks, 7);
        assert_eq!(Weapon::Sniper.stats().fire_ticks, 80);
        assert_eq!(Weapon::Rifle.stats().reload_ticks, 141);
    }
}
