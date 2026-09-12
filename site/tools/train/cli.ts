/**
 * cli.ts — train a coefficient table from a corpus file.
 *
 *   npm run train -- --corpus corpus.jsonl --out model.json [--ship]
 *
 * which is `vite-node tools/train/cli.ts`. Run through vite-node rather than plain `node` because
 * this imports from `src/`, whose modules use extensionless specifiers: Node's type stripping
 * resolves `./rules` to nothing, while vite's resolver handles it. vite-node is already in
 * node_modules as a vitest dependency, so there is nothing new to install.
 *
 * This file holds only argument parsing and I/O. Everything testable — the gates, the report, the
 * path guard, the dataset reader — lives in `train.ts` and `dataset.ts`, so importing this module is
 * never required to test the pipeline and `main()` cannot run as a side effect of a test.
 *
 * ---------------------------------------------------------------------------
 * THE --ship FLAG
 * ---------------------------------------------------------------------------
 * The trainer writes wherever `--out` says, except that writing into the served data directory
 * requires `--ship`. Without it the run produces a table and a report, and stops.
 *
 * That is not ceremony. The moment a `model.json` exists in `public/data/`, the deployed app fetches
 * it, Tier 1 becomes available, and probabilities appear on screen badged as predictions. Making the
 * last step a deliberate flag means a fixture corpus, a test run, or a half-finished experiment
 * cannot quietly put a forecast in front of a traveller. A test also asserts no `model.json` is
 * checked into that directory, so the only way one gets there is on purpose.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { istNow } from '../../src/availability/rules';
import { parseJsonl } from './corpus';
import { geometryFromDataset } from './dataset';
import { emitModelJson, formatReport, isServedDataPath, trainModel } from './train';

const USAGE = `
train a Tier 1 coefficient table

  npm run train -- --corpus <file.jsonl> --out <model.json> [--ship]

  --corpus   JSON lines, one observation per line. Required: trainNumber, board, alight, dateIso
             (origin departure), bookedOn, klass, quota, outcome. Outcomes are
             CONFIRMED | RAC_CONFIRMED | NOT_CONFIRMED | REGRET.
  --out      where to write the table. Writing inside the served data directory needs --ship.
  --data     dataset directory holding graph.bin and stations.bin (default ./public/data).
  --ship     allow writing into the served data directory, which activates Tier 1 in the app.

Exits non-zero when a gate fails, and prints which one. A refused run writes nothing.
`;

interface Args {
  corpus: string | null;
  out: string | null;
  data: string;
  ship: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    corpus: null, out: null, data: resolve(process.cwd(), 'public/data'), ship: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') args.corpus = argv[++i] ?? null;
    else if (a === '--out') args.out = argv[++i] ?? null;
    else if (a === '--data') args.data = resolve(argv[++i] ?? args.data);
    else if (a === '--ship') args.ship = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`unknown argument: ${a}\n${USAGE}`);
      process.exit(2);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.corpus === null || args.out === null) {
    console.error(`--corpus and --out are both required.\n${USAGE}`);
    process.exit(2);
  }
  if (!existsSync(args.corpus)) {
    console.error(`no corpus at ${args.corpus}.

No corpus ships with this repository and none can be synthesised: fabricated outcomes would produce
a model that predicts the fabricator's assumptions, badged as a forecast about Indian Railways.
docs/01 names an Apache-2.0 licensed historical corpus as the intended source; until that is
obtained and its licence checked, there is nothing to train on.`);
    process.exit(3);
  }

  const observations = parseJsonl(readFileSync(args.corpus, 'utf8'));
  const geo = geometryFromDataset(args.data);
  console.log(`corpus: ${observations.length} observations · dataset: ${geo.trains} trains, ${geo.stations} stations`);

  const result = trainModel(observations, {
    resolveTrain: geo.resolveTrain,
    resolveStation: geo.resolveStation,
    trainedOnDate: istNow().dateIso,
  });
  console.log(`\n${formatReport(result.report)}\n`);

  if (result.table === null) {
    console.error('no table emitted.');
    process.exit(1);
  }

  if (isServedDataPath(args.out, args.data) && !args.ship) {
    console.error(`refusing to write ${args.out} without --ship.
That directory is what the deployed site serves: a model.json there makes Tier 1 live and puts
probabilities in front of travellers. Re-run with --ship once the report above has been read and the
corpus licence checked.`);
    process.exit(4);
  }

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, emitModelJson(result), 'utf8');
  console.log(`wrote ${outPath}`);
  console.log(`version ${result.table.version} · trainedOn ${result.table.trainedOn}`);
}

main();
