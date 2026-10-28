// Tiki Golf courses. Each hole lives in a 400 x 300 world (x right, y down),
// drawn top-down and scaled to the screen.
//
//   greens   closed polygons [x,y, x,y, ...]; bamboo runs along every edge, so
//            the ball can never leave them (only end up somewhere worse)
//   walls    extra bamboo inside the greens [x1,y1,x2,y2]
//   sand     slows the ball a lot; water costs a stroke and puts the ball
//            back where it was hit from
//   bumpers  pool-table bumpers {x,y,r}: hit one and it shoves the ball away
//   doors    {a, b, period, phase}: a bamboo gate hinged at a that opens and
//            closes on a timer (phase 0..1 staggers gates)
//   tubes    {from, to, dir}: roll into from, pop out at to heading dir
//            (degrees, 0 = right, 90 = down). Some help, some don't.
//   moles    {x, y, throws, speed, grab}: roll into the hole and the mole
//            throws the ball out, taking turns through its directions; it only
//            catches balls slower than grab (default 300), so a hard putt
//            rolls over unless grab is raised
//   cranes   {pad:[x,y,w,h], drop:[x,y,w,h]}: stop inside the pad and the
//            crane carries the ball to the same spot in the drop box. The cup
//            sits in the drop box, so the right spot in the pad is a hole in one.
//
// Grand Tour (course 2) adds:
//   slopes   {poly, g:[x,y]}: tilted ground; g is the pull in units/s² (it
//            points downhill). Steeper than the green's grip (about 110) and
//            the ball can't rest there.
//   rocks    {x, y, r, look}: solid round things that don't shove (lighthouse,
//            baobab, stone, mast, rock)
//   boxes    [x, y, w, h]: solid crates
//   movers   {w, h, from, to, period, phase, look}: something (a bus) gliding
//            back and forth between from and to (its center); it knocks the
//            ball with its own speed
//   bumpers  may be {wood: true}: a softer wooden bumper
//   tubes    may be {look: 'tunnel'}
//   scene    'sea' or 'city' instead of jungle; surface 'asphalt' for streets
//   raised, bridges, falls: drawing only (a raised green, plank bridges, a
//            waterfall)
//
// Original holes, inspired by the tiki minigolf in the PS2 game Madagascar
// (2005). No art or layouts copied.

