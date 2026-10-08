//! A recording of every match, for the person deciding a review.
//!
//! The anti-cheat's lines say a record is unlikely; they cannot say why.
//! A reviewer holding a player's withdrawals needs to *see* the match: who
//! was where, where each of them was looking, and what they shot at. So the
//! lobby records each match as it is played - every body's position, aim and
//! health a few times a second, and every shot, kill and explosion the match
//! was told about - and the recording is written when the match ends.
//!
//! It is what the server already knew, sampled. Nothing is reported by a
//! client, and nothing here decides anything: it is evidence for a person.
//!
//! # The format
//!
//! JSON, as compact as JSON gets: integers only, in decimetres and
//! hundredths of a radian, with times in ticks from the first sample. One
//! match of twenty players over five minutes is a megabyte or so of text,
//! which Postgres compresses on its own when it stores it (TOAST), and the
//! admin view decodes it in the browser. A version number goes first, so the
//! viewer can refuse a recording it does not understand.

use serde_json::{Value, json};
use solatel_protocol::{
    glam::Vec3,
    ids::{MatchId, PlayerId},
    net::{DeathCause, ServerMsg},
};
use std::collections::HashMap;

/// Ticks between samples: eight a second at sixty-four ticks a second, which
/// is enough to see somebody track a target and a fraction of the cost of
/// every tick.
pub const EVERY_TICKS: u32 = 8;

/// Which version of the format below this writes.
pub const VERSION: u32 = 1;

/// Decimetres, as an integer.
fn dm(v: f32) -> i32 {
    (v * 10.0).round() as i32
}

/// Hundredths of a radian, as an integer.
fn crad(v: f32) -> i32 {
    (v * 100.0).round() as i32
}

fn cause_code(cause: DeathCause) -> i32 {
    match cause {
        DeathCause::Rifle => 0,
        DeathCause::Grenade => 1,
        DeathCause::Zone => 2,
        DeathCause::Fall => 3,
        DeathCause::Pistol => 4,
        DeathCause::Smg => 5,
        DeathCause::Lmg => 6,
        DeathCause::Sniper => 7,
    }
}

/// One body at one moment, as the lobby hands it over.
pub struct Pose {
    pub id: PlayerId,
    pub position: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub health: i16,
}

/// A match being recorded.
#[derive(Default)]
pub struct Recorder {
    /// The tick of the first sample; every time is counted from it.
    first: Option<u32>,
    /// Each player's place in `players`, which is how the frames name them.
    index: HashMap<PlayerId, i32>,
    players: Vec<PlayerId>,
    /// One per sample: the tick, then seven numbers per living body -
    /// player, x, y, z, yaw, pitch, health.
    frames: Vec<Vec<i32>>,
    /// tick, shooter, from x y z, to x y z, whether it hit a player. The
    /// tick is when it was fired, and the shot is kept when it lands.
    shots: Vec<[i32; 9]>,
    /// Rounds fired and not yet landed, by the match's number for the shot:
    /// when, by whom, and from where.
    flying: HashMap<u32, (i32, i32, Vec3)>,
    /// tick, killer (-1 for nobody), victim, cause, headshot.
    kills: Vec<[i32; 5]>,
    /// tick, thrower, x y z.
    blasts: Vec<[i32; 5]>,
    /// Names as they were when the match formed. Taken then because by the
    /// time it ends some of the players will have left, and a recording of
    /// "a ghost" shooting "a ghost" helps nobody decide anything.
    names: HashMap<PlayerId, String>,
}

impl Recorder {
    fn who(&mut self, id: PlayerId) -> i32 {
        if let Some(i) = self.index.get(&id) {
            return *i;
        }
        let i = self.players.len() as i32;
        self.players.push(id);
        self.index.insert(id, i);
        i
    }

    fn at(&mut self, tick: u32) -> i32 {
        let first = *self.first.get_or_insert(tick);
        tick.wrapping_sub(first) as i32
    }

