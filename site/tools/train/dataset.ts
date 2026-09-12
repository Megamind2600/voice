/**
 * dataset.ts — reading the packed timetable in Node, for the trainer.
 *
 * The browser loads these containers through `state/cache.ts` with fetch and IndexedDB. A training
 * run has neither and needs no caching: it reads two files once. This module is the Node-side
 * equivalent, and it deliberately reuses the same `Container`, `Graph` and `StationIndex` classes
 * rather than re-parsing bytes, so the trainer derives features from exactly the timetable the app
 * serves. A second reader would be a second opinion about what the data says.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Container, ContainerKind } from '../../src/lib/binary';
import { Graph, stationCountOf } from '../../src/lib/graph';
import { StationIndex } from '../../src/lib/stations';
import type { TrainGeometry } from '../../src/availability/features';

function readAb(file: string): ArrayBuffer {
  const b = readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export interface DatasetGeometry {
  resolveTrain: (trainNumber: string) => TrainGeometry | null;
  resolveStation: (code: string) => number;
  trains: number;
  stations: number;
}

/**
 * Build a train-number → geometry map from `graph.bin` and `stations.bin`.
 *
 * The graph resolves trains by integer index and has no by-number lookup, so the map is built once
 * here rather than the resolver scanning per observation — a corpus of a hundred thousand rows
 * against five thousand trains would otherwise be half a billion comparisons.
 *
 * Throws if the dataset is missing, with what to run instead. There is no fallback: features are
 * derived from real stop distances and real class lists, and inventing either would produce a model
 * trained on a timetable that does not exist.
 */
export function geometryFromDataset(dataDir: string): DatasetGeometry {
  const graphPath = resolve(dataDir, 'graph.bin');
  const stationsPath = resolve(dataDir, 'stations.bin');
  if (!existsSync(graphPath) || !existsSync(stationsPath)) {
    throw new Error(
      `no packed dataset at ${dataDir}. Run the harvester and harvester/pack_binary.py first — the `
      + 'trainer needs real stop distances and class lists to derive features, and there is no '
      + 'substitute for them.',
    );
  }
  const gc = Container.parse(readAb(graphPath), ContainerKind.Graph);
  const sc = Container.parse(readAb(stationsPath), ContainerKind.Stations);
  const stations = StationIndex.fromContainer(sc);
  const graph = Graph.fromContainer(gc, stationCountOf(gc));

  const byNumber = new Map<string, TrainGeometry>();
  for (let t = 0; t < graph.trainCount; t++) {
    const train = graph.train(t);
    byNumber.set(train.number, {
      type: train.type,
      classes: train.classes,
      classesInferred: train.classesInferred,
      distanceKm: train.distanceKm,
      runsDays: train.runsDays,
      runsDaysAssumed: train.runsDaysAssumed,
      stops: graph.rawStopsOfTrain(t).map((r) => ({
        station: r.station, distKm: r.distKm, arrMin: r.arrMin, depMin: r.depMin,
      })),
    });
  }

  return {
    resolveTrain: (n) => byNumber.get(n) ?? null,
    resolveStation: (code) => stations.indexOfCode(code),
    trains: byNumber.size,
    stations: stations.count,
  };
}