export const COURSES = [
  {
    id: 'island',
    name: 'Tiki Island',
    holes: [
      {
        name: 'Welcome Ashore',
        par: 2,
        tee: [85, 150],
        cup: [315, 150],
        greens: [[50, 110, 350, 110, 350, 190, 50, 190]],
      },
      {
        name: 'Bamboo Bend',
        par: 3,
        tee: [75, 220],
        cup: [305, 90],
        greens: [[40, 180, 250, 180, 250, 50, 360, 50, 360, 260, 40, 260]],
        sand: [[300, 212, 360, 212, 360, 260, 300, 260]],
      },
      {
        name: 'Pool Party',
        par: 3,
        tee: [85, 150],
        cup: [315, 150],
        greens: [[50, 60, 350, 60, 350, 240, 50, 240]],
        bumpers: [
          { x: 190, y: 105, r: 11 }, { x: 190, y: 195, r: 11 }, { x: 235, y: 150, r: 13 },
          { x: 280, y: 95, r: 9 }, { x: 280, y: 205, r: 9 },
        ],
      },
      {
        name: 'Tiki Gates',
        par: 3,
        tee: [70, 150],
        cup: [330, 150],
        greens: [[40, 110, 360, 110, 360, 190, 40, 190]],
        doors: [
          { a: [160, 110], b: [160, 190], period: 3.2, phase: 0 },
          { a: [260, 190], b: [260, 110], period: 3.2, phase: 0.5 },
        ],
      },
      {
        name: 'Lagoon Tubes',
        par: 3,
        tee: [70, 150],
        cup: [330, 105],
        greens: [[40, 60, 360, 60, 360, 240, 40, 240]],
        water: [[175, 60, 225, 60, 225, 240, 175, 240]],
        sand: [[290, 200, 360, 200, 360, 240, 290, 240]],
        tubes: [
          { from: [150, 90], to: [245, 95], dir: 0 },
          { from: [150, 210], to: [245, 205], dir: 20 },
        ],
      },
      {
        name: 'Mole Meadow',
        par: 3,
        tee: [110, 90],
        cup: [290, 90],
        greens: [[50, 50, 350, 50, 350, 250, 50, 250]],
        walls: [[200, 50, 200, 185]],
        moles: [
          { x: 125, y: 215, throws: [0, -30], speed: 240 },
          { x: 275, y: 220, throws: [-90, 200], speed: 230 },
          { x: 310, y: 160, throws: [-120], speed: 150 },
        ],
      },
      {
        name: 'Crane Lift',
        par: 3,
        tee: [70, 210],
        cup: [300, 95],
        greens: [[40, 160, 210, 160, 210, 260, 40, 260], [230, 40, 360, 40, 360, 150, 230, 150]],
        sand: [[100, 235, 140, 235, 140, 260, 100, 260]],
        cranes: [{ pad: [145, 180, 50, 60], drop: [235, 45, 120, 100] }],
      },
      {
        name: 'Torch Gauntlet',
        par: 4,
        tee: [70, 75],
        cup: [325, 228],
        greens: [[40, 40, 360, 40, 360, 260, 40, 260]],
        walls: [[40, 110, 295, 110], [105, 190, 360, 190]],
        doors: [{ a: [200, 110], b: [200, 190], period: 3.6, phase: 0.25 }],
        bumpers: [{ x: 335, y: 150, r: 10 }],
        sand: [[40, 215, 95, 215, 95, 260, 40, 260]],
      },
      {
        name: 'Volcano Drop',
        par: 4,
        tee: [70, 70],
        cup: [317, 140],
        greens: [[40, 40, 250, 40, 250, 260, 40, 260], [275, 70, 360, 70, 360, 210, 275, 210]],
        water: [[95, 120, 165, 120, 165, 175, 95, 175]],
        moles: [{ x: 110, y: 225, throws: [0, -20], speed: 220 }],
        tubes: [{ from: [225, 65], to: [65, 235], dir: -45 }],
        cranes: [{ pad: [190, 195, 50, 50], drop: [280, 75, 75, 130] }],
        volcano: 1,   // index of the green drawn as the volcano's rocky top
      },
    ],
  },
  {
    // Themes from the original's nine holes (Zoo, Beacon, Mole Holes,
    // Manhattan, Hills, Ship, Waterfall, Baobabs, Tsingy), from descriptions
    // of them. Layouts and art are new.
    id: 'tour',
    name: 'Grand Tour',
    holes: [
      {
        name: 'Zoo Break',
        par: 3,
        tee: [70, 80],
        cup: [110, 225],
        greens: [[40, 40, 360, 40, 360, 120, 40, 120], [40, 180, 360, 180, 360, 270, 40, 270]],
        water: [[180, 40, 220, 40, 220, 68, 180, 68], [180, 92, 220, 92, 220, 120, 180, 120]],
        bridges: [[180, 68, 40, 24]],
        tubes: [{ from: [345, 80], to: [345, 215], dir: 180, look: 'tunnel' }],
        slopes: [
          { poly: [290, 180, 360, 180, 360, 270, 290, 270], g: [-60, 0] },
          // Side hill across the lower green (a smaller one didn't
          // register in play). Downhill is toward the bottom bamboo; aim high.
          { poly: [130, 180, 290, 180, 290, 270, 130, 270], g: [0, 75] },
        ],
      },
      {
        name: 'Lighthouse',
        par: 3,
        scene: 'sea',
        tee: [85, 150],
        cup: [315, 150],
        greens: [[100, 50, 300, 50, 350, 100, 350, 200, 300, 250, 100, 250, 50, 200, 50, 100]],
        rocks: [
          { x: 200, y: 150, r: 30, look: 'lighthouse' },
          { x: 200, y: 72, r: 8, look: 'rock' }, { x: 200, y: 228, r: 8, look: 'rock' },
        ],
      },
      {
        name: 'Mole Hills',
        par: 3,
        tee: [80, 220],
        cup: [320, 80],
        greens: [[50, 50, 350, 50, 350, 250, 50, 250]],
        slopes: [
          { poly: [100, 80, 170, 80, 170, 140, 100, 140], g: [0, -55] },
          { poly: [220, 160, 300, 160, 300, 230, 220, 230], g: [45, 0] },
        ],
        moles: [
          // Sits on the straight line from the tee and grabs even a full-power putt
          // (one used to sail past every mole); throws back toward the start.
          { x: 200, y: 150, throws: [180, 90], speed: 230, grab: 999 },
          { x: 245, y: 112, throws: [0, 180], speed: 200 },
          { x: 300, y: 205, throws: [-90], speed: 210 },
        ],
      },
      {
        name: 'Rush Hour',
        par: 3,
        scene: 'city',
        surface: 'asphalt',
        tee: [70, 150],
        cup: [330, 150],
        greens: [[40, 70, 360, 70, 360, 230, 40, 230]],
        movers: [
          { look: 'bus', w: 24, h: 46, from: [150, 97], to: [150, 203], period: 4, phase: 0 },
          { look: 'bus', w: 24, h: 46, from: [250, 203], to: [250, 97], period: 3.4, phase: 0.3 },
        ],
      },
      {
        name: 'Rolling Hills',
        par: 3,
        tee: [70, 150],
        cup: [330, 128],
        greens: [[40, 90, 360, 90, 360, 210, 40, 210]],
        // The ridges also lean toward the bottom bamboo, so a straight putt
        // curls away (2026-10-24: it used to be a straight-line ace).
        slopes: [
          { poly: [110, 90, 150, 90, 150, 210, 110, 210], g: [-90, 60] },
          { poly: [150, 90, 190, 90, 190, 210, 150, 210], g: [90, 60] },
          { poly: [210, 90, 250, 90, 250, 210, 210, 210], g: [-90, 60] },
          { poly: [250, 90, 290, 90, 290, 210, 250, 210], g: [90, 60] },
        ],
      },
      {
        name: 'All Aboard',
        par: 4,
        scene: 'sea',
        tee: [75, 150],
        cup: [353, 92],
        greens: [[40, 150, 85, 95, 285, 95, 305, 150, 285, 205, 85, 205], [322, 45, 385, 45, 385, 140, 322, 140]],
        rocks: [{ x: 140, y: 150, r: 7, look: 'mast' }, { x: 205, y: 150, r: 7, look: 'mast' }],
        boxes: [[160, 108, 20, 16], [172, 178, 22, 16]],
        cranes: [{ pad: [232, 125, 40, 50], drop: [327, 50, 52, 84] }],
        ship: 0,    // the green drawn as a deck
      },
      {
        name: 'Waterfall',
        par: 4,
        tee: [70, 215],
        cup: [300, 75],
        greens: [[40, 170, 230, 170, 230, 40, 360, 40, 360, 260, 40, 260]],
        raised: [[230, 40, 360, 40, 360, 120, 230, 120]],
        slopes: [{ poly: [230, 120, 360, 120, 360, 170, 230, 170], g: [0, 150] }],
        water: [[110, 205, 170, 205, 170, 260, 110, 260]],
        falls: [[112, 110, 56, 98]],
      },
      {
        name: 'Baobab Grove',
        par: 3,
        tee: [80, 220],
        cup: [310, 80],
        greens: [[50, 50, 350, 50, 350, 250, 50, 250]],
        rocks: [
          { x: 195, y: 150, r: 16, look: 'baobab' }, { x: 230, y: 95, r: 14, look: 'baobab' },
          { x: 255, y: 200, r: 18, look: 'baobab' },
        ],
        bumpers: [{ x: 190, y: 228, r: 8, wood: true }, { x: 302, y: 135, r: 7, wood: true }],
        slopes: [
          { poly: [170, 172, 220, 172, 220, 195, 170, 195], g: [0, 40] },
          { poly: [212, 112, 248, 112, 248, 132, 212, 132], g: [0, 40] },
        ],
      },
      {
        name: 'Stone Forest',
        par: 5,
        tee: [70, 68],
        cup: [330, 240],
        greens: [[40, 40, 360, 40, 360, 260, 40, 260]],
        walls: [[40, 95, 290, 95], [110, 160, 360, 160], [40, 220, 290, 220]],
        bumpers: [{ x: 346, y: 56, r: 8, wood: true }, { x: 54, y: 112, r: 8, wood: true }, { x: 346, y: 176, r: 8, wood: true }],
        rocks: [
          { x: 200, y: 52, r: 7, look: 'stone' }, { x: 190, y: 147, r: 7, look: 'stone' },
          { x: 230, y: 208, r: 7, look: 'stone' },
        ],
      },
    ],
  },
];

// A course opens once the one before it was finished at par or better.
export const coursePar = (c) => c.holes.reduce((a, h) => a + h.par, 0);
