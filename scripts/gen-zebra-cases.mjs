#!/usr/bin/env node
/**
 * Generated 3-attribute logic-grid ("zebra") puzzles.
 *
 * The 2-attribute puzzles from `gen-puzzle-cases.mjs` were solved 36/36 by a
 * single free agent — no variance, so nothing to measure. These add a third
 * attribute, which raises the deduction depth sharply while keeping brute-force
 * verification cheap (5!^3 = 1.7M assignments).
 *
 * Purpose: produce a regime where the model is sometimes RIGHT and sometimes
 * WRONG. Variance is the precondition for the question being asked —
 * "does disagreement among proposer drafts predict an incorrect answer?" —
 * because with no errors there is nothing for a disagreement signal to predict.
 *
 * Every puzzle's clue set is verified to admit EXACTLY ONE solution; ambiguous
 * or over-constrained candidates are discarded, so a correct answer can never be
 * scored wrong and no clue set gives the answer away without deduction.
 */
import fs from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "evals", "cases");
const TAGS = ["puzzle", "zebra", "disagreement-ab", "generated"];
const COUNT = Number(process.env.ZEBRA_COUNT ?? 14);
const N = Number(process.env.ZEBRA_HOUSES ?? 5);

const ATTRS = {
  name: ["Ada", "Bruno", "Chen", "Dara", "Eli", "Fay"],
  colour: ["red", "green", "blue", "amber", "violet", "teal"],
  drink: ["tea", "coffee", "milk", "juice", "water", "cider"],
};

function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