    /// A player in this match, by the name they had when it formed.
    /// The name `id` was introduced under, if they were.
    pub fn name_of(&self, id: PlayerId) -> Option<&str> {
        self.names.get(&id).map(String::as_str)
    }

    pub fn introduce(&mut self, id: PlayerId, name: String) {
        self.who(id);
        self.names.insert(id, name);
    }

    /// Whether `tick` is one a sample is taken on.
    pub fn due(tick: u32) -> bool {
        tick.is_multiple_of(EVERY_TICKS)
    }

    /// Everybody still standing, at `tick`.
    pub fn sample(&mut self, tick: u32, poses: impl IntoIterator<Item = Pose>) {
        let t = self.at(tick);
        let mut frame = vec![t];
        for pose in poses {
            let who = self.who(pose.id);
            frame.extend([
                who,
                dm(pose.position.x),
                dm(pose.position.y),
                dm(pose.position.z),
                crad(pose.yaw),
                crad(pose.pitch),
                i32::from(pose.health),
            ]);
        }
        self.frames.push(frame);
    }

    /// Something the match was told. Shots, kills and explosions are kept;
    /// everything else is either in the samples already or not evidence.
    pub fn heard(&mut self, tick: u32, msg: &ServerMsg) {
        match msg {
            ServerMsg::ShotFired {
                shooter,
                shot,
                from,
                landed,
                ..
            } => {
                let t = self.at(tick);
                let who = self.who(*shooter);
                match landed {
                    Some(landing) => self.shot(t, who, *from, landing.at, landing.hit_player),
                    None => {
                        self.flying.insert(*shot, (t, who, *from));
                    }
                }
            }
            ServerMsg::ShotLanded { shot, landing, .. } => {
                if let Some((t, who, from)) = self.flying.remove(shot) {
                    self.shot(t, who, from, landing.at, landing.hit_player);
                }
            }
            ServerMsg::Killed {
                victim,
                killer,
                headshot,
                cause,
                ..
            } => {
                let t = self.at(tick);
                let killer = killer.map(|k| self.who(k)).unwrap_or(-1);
                let victim = self.who(*victim);
                self.kills
                    .push([t, killer, victim, cause_code(*cause), i32::from(*headshot)]);
            }
            ServerMsg::Exploded { at, thrower, .. } => {
                let t = self.at(tick);
                let who = self.who(*thrower);
                self.blasts.push([t, who, dm(at.x), dm(at.y), dm(at.z)]);
            }
            _ => {}
        }
    }

