// Analyzer habits that differ from plain ASTM, by LabXpro preset (lims/lib/instrumentPresets.js).
// From the makers' host interface manuals; to be confirmed on each analyzer (raw log).
//
//   testId(code)      how a test is written in our order record
//   orderSample(id)   [O.3, O.4] where the tube ID goes in our order record
//   perTestOrder      one O record per test instead of one O with all tests
//   noOrder           records sent when LabXpro has no tests for the tube
const DEFAULT = {
  testId: (c) => `^^^${c}`,
  orderSample: (id) => [id, ""],
  perTestOrder: false,
  noOrder: () => ["L|1|I"],
};

const QUIRKS = {
  // Sysmex XN / XS: test "^^^^WBC^1", the sample number in O.4 as "^^<number>^B"
  "sysmex-xn": { testId: (c) => `^^^^${c}^1`, orderSample: (id) => ["", `^^${id}^B`] },
  "sysmex-xp": { testId: (c) => `^^^^${c}^1`, orderSample: (id) => ["", `^^${id}^B`] },
  "sysmex-xs": { testId: (c) => `^^^^${c}^1`, orderSample: (id) => ["", `^^${id}^B`] },
  // Snibe Maglumi: one O record per assay; always answer (it waits ~12 s, then drops the line)
  maglumi: { perTestOrder: true, noOrder: () => ["P|1", "L|1|N"] },
};

export const quirksFor = (preset) => ({ ...DEFAULT, ...(QUIRKS[preset] || {}) });