function shuffled(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function build(seed, n) {
  const rand = rng(seed);
  const names = ATTRS.name.slice(0, n);
  const colours = ATTRS.colour.slice(0, n);
  const drinks = ATTRS.drink.slice(0, n);

  // Ground truth: position i holds truth.name[i] / truth.colour[i] / truth.drink[i].
  const truth = {
    name: shuffled(names, rand),
    colour: shuffled(colours, rand),
    drink: shuffled(drinks, rand),
  };
  const posOf = (kind, value) => truth[kind].indexOf(value);

  // Clue templates. Each yields {text, test(cand)} where cand is {name,colour,drink}
  // arrays indexed by position.
  const templates = [
    // Direct link between two attributes of the same resident.
    (rand) => {
      const kinds = shuffled(["name", "colour", "drink"], rand).slice(0, 2);
      const [ka, kb] = kinds;
      const pos = Math.floor(rand() * n);
      const a = truth[ka][pos];
      const b = truth[kb][pos];
      return {
        text: `${phrase(ka, a)} ${linkVerb(ka, kb)} ${phrase(kb, b)}.`,
        test: (c) => c[ka].indexOf(a) === c[kb].indexOf(b),
      };
    },
    // Negative link — the pressure test: it removes a possibility without giving one.
    (rand) => {
      const kinds = shuffled(["name", "colour", "drink"], rand).slice(0, 2);
      const [ka, kb] = kinds;
      const a = truth[ka][Math.floor(rand() * n)];
      const b = truth[kb][Math.floor(rand() * n)];
      if (posOf(ka, a) === posOf(kb, b)) return null;
      return {
        text: `${phrase(ka, a)} ${linkVerb(ka, kb)} NOT ${phrase(kb, b)}.`,
        test: (c) => c[ka].indexOf(a) !== c[kb].indexOf(b),
      };
    },
    // Absolute position.
    (rand) => {
      const kind = shuffled(["name", "colour", "drink"], rand)[0];
      const v = truth[kind][Math.floor(rand() * n)];
      const p = posOf(kind, v);
      return {
        text: `${phrase(kind, v)} is in house ${p + 1}.`,
        test: (c) => c[kind].indexOf(v) === p,
      };
    },
    // Relative order.
    (rand) => {
      const ka = shuffled(["name", "colour", "drink"], rand)[0];
      const kb = shuffled(["name", "colour", "drink"], rand)[0];
      const a = truth[ka][Math.floor(rand() * n)];
      const b = truth[kb][Math.floor(rand() * n)];
      if (posOf(ka, a) === posOf(kb, b)) return null;
      const left = posOf(ka, a) < posOf(kb, b);
      return {
        text: `${phrase(ka, a)} is somewhere to the ${left ? "left" : "right"} of ${phrase(kb, b)}.`,
        test: (c) =>
          left ? c[ka].indexOf(a) < c[kb].indexOf(b) : c[ka].indexOf(a) > c[kb].indexOf(b),
      };
    },
    // Adjacency (unordered) — a classic source of branching.
    (rand) => {
      const ka = shuffled(["name", "colour", "drink"], rand)[0];
      const kb = shuffled(["name", "colour", "drink"], rand)[0];
      const a = truth[ka][Math.floor(rand() * n)];
      const b = truth[kb][Math.floor(rand() * n)];
      if (Math.abs(posOf(ka, a) - posOf(kb, b)) !== 1) return null;
      return {
        text: `${phrase(ka, a)} is directly next to ${phrase(kb, b)}.`,
        test: (c) => Math.abs(c[ka].indexOf(a) - c[kb].indexOf(b)) === 1,
      };
    },
  ];

  function phrase(kind, v) {
    if (kind === "name") return v;
    if (kind === "colour") return `the ${v} house`;
    return `the ${v} drinker`;
  }
  function linkVerb(ka, kb) {
    if (ka === "name" && kb === "colour") return "lives in";
    if (ka === "name" && kb === "drink") return "drinks";
    if (ka === "colour" && kb === "name") return "is home to";
    if (ka === "colour" && kb === "drink") return "belongs to";
    if (ka === "drink" && kb === "name") return "is drunk by";
    return "is in";
  }

  const namePerms = permutations(names);
  const colourPerms = permutations(colours);
  const drinkPerms = permutations(drinks);

  const countSolutions = (clues, cap = 2) => {
    let count = 0;
    for (const np of namePerms) {
      for (const cp of colourPerms) {
        // Prune on clues that only involve name+colour before the inner loop.
        for (const dp of drinkPerms) {
          const cand = { name: np, colour: cp, drink: dp };
          if (clues.every((cl) => cl.test(cand))) {
            count++;
            if (count >= cap) return count;
          }
        }
      }
    }
    return count;
  };

  const clues = [];
  for (let guard = 0; guard < 300; guard++) {
    if (clues.length >= 4 && countSolutions(clues) === 1) break;
    const t = templates[Math.floor(rand() * templates.length)](rand);
    if (!t || clues.some((c) => c.text === t.text)) continue;
    clues.push(t);
  }
  if (countSolutions(clues) !== 1) return null;

  // Drop redundant clues so the puzzle needs deduction, not transcription.
  for (let i = clues.length - 1; i >= 0; i--) {
    const trimmed = clues.filter((_, k) => k !== i);
    if (trimmed.length >= 4 && countSolutions(trimmed) === 1) clues.splice(i, 1);
  }
  if (countSolutions(clues) !== 1) return null;

  return { truth, clues: clues.map((c) => c.text), n };
}

const puzzles = [];
for (let seed = 1; puzzles.length < COUNT && seed < 600; seed++) {
  const p = build(seed * 104729, N);
  if (p) puzzles.push(p);
}
console.log(`generated ${puzzles.length} zebra puzzles (${N} houses, 3 attributes, unique solutions verified)`);

puzzles.forEach((p, i) => {
  const id = `400-zebra-${String(i + 1).padStart(2, "0")}`;
  const names = ATTRS.name.slice(0, p.n);
  const colours = ATTRS.colour.slice(0, p.n);
  const drinks = ATTRS.drink.slice(0, p.n);
  const message =
    `${p.n} houses stand in a row, numbered 1 to ${p.n} from left to right.\n` +
    `Each house has a different colour (${colours.join(", ")}), one resident ` +
    `(${names.join(", ")}), and each resident drinks a different beverage (${drinks.join(", ")}).\n\n` +
    `Clues:\n${p.clues.map((c, k) => `${k + 1}. ${c}`).join("\n")}\n\n` +
    `This puzzle has exactly one solution. Work out who lives in each house, its colour, and their drink.\n\n` +
    `End your answer with one line per house in EXACTLY this format:\n` +
    `House 1: <name> - <colour> - <drink>\nHouse 2: <name> - <colour> - <drink>\n(and so on)`;

  const assertions = p.truth.name.map((nm, idx) => ({
    type: "matches",
    pattern:
      `House\\s*${idx + 1}\\s*[:\\-]?\\s*\\**\\s*${nm}\\s*\\**\\s*[-–—:]\\s*\\**\\s*` +
      `${p.truth.colour[idx]}\\s*\\**\\s*[-–—:]\\s*\\**\\s*${p.truth.drink[idx]}`,
    flags: "i",
  }));

  fs.writeFileSync(
    path.join(DIR, `${id}.json`),
    JSON.stringify(
      {
        id,
        description: `Generated zebra puzzle (${p.n} houses × 3 attributes, ${p.clues.length} clues, unique solution verified by brute force).`,
        tags: TAGS,
        input: { message, swarmEnabled: true, forceSwarm: true },
        assertions,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`  ${id}: ${p.clues.length} clues`);
});

// Only the zebra set carries the disagreement-experiment tag.
for (const file of fs.readdirSync(DIR)) {
  if (!file.endsWith(".json") || file.startsWith("400-zebra")) continue;
  const p = path.join(DIR, file);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!j.tags?.includes("disagreement-ab")) continue;
  j.tags = j.tags.filter((t) => t !== "disagreement-ab");
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}
