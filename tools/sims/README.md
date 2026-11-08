# Game simulators

Headless checks for Tiki Golf, Star Pinball and Fishing Trip. They import the real game code from
`app/`, so they always test what is deployed. Run them with Node from this
folder; nothing here is served to phones.

- `COURSE=0|1 node sim.mjs [hole]`: beam search over aim and power for every
  hole (or one), reports the best score found and how many hole-in-one shots
  exist. A hole is fine when the best is at or under par. Run it after any
  change to `golf-holes.js` or the physics in `golf.js`.
- `COURSE=0|1 node check.mjs`: static checks on the hole data (tee, cup and
  gadgets on the green, nothing overlapping).
- `node probe.mjs`: full-power putts at the starting aim on Grand Tour holes
  1, 3, 5, 8 and 9 (the "no thought needed" ace check from 2026-10-24).
- `node pinball.mjs [games]`: Star Pinball on autopilot (flips a moment
  after a ball comes near a flipper, missing a share: MISS=0.25 by default,
  MISS=0 never misses). Watch for `escapes` (a ball outside the table: a gap
  in the walls) and `nudges` (a ball stuck long enough for the ball search),
  both should be 0. On 2026-11-08: MISS=0.25 games last about a minute and
  finish ~2 missions, MISS=0.1 about two minutes and ~4 missions, with
  multiballs. With the ramp (0.14.0) the autopilot, which never aims, rides
  it about once a game. `TABLE=1` and `TABLE=2` play Nebula and Event
  Horizon; `WHERE=1` prints where each stuck ball sat. Rerun after moving
  anything on a table in `pinball.js`.
- `node fishing.mjs [minutes]`: Fishing Trip played by a bot like a person
  (aims at a fish that takes the lure, casts past it, reels slowly, hooks a
  bite after a human reaction time, fights by spinning to keep the tension
  marker in the green at a thumb's speed). `SPOT=0|1|2`,
  `LURE=worm|spinner|frog|jig`, `SKILL=0.5` for a slower, sloppier player,
  `SPAM=1` for one who just spins forward through every fight, `FAST=1`
  for one who reels the lure in fast (should get no bites). On
  2026-11-08: the careful bot lands 2 to 3 fish a minute and loses none,
  SKILL=0.5 about 2 a minute and loses the odd one to slack, SPAM=1 snaps
  the line every time. With the drifting green (0.16.1) SKILL=0.5 loses
  about a third of river and sea fish; FAST=1 gets no bites. Fights
  average 12 to 25 s. Points a minute (about
  150 to 300 at the pond and river, 450 to 800 at the sea) are what the
  unlock points are set against. Rerun after changing the fight, the fish
  or the unlock points in `fishing.js`.

`env.mjs` seeds the randomness (start times, mole order, which fish swim in), so
the same code prints the same output every run. That makes a cleanup
checkable: run the sims on the last commit and on the change and diff the
output; anything but the timings differing means behavior changed. For
balance work try a few seeds (`SEED=2 node fishing.mjs`), since one seed is
one set of dice rolls.