    fn shot(&mut self, t: i32, who: i32, from: Vec3, to: Vec3, hit_player: bool) {
        self.shots.push([
            t,
            who,
            dm(from.x),
            dm(from.y),
            dm(from.z),
            dm(to.x),
            dm(to.y),
            dm(to.z),
            i32::from(hit_player),
        ]);
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    /// The recording, finished, with each player's name as the match knew
    /// it. `names` is asked once per player.
    pub fn finish(self, map: &str, mut names: impl FnMut(PlayerId) -> String) -> Value {
        let players: Vec<Value> = self
            .players
            .iter()
            .map(|id| {
                let name = self.names.get(id).cloned().unwrap_or_else(|| names(*id));
                json!({ "id": id.as_uuid(), "name": name })
            })
            .collect();
        json!({
            "v": VERSION,
            "map": map,
            "tick_hz": solatel_protocol::TICK_HZ,
            "every": EVERY_TICKS,
            "players": players,
            "frames": self.frames,
            "shots": self.shots,
            "kills": self.kills,
            "blasts": self.blasts,
        })
    }
}

/// A finished recording, on its way to the database.
pub struct Replay {
    pub match_id: MatchId,
    pub map: &'static str,
    pub data: Value,
}

/// A plan of a map from above, for drawing a replay over: every brush that
/// stands between a standing player's knees and eyes, as a rectangle in
/// decimetres. Ground, ceilings and anything a player walks under are left
/// out - they are not what stops a shot.
pub fn plan(map: &solatel_protocol::sim::map::Map) -> Value {
    let walls: Vec<[i32; 4]> = map
        .brushes
        .iter()
        .filter(|b| b.min.y < 1.6 && b.max.y > 0.6)
        .map(|b| [dm(b.min.x), dm(b.min.z), dm(b.max.x), dm(b.max.z)])
        .collect();
    json!({
        "map": map.name,
        "half_x": dm(map.half_x),
        "half_z": dm(map.half_z),
        "walls": walls,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recording_says_who_was_where_and_what_they_did() {
        let a = PlayerId::new();
        let b = PlayerId::new();
        let mut r = Recorder::default();
        r.sample(
            800,
            [
                Pose {
                    id: a,
                    position: Vec3::new(1.25, 0.9, -3.0),
                    yaw: 1.5,
                    pitch: -0.1,
                    health: 100,
                },
                Pose {
                    id: b,
                    position: Vec3::new(10.0, 0.9, 4.0),
                    yaw: -3.0,
                    pitch: 0.0,
                    health: 70,
                },
            ],
        );
        r.heard(
            805,
            &ServerMsg::ShotFired {
                shooter: a,
                shot: 1,
                weapon: solatel_protocol::sim::weapon::Weapon::Rifle,
                from: Vec3::new(1.0, 1.7, -3.0),
                velocity: Vec3::new(910.0, 0.0, 0.0),
                landed: Some(solatel_protocol::net::Landing {
                    at: Vec3::new(10.0, 1.2, 4.0),
                    hit_player: true,
                    struck: true,
                }),
            },
        );
        // A long one: fired now, kept when it lands, at the time it was
        // fired.
        r.heard(
            805,
            &ServerMsg::ShotFired {
                shooter: b,
                shot: 2,
                weapon: solatel_protocol::sim::weapon::Weapon::Sniper,
                from: Vec3::new(10.0, 1.7, 4.0),
                velocity: Vec3::new(-790.0, 0.0, 0.0),
                landed: None,
            },
        );
        r.heard(
            830,
            &ServerMsg::ShotLanded {
                shooter: b,
                shot: 2,
                landing: solatel_protocol::net::Landing {
                    at: Vec3::new(-200.0, 1.0, 4.0),
                    hit_player: false,
                    struck: true,
                },
            },
        );
        r.heard(
            806,
            &ServerMsg::Killed {
                victim: b,
                victim_name: "B".into(),
                killer: Some(a),
                killer_name: Some("A".into()),
                headshot: true,
                cause: DeathCause::Rifle,
            },
        );
        let names = HashMap::from([(a, "A".to_string()), (b, "B".to_string())]);
        let out = r.finish("arena", |id| names[&id].clone());

        assert_eq!(out["v"], VERSION);
        assert_eq!(out["players"][0]["name"], "A");
        // Times from the first sample, positions in decimetres, angles in
        // hundredths of a radian.
        assert_eq!(
            out["frames"][0],
            json!([0, 0, 13, 9, -30, 150, -10, 100, 1, 100, 9, 40, -300, 0, 70])
        );
        assert_eq!(out["shots"][0], json!([5, 0, 10, 17, -30, 100, 12, 40, 1]));
        assert_eq!(out["shots"][1], json!([5, 1, 100, 17, 40, -2000, 10, 40, 0]));
        assert_eq!(out["kills"][0], json!([6, 0, 1, 0, 1]));
    }

    #[test]
    fn a_plan_has_the_walls_and_not_the_floor() {
        let map = solatel_protocol::sim::map::by_name("arena").unwrap();
        let plan = plan(map);
        let walls = plan["walls"].as_array().unwrap();
        assert!(!walls.is_empty());
        assert!(
            walls.len() < map.brushes.len(),
            "the floor and the roofs are not walls"
        );
    }
}
