/**
 * Programmatically generated logic-grid puzzles.
 *
 * Every knowledge-based case set saturated (control scored 0.96–1.00 four times
 * over), because the traps were textbook misconceptions a model has memorised.
 * These puzzles are NOVEL BY CONSTRUCTION — generated from a seeded RNG, with
 * the solution and its UNIQUENESS verified by brute force here, so no model can
 * have seen them. Difficulty comes from multi-step deduction, which is exactly
 * where a small model has genuine sample-to-sample variance, and variance is the
 * precondition for selection (max of N) to beat averaging (mean of N).
 *
 * Verification: each puzzle's clue set is checked to admit EXACTLY ONE
 * permutation. A puzzle with 0 or >1 solutions is discarded and regenerated —
 * an ambiguous puzzle would score a correct answer as wrong.
 */
import fs from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "evals", "cases");
const TAGS = ["puzzle", "selection-ab", "generated"];

// Deterministic RNG (mulberry32) so the corpus is reproducible.
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["Ada", "Bruno", "Chen", "Dara", "Eli"];
const HOUSES = ["red", "green", "blue", "amber", "violet"];

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

/**
 * A candidate assignment maps position index -> {name, colour}. We fix names to
 * positions by permutation and colours by permutation, then test clues.
 */
function makePuzzle(seed, n) {
  const rand = rng(seed);
  const names = NAMES.slice(0, n);
  const colours = HOUSES.slice(0, n);

  // Ground truth: a random colour permutation aligned to positions 1..n.
  const truthColours = [...colours];
  for (let i = truthColours.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [truthColours[i], truthColours[j]] = [truthColours[j], truthColours[i]];
  }
  const truthNames = [...names];
  for (let i = truthNames.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [truthNames[i], truthNames[j]] = [truthNames[j], truthNames[i]];
  }
  // truth: position i (0-based) has truthNames[i] living in truthColours[i].

  const posOfName = (nm) => truthNames.indexOf(nm);
  const posOfColour = (c) => truthColours.indexOf(c);

  // Clue generators — each returns {text, test(namesPerm, coloursPerm)}.
  const generators = [
    () => {
      const a = names[Math.floor(rand() * n)];
      const c = truthColours[posOfName(a)];
      return {
        text: `${a} lives in the ${c} house.`,
        test: (np, cp) => cp[np.indexOf(a)] === c,
      };
    },
    () => {
      const a = names[Math.floor(rand() * n)];
      const b = names[Math.floor(rand() * n)];
      if (a === b) return null;
      const left = posOfName(a) < posOfName(b);
      return {
        text: `${a} lives somewhere to the ${left ? "left" : "right"} of ${b}.`,
        test: (np) => (left ? np.indexOf(a) < np.indexOf(b) : np.indexOf(a) > np.indexOf(b)),
      };
    },
    () => {
      const a = names[Math.floor(rand() * n)];
      const p = posOfName(a);
      return {
        text: `${a} lives in house number ${p + 1} (houses are numbered 1 to ${n} from left to right).`,
        test: (np) => np.indexOf(a) === p,
      };
    },
    () => {
      const c = colours[Math.floor(rand() * n)];
      const d = colours[Math.floor(rand() * n)];
      if (c === d) return null;
      const adjacent = Math.abs(posOfColour(c) - posOfColour(d)) === 1;
      if (!adjacent) return null;
      return {
        text: `The ${c} house is directly next to the ${d} house.`,
        test: (np, cp) => Math.abs(cp.indexOf(c) - cp.indexOf(d)) === 1,
      };
    },
    () => {
      const a = names[Math.floor(rand() * n)];
      const c = colours[Math.floor(rand() * n)];
      if (truthColours[posOfName(a)] === c) return null;
      return {
        text: `${a} does NOT live in the ${c} house.`,
        test: (np, cp) => cp[np.indexOf(a)] !== c,
      };
    },
  ];

  const namePerms = permutations(names);
  const colourPerms = permutations(colours);
  const countSolutions = (clues) => {
    let count = 0;
    let sol = null;
    for (const np of namePerms) {
      for (const cp of colourPerms) {
        if (clues.every((cl) => cl.test(np, cp))) {
          count++;
          sol = { np, cp };
          if (count > 1) return { count, sol };
        }
      }
    }
    return { count, sol };
  };

  // Add clues until the solution is unique, then drop redundant ones so the
  // puzzle still REQUIRES deduction rather than reading off the answer.
  const clues = [];
  for (let guard = 0; guard < 400; guard++) {
    const r = countSolutions(clues);
    if (clues.length > 0 && r.count === 1) break;
    const gen = generators[Math.floor(rand() * generators.length)]();
    if (!gen) continue;
    if (clues.some((c) => c.text === gen.text)) continue;
    clues.push(gen);
  }
  if (countSolutions(clues).count !== 1) return null;

  for (let i = clues.length - 1; i >= 0; i--) {
    const trimmed = clues.filter((_, idx) => idx !== i);
    if (trimmed.length && countSolutions(trimmed).count === 1) clues.splice(i, 1);
  }
  if (countSolutions(clues).count !== 1) return null;

  return { names: truthNames, colours: truthColours, clues: clues.map((c) => c.text), n };
}

