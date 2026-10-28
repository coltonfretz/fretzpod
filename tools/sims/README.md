# Game simulators

Headless checks for Tiki Golf, Vortex and Space Sheep. They import the real game code from
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
- `node vortex.mjs`: a perfect paddle plays Vortex for 10 game-minutes; it
  should climb levels, catch power-ups and never throw.
- `node sheep.mjs`: Space Sheep, 6 games doing nothing and 6 with a bot that
  plays like a quick human (wheel ticks capped, shots capped). On 2026-10-25:
  idle dies first at 10-20 s, the bot reaches wave 6-11 in 1 to 1.5 minutes,
  enemies almost never fall into the sun on their own. Rerun after changing
  the AI, gravity, speeds or sizes in `spacesheep.js`.

`env.mjs` seeds the randomness (start times, mole order, enemy aim), so
the same code prints the same output every run. That makes a cleanup
checkable: run the sims on the last commit and on the change and diff the
output; anything but the timings differing means behavior changed. For
balance work try a few seeds (`SEED=2 node sheep.mjs`), since one seed is
one set of dice rolls.