const puzzles = [];
for (let seed = 1; puzzles.length < 12 && seed < 400; seed++) {
  const n = puzzles.length < 6 ? 4 : 5;
  const p = makePuzzle(seed * 7919, n);
  // Keep only puzzles that need real work: at least n clues.
  if (p && p.clues.length >= n) puzzles.push(p);
}

console.log(`generated ${puzzles.length} puzzles with verified-unique solutions`);

puzzles.forEach((p, i) => {
  const id = `300-puzzle-${String(i + 1).padStart(2, "0")}-${p.n}houses`;
  const message =
    `There are ${p.n} houses in a row, numbered 1 to ${p.n} from left to right. ` +
    `Each house has a different colour (${HOUSES.slice(0, p.n).join(", ")}) and exactly one resident ` +
    `(${NAMES.slice(0, p.n).join(", ")}).\n\nClues:\n` +
    p.clues.map((c, k) => `${k + 1}. ${c}`).join("\n") +
    `\n\nDetermine, for every house number, who lives there and what colour it is. ` +
    `This puzzle has exactly one solution.\n\n` +
    `End your answer with one line per house in EXACTLY this format:\n` +
    `House 1: <name> - <colour>\nHouse 2: <name> - <colour>\n(and so on)`;

  // One constraint per house: the name and colour must both be right, in the
  // requested line format. Tolerant of markdown emphasis and dash variants.
  const assertions = p.names.map((nm, idx) => ({
    type: "matches",
    pattern: `House\\s*${idx + 1}\\s*[:\\-]?\\s*\\**\\s*${nm}\\s*\\**\\s*[-–—:]\\s*\\**\\s*${p.colours[idx]}`,
    flags: "i",
  }));

  const json = {
    id,
    description: `Generated logic-grid puzzle (${p.n} houses, ${p.clues.length} clues, unique solution verified by brute force).`,
    tags: TAGS,
    input: { message, swarmEnabled: true, forceSwarm: true },
    assertions,
  };
  fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify(json, null, 2) + "\n");
  console.log(
    `  ${id}: ${p.clues.length} clues, solution ${p.names.map((nm, k) => `${nm}/${p.colours[k]}`).join(" ")}`
  );
});

// Only the puzzles are in the experiment now.
for (const file of fs.readdirSync(DIR)) {
  if (!file.endsWith(".json") || file.startsWith("300-puzzle")) continue;
  const p = path.join(DIR, file);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!j.tags?.includes("selection-ab")) continue;
  j.tags = j.tags.filter((t) => t !== "selection-ab");
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}
